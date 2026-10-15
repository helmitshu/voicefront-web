import type { Metadata } from 'next';
import {
  HeroSection,
  SocialProofSection,
  StatBandSection,
  BeyondAnsweringSection,
  PricingStripSection,
  FinalCtaSection,
} from '@/components/marketing/sections';
import { getPricingCurrency } from '@/lib/visitor-country';

export const metadata: Metadata = {
  title: { absolute: 'VoiceFront: The AI receptionist for dental clinics that answers every call' },
  description:
    'VoiceFront is an AI receptionist built for dental clinics. She answers every call in about a second and books patients into your VoiceFront calendar, 24/7. Hear the live demo, then start a 7-day free trial.',
};

// The pricing strip is priced per visitor (CAD for Canadian visitors,
// USD for everyone else), so this page renders per request.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const currency = await getPricingCurrency();
  return (
    <>
      <HeroSection />
      <SocialProofSection />
      <StatBandSection />
      <BeyondAnsweringSection />
      <PricingStripSection currency={currency} />
      <FinalCtaSection />
    </>
  );
}
