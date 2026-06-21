import type { Metadata } from 'next';
import { LiveDemoSection, FinalCtaSection } from '@/components/marketing/sections';

export const metadata: Metadata = {
  title: 'Live demo — Talk to the AI receptionist right now',
  description:
    'Talk to VoiceFront live in your browser. Ask it to book an appointment, try to double-book it, and watch the calendar fill in real time.',
};

export default function DemoPage() {
  return (
    <>
      <LiveDemoSection />
      <FinalCtaSection />
    </>
  );
}
