import type { Metadata } from 'next';
import { BookSection } from '@/components/marketing/sections';

export const metadata: Metadata = {
  title: 'White glove setup, done for you',
  description:
    'Book a white glove setup call and a human will configure VoiceFront for your clinic. White glove setup is $500 one time plus your plan, and it covers your receptionist, your hours and your booking rules.',
};

export default function BookPage() {
  return <BookSection />;
}
