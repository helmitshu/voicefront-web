import { HttpError } from '../lib/http';
import { getSettingValue } from './platform-config.service';

/**
 * Thin Resend wrapper for outreach email. The API key, from-email and from-name
 * are all operator-editable platform settings, so the founder can swap the
 * sending identity at any time with no redeploy.
 *
 * Testing note: with no verified domain, Resend only delivers from
 * `onboarding@resend.dev` to your own Resend signup email. Sending to a real
 * list requires verifying a domain — Resend's own error is surfaced verbatim so
 * that restriction is obvious when it bites.
 */

export async function sendOutreachEmail(params: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<void> {
  const [apiKey, fromEmail, fromName] = await Promise.all([
    getSettingValue('RESEND_API_KEY'),
    getSettingValue('OUTREACH_FROM_EMAIL'),
    getSettingValue('OUTREACH_FROM_NAME'),
  ]);
  if (!apiKey || !fromEmail) {
    throw new HttpError(
      400,
      'Add a Resend API key and a “from” email under Keys & config before sending.',
      'MAILER_NOT_CONFIGURED',
    );
  }
  const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [params.to], subject: params.subject, html: params.html, text: params.text }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new HttpError(
      502,
      `Email provider rejected the send (${res.status}). ${detail.slice(0, 300)}`,
      'MAILER_ERROR',
    );
  }
}
