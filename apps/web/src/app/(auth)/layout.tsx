'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { RedirectIfAuthed } from '@/lib/auth-context';
import { Logo } from '@/components/ui/Logo';
import { Waveform } from '@/components/ui/Waveform';

const VALUE_PROPS = [
  { title: 'Every call answered', body: 'Nights, weekends, lunch rushes — your line never rings out.' },
  { title: 'Smart transfers', body: 'Urgent callers reach a human; everything else is handled or logged.' },
  { title: 'Built for your industry', body: 'Clinic triage protocols or contractor bid capture, out of the box.' },
];

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <RedirectIfAuthed>
      <div className="grid min-h-screen lg:grid-cols-[5fr_6fr]">
        {/* Brand panel */}
        <aside className="relative hidden flex-col justify-between overflow-hidden bg-ink p-10 lg:flex">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-32 -top-32 h-96 w-96 rounded-full bg-signal/20 blur-3xl"
          />
          <Link href="/" aria-label="VoiceFront home" className="relative w-fit">
            <Logo tone="light" />
          </Link>
          <div className="relative">
            <Waveform bars={36} active tone="light" className="mb-8 h-16 justify-start opacity-80" />
            <h1 className="max-w-md font-display text-4xl font-semibold leading-tight text-white">
              The receptionist who never misses a call.
            </h1>
            <ul className="mt-8 flex max-w-md flex-col gap-5">
              {VALUE_PROPS.map((prop) => (
                <li key={prop.title} className="flex gap-3">
                  <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-signal" />
                  <div>
                    <p className="font-medium text-white">{prop.title}</p>
                    <p className="text-sm text-white/60">{prop.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <p className="relative text-xs text-white/40">VoiceFront · AI reception for clinics &amp; contractors</p>
        </aside>

        {/* Form column */}
        <main className="flex items-center justify-center px-6 py-12">
          <div className="w-full max-w-md animate-fade-up">
            <div className="mb-8 lg:hidden">
              <Link href="/" aria-label="VoiceFront home" className="w-fit">
                <Logo />
              </Link>
            </div>
            {children}
          </div>
        </main>
      </div>
    </RedirectIfAuthed>
  );
}
