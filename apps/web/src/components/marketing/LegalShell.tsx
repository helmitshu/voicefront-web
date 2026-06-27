import type { ReactNode } from 'react';

/**
 * Shared layout for legal pages (Terms, Privacy). Plain, readable prose column.
 * The amber banner is a deliberate reminder that this copy is a starting
 * template and must be reviewed by counsel before it's relied on — remove it
 * once a lawyer has signed off.
 */
export function LegalShell({
  title,
  lastUpdated,
  children,
}: {
  title: string;
  lastUpdated: string;
  children: ReactNode;
}) {
  return (
    <section className="px-6 pb-24">
      <div className="mx-auto max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-signal-deep">Legal</p>
        <h1 className="mt-2 font-display text-4xl font-semibold tracking-tight text-ink">{title}</h1>
        <p className="mt-3 text-sm text-ink-muted">Last updated: {lastUpdated}</p>

        <div className="mt-6 rounded-2xl border border-construction/30 bg-construction-soft/50 px-4 py-3 text-sm text-[#9a6a1d]">
          <strong>Draft template — not yet legal advice.</strong> This document is a starting point and must be
          reviewed by qualified counsel, with every <code>[BRACKETED]</code> value filled in, before you rely on it.
        </div>

        <div className="legal-prose mt-10 flex flex-col gap-6 text-[15px] leading-relaxed text-ink-muted">
          {children}
        </div>
      </div>
    </section>
  );
}

/** A titled section block, so the two legal pages stay visually consistent. */
export function LegalSection({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="font-display text-xl font-semibold tracking-tight text-ink">{heading}</h2>
      {children}
    </div>
  );
}
