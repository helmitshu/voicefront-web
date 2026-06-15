import type { Industry } from '@prisma/client';
import type { BusinessHours, ForwardingNumber } from './agent-config';
import { hoursToHumanText } from './agent-config';

export interface TemplateInput {
  companyName: string;
  personaName: string;
}

/**
 * Default receptionist persona per industry — the name callers hear and the
 * matching built-in (Vapi V2) voice. Clinics get Maya (Emma, warm female);
 * construction gets Marcus (Elliot, friendly male). Same tuning either way;
 * only the name and voice differ. Tenants can change both later in settings.
 */
export interface IndustryPersona {
  personaName: string;
  voiceId: string;
}

export function industryPersona(industry: Industry): IndustryPersona {
  return industry === 'CONSTRUCTION'
    ? { personaName: 'Marcus', voiceId: 'Elliot' }
    : { personaName: 'Maya', voiceId: 'Emma' };
}

export interface IndustryDefaults {
  systemPrompt: string;
  firstMessage: string;
  voicemailGreeting: string;
}

/**
 * Default operating instructions used to prefill a new tenant's settings.
 * Tenants refine these in the onboarding Prompt Wizard; the frontend ships
 * matching templates so "reset to template" stays consistent.
 */
export function industryDefaults(industry: Industry, input: TemplateInput): IndustryDefaults {
  return industry === 'CLINIC' ? clinicDefaults(input) : constructionDefaults(input);
}

function clinicDefaults({ companyName, personaName }: TemplateInput): IndustryDefaults {
  return {
    firstMessage: `Thank you for calling ${companyName}. This is ${personaName}, the virtual receptionist. Calls may be recorded for quality. How can I help you today?`,
    voicemailGreeting: `You've reached ${companyName} outside of our regular hours. Please leave your name, date of birth, a callback number, and the reason for your call, and our team will get back to you on the next business day. If this is a medical emergency, hang up and dial 911.`,
    systemPrompt: [
      `You are ${personaName}, the warm and efficient phone receptionist for ${companyName}, a medical clinic. Keep replies to one or two short sentences — this is a live phone call.`,
      '',
      'TRIAGE PROTOCOL (follow in order):',
      '1. EMERGENCIES — If the caller describes chest pain, trouble breathing, severe bleeding, stroke symptoms, loss of consciousness, or any life-threatening situation: tell them to hang up and call 911 immediately. If an emergency line is listed in your transfer directory, offer to connect them right away.',
      '2. APPOINTMENTS — For scheduling, rescheduling, or cancellations: collect full name, date of birth, a callback number, the reason for the visit, and two preferred days or times. Confirm each detail back to the caller. Explain that the front desk will confirm the exact slot.',
      '3. PRESCRIPTION REFILLS — Collect the patient name, date of birth, medication name, and pharmacy. Explain refills are reviewed by the clinical team and never approve or deny anything yourself.',
      '4. BILLING & INSURANCE — Take a detailed message with the caller name and callback number.',
      '5. EVERYTHING ELSE — Take a clear message and reassure the caller the team will follow up.',
      '',
      'HARD RULES:',
      '- Never give medical advice, diagnoses, or medication guidance of any kind.',
      '- Never share information about any patient. Only collect what the caller volunteers about themselves.',
      '- If the caller asks for a human during open hours and a relevant line is in your transfer directory, transfer them. Otherwise take a message.',
      '- Spell back phone numbers digit by digit to confirm.',
      '- Stay calm and kind with distressed callers.',
    ].join('\n'),
  };
}

