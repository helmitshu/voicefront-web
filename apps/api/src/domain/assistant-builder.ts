import type { AgentSettings, Tenant } from '@prisma/client';
import { hoursToHumanText, isOpenNow, parseBusinessHours, parseForwardingNumbers } from './agent-config';
import { composeSystemPrompt } from './prompt-templates';
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
  model: {
    provider: 'openai';
    model: string;
    temperature: number;
    messages: Array<{ role: 'system'; content: string }>;
    tools?: Array<TransferCallTool | FunctionTool>;
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
  transcriber: { provider: 'deepgram'; model: string; language: string };
  voicemailMessage: string;
  endCallMessage: string;
  maxDurationSeconds: number;
  serverMessages: string[];
  analysisPlan: { summaryPlan: { enabled: boolean } };
  artifactPlan: { recordingEnabled: boolean };
  /** How quickly the agent starts talking once the caller stops. */
  startSpeakingPlan?: { waitSeconds: number; smartEndpointingEnabled: boolean };
  /** Lets the caller interrupt the agent (barge-in), like a real conversation. */
  stopSpeakingPlan?: { numWords: number; voiceSeconds: number; backoffSeconds: number };
  /** Gives the model a tool to actually hang up once the call is done. */
  endCallFunctionEnabled?: boolean;
  /** Spoken-phrase fallbacks that also trigger a hang-up. */
  endCallPhrases?: string[];
  metadata: { tenantId: string; channel: CallChannel };
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
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
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

export function buildTransientAssistant(
  tenant: Pick<Tenant, 'id' | 'companyName'>,
  settings: AgentSettings,
  channel: CallChannel,
  now: Date = new Date(),
  options: { serverUrl?: string; serverSecret?: string } = {},
): TransientAssistant {
  const businessHours = parseBusinessHours(settings.businessHours);
  const forwardingNumbers = parseForwardingNumbers(settings.forwardingNumbers);
  const openNow = isOpenNow(businessHours, settings.timezone, now);
  const local = utcToZonedParts(now, settings.timezone);
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: settings.timezone,
    weekday: 'long',
  }).format(now);

  const systemPrompt = composeSystemPrompt({
    companyName: tenant.companyName,
    basePrompt: settings.systemPrompt,
    businessHours,
    timezone: settings.timezone,
    openNow,
    voicemailGreeting: settings.voicemailGreeting,
    forwardingNumbers,
    localToday: { date: local.date, weekday },
  });

  const tools: Array<TransferCallTool | FunctionTool> = [...buildBookingTools()];
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
    firstMessage: openNow
      ? settings.firstMessage
      : `${settings.firstMessage} Just so you know, you've reached us outside regular hours, but I can still help or take a message.`,
    model: {
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.75,
      messages: [{ role: 'system', content: systemPrompt }],
      ...(tools.length > 0 ? { tools } : {}),
    },
    // Vapi's native voices opt into the V2 TTS model (more realistic and
    // human); other providers (e.g. 11labs) take the voiceId as-is.
    voice:
      settings.voiceProvider === 'vapi'
        ? { provider: 'vapi', voiceId: settings.voiceId, version: 2 }
        : { provider: settings.voiceProvider, voiceId: settings.voiceId },
    backgroundSound: settings.backgroundSound,
    // Explicit server URL (when configured) routes tool calls here even for
    // browser test calls, which have no phone-number-level server fallback.
    ...(options.serverUrl
      ? { server: { url: options.serverUrl, ...(options.serverSecret ? { secret: options.serverSecret } : {}) } }
      : {}),
    transcriber: { provider: 'deepgram', model: 'nova-2', language: 'en' },
    voicemailMessage: settings.voicemailGreeting,
    endCallMessage: `Thanks for calling ${tenant.companyName}. Have a great day!`,
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
    startSpeakingPlan: { waitSeconds: 0.8, smartEndpointingEnabled: true },
    stopSpeakingPlan: { numWords: 3, voiceSeconds: 0.3, backoffSeconds: 1.5 },
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
  options: { serverUrl?: string; serverSecret?: string } = {},
): TransientAssistant {
  const businessHours = parseBusinessHours(settings.businessHours);
  const forwardingNumbers = parseForwardingNumbers(settings.forwardingNumbers);

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
    [
      'WHO YOU ARE — your personality (this matters as much as the steps below):',
      'You\'re a warm, upbeat North-American front-desk receptionist who genuinely likes people. You smile while you talk and it comes through in your voice. You\'re kind, a little chatty, and you make every caller feel welcome and looked-after — like the friendliest person at a great local front desk.',
      '',
      'How you sound:',
      '- Be genuinely friendly and warm, never stiff or formal. Talk like a real person: contractions ("I\'ll", "you\'re", "let\'s"), everyday words, and a little lightness.',
      '- React like a human with feelings. Use natural little interjections where they fit: "Oh, of course!", "Aw, no worries at all!", "Perfect!", "Gotcha", "Awesome", "Oh nice!". Sprinkle them in — don\'t overdo it.',
      '- Use the caller\'s first name once or twice once you know it ("Sure thing, Hakim!"), but not in every sentence.',
      '- Show warmth and care. If someone\'s in pain or stressed: "Oh no, I\'m so sorry you\'re dealing with that — let\'s get you in to see someone." If they\'re happy or joking, match their energy and smile back.',
      '',
      'Small talk and pleasantries (handle these like a warm human, not a bot):',
      '- If the caller greets you or asks how you\'re doing, answer warmly and briefly, then gently steer back. Example — Caller: "Hi, how are you?" You: "Aw, I\'m doing great, thanks so much for asking! How are you doing today?" After they answer: "Glad to hear it! So, what can I do for you?"',
      '- If they thank you, respond warmly and vary it: "Of course!", "Anytime!", "Happy to help!".',
      '- Keep small talk short and genuine — be warm first, then move things along. Never let chit-chat stall the reason they called.',
      '',
      'Conversation mechanics:',
      '- Keep each turn to one or two short, natural sentences. Ask for exactly ONE piece of information per turn, then stop and wait. Never bundle requests — ask "Can I start with your name?", get it, then ask the next thing.',
      '- Vary your acknowledgments so you never sound on-repeat, and never say "thank you" twice in a row.',
      '- Confirm details naturally and only when it matters (like a phone number) — read it back once, normally; don\'t robotically spell every digit unless they seem unsure.',
      '- A brief filler ("let me see…", "one sec!") while you look something up is fine — say it once, then go quiet until you have the answer.',
      '- Mirror the caller\'s energy: warm and chatty if they are, quick and efficient if they\'re in a hurry.',
    ].join('\n'),
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
    [
      'APPOINTMENT BOOKING — gather details ONE question at a time, in this order (never bundle them):',
      '1. Ask for their name first. After they answer, ask for a callback number. After that, ask the reason for the visit. A date of birth is NOT an appointment date — never check the calendar against a birth date.',
      '2. Ask which day they\'d like. Convert their answer to an exact calendar date using today\'s date above (e.g. if today is the 14th and they say "Monday", that is the coming Monday).',
      `3. Call checkAvailability ONCE for that day, passing the date as YYYY-MM-DD (all times ${tz}). Wait for the result before saying anything about availability — never guess that a day is full or open.`,
      '4. The tool returns ALL open times for the day. If the caller asked for a specific time of day (e.g. "afternoon" or "around 3 PM"), offer the open slots closest to what they asked for — do not claim afternoons are full if afternoon slots are in the list. Otherwise offer about 3 reasonable options.',
      '5. When the caller picks a slot the tool listed as free, call bookAppointment with their name, number, reason, the date (YYYY-MM-DD) and the time (HH:MM, 24-hour).',
      '6. Only after bookAppointment succeeds, confirm by repeating the weekday, date, and time back. Never claim something is booked unless the tool confirmed it.',
    ].join('\n'),
    '',
    [
      'ENDING THE CALL:',
      '- When the caller signals they\'re done (they say "bye", "that\'s all", "thanks, that\'s it", or similar), give ONE short, warm goodbye and then immediately use the end-call function to hang up.',
      '- Do not keep talking, do not ask "anything else?" more than once, and never trade repeated goodbyes. One goodbye, then end the call.',
    ].join('\n'),
  ].join('\n');

  const tools: Array<TransferCallTool | FunctionTool> = [...buildBookingTools()];
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
    model: {
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.75,
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
    endCallMessage: `Thanks for calling ${tenant.companyName}. Have a great day!`,
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
    startSpeakingPlan: { waitSeconds: 0.8, smartEndpointingEnabled: true },
    stopSpeakingPlan: { numWords: 3, voiceSeconds: 0.3, backoffSeconds: 1.5 },
    // Let the agent hang up once the caller is done. endCallPhrases is forced
    // empty — phrase triggers cut the goodbye off mid-sentence; the model's
    // end-call tool lets Vapi finish speaking before it disconnects. (Must be
    // sent explicitly: Vapi PATCH won't clear a field that's merely omitted.)
    endCallFunctionEnabled: true,
    endCallPhrases: [],
    metadata: { tenantId: tenant.id, channel: 'phone' },
  };
}
