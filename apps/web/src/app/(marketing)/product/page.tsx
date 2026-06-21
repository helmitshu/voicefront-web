import type { Metadata } from 'next';
import {
  HowItWorksSection,
  FeaturesSection,
  BeyondAnsweringSection,
  IntegrationsSection,
  GettingSetUpSection,
  FinalCtaSection,
} from '@/components/marketing/sections';

export const metadata: Metadata = {
  title: 'Product — How VoiceFront handles every call',
  description:
    'See exactly how VoiceFront handles a call end to end: books real appointments, never double-books, transfers when it matters, and answers from your own docs — all on your calendar.',
};

export default function ProductPage() {
  return (
    <>
      <HowItWorksSection />
      <FeaturesSection />
      <BeyondAnsweringSection />
      <IntegrationsSection />
      <GettingSetUpSection />
      <FinalCtaSection />
    </>
  );
}
