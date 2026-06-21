import type { Lead } from '@prisma/client';
import { corsOrigins } from '../config/env';

/**
 * Builds the personalized cold-outreach email for a lead. The hook is a
 * "missed-money" card computed for that lead's trade — the calculator's *answer*
 * baked straight into the email, so the prospect never has to click to do math.
 * Plus a Book-a-demo button and a "hear it live" link to a tailored demo.
 *
 * Emails can't run JavaScript, so this is static, email-safe HTML (inline
 * styles, table layout) with a plain-text fallback. CAN-SPAM footer included;
 * the physical address must be set before sending for real.
 */

const WEB_APP_URL = corsOrigins[0] ?? 'http://localhost:3000';

interface RoiAssumptions {
  missedPerWeek: number;
  avgJobValue: number;
  closeRate: number;
}

// Conservative, transparent per-trade defaults — shown in the email on purpose,
// so the prospect can push back ("we miss way more than that") — and that
// pushback is a reply, which is a warm lead.
const TRADE_ROI: Record<string, RoiAssumptions> = {
  hvac: { missedPerWeek: 10, avgJobValue: 2500, closeRate: 0.25 },
  roofing: { missedPerWeek: 8, avgJobValue: 9000, closeRate: 0.15 },
  plumbing: { missedPerWeek: 12, avgJobValue: 600, closeRate: 0.3 },
  electrician: { missedPerWeek: 10, avgJobValue: 800, closeRate: 0.3 },
  electrical: { missedPerWeek: 10, avgJobValue: 800, closeRate: 0.3 },
  restoration: { missedPerWeek: 8, avgJobValue: 4000, closeRate: 0.3 },
  remodeling: { missedPerWeek: 6, avgJobValue: 12000, closeRate: 0.12 },
  landscaping: { missedPerWeek: 8, avgJobValue: 1200, closeRate: 0.25 },
};
const DEFAULT_ROI: RoiAssumptions = { missedPerWeek: 8, avgJobValue: 1500, closeRate: 0.25 };

function roiFor(trade: string) {
  const key = trade.toLowerCase().replace(/[^a-z]/g, '');
  const match =
    TRADE_ROI[key] ?? Object.entries(TRADE_ROI).find(([k]) => key.includes(k))?.[1] ?? DEFAULT_ROI;
  const jobsPerMonth = match.missedPerWeek * 4.33 * match.closeRate;
  // Round the headline to the nearest $100 so it reads like an estimate, not a
  // false-precision claim.
  const monthly = Math.round((jobsPerMonth * match.avgJobValue) / 100) * 100;
  return { ...match, monthly, yearly: monthly * 12, jobsPerMonth: Math.round(jobsPerMonth) };
}

const money = (n: number) => `$${n.toLocaleString('en-US')}`;
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface OutreachEmail {
  subject: string;
  html: string;
  text: string;
}

