import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import twilio from 'twilio';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { getSettingValue } from './platform-config.service';
import { sendEmergencyJobAlert } from './sms.service';
import {
  nextDispatchAction,
  parseOnCallRoster,
  type DispatchEvent,
  type OnCallContact,
} from '../domain/dispatch';

/**
 * On-call dispatch runtime. Given an emergency job, it rings the tenant's
 * on-call roster in order over Twilio voice, escalating to the next person when
 * one doesn't accept, until someone takes it (the customer is texted "help is on
 * the way") or the list is exhausted (the owner gets a final alert). The pure
 * escalation rule lives in domain/dispatch; this layer is the side effects.
 *
 * Gating happens upstream (job.service only calls startDispatch when the
 * ON_CALL_DISPATCH feature is effective). If we can't actually ring anyone —
 * no roster, no Twilio, no public URL — we fall back to the owner SMS alert so
 * an emergency is never silently dropped.
 */

function twilioClient() {
  if (!isDispatchVoiceAvailable()) return null;
  return twilio(env.TWILIO_ACCOUNT_SID!, env.TWILIO_AUTH_TOKEN!);
}

export function isDispatchVoiceAvailable(): boolean {
  return !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER);
}

async function publicBase(): Promise<string | null> {
  const url = await getSettingValue('PUBLIC_API_URL');
  return url ? url.replace(/\/$/, '') : null;
}

function legUrl(
  base: string,
  leg: 'twiml' | 'accept' | 'status',
  dispatchId: string,
  index: number,
  token: string,
): string {
  return `${base}/api/dispatch/${leg}/${dispatchId}/${index}?token=${token}`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === "'" ? '&apos;' : '&quot;',
  );
}

/** Constant-time token check guarding the public Twilio webhooks. */
function tokenOk(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(provided).digest();
  return timingSafeEqual(a, b);
}

type DispatchWithJob = Prisma.DispatchGetPayload<{
  include: { job: { include: { tenant: { select: { companyName: true } } } } };
}>;

function loadDispatch(id: string): Promise<DispatchWithJob | null> {
  return prisma.dispatch.findUnique({
    where: { id },
    include: { job: { include: { tenant: { select: { companyName: true } } } } },
  });
}

function roster(d: DispatchWithJob): OnCallContact[] {
  return Array.isArray(d.roster) ? (d.roster as unknown as OnCallContact[]) : [];
}

/**
 * Entry point: kick off dispatch for an emergency job, or fall back to the
 * owner SMS alert when we can't ring a roster.
 */
export async function startDispatch(jobId: string): Promise<void> {
  const job = await prisma.jobRequest.findUnique({ where: { id: jobId } });
  if (!job || job.demoSessionId) return;

  const settings = await prisma.agentSettings.findUnique({
    where: { tenantId: job.tenantId },
    select: { onCallRoster: true, dispatchEscalationSeconds: true },
  });
  const contacts = parseOnCallRoster(settings?.onCallRoster);
  const base = await publicBase();

  if (contacts.length === 0 || !isDispatchVoiceAvailable() || !base) {
    await sendEmergencyJobAlert(jobId).catch(() => {});
    return;
  }

  const dispatch = await prisma.dispatch.create({
    data: {
      tenantId: job.tenantId,
      jobRequestId: job.id,
      roster: contacts as unknown as Prisma.InputJsonValue,
      token: randomBytes(16).toString('hex'),
      escalateAfterSec: settings?.dispatchEscalationSeconds ?? 120,
      currentIndex: 0,
    },
  });
  await callContact(dispatch.id, 0);
}

/** Ring one roster contact (records the attempt, places the Twilio call). */
async function callContact(dispatchId: string, index: number): Promise<void> {
  const dispatch = await loadDispatch(dispatchId);
  if (!dispatch || dispatch.status !== 'NOTIFYING') return;
  const contact = roster(dispatch)[index];
  if (!contact) {
    await markExhausted(dispatchId);
    return;
  }
  const client = twilioClient();
  const base = await publicBase();
  if (!client || !base) return;

  await prisma.dispatch.update({ where: { id: dispatchId }, data: { currentIndex: index } });
  await prisma.dispatchAttempt.upsert({
    where: { dispatchId_index: { dispatchId, index } },
    create: { dispatchId, index, contactName: contact.name, contactPhone: contact.phone, status: 'CALLING' },
    update: { status: 'CALLING' },
  });

  try {
    const call = await client.calls.create({
      to: contact.phone,
      from: env.TWILIO_FROM_NUMBER!,
      url: legUrl(base, 'twiml', dispatchId, index, dispatch.token),
      statusCallback: legUrl(base, 'status', dispatchId, index, dispatch.token),
      statusCallbackEvent: ['completed', 'no-answer', 'busy', 'failed'],
      timeout: 25,
    });
    await prisma.dispatchAttempt.update({
      where: { dispatchId_index: { dispatchId, index } },
      data: { callSid: call.sid },
    });
  } catch {
    // Couldn't place the call — treat as a miss and escalate immediately.
    await handleEvent(dispatchId, index, 'failed');
  }
}

/**
 * Feed an event for a specific attempt into the state machine and act on the
 * decision. Stale events (for a contact we've already moved past) are ignored.
 */
