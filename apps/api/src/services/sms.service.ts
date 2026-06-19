import twilio from 'twilio';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { utcToZonedParts, to12h } from './appointment.service';

// ── Platform defaults ────────────────────────────────────────────────────────

export const DEFAULT_CONFIRMATION_TEMPLATE =
  'Hi {customerName}, your appointment at {businessName} is confirmed for {date} at {time}. Reply STOP to opt out.';

export const DEFAULT_REMINDER_24H_TEMPLATE =
  'Reminder: You have an appointment at {businessName} tomorrow at {time}. Reply STOP to unsubscribe.';

export const DEFAULT_REMINDER_1H_TEMPLATE =
  'Your {businessName} appointment starts in 1 hour ({time}). Reply STOP to unsubscribe.';

export const DEFAULT_WAITLIST_TEMPLATE =
  'Good news {customerName} — a spot just opened at {businessName} on {date} at {time}. Call us back to grab it before someone else does. Reply STOP to opt out.';

export const DEFAULT_REACTIVATION_TEMPLATE =
  "Hi {customerName}, it's been a while since your last visit to {businessName}. We'd love to see you again — call us to book a time that works for you. Reply STOP to opt out.";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** True when all three Twilio credentials are present in the environment. */
export function isSmsAvailable(): boolean {
  return !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER);
}

/** Replace {variable} placeholders with values; unknown vars become empty string. */
function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? '');
}

/** Check whether a phone number has opted out for a specific tenant. */
async function isOptedOut(phone: string, tenantId: string): Promise<boolean> {
  const row = await prisma.smsOptOut.findUnique({
    where: { phone_tenantId: { phone, tenantId } },
  });
  return !!row;
}

/** Low-level send via Twilio. No-ops silently when Twilio isn't configured. */
async function sendRaw(to: string, body: string): Promise<void> {
  if (!isSmsAvailable()) return;
  const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  await client.messages.create({
    from: env.TWILIO_FROM_NUMBER!,
    to,
    body,
  });
}

// ── Opt-out webhook ──────────────────────────────────────────────────────────

/**
 * Called by the Twilio status-callback webhook when a STOP reply is received.
 * Records the opt-out so the cron job won't retry before Twilio's own suppression kicks in.
 */
export async function recordOptOut(phone: string, tenantId: string): Promise<void> {
  await prisma.smsOptOut.upsert({
    where: { phone_tenantId: { phone, tenantId } },
    create: { phone, tenantId },
    update: {},
  });
}

/**
 * Called when a START reply is received — removes the opt-out record so
 * future reminders resume.
 */
export async function recordOptIn(phone: string, tenantId: string): Promise<void> {
  await prisma.smsOptOut.deleteMany({ where: { phone, tenantId } });
}

// ── Booking confirmation ─────────────────────────────────────────────────────

/**
 * Fire-and-forget after a successful booking. Fetches the appointment + tenant
 * name, checks opt-out, sends the configured template, then stamps sentAt.
 * Safe to call without await from routes.
 */
export async function sendBookingConfirmation(appointmentId: string): Promise<void> {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { tenant: { select: { companyName: true } } },
  });
  if (!appointment?.customerPhone) return;
  // Skip demo appointments — don't text real numbers booked during a sales demo.
  if (appointment.demoSessionId) return;
  if (appointment.confirmationSentAt) return;

  const settings = await prisma.agentSettings.findUnique({
    where: { tenantId: appointment.tenantId },
    select: { smsEnabled: true, smsConfirmation: true, smsConfirmationTemplate: true },
  });
  if (!settings?.smsEnabled || !settings.smsConfirmation) return;
  if (!isSmsAvailable()) return;
  if (await isOptedOut(appointment.customerPhone, appointment.tenantId)) return;

  const local = utcToZonedParts(appointment.startsAt, appointment.timezone);
  const dayLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: appointment.timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(appointment.startsAt);

  const body = interpolate(settings.smsConfirmationTemplate ?? DEFAULT_CONFIRMATION_TEMPLATE, {
    customerName: appointment.customerName,
    businessName: appointment.tenant.companyName,
    date: dayLabel,
    time: to12h(local.time),
  });

  await sendRaw(appointment.customerPhone, body);
  await prisma.appointment.update({
    where: { id: appointmentId },
    data: { confirmationSentAt: new Date() },
  });
}