export function buildOutreachEmail(
  lead: Pick<Lead, 'id' | 'businessName' | 'trade' | 'city'>,
  options: { physicalAddress?: string } = {},
): OutreachEmail {
  const biz = lead.businessName;
  const trade = lead.trade;
  const address = options.physicalAddress?.trim() || '[Your mailing address here]';
  const roi = roiFor(trade);
  const isHvac = /hvac|air|cooling|ac\b/i.test(trade);

  const demoUrl = `${WEB_APP_URL}/demo?biz=${encodeURIComponent(biz)}&industry=contractor&ref=${lead.id}`;
  const bookUrl = `${WEB_APP_URL}/book?ref=${lead.id}`;
  const unsubUrl = `${WEB_APP_URL}/unsubscribe?lead=${lead.id}`;

  const subject = `Missed calls are costing ${biz} more than you think`;

  const painLine = isHvac
    ? `When it's 110° out and someone's AC just died, they call the first ${trade} shop that picks up — and the second one if you don't.`
    : `When a ${trade.toLowerCase()} job comes up, the homeowner calls down the list — and stops at whoever answers.`;

  const assumptionLine = `Based on missing ~${roi.missedPerWeek} calls a week, ~${Math.round(
    roi.closeRate * 100,
  )}% of them being real jobs, at a ${money(roi.avgJobValue)} average ticket. Your numbers are probably different — that's the point of a quick chat.`;

  // ---- HTML (email-safe: inline styles, table layout) ----
  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F6F7F3;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1E2421;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F7F3;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #E4E7E2;border-radius:16px;overflow:hidden;">
        <tr><td style="padding:28px 32px 8px;">
          <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#1E2421;">Hi ${esc(biz)} team,</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#1E2421;">${esc(painLine)}</p>
          <p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#1E2421;">Here's roughly what that adds up to for a shop your size:</p>
        </td></tr>

        <!-- missed-money card -->
        <tr><td style="padding:4px 32px 8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#D9EEEA;border:1px solid rgba(14,107,99,0.2);border-radius:14px;">
            <tr><td style="padding:22px 24px;">
              <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#0A574F;">Revenue walking out the door</p>
              <p style="margin:6px 0 0;font-size:40px;font-weight:800;line-height:1.05;color:#1E2421;">${money(
                roi.monthly,
              )}<span style="font-size:17px;font-weight:600;color:#66706B;">/month</span></p>
              <p style="margin:8px 0 0;font-size:14px;line-height:1.5;color:#2C332E;">That's about <strong>${money(
                roi.yearly,
              )} a year</strong> — roughly ${roi.jobsPerMonth} job${
                roi.jobsPerMonth === 1 ? '' : 's'
              } a month going to whoever picked up instead of you.</p>
            </td></tr>
          </table>
          <p style="margin:8px 2px 0;font-size:11.5px;line-height:1.5;color:#66706B;">${esc(assumptionLine)}</p>
        </td></tr>

        <tr><td style="padding:12px 32px 4px;">
          <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#1E2421;">VoiceFront is an AI receptionist that answers every one of those calls — 24/7, in a voice your customers can't tell from a person — and books the job straight into your calendar before they hang up.</p>
        </td></tr>

        <!-- CTA button -->
        <tr><td style="padding:4px 32px 8px;" align="center">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:999px;background:#0E6B63;">
            <a href="${bookUrl}" style="display:inline-block;padding:14px 30px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:999px;">Book a 15-minute demo →</a>
          </td></tr></table>
          <p style="margin:14px 0 0;font-size:13px;color:#66706B;">or <a href="${demoUrl}" style="color:#0A574F;font-weight:600;">hear it answer a call yourself</a> — set up for ${esc(
            biz,
          )}.</p>
        </td></tr>

        <tr><td style="padding:18px 32px 26px;">
          <p style="margin:0;font-size:14px;line-height:1.6;color:#1E2421;">Worth a look?</p>
        </td></tr>

        <!-- footer / CAN-SPAM -->
        <tr><td style="padding:16px 32px 24px;border-top:1px solid #E4E7E2;">
          <p style="margin:0;font-size:11px;line-height:1.6;color:#66706B;">${esc(address)}<br>
          You're receiving this because you run a ${esc(trade)} business in ${esc(
            lead.city,
          )}. <a href="${unsubUrl}" style="color:#66706B;">Unsubscribe</a> and I won't email again.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  // ---- Plain-text fallback ----
  const text = [
    `Hi ${biz} team,`,
    '',
    painLine,
    '',
    `Here's roughly what that adds up to for a shop your size:`,
    `~${money(roi.monthly)}/month — about ${money(roi.yearly)} a year, or ${roi.jobsPerMonth} job${
      roi.jobsPerMonth === 1 ? '' : 's'
    } a month going to whoever picked up instead of you.`,
    `(${assumptionLine})`,
    '',
    `VoiceFront is an AI receptionist that answers every one of those calls 24/7 — in a voice your customers can't tell from a person — and books the job into your calendar before they hang up.`,
    '',
    `Book a 15-minute demo: ${bookUrl}`,
    `Or hear it answer a call yourself (set up for ${biz}): ${demoUrl}`,
    '',
    `Worth a look?`,
    '',
    `—`,
    address,
    `You're receiving this because you run a ${trade} business in ${lead.city}. Unsubscribe: ${unsubUrl}`,
  ].join('\n');

  return { subject, html, text };
}
