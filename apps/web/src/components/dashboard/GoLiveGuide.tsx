'use client';

import { useState } from 'react';
import Link from 'next/link';
import { formatPhone } from '@/lib/format';

/**
 * The "you're live, now forward your line" guide. Activation alone doesn't
 * capture a single lead: the owner still has to forward their business number to
 * the VoiceFront number. That real-world step was previously unguided (the dead
 * end). This shows the number live, the exact forwarding action, and a one-tap
 * test call. The dashboard renders it while the line has taken no calls in the
 * last 30 days, so it steps aside on its own once leads are flowing.
 */
export function GoLiveGuide({ number }: { number: string }) {
  const [copied, setCopied] = useState(false);
  const digits = number.replace(/[^\d+]/g, '');

  async function copy() {
    try {
      await navigator.clipboard.writeText(digits);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the number is shown anyway */
    }
  }

  return (
    <div className="animate-fade-up vf-stage-v2 relative overflow-hidden rounded-3xl border border-signal/20 bg-gradient-to-br from-signal-soft/70 to-card p-6 shadow-card md:p-7">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="min-w-0">
          <span className="inline-flex items-center gap-2 rounded-full bg-card/70 px-3 py-1 text-[12px] font-semibold text-signal-deep ring-1 ring-inset ring-signal/15">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute h-full w-full animate-pulse-ring rounded-full bg-signal" />
              <span className="relative h-1.5 w-1.5 rounded-full bg-signal" />
            </span>
            You&apos;re live
          </span>
          <h3 className="mt-3 font-display text-xl font-semibold tracking-tight text-ink">
            Three steps to answering every call
          </h3>
          <p className="mt-1.5 max-w-lg text-sm leading-relaxed text-ink-muted">
            Forward your business line to your VoiceFront number and it starts answering every call. Takes about 10
            seconds, and you can turn it off anytime.
          </p>
        </div>

        <div className="rounded-2xl border border-signal/15 bg-card px-4 py-3 text-center shadow-input">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted/70">Your number</p>
          <p className="mt-1 font-mono text-lg font-semibold tracking-tight text-ink">{formatPhone(number)}</p>
          <button
            type="button"
            onClick={copy}
            className="mt-1.5 text-xs font-medium text-signal-deep transition-colors hover:text-signal"
          >
            {copied ? 'Copied ✓' : 'Copy number'}
          </button>
        </div>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="rounded-2xl border border-line/70 bg-card/80 p-4">
          <p className="text-sm font-semibold text-ink">1 · Your number is live</p>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
            Your receptionist answers on{' '}
            <span className="font-mono font-semibold text-ink">{formatPhone(number)}</span>. Her greeting, hours, and
            voice live in receptionist settings.
          </p>
          <Link
            href="/dashboard/settings"
            className="mt-2 inline-flex items-center gap-1.5 text-[13px] font-semibold text-signal-deep transition-colors hover:text-signal"
          >
            Open receptionist settings →
          </Link>
        </div>
        <div className="rounded-2xl border border-line/70 bg-card/80 p-4">
          <p className="text-sm font-semibold text-ink">2 · Forward your business line</p>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
            From the phone or line you give customers, dial{' '}
            <span className="font-mono font-semibold text-ink">*72</span> then{' '}
            <span className="font-mono font-semibold text-ink">{digits}</span> and press call. (That&apos;s &ldquo;call
            forwarding&rdquo; on most US/Canada carriers. To stop, dial <span className="font-mono">*73</span>.)
          </p>
          <Link
            href="/dashboard/settings"
            className="mt-2 inline-flex items-center gap-1.5 text-[13px] font-semibold text-signal-deep transition-colors hover:text-signal"
          >
            Manage your lines in Settings →
          </Link>
        </div>
        <div className="rounded-2xl border border-line/70 bg-card/80 p-4">
          <p className="text-sm font-semibold text-ink">3 · Hear her answer</p>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
            Call your number from any phone and talk to your receptionist. Your first call shows up right here, live.
          </p>
          <a
            href={`tel:${digits}`}
            className="mt-2 inline-flex items-center gap-1.5 text-[13px] font-semibold text-signal-deep transition-colors hover:text-signal"
          >
            Call {formatPhone(number)} to test →
          </a>
        </div>
      </div>

      <p className="mt-4 text-xs text-ink-muted/80">
        Not sure how to forward on your carrier? Reply to your setup email and we&apos;ll do it with you in 5 minutes.
      </p>
    </div>
  );
}
