import type { CallStatus } from '@prisma/client';

/** Maps the provider's free-form endedReason onto tenant-friendly statuses. */
export function deriveCallStatus(endedReason: string | null | undefined): CallStatus {
  if (!endedReason) return 'UNKNOWN';
  const reason = endedReason.toLowerCase();
  if (reason.includes('forward') || reason.includes('transfer')) return 'FORWARDED';
  if (reason.includes('voicemail')) return 'VOICEMAIL';
  if (
    reason.includes('error') ||
    reason.includes('failed') ||
    reason.includes('did-not-connect') ||
    reason.includes('no-answer')
  ) {
    return 'FAILED';
  }
  if (
    reason.includes('customer-ended-call') ||
    reason.includes('assistant-ended-call') ||
    reason.includes('silence') ||
    reason.includes('max-duration') ||
    reason.includes('hangup') ||
    reason.includes('ended')
  ) {
    return 'COMPLETED';
  }
  return 'UNKNOWN';
}
