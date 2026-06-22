import { Router } from 'express';
import { z } from 'zod';
import { Prisma, type AgentSettings } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError } from '../lib/http';
import { getAuth, requireAuth, requireRole } from '../middleware/auth';
import {
  BusinessHoursSchema,
  ForwardingNumbersSchema,
  isValidTimezone,
  parseBusinessHours,
  parseForwardingNumbers,
  type BusinessHours,
  type ForwardingNumber,
} from '../domain/agent-config';
import { BACKGROUND_SOUNDS, VOICE_PROVIDERS, isKnownVapiVoice } from '../domain/voice-catalog';
import { isE164, normalizePhone } from '../lib/phone';
import { syncAssistantForTenant } from '../services/vapi.service';

export const agentRouter = Router();
agentRouter.use(requireAuth);

/** Tenant-facing settings shape; provider internals are never included. */
interface AgentSettingsDto {
  displayName: string;
  systemPrompt: string;
  firstMessage: string;
  voicemailGreeting: string;
  businessHours: BusinessHours;
  forwardingNumbers: ForwardingNumber[];
  timezone: string;
  /** "vapi" (native) or "11labs" (ElevenLabs via the provider). */
  voiceProvider: string;
  voiceId: string;
  /** Ambient call audio: "office" | "off". */
  backgroundSound: string;
  /** Average revenue per appointment (whole dollars) — drives the ROI dashboard. */
  avgAppointmentValue: number;
  /** Spam screening: refuse calls with no caller ID. Opt-in, default false. */
  rejectAnonymousCallers: boolean;
  /** Hard call-length ceiling in seconds (safety backstop). */
  maxCallDurationSeconds: number;
  /** Hang up after this many seconds of total silence (dead air). */
  silenceTimeoutSeconds: number;
  /** Custom closing line for graceful wrap-up; null = built-in default. */
  wrapUpMessage: string | null;
  /** Trades: number texted the moment an EMERGENCY job is captured. Null = off. */
  emergencyAlertPhone: string | null;
  /** E.164 number from the provider dashboard; null until assigned. */
  inboundPhoneNumber: string | null;
  /**
   * Vapi assistant assigned by the founder. Read-only here — the customer
   * can't change it, but seeing it confirms their edits have somewhere to go.
   * Null when none is assigned (the workspace uses the transient flow).
   */
  assistantId: string | null;
  updatedAt: string;
}

function toDto(settings: AgentSettings): AgentSettingsDto {
  return {
    displayName: settings.displayName,
    systemPrompt: settings.systemPrompt,
    firstMessage: settings.firstMessage,
    voicemailGreeting: settings.voicemailGreeting,
    businessHours: parseBusinessHours(settings.businessHours),
    forwardingNumbers: parseForwardingNumbers(settings.forwardingNumbers),
    timezone: settings.timezone,
    voiceProvider: settings.voiceProvider,
    voiceId: settings.voiceId,
    backgroundSound: settings.backgroundSound,
    avgAppointmentValue: settings.avgAppointmentValue,
    rejectAnonymousCallers: settings.rejectAnonymousCallers,
    maxCallDurationSeconds: settings.maxCallDurationSeconds,
    silenceTimeoutSeconds: settings.silenceTimeoutSeconds,
    wrapUpMessage: settings.wrapUpMessage,
    emergencyAlertPhone: settings.emergencyAlertPhone,
    inboundPhoneNumber: settings.inboundPhoneNumber,
    assistantId: settings.assistantId,
    updatedAt: settings.updatedAt.toISOString(),
  };
}

async function getSettingsOrThrow(tenantId: string): Promise<AgentSettings> {
  const settings = await prisma.agentSettings.findUnique({ where: { tenantId } });
  if (!settings) {
    throw new HttpError(409, 'Receptionist settings are missing for this workspace.', 'SETTINGS_MISSING');
  }
  return settings;
}

agentRouter.get(
  '/settings',
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const settings = await getSettingsOrThrow(auth.tenantId);
    res.json({ settings: toDto(settings) });
  }),
);

