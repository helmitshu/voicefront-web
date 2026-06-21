'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { PublicApi } from '@/lib/api';
import { Logo } from '@/components/ui/Logo';
import { Spinner } from '@/components/ui/Spinner';

type State = 'working' | 'done' | 'error' | 'missing';

export default function UnsubscribePage() {
  const [state, setState] = useState<State>('working');

  useEffect(() => {
    const leadId = new URLSearchParams(window.location.search).get('lead');
    if (!leadId) {
      setState('missing');
      return;
    }
    PublicApi.unsubscribe(leadId)
      .then(() => setState('done'))
      .catch(() => setState('error'));
  }, []);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-paper px-6 text-center">
      <Link href="/" aria-label="VoiceFront home" className="mb-8">
        <Logo />
      </Link>
      <div className="w-full max-w-md rounded-3xl border border-line/70 bg-white p-8 shadow-card">
        {state === 'working' && (
          <div className="flex flex-col items-center gap-4">
            <Spinner className="h-6 w-6 text-signal" />
            <p className="text-sm text-ink-muted">Updating your preferences…</p>
          </div>
        )}

        {state === 'done' && (
          <>
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-clinic-soft text-[#0b8a74]">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
                <path d="M3 8.5 6.5 12 13 4.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <h1 className="mt-4 font-display text-xl font-semibold tracking-tight text-ink">You’re unsubscribed</h1>
            <p className="mt-2 text-sm leading-relaxed text-ink-muted">
              You won’t receive any more emails from us. Sorry for the interruption — and if you ever change
              your mind, you know where to find us.
            </p>
          </>
        )}

        {state === 'missing' && (
          <>
            <h1 className="font-display text-xl font-semibold tracking-tight text-ink">Nothing to unsubscribe</h1>
            <p className="mt-2 text-sm leading-relaxed text-ink-muted">
              This link is missing its reference. If you’re still getting emails you don’t want, reply to one
              and we’ll remove you right away.
            </p>
          </>
        )}

        {state === 'error' && (
          <>
            <h1 className="font-display text-xl font-semibold tracking-tight text-ink">Hmm, that didn’t work</h1>
            <p className="mt-2 text-sm leading-relaxed text-ink-muted">
              We couldn’t process the request just now. Please try again, or reply to any email and we’ll take
              you off the list manually.
            </p>
          </>
        )}

        <Link
          href="/"
          className="mt-6 inline-block rounded-full border border-line bg-white px-5 py-2.5 text-sm font-semibold text-ink shadow-input transition-colors hover:border-ink-muted/40"
        >
          Back to VoiceFront
        </Link>
      </div>
    </main>
  );
}
