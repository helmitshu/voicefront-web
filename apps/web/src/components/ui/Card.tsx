import type { ReactNode } from 'react';
import type { CallStatus } from '@/lib/api';

export function Card({
  children,
  className = '',
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={`rounded-[18px] border border-line bg-card shadow-card transition-shadow duration-200 ${padded ? 'p-6' : ''} ${className}`}
    >
      {children}
    </div>
  );
}

export function CardHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div>
        <h2 className="font-display text-[17px] font-semibold tracking-tight text-ink">{title}</h2>
        {description && <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export type BadgeTone = 'neutral' | 'signal' | 'success' | 'warning' | 'danger';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface3 text-ink-muted ring-ink/10',
  signal: 'bg-signal-soft/70 text-signal-deep ring-signal/20',
  success: 'bg-clinic-soft text-signal-deep ring-clinic/25',
  warning: 'bg-construction-soft text-construction ring-construction/30',
  danger: 'bg-danger-soft text-danger ring-danger/25',
};

const BADGE_DOTS: Record<BadgeTone, string> = {
  neutral: 'bg-ink-muted/60',
  signal: 'bg-signal',
  success: 'bg-clinic',
  warning: 'bg-construction',
  danger: 'bg-danger',
};

export function Badge({
  tone = 'neutral',
  dot = false,
  children,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11.5px] font-extrabold ring-1 ring-inset ${BADGE_TONES[tone]}`}
    >
      {dot && <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${BADGE_DOTS[tone]}`} />}
      {children}
    </span>
  );
}

const CALL_STATUS_META: Record<CallStatus, { label: string; tone: BadgeTone }> = {
  COMPLETED: { label: 'Completed', tone: 'success' },
  FORWARDED: { label: 'Transferred', tone: 'signal' },
  VOICEMAIL: { label: 'Voicemail', tone: 'warning' },
  FAILED: { label: 'Dropped', tone: 'danger' },
  UNKNOWN: { label: 'Unknown', tone: 'neutral' },
};

export function CallStatusBadge({ status }: { status: CallStatus }) {
  const meta = CALL_STATUS_META[status];
  return (
    <Badge tone={meta.tone} dot>
      {meta.label}
    </Badge>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line bg-paper/70 px-6 py-14 text-center">
      <span
        aria-hidden
        className="mb-2 flex h-12 w-12 items-end justify-center gap-1 rounded-2xl border border-line/80 bg-card pb-3 shadow-input"
      >
        {[10, 18, 13, 22, 9].map((h, i) => (
          <span key={i} className="w-1 rounded-full bg-signal/40" style={{ height: `${h * 0.8}px` }} />
        ))}
      </span>
      <h3 className="font-display text-base font-semibold text-ink">{title}</h3>
      {description && <p className="max-w-sm text-sm leading-relaxed text-ink-muted">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function StatCard({
  label,
  value,
  sublabel,
  hint,
  accent = false,
  icon,
}: {
  label: string;
  value: string;
  sublabel?: string;
  /** Quiet muted line under the value, for a zero stat that needs context. */
  hint?: string;
  /** Kept for call-site compatibility; the demo KPI treatment is uniform. */
  accent?: boolean;
  icon?: ReactNode;
}) {
  void accent;
  return (
    <Card className="group relative overflow-hidden hover:shadow-card-hover" padded={false}>
      {/* The demo KPI's signal strip across the top edge. */}
      <span aria-hidden className="bg-grad pointer-events-none absolute inset-x-0 top-0 h-[2px] opacity-[0.85]" />
      <div className="p-4 pb-3.5 sm:p-5 sm:pb-4">
        <div className="flex items-center justify-between gap-3">
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">{label}</p>
          {icon && (
            <span
              aria-hidden
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface3 text-signal"
            >
              {icon}
            </span>
          )}
        </div>
        <p className="mt-2.5 font-display text-[25px] font-bold leading-none tracking-[-0.02em] text-ink tabular-nums sm:mt-3 sm:text-[34px]">
          {value}
        </p>
        {sublabel && (
          <p className="mt-1.5 text-xs font-bold leading-relaxed text-signal sm:text-[12.5px]">{sublabel}</p>
        )}
        {hint && <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">{hint}</p>}
      </div>
    </Card>
  );
}
