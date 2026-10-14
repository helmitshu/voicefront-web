import type { ReactNode } from 'react';

/**
 * Shared layout for legal pages (Terms, Privacy). Plain, readable prose column.
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
