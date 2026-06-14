import type { Industry } from '@/lib/api';

const TIPS: Record<Industry, Record<'PROFILE' | 'PROMPT' | 'VOICE_TEST', { title: string; body: string }>> = {
  CLINIC: {
    PROFILE: {
      title: 'Set hours patients can trust',
      body: 'After-hours callers are told the clinic is closed and offered voicemail — so accurate hours mean fewer confused patients and cleaner messages.',
    },
    PROMPT: {
      title: 'Triage language matters',
      body: 'The medical template directs emergencies to 911 and never gives medical advice. Keep those guardrails if you customize — they protect patients and the practice.',
    },
    VOICE_TEST: {
      title: 'Try a realistic call',
      body: 'Ask to book an appointment, then try describing chest pain — you should hear the receptionist switch to the emergency protocol immediately.',
    },
  },
  CONSTRUCTION: {
    PROFILE: {
      title: 'Hours drive routing',
      body: 'During open hours, the receptionist can transfer urgent calls to your lines. After hours, it captures detailed messages so leads never go cold.',
    },
    PROMPT: {
      title: 'Capture bids completely',
      body: 'The contractor template collects scope, address, timeline, and budget on every lead call. Add your service area or specialties to qualify leads even better.',
    },
    VOICE_TEST: {
      title: 'Test a lead call',
      body: 'Pretend to be a homeowner asking about a kitchen remodel — check that the receptionist captures your callback number and reads it back correctly.',
    },
  },
};

export function TipCard({ industry, step }: { industry: Industry; step: 'PROFILE' | 'PROMPT' | 'VOICE_TEST' }) {
  const tip = TIPS[industry][step];
  return (
    <aside className="rounded-2xl border border-signal/20 bg-signal-soft/60 p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-signal-deep">Tip</p>
      <p className="mt-1.5 font-display text-sm font-semibold text-ink">{tip.title}</p>
      <p className="mt-1 text-sm leading-relaxed text-ink-muted">{tip.body}</p>
    </aside>
  );
}