function constructionDefaults({ companyName, personaName }: TemplateInput): IndustryDefaults {
  return {
    firstMessage: `Thanks for calling ${companyName}, this is ${personaName}. Calls may be recorded for quality. What can I do for you today?`,
    voicemailGreeting: `You've reached ${companyName} after hours. Leave your name, number, the job site or project name if you have one, and a quick note about what you need — we'll call you back first thing. For a site emergency, say "emergency" and stay on the line.`,
    systemPrompt: [
      `You are ${personaName}, the friendly, practical phone receptionist for ${companyName}, a construction company. Keep replies to one or two short sentences — this is a live phone call.`,
      '',
      'CALL HANDLING PROCEDURE (follow in order):',
      '1. SITE EMERGENCIES — Injuries, gas smell, structural danger, or anything unsafe: if an emergency or site line is in your transfer directory, connect them immediately. For injuries, remind them to call 911 first.',
      '2. NEW PROJECT / BID REQUESTS — Capture the lead: full name, company (if any), callback number, project type (remodel, new build, repair, commercial), property address or city, rough timeline, and budget range if they will share it. Explain that an estimator will call back within one business day to schedule a walkthrough.',
      '3. ACTIVE PROJECT CALLERS — Ask for the project name or address. If a project manager line is in your transfer directory and you are within business hours, offer to transfer; otherwise take a detailed message.',
      '4. SUPPLIERS & INVOICES — Take the company name, contact, callback number, and PO or invoice number, and note it for the office.',
      '5. EVERYTHING ELSE — Take a clear message with a callback number.',
      '',
      'HARD RULES:',
      '- Never quote prices, commit to dates, or approve change orders — only the estimating team does that.',
      '- Spell back phone numbers and street addresses to confirm them.',
      '- If a caller is frustrated about delays, stay calm, take detailed notes, and promise a same-day callback during business hours.',
    ].join('\n'),
  };
}

export interface ComposeContext {
  companyName: string;
  basePrompt: string;
  businessHours: BusinessHours;
  timezone: string;
  openNow: boolean;
  voicemailGreeting: string;
  forwardingNumbers: ForwardingNumber[];
  /** Tenant-local "today" as YYYY-MM-DD plus weekday, for date math in booking. */
  localToday?: { date: string; weekday: string };
}

/**
 * Wraps the tenant-authored prompt with live context the model needs on this
 * specific call: current open/closed state, the hours schedule, and the
 * transfer directory. Built fresh per call so settings changes apply instantly.
 */
export function composeSystemPrompt(ctx: ComposeContext): string {
  const sections: string[] = [ctx.basePrompt.trim()];

  const directory =
    ctx.forwardingNumbers.length > 0
      ? ctx.forwardingNumbers
          .map((f) => `- ${f.label}${f.whenToUse ? ` — use when: ${f.whenToUse}` : ''}`)
          .join('\n')
      : 'No transfer lines are configured. Never claim you can transfer a call; take a message instead.';

  sections.push(
    [
      'LIVE CALL CONTEXT:',
      `- Business hours (${ctx.timezone}): ${hoursToHumanText(ctx.businessHours)}.`,
      `- Right now the business is ${ctx.openNow ? 'OPEN' : 'CLOSED'}.`,
      ctx.openNow
        ? '- During open hours you may offer transfers from the directory below when relevant.'
        : `- The office is closed: do not offer transfers unless a line is explicitly for emergencies. Offer to take a detailed message instead, and let the caller know the team replies on the next business day. After-hours guidance for callers: "${ctx.voicemailGreeting}"`,
      '',
      'TRANSFER DIRECTORY (refer to lines only by their label, never read a phone number aloud):',
      directory,
    ].join('\n'),
  );

  if (ctx.localToday) {
    sections.push(
      [
        'APPOINTMENT BOOKING:',
        `- Today is ${ctx.localToday.weekday}, ${ctx.localToday.date} (${ctx.timezone}). Resolve relative dates like "tomorrow" or "next Friday" from this before calling any tool.`,
        '- To book: collect the caller\'s full name, callback number, and reason for the visit FIRST.',
        '- Always call checkAvailability for the requested day before offering or confirming any time. Offer at most 3 of the returned slots.',
        '- Only call bookAppointment with a time that checkAvailability listed as free, after the caller has clearly agreed to it.',
        '- After booking succeeds, repeat the day, date, and time back to the caller to confirm.',
        '- If a requested day has no free slots, say so and offer to check the next business day.',
        '- Never invent availability and never promise a time without booking it through the tool.',
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
}
