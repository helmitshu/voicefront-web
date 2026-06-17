import type { AgentSettings, Tenant } from '@prisma/client';
import { hoursToHumanText, isOpenNow, parseBusinessHours, parseForwardingNumbers } from './agent-config';
import {
  PERSONA_VOICE_LAYER,
  bookingDiscipline,
  composeSystemPrompt,
  ENDING_THE_CALL,
} from './prompt-templates';
import { utcToZonedParts } from '../services/appointment.service';

export type CallChannel = 'phone' | 'web';

/**
 * The transient assistant payload the provider expects when a call connects.
 * Typed structurally (no provider SDK import) so the server stays decoupled
 * from provider package churn; field names follow the provider's public API.
 */
export interface TransientAssistant {
  name: string;
  firstMessage: string;
  /** "assistant-speaks-first" makes the agent say firstMessage once, then wait
   * for the caller — preventing it from rattling off several opening turns. */
  firstMessageMode?: string;
  model: {
    provider: 'openai';
    model: string;
    temperature: number;
    messages: Array<{ role: 'system'; content: string }>;
    tools?: Array<TransferCallTool | FunctionTool | QueryTool>;
  };
  /**
   * Where the provider sends webhooks for this assistant (tool calls etc.).
   * `secret` is echoed back as the `x-vapi-secret` header so our webhook can
   * authenticate the caller — without it every tool-call / end-of-call report
   * is rejected with 401.
   */
  server?: { url: string; secret?: string };
  voice: { provider: string; voiceId: string; version?: number };
  /** "office" | "off" | URL — ambient audio mixed into the call. */
  backgroundSound: string;
  /** `keywords` boost recognition of hard-to-hear words (e.g. the prospect's
   *  name in the sales demo) — Deepgram nova-2 takes `word:intensity` strings. */
  transcriber: { provider: 'deepgram'; model: string; language: string; keywords?: string[] };
  voicemailMessage: string;
  endCallMessage: string;
  maxDurationSeconds: number;
  serverMessages: string[];
  /** `summaryPlan.messages`, when set, replaces the provider's default summary
   *  prompt — the sales demo uses it to capture the full call arc, objections
   *  and any friction, not just "an appointment was booked". */
  analysisPlan: { summaryPlan: { enabled: boolean; messages?: Array<{ role: 'system' | 'user'; content: string }> } };
  artifactPlan: { recordingEnabled: boolean };
  /** How quickly the agent starts talking once the caller stops. */
  startSpeakingPlan?: { waitSeconds: number; smartEndpointingEnabled: boolean };
  /** Lets the caller interrupt the agent (barge-in), like a real conversation. */
  stopSpeakingPlan?: { numWords: number; voiceSeconds: number; backoffSeconds: number };
  /** Gives the model a tool to actually hang up once the call is done. */
  endCallFunctionEnabled?: boolean;
  /** Spoken-phrase fallbacks that also trigger a hang-up. */
  endCallPhrases?: string[];
  metadata: { tenantId: string; channel: CallChannel; demoSessionId?: string };
}

/**
 * Natural, varied filler the agent speaks the moment a tool starts — so the
 * line never goes silent while the calendar is queried. Multiple entries let
 * the provider rotate them so it doesn't sound like a stuck recording.
 */
const CHECK_AVAILABILITY_FILLERS = [
  'Let me take a look at the calendar.',
  'Sure, let me pull up our availability.',
  'One sec while I check what we have open.',
  'Let me see what we’ve got — just a moment.',
];
const BOOKING_FILLERS = [
  'Perfect, let me get that booked for you.',
  'Great — putting that in now.',
  'Got it, booking that for you.',
];

interface TransferCallTool {
  type: 'transferCall';
  destinations: Array<{
    type: 'number';
    number: string;
    message: string;
    description: string;
  }>;
}

/**
 * Vapi "query" tool backed by uploaded knowledge-base files. The model calls
 * it to look up business facts (services, pricing, promotions, location,
 * parking, insurance) from the tenant's documents instead of guessing.
 * `provider: 'google'` is what Vapi uses for files uploaded to its own store.
 */
interface QueryTool {
  type: 'query';
  function: { name: string };
  knowledgeBases: Array<{
    provider: 'google';
    name: string;
    description: string;
    fileIds: string[];
  }>;
}

