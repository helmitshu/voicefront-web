import type { Metadata } from 'next';
import { BookSection } from '@/components/marketing/sections';

export const metadata: Metadata = {
  title: 'Book a call — Talk to a human',
  description:
    'Prefer a real conversation? Pick a time on our calendar and we’ll walk you through exactly how VoiceFront would fit your business. No account needed.',
};

export default function BookPage() {
  return <BookSection />;
}