async function handleEvent(dispatchId: string, index: number, event: DispatchEvent): Promise<void> {
  const dispatch = await loadDispatch(dispatchId);
  if (!dispatch) return;
  // Only the currently-ringing contact can move the dispatch — guards against
  // a late callback from an earlier leg double-escalating.
  if (index !== dispatch.currentIndex) return;

  const action = nextDispatchAction(
    { status: dispatch.status, currentIndex: dispatch.currentIndex, rosterLength: roster(dispatch).length },
    event,
  );
  if (action.type === 'noop') return;

  if (action.type === 'accept') {
    const contact = roster(dispatch)[index];
    await prisma.dispatch.update({
      where: { id: dispatchId },
      data: { status: 'ACCEPTED', acceptedName: contact?.name ?? null, acceptedPhone: contact?.phone ?? null },
    });
    await setAttempt(dispatchId, index, 'ACCEPTED');
    await notifyCustomerAccepted(dispatch, contact);
    return;
  }

  await setAttempt(dispatchId, index, event === 'declined' ? 'DECLINED' : event === 'failed' ? 'FAILED' : 'NO_ANSWER');
  if (action.type === 'call') await callContact(dispatchId, action.index);
  else if (action.type === 'exhaust') await markExhausted(dispatchId);
}

async function setAttempt(
  dispatchId: string,
  index: number,
  status: 'NO_ANSWER' | 'DECLINED' | 'ACCEPTED' | 'FAILED',
): Promise<void> {
  await prisma.dispatchAttempt
    .update({ where: { dispatchId_index: { dispatchId, index } }, data: { status } })
    .catch(() => {});
}

async function markExhausted(dispatchId: string): Promise<void> {
  const d = await prisma.dispatch.findUnique({ where: { id: dispatchId } });
  if (!d || d.status !== 'NOTIFYING') return;
  await prisma.dispatch.update({ where: { id: dispatchId }, data: { status: 'EXHAUSTED' } });
  // Final safety net: the existing owner emergency SMS so it's never dropped.
  await sendEmergencyJobAlert(d.jobRequestId).catch(() => {});
}

/** Text the caller that a tech accepted and is on the way. */
async function notifyCustomerAccepted(dispatch: DispatchWithJob, contact: OnCallContact | undefined): Promise<void> {
  const client = twilioClient();
  const to = dispatch.job.customerPhone;
  if (!client || !to) return;
  const who = contact?.name && contact.name !== 'On-call tech' ? contact.name : 'Our on-call tech';
  try {
    await client.messages.create({
      from: env.TWILIO_FROM_NUMBER!,
      to,
      body: `${dispatch.job.tenant.companyName}: ${who} has your emergency and will call you shortly. Help is on the way.`,
    });
  } catch {
    /* best-effort */
  }
}

// ── Public webhook handlers (called by routes; Twilio drives these) ──────────

/** TwiML for the ringing leg: read the job, gather "1 to accept". */
export async function getRingTwiml(dispatchId: string, index: number, token: string | undefined): Promise<string> {
  const dispatch = await loadDispatch(dispatchId);
  const base = await publicBase();
  if (!dispatch || !base || !tokenOk(dispatch.token, token)) {
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;
  }
  const job = dispatch.job;
  const detail = `Emergency from ${job.customerName}. ${job.jobType ?? 'Service request'}${
    job.serviceAddress ? ` at ${job.serviceAddress}` : ''
  }.`;
  const acceptUrl = legUrl(base, 'accept', dispatchId, index, dispatch.token);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<Response>`,
    `<Gather numDigits="1" action="${escapeXml(acceptUrl)}" method="POST" timeout="12">`,
    `<Say voice="Polly.Matthew">${escapeXml(detail)} Press 1 to accept this job, or hang up to pass it on.</Say>`,
    `</Gather>`,
    `<Say voice="Polly.Matthew">No response received. Goodbye.</Say>`,
    `</Response>`,
  ].join('');
}

/** The contact pressed a key — accept on "1", otherwise pass. */
export async function handleAccept(
  dispatchId: string,
  index: number,
  token: string | undefined,
  digits: string | undefined,
): Promise<string> {
  const dispatch = await loadDispatch(dispatchId);
  if (!dispatch || !tokenOk(dispatch.token, token)) {
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;
  }
  if (digits === '1') {
    await handleEvent(dispatchId, index, 'accepted');
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Matthew">Thanks. We'll let the customer know you're on the way. Goodbye.</Say></Response>`;
  }
  await handleEvent(dispatchId, index, 'declined');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Matthew">Okay, passing this along. Goodbye.</Say></Response>`;
}

/** Twilio call-status callback — escalate on a missed/ended-without-accept call. */
export async function handleStatusCallback(
  dispatchId: string,
  index: number,
  token: string | undefined,
  callStatus: string | undefined,
): Promise<void> {
  const dispatch = await loadDispatch(dispatchId);
  if (!dispatch || !tokenOk(dispatch.token, token)) return;
  // 'completed' fires after every answered call; if the dispatch is still
  // NOTIFYING at this index, nobody pressed 1, so it's a miss. Accept/decline
  // were already handled on the accept leg (which flips status), making this a
  // no-op via the state machine.
  const event: DispatchEvent =
    callStatus === 'no-answer' ? 'no_answer' : callStatus === 'completed' ? 'no_answer' : 'failed';
  await handleEvent(dispatchId, index, event);
}

/**
 * Safety sweep (cron): escalate dispatches stuck NOTIFYING past their timeout,
 * in case a Twilio callback was lost. Idempotent via the current-index guard.
 */
export async function sweepStaleDispatches(now: Date = new Date()): Promise<void> {
  const stuck = await prisma.dispatch.findMany({
    where: { status: 'NOTIFYING' },
    select: { id: true, currentIndex: true, escalateAfterSec: true, updatedAt: true },
  });
  for (const d of stuck) {
    const ageSec = (now.getTime() - d.updatedAt.getTime()) / 1000;
    // Pad past the call timeout so we only fire when a callback was truly missed.
    if (ageSec > d.escalateAfterSec + 30) {
      await handleEvent(d.id, d.currentIndex, 'timeout').catch(() => {});
    }
  }
}