// ── Reminder sends (called from the cron job) ────────────────────────────────

export type ReminderType = '24h' | '1h';

/**
 * Send a single reminder for an appointment. Called per-appointment from the
 * cron job; stamps the sent timestamp so it's never resent.
 */
export async function sendReminder(appointmentId: string, type: ReminderType): Promise<void> {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { tenant: { select: { companyName: true } } },
  });
  if (!appointment?.customerPhone) return;
  if (appointment.demoSessionId) return;
  if (appointment.status !== 'CONFIRMED') return;

  // Double-check the sent flag in case two cron ticks race.
  const alreadySent =
    type === '24h' ? appointment.reminder24hSentAt : appointment.reminder1hSentAt;
  if (alreadySent) return;

  const settings = await prisma.agentSettings.findUnique({
    where: { tenantId: appointment.tenantId },
    select: {
      smsEnabled: true,
      smsReminder24h: true,
      smsReminder1h: true,
      smsReminder24hTemplate: true,
      smsReminder1hTemplate: true,
    },
  });
  if (!settings?.smsEnabled) return;
  if (type === '24h' && !settings.smsReminder24h) return;
  if (type === '1h' && !settings.smsReminder1h) return;
  if (!isSmsAvailable()) return;
  if (await isOptedOut(appointment.customerPhone, appointment.tenantId)) return;

  const local = utcToZonedParts(appointment.startsAt, appointment.timezone);

  const templateSrc =
    type === '24h'
      ? (settings.smsReminder24hTemplate ?? DEFAULT_REMINDER_24H_TEMPLATE)
      : (settings.smsReminder1hTemplate ?? DEFAULT_REMINDER_1H_TEMPLATE);

  const body = interpolate(templateSrc, {
    customerName: appointment.customerName,
    businessName: appointment.tenant.companyName,
    time: to12h(local.time),
  });

  await sendRaw(appointment.customerPhone, body);
  await prisma.appointment.update({
    where: { id: appointmentId },
    data: type === '24h' ? { reminder24hSentAt: new Date() } : { reminder1hSentAt: new Date() },
  });
}

// ── Waitlist opening ─────────────────────────────────────────────────────────

export interface WaitlistOpeningParams {
  tenantId: string;
  phone: string;
  customerName: string;
  businessName: string;
  /** Pre-formatted, in the tenant's locale: long date + 12h time. */
  date: string;
  time: string;
  /** Tenant override, or null to use the platform default. */
  template: string | null;
}

/**
 * Text a waitlisted customer that a slot has opened. Returns true if a message
 * was actually sent (Twilio configured + not opted out), false otherwise — so
 * the caller only flips the entry to NOTIFIED when the text really went out.
 */
export async function sendWaitlistOpening(params: WaitlistOpeningParams): Promise<boolean> {
  if (!isSmsAvailable()) return false;
  if (await isOptedOut(params.phone, params.tenantId)) return false;

  const body = interpolate(params.template ?? DEFAULT_WAITLIST_TEMPLATE, {
    customerName: params.customerName,
    businessName: params.businessName,
    date: params.date,
    time: params.time,
  });

  await sendRaw(params.phone, body);
  return true;
}

// ── Reactivation / recall ────────────────────────────────────────────────────

export interface ReactivationParams {
  tenantId: string;
  phone: string;
  customerName: string;
  businessName: string;
  /** Tenant override, or null to use the platform default. */
  template: string | null;
}

/**
 * Text a lapsed customer an invitation to rebook. Returns true if a message was
 * actually sent (Twilio configured + not opted out), false otherwise — so the
 * caller only records the send when the text really went out.
 */
export async function sendReactivation(params: ReactivationParams): Promise<boolean> {
  if (!isSmsAvailable()) return false;
  if (await isOptedOut(params.phone, params.tenantId)) return false;

  const body = interpolate(params.template ?? DEFAULT_REACTIVATION_TEMPLATE, {
    customerName: params.customerName,
    businessName: params.businessName,
  });

  await sendRaw(params.phone, body);
  return true;
}
