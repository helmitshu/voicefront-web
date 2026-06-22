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
      className={`rounded-2xl border border-line/70 bg-white shadow-card transition-shadow duration-200 ${padded ? 'p-6' : ''} ${className}`}
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
  neutral: 'bg-paper text-ink-muted ring-ink/10',
  signal: 'bg-signal-soft/70 text-signal-deep ring-signal/20',
  success: 'bg-clinic-soft/70 text-[#0b8a74] ring-clinic/25',
  warning: 'bg-construction-soft/70 text-[#9a6a1d] ring-construction/30',
  danger: 'bg-danger-soft/70 text-danger ring-danger/25',
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
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${BADGE_TONES[tone]}`}
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
        className="mb-2 flex h-12 w-12 items-end justify-center gap-1 rounded-2xl border border-line/80 bg-white pb-3 shadow-input"
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
  accent = false,
  icon,
}: {
  label: string;
  value: string;
  sublabel?: string;
  accent?: boolean;
  icon?: ReactNode;
}) {
  return (
    <Card className="group relative flex flex-col gap-3 overflow-hidden hover:shadow-card-hover" padded>
      {accent && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-signal/50 to-transparent"
        />
      )}
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">{label}</p>
        {icon && (
          <span
            aria-hidden
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ${
              accent
                ? 'bg-signal-soft/70 text-signal-deep ring-signal/15'
                : 'bg-paper text-ink-muted ring-ink/5'
            }`}
          >
            {icon}
          </span>
        )}
      </div>
      <div>
        <p
          className={`font-display text-[32px] font-semibold leading-none tracking-tight ${
            accent ? 'text-signal-deep' : 'text-ink'
          }`}
        >
          {value}
        </p>
        {sublabel && <p className="mt-2 text-xs leading-relaxed text-ink-muted">{sublabel}</p>}
      </div>
    </Card>
  );
}
