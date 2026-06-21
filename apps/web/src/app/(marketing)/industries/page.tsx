import type { Metadata } from 'next';
import { IndustriesSection, FinalCtaSection } from '@/components/marketing/sections';

export const metadata: Metadata = {
  title: 'Industries — Trained for your front desk',
  description:
    'Not a generic chatbot with a phone number. VoiceFront already speaks your industry’s language — clinics, contractors, salons, legal, real estate and more.',
};

export default function IndustriesPage() {
  return (
    <>
      <IndustriesSection />
      <FinalCtaSection />
    </>
  );
}