/** Name the model sees for the knowledge-base lookup; referenced in the prompt. */
const KNOWLEDGE_TOOL_NAME = 'lookupBusinessInfo';

/**
 * Builds the knowledge-base query tool from a tenant's uploaded file ids, or
 * null when they have none (so we never attach an empty knowledge base).
 */
function buildKnowledgeTool(companyName: string, fileIds: string[]): QueryTool | null {
  if (fileIds.length === 0) return null;
  return {
    type: 'query',
    function: { name: KNOWLEDGE_TOOL_NAME },
    knowledgeBases: [
      {
        provider: 'google',
        name: 'business-info',
        description: `Reference documents for ${companyName}: services, pricing, promotions, location, parking, insurance, and other business details.`,
        fileIds,
      },
    ],
  };
}

/** Prompt block telling the model when to reach for the knowledge base. */
const KNOWLEDGE_PROMPT = [
  'BUSINESS KNOWLEDGE (uploaded documents):',
  `- You have a ${KNOWLEDGE_TOOL_NAME} tool that searches the business's own documents (services, pricing, promotions, location, parking, insurance, policies).`,
  `- Whenever a caller asks about any of those and you're not 100% sure of the answer, call ${KNOWLEDGE_TOOL_NAME} first and answer from what it returns — don't guess or make up details.`,
  '- If the documents don\'t cover it, say you\'re not certain and offer to take a message or have someone follow up.',
].join('\n');

interface FunctionTool {
  type: 'function';
  /** Spoken while the server processes the call, so the line never goes dead. */
  async?: boolean;
  messages?: Array<{ type: 'request-start'; content: string }>;
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string; enum?: string[] }>;
      required: string[];
    };
  };
}

/** The screens Ava can switch the prospect's browser to, in story order. */
export const DEMO_SCREENS = ['intro', 'booking', 'doublebook', 'summary', 'close'] as const;
export type DemoScreen = (typeof DEMO_SCREENS)[number];

/**
 * Web-demo-only tool: lets Ava drive the prospect's on-screen panel directly,
 * so the visuals follow what she's actually doing instead of guessing from her
 * words. `async` (fire-and-forget) so changing the screen never pauses her
 * speech. She can move forward OR back (e.g. when the prospect asks to revisit
 * the calendar), which keyword detection could never do.
 */
function buildScreenControlTool(): FunctionTool {
  return {
    type: 'function',
    async: true,
    function: {
      name: 'set_demo_screen',
      description:
        "Switch the prospect's on-screen panel to match what you're doing right now. Call it the moment you move to a new part of the demo — and again to go back if they ask to revisit something. Screens: 'intro' (welcome), 'booking' (the live calendar — use while booking), 'doublebook' (the double-booking test — also shows the calendar), 'summary' (the after-call recap), 'close' (booking their setup call).",
      parameters: {
        type: 'object',
        properties: {
          screen: {
            type: 'string',
            description: 'Which screen to show the prospect now.',
            enum: [...DEMO_SCREENS],
          },
        },
        required: ['screen'],
      },
    },
  };
}

/**
 * Web-demo-only tool: lets Ava put a REAL recap of THIS call on the summary
 * screen — what the prospect actually needed, in her words — instead of a
 * generic mockup. Also flips the panel to the summary screen. `async` so it
 * never pauses her speech.
 */
function buildCallSummaryTool(): FunctionTool {
  return {
    type: 'function',
    async: true,
    function: {
      name: 'show_call_summary',
      description:
        "Put a real recap of THIS call on the prospect's summary screen, and switch them to it. Call it when you reach the summary part of the demo. Use what they actually told you — never generic filler.",
      parameters: {
        type: 'object',
        properties: {
          headline: {
            type: 'string',
            description: "One short phrase for what the caller wanted, e.g. \"Capture every lead and answer customer questions\".",
          },
          recap: {
            type: 'string',
            description:
              'One or two natural sentences recapping what the caller needed and what you did for them on this call, as a post-call note their team would read.',
          },
        },
        required: ['headline', 'recap'],
      },
    },
  };
}

