import type { Metadata } from 'next';
import {
  HeroSection,
  SocialProofSection,
  StatBandSection,
  BeyondAnsweringSection,
  FinalCtaSection,
} from '@/components/marketing/sections';

export const metadata: Metadata = {
  title: { absolute: 'VoiceFront — The AI receptionist that answers every call and books appointments' },
  description:
    'VoiceFront answers every call in a voice your customers can’t tell from a person, then books the appointment straight into your calendar. 24/7. No hold music, no missed revenue.',
};

export default function HomePage() {
  return (
    <>
      <HeroSection />
      <SocialProofSection />
      <StatBandSection />
      <BeyondAnsweringSection />
      <FinalCtaSection />
    </>
  );
}
