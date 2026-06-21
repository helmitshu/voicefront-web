import type { Metadata } from 'next';
import { PricingSection, RoiSection, FaqSection, FinalCtaSection } from '@/components/marketing/sections';

export const metadata: Metadata = {
  title: 'Pricing — Priced around your calls',
  description:
    'VoiceFront is priced around your call volume, not a one-size plan. See what missed calls are costing you with the ROI calculator, then get a custom quote within a day.',
};

export default function PricingPage() {
  return (
    <>
      <PricingSection />
      <RoiSection />
      <FaqSection />
      <FinalCtaSection />
    </>
  );
}