/** Booking tools handled by our webhook (`tool-calls` messages). */
function buildBookingTools(): FunctionTool[] {
  return [
    {
      type: 'function',
      async: false,
      messages: CHECK_AVAILABILITY_FILLERS.map((content) => ({ type: 'request-start' as const, content })),
      function: {
        name: 'checkAvailability',
        description:
          'Returns the open appointment slots for one calendar day. Always call this before offering or booking any time.',
        parameters: {
          type: 'object',
          properties: {
            date: {
              type: 'string',
              description: 'The day to check, as YYYY-MM-DD in the business timezone.',
            },
          },
          required: ['date'],
        },
      },
    },
    {
      type: 'function',
      async: false,
      messages: BOOKING_FILLERS.map((content) => ({ type: 'request-start' as const, content })),
      function: {
        name: 'bookAppointment',
        description:
          'Books a confirmed appointment in an open slot. Only use times that checkAvailability returned as free and the caller agreed to.',
        parameters: {
          type: 'object',
          properties: {
            customerName: { type: 'string', description: "Caller's full name." },
            customerPhone: {
              type: 'string',
              description: "Caller's callback number with country code, e.g. +15551234567.",
            },
            reason: { type: 'string', description: 'Short reason for the appointment.' },
            date: { type: 'string', description: 'Appointment day, YYYY-MM-DD in the business timezone.' },
            time: {
              type: 'string',
              description: 'Start time as 24-hour HH:MM in the business timezone, e.g. 14:30.',
            },
          },
          required: ['customerName', 'date', 'time'],
        },
      },
    },
  ];
}

/**
 * Tools that book a planning call onto the FOUNDER's calendar (not the demo
 * clinic). The sales demo adds these so Ava can close by scheduling the founder
 * — routed in the webhook to founder.service, which reuses the booking engine's
 * overlap guard so she can never double-book the founder.
 */
export function buildFounderBookingTools(): FunctionTool[] {
  return [
    {
      type: 'function',
      async: false,
      messages: CHECK_AVAILABILITY_FILLERS.map((content) => ({ type: 'request-start' as const, content })),
      function: {
        name: 'checkFounderAvailability',
        description:
          "Returns the founder's open times for one day, for scheduling a planning call. Always call this before offering or booking a planning-call time.",
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: "The day to check, YYYY-MM-DD in the founder's timezone." },
          },
          required: ['date'],
        },
      },
    },
    {
      type: 'function',
      async: false,
      messages: BOOKING_FILLERS.map((content) => ({ type: 'request-start' as const, content })),
      function: {
        name: 'bookPlanningCall',
        description:
          "Books a planning call with the founder in one of their open slots. Only use a time checkFounderAvailability returned as free and the prospect agreed to.",
        parameters: {
          type: 'object',
          properties: {
            customerName: { type: 'string', description: "The prospect's full name." },
            customerPhone: { type: 'string', description: "The prospect's phone with country code, e.g. +15551234567." },
            reason: { type: 'string', description: 'One short line on what they want to discuss.' },
            date: { type: 'string', description: "Planning-call day, YYYY-MM-DD in the founder's timezone." },
            time: { type: 'string', description: "Start time as 24-hour HH:MM in the founder's timezone." },
          },
          required: ['customerName', 'date', 'time'],
        },
      },
    },
  ];
}