const UpdateSchema = z
  .object({
    displayName: z.string().trim().min(2).max(40),
    systemPrompt: z
      .string()
      .trim()
      .min(40, 'Instructions should be at least 40 characters so the receptionist has enough to work with.')
      .max(6000),
    firstMessage: z.string().trim().min(4).max(400),
    voicemailGreeting: z.string().trim().min(4).max(600),
    businessHours: BusinessHoursSchema,
    forwardingNumbers: ForwardingNumbersSchema,
    timezone: z
      .string()
      .trim()
      .refine(isValidTimezone, 'Unknown timezone. Use an IANA name like America/Chicago.'),
    voiceProvider: z.enum(VOICE_PROVIDERS),
    voiceId: z.string().trim().min(1).max(100),
    backgroundSound: z.enum(BACKGROUND_SOUNDS),
    avgAppointmentValue: z.coerce.number().int().min(0).max(100000),
    rejectAnonymousCallers: z.boolean(),
    // Floored at 3 min so a real booking can never be cut short; capped at 30 min.
    maxCallDurationSeconds: z.coerce.number().int().min(180).max(1800),
    // Floored at 15s so a caller who just paused is never hung up on.
    silenceTimeoutSeconds: z.coerce.number().int().min(15).max(120),
    // Empty string clears it back to the built-in default (stored as null).
    wrapUpMessage: z
      .string()
      .trim()
      .max(300)
      .transform((v) => (v.length > 0 ? v : null))
      .nullable(),
    inboundPhoneNumber: z
      .string()
      .trim()
      .transform(normalizePhone)
      .refine(isE164, 'Use E.164 format, e.g. +15551234567.')
      .nullable(),
    // Empty string clears the alert (stored as null); otherwise a valid E.164.
    emergencyAlertPhone: z
      .string()
      .trim()
      .transform((v) => normalizePhone(v))
      .refine((v) => v === '' || isE164(v), 'Use E.164 format, e.g. +15551234567.')
      .transform((v) => (v.length > 0 ? v : null))
      .nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update.' });

agentRouter.patch(
  '/settings',
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const patch = UpdateSchema.parse(req.body);
    const current = await getSettingsOrThrow(auth.tenantId); // 409 with a clear code if missing

    // Validate the voice pair as it will exist after the patch, so a
    // provider switch and a voiceId change can't sneak past separately.
    const effectiveProvider = patch.voiceProvider ?? current.voiceProvider;
    const effectiveVoiceId = patch.voiceId ?? current.voiceId;
    if (
      (patch.voiceProvider !== undefined || patch.voiceId !== undefined) &&
      effectiveProvider === 'vapi' &&
      !isKnownVapiVoice(effectiveVoiceId)
    ) {
      throw new HttpError(400, 'Unknown voice for the built-in provider.', 'UNKNOWN_VOICE');
    }

    const data: Prisma.AgentSettingsUpdateInput = {};
    if (patch.displayName !== undefined) data.displayName = patch.displayName;
    if (patch.systemPrompt !== undefined) data.systemPrompt = patch.systemPrompt;
    if (patch.firstMessage !== undefined) data.firstMessage = patch.firstMessage;
    if (patch.voicemailGreeting !== undefined) data.voicemailGreeting = patch.voicemailGreeting;
    if (patch.timezone !== undefined) data.timezone = patch.timezone;
    if (patch.voiceProvider !== undefined) data.voiceProvider = patch.voiceProvider;
    if (patch.voiceId !== undefined) data.voiceId = patch.voiceId;
    if (patch.backgroundSound !== undefined) data.backgroundSound = patch.backgroundSound;
    if (patch.avgAppointmentValue !== undefined) data.avgAppointmentValue = patch.avgAppointmentValue;
    if (patch.rejectAnonymousCallers !== undefined) data.rejectAnonymousCallers = patch.rejectAnonymousCallers;
    if (patch.maxCallDurationSeconds !== undefined) data.maxCallDurationSeconds = patch.maxCallDurationSeconds;
    if (patch.silenceTimeoutSeconds !== undefined) data.silenceTimeoutSeconds = patch.silenceTimeoutSeconds;
    if (patch.wrapUpMessage !== undefined) data.wrapUpMessage = patch.wrapUpMessage;
    if (patch.emergencyAlertPhone !== undefined) data.emergencyAlertPhone = patch.emergencyAlertPhone;
    if (patch.inboundPhoneNumber !== undefined) data.inboundPhoneNumber = patch.inboundPhoneNumber;
    if (patch.businessHours !== undefined) {
      data.businessHours = patch.businessHours as unknown as Prisma.InputJsonValue;
    }
    if (patch.forwardingNumbers !== undefined) {
      data.forwardingNumbers = patch.forwardingNumbers as unknown as Prisma.InputJsonValue;
    }

    try {
      const updated = await prisma.agentSettings.update({
        where: { tenantId: auth.tenantId },
        data,
      });
      // If an assistant is assigned, push the new settings to Vapi. Best-effort:
      // the save already succeeded, so a sync hiccup only adds a gentle note.
      const sync = await syncAssistantForTenant(auth.tenantId);
      res.json({ settings: toDto(updated), sync });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new HttpError(
          409,
          'That phone number is already assigned to another workspace.',
          'NUMBER_TAKEN',
        );
      }
      throw err;
    }
  }),
);
