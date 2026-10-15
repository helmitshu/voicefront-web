import type { Metadata } from 'next';
import {
  HeroSection,
  SocialProofSection,
  StatBandSection,
  BeyondAnsweringSection,
  PricingStripSection,
  FinalCtaSection,
} from '@/components/marketing/sections';

export const metadata: Metadata = {
  title: { absolute: 'VoiceFront: The AI receptionist for dental clinics that answers every call' },
  description:
    'VoiceFront is an AI receptionist built for dental clinics. She answers every call in about a second and books patients into your VoiceFront calendar, 24/7. Hear the live demo, then start a 7-day free trial.',
};

export default function HomePage() {
  return (
    <>
      <HeroSection />
      <SocialProofSection />
      <StatBandSection />
      <BeyondAnsweringSection />
      <PricingStripSection />
      <FinalCtaSection />
    </>
  );
}