export function buildTransientAssistant(
  tenant: Pick<Tenant, 'id' | 'companyName'>,
  settings: AgentSettings,
  channel: CallChannel,
  now: Date = new Date(),
  options: {
    serverUrl?: string;
    serverSecret?: string;
    knowledgeFileIds?: string[];
    /** Override the tenant's saved voice — used by the in-browser test so the
     * founder can A/B voices live before committing one. */
    voice?: { provider: string; voiceId: string };
    /** Replace the composed receptionist system prompt entirely — used by the
     * landing-page SALES demo, which has its own persona and playbook. */
    systemPromptOverride?: string;
    /** Override the assistant display name (e.g. the sales-demo agent). */
    assistantName?: string;
    /** Override ambient audio (e.g. 'office' to add life to the sales demo). */
    backgroundSound?: string;
    /** Sales demo: also give the agent tools to book the founder's calendar. */
    includeFounderBooking?: boolean;
    /** Web sales demo: give Ava the set_demo_screen tool so she drives the
     *  prospect's on-screen panel directly. */
    includeScreenControl?: boolean;
    /** Boost the transcriber on hard-to-hear words (e.g. the prospect's name). */
    transcriberKeywords?: string[];
    /** Replace the default end-of-call summary prompt (sales-demo recap). */
    summaryPrompt?: string;
  } = {},
): TransientAssistant {
  const businessHours = parseBusinessHours(settings.businessHours);
  const forwardingNumbers = parseForwardingNumbers(settings.forwardingNumbers);
  const openNow = isOpenNow(businessHours, settings.timezone, now);
  const local = utcToZonedParts(now, settings.timezone);
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: settings.timezone,
    weekday: 'long',
  }).format(now);

  const knowledgeTool = buildKnowledgeTool(tenant.companyName, options.knowledgeFileIds ?? []);

  const systemPrompt =
    options.systemPromptOverride ??
    [
      composeSystemPrompt({
        companyName: tenant.companyName,
        basePrompt: settings.systemPrompt,
        businessHours,
        timezone: settings.timezone,
        openNow,
        voicemailGreeting: settings.voicemailGreeting,
        forwardingNumbers,
        localToday: { date: local.date, weekday },
      }),
      ...(knowledgeTool ? ['', KNOWLEDGE_PROMPT] : []),
    ].join('\n');

  const tools: Array<TransferCallTool | FunctionTool | QueryTool> = [...buildBookingTools()];
  if (options.includeFounderBooking) tools.push(...buildFounderBookingTools());
  if (options.includeScreenControl) tools.push(buildScreenControlTool(), buildCallSummaryTool());
  if (knowledgeTool) tools.push(knowledgeTool);
  if (forwardingNumbers.length > 0) {
    tools.push({
      type: 'transferCall',
      destinations: forwardingNumbers.map((f) => ({
        type: 'number' as const,
        number: f.number,
        message: `One moment — connecting you to ${f.label}.`,
        description:
          f.whenToUse.length > 0 ? `${f.label}. Use when: ${f.whenToUse}` : `Transfer line for ${f.label}.`,
      })),
    });
  }

  // In-browser test: a short, warm opener (the founder is talking to it, not a
  // real caller) — no "calls may be recorded" and no multi-sentence corporate
  // greeting that fragments into several bubbles. Real phone calls keep the
  // tenant's full greeting (plus the after-hours note when closed).
  const personaName = settings.displayName;
  const firstMessage =
    channel === 'web'
      ? `Hi! This is ${personaName} from ${tenant.companyName} — go ahead whenever you're ready.`
      : openNow
        ? settings.firstMessage
        : `${settings.firstMessage} Just so you know, we're after hours at the moment, so I'll take a message and our team will follow up.`;

  // Voice: an explicit override (live A/B test) wins; otherwise the saved voice.
  const voiceProvider = options.voice?.provider ?? settings.voiceProvider;
  const voiceId = options.voice?.voiceId ?? settings.voiceId;

  return {
    name: options.assistantName ?? `${tenant.companyName} Receptionist`,
    firstMessage,
    firstMessageMode: 'assistant-speaks-first',
    model: {
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.65,
      messages: [{ role: 'system', content: systemPrompt }],
      ...(tools.length > 0 ? { tools } : {}),
    },
    // Vapi's native voices opt into the V2 TTS model (more realistic and
    // human); other providers (e.g. 11labs) take the voiceId as-is.
    voice:
      voiceProvider === 'vapi'
        ? { provider: 'vapi', voiceId, version: 2 }
        : { provider: voiceProvider, voiceId },
    backgroundSound: options.backgroundSound ?? settings.backgroundSound,
    // Explicit server URL (when configured) routes tool calls here even for
    // browser test calls, which have no phone-number-level server fallback.
    ...(options.serverUrl
      ? { server: { url: options.serverUrl, ...(options.serverSecret ? { secret: options.serverSecret } : {}) } }
      : {}),
    transcriber: {
      provider: 'deepgram',
      model: 'nova-2',
      language: 'en',
      ...(options.transcriberKeywords && options.transcriberKeywords.length > 0
        ? { keywords: options.transcriberKeywords }
        : {}),
    },
    voicemailMessage: settings.voicemailGreeting,
    // Front-load the meaningful goodbye; Vapi tends to clip the tail on hangup,
    // so "take care now, bye!" is the disposable part that can be safely lost.
    endCallMessage: `Thanks so much for calling ${tenant.companyName} — take care now, bye!`,
    maxDurationSeconds: 900,
    serverMessages: ['end-of-call-report', 'status-update', 'tool-calls'],
    analysisPlan: {
      summaryPlan: {
        enabled: true,
        ...(options.summaryPrompt ? { messages: [{ role: 'system', content: options.summaryPrompt }] } : {}),
      },
    },
    artifactPlan: { recordingEnabled: true },
    // Snappy responses + barge-in so the agent feels like a real conversation,
    // not a walkie-talkie: start talking ~0.4s after the caller stops, and let
    // the caller interrupt mid-sentence.
    // Wait a beat longer before talking so the caller's natural pauses don't
    // trigger an interruption, and require a few words (not one stray sound)
    // before the agent yields — this stops the "Got it. Got it." stutter.
    // Tighter response timing: smart endpointing detects turn-end, and a lower
    // wait floor (0.6s) cuts the laggy gap before she replies. Faster resume
    // after an interruption too. numWords:3 still guards against twitchy cut-ins.
    startSpeakingPlan: { waitSeconds: 0.6, smartEndpointingEnabled: true },
    stopSpeakingPlan: { numWords: 3, voiceSeconds: 0.3, backoffSeconds: 1.0 },
    // Let the agent hang up once the caller is done. endCallPhrases is forced
    // empty — phrase triggers cut the goodbye off mid-sentence; the model's
    // end-call tool lets Vapi finish speaking before it disconnects. (Must be
    // sent explicitly: Vapi PATCH won't clear a field that's merely omitted.)
    endCallFunctionEnabled: true,
    endCallPhrases: [],
    // Round-trips through provider webhooks so end-of-call reports can be
    // attributed to a tenant even for browser test calls with no phone number.
    metadata: { tenantId: tenant.id, channel },
  };
}

/**
 * Builds the assistant body to PATCH onto a *persistent* Vapi assistant the
 * founder assigned to a tenant. Unlike the transient assistant (rebuilt per
 * call), this is pushed once when settings are saved, so its prompt must be
 * timeless: no "right now it's OPEN/CLOSED" and no baked-in "today" — those
 * are resolved live by the model at call time from the static hours below.
 *
 * Shares the transient assistant's shape so a synced assistant behaves the
 * same on phone calls. Booking still works because the booking tools are
 * attached and routed to our webhook via `server.url`.
 */
export function buildAssistantUpdatePayload(
  tenant: Pick<Tenant, 'id' | 'companyName'>,
  settings: AgentSettings,
  options: { serverUrl?: string; serverSecret?: string; knowledgeFileIds?: string[] } = {},
): TransientAssistant {
  const businessHours = parseBusinessHours(settings.businessHours);
  const forwardingNumbers = parseForwardingNumbers(settings.forwardingNumbers);
  const knowledgeTool = buildKnowledgeTool(tenant.companyName, options.knowledgeFileIds ?? []);

  const directory =
    forwardingNumbers.length > 0
      ? forwardingNumbers
          .map((f) => `- ${f.label}${f.whenToUse ? ` — use when: ${f.whenToUse}` : ''}`)
          .join('\n')
      : 'No transfer lines are configured. Never claim you can transfer a call; take a message instead.';

  // Vapi replaces these liquid variables with the real date/time at call time,
  // in the tenant's timezone — so the agent always knows "today" without us
  // re-pushing a baked-in date that would go stale.
  const tz = settings.timezone;
  const todayVar = `{{"now" | date: "%A, %B %d, %Y", "${tz}"}}`;
  const timeVar = `{{"now" | date: "%I:%M %p", "${tz}"}}`;

  const systemPrompt = [
    settings.systemPrompt.trim(),
    '',
    PERSONA_VOICE_LAYER,
    '',
    [
      'CURRENT DATE & TIME (authoritative — always trust this over your own assumptions):',
      `- Today is ${todayVar}. The current local time is ${timeVar} (${tz}).`,
      '- Resolve every relative date the caller uses ("today", "tomorrow", "next Monday", "the 18th") against today\'s date above before doing anything with it.',
    ].join('\n'),
    '',
    [
      'BUSINESS INFO:',
      `- Company: ${tenant.companyName}.`,
      `- Business hours (${tz}): ${hoursToHumanText(businessHours)}.`,
      '- If a caller reaches you outside these hours, let them know the office is closed and offer to take a detailed message; the team replies on the next business day.',
      `- After-hours guidance for callers: "${settings.voicemailGreeting}"`,
      '',
      'TRANSFER DIRECTORY (refer to lines only by their label, never read a phone number aloud):',
      directory,
    ].join('\n'),
    '',
    bookingDiscipline(tz),
    '',
    ENDING_THE_CALL,
    ...(knowledgeTool ? ['', KNOWLEDGE_PROMPT] : []),
  ].join('\n');

  const tools: Array<TransferCallTool | FunctionTool | QueryTool> = [...buildBookingTools()];
  if (knowledgeTool) tools.push(knowledgeTool);
  if (forwardingNumbers.length > 0) {
    tools.push({
      type: 'transferCall',
      destinations: forwardingNumbers.map((f) => ({
        type: 'number' as const,
        number: f.number,
        message: `One moment — connecting you to ${f.label}.`,
        description:
          f.whenToUse.length > 0 ? `${f.label}. Use when: ${f.whenToUse}` : `Transfer line for ${f.label}.`,
      })),
    });
  }

  return {
    name: `${tenant.companyName} Receptionist`,
    firstMessage: settings.firstMessage,
    firstMessageMode: 'assistant-speaks-first',
    model: {
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.65,
      messages: [{ role: 'system', content: systemPrompt }],
      ...(tools.length > 0 ? { tools } : {}),
    },
    voice:
      settings.voiceProvider === 'vapi'
        ? { provider: 'vapi', voiceId: settings.voiceId, version: 2 }
        : { provider: settings.voiceProvider, voiceId: settings.voiceId },
    backgroundSound: settings.backgroundSound,
    ...(options.serverUrl
      ? { server: { url: options.serverUrl, ...(options.serverSecret ? { secret: options.serverSecret } : {}) } }
      : {}),
    transcriber: { provider: 'deepgram', model: 'nova-2', language: 'en' },
    voicemailMessage: settings.voicemailGreeting,
    // Front-load the meaningful goodbye; Vapi tends to clip the tail on hangup,
    // so "take care now, bye!" is the disposable part that can be safely lost.
    endCallMessage: `Thanks so much for calling ${tenant.companyName} — take care now, bye!`,
    maxDurationSeconds: 900,
    serverMessages: ['end-of-call-report', 'status-update', 'tool-calls'],
    analysisPlan: { summaryPlan: { enabled: true } },
    artifactPlan: { recordingEnabled: true },
    // Snappy responses + barge-in so the agent feels like a real conversation,
    // not a walkie-talkie: start talking ~0.4s after the caller stops, and let
    // the caller interrupt mid-sentence.
    // Wait a beat longer before talking so the caller's natural pauses don't
    // trigger an interruption, and require a few words (not one stray sound)
    // before the agent yields — this stops the "Got it. Got it." stutter.
    // Tighter response timing: smart endpointing detects turn-end, and a lower
    // wait floor (0.6s) cuts the laggy gap before she replies. Faster resume
    // after an interruption too. numWords:3 still guards against twitchy cut-ins.
    startSpeakingPlan: { waitSeconds: 0.6, smartEndpointingEnabled: true },
    stopSpeakingPlan: { numWords: 3, voiceSeconds: 0.3, backoffSeconds: 1.0 },
    // Let the agent hang up once the caller is done. endCallPhrases is forced
    // empty — phrase triggers cut the goodbye off mid-sentence; the model's
    // end-call tool lets Vapi finish speaking before it disconnects. (Must be
    // sent explicitly: Vapi PATCH won't clear a field that's merely omitted.)
    endCallFunctionEnabled: true,
    endCallPhrases: [],
    metadata: { tenantId: tenant.id, channel: 'phone' },
  };
}
