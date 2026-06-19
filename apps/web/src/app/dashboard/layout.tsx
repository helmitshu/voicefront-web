'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { RequireAuth, useAuth } from '@/lib/auth-context';
import { Logo } from '@/components/ui/Logo';
import { Badge } from '@/components/ui/Card';
import { INDUSTRY_LABELS } from '@/domain/prompt-templates';

const NAV = [
  {
    href: '/dashboard',
    label: 'Overview',
    exact: true,
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
        <rect x="3" y="3" width="6" height="6" rx="1.5" />
        <rect x="11" y="3" width="6" height="6" rx="1.5" />
        <rect x="3" y="11" width="6" height="6" rx="1.5" />
        <rect x="11" y="11" width="6" height="6" rx="1.5" />
      </svg>
    ),
  },
  {
    href: '/dashboard/calendar',
    label: 'Calendar',
    exact: false,
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
        <rect x="3" y="4" width="14" height="13" rx="2" />
        <path d="M3 8.5h14M7 2.5v3M13 2.5v3" strokeLinecap="round" />
        <path d="M6.5 12h2M11.5 12h2M6.5 14.5h2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    href: '/dashboard/providers',
    label: 'Providers',
    exact: false,
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
        <circle cx="7" cy="6.5" r="2.5" />
        <circle cx="13.5" cy="7.5" r="2" />
        <path d="M2.5 16c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4M12 12c2.2 0 4 1.4 4 3.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    href: '/dashboard/settings',
    label: 'Receptionist',
    exact: false,
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
        <rect x="7.5" y="2.5" width="5" height="9" rx="2.5" />
        <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5M7 17.5h6" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    href: '/dashboard/calls',
    label: 'Call history',
    exact: false,
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
        <path
          d="M4 3.5h3l1.5 4-2 1.5a11 11 0 0 0 4.5 4.5l1.5-2 4 1.5v3a1.5 1.5 0 0 1-1.6 1.5C8.3 16.9 3.1 11.7 2.5 5.1A1.5 1.5 0 0 1 4 3.5Z"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
];

function initials(fullName: string): string {
  return fullName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function DashboardChrome({ children }: { children: ReactNode }) {
  const { me, signOut } = useAuth();
  const pathname = usePathname();
  if (!me) return null;

  return (
    <div className="flex min-h-screen bg-paper">
      {/* Sidebar */}
      <aside className="sticky top-0 hidden h-screen w-64 flex-col border-r border-line/70 bg-white px-4 py-6 md:flex">
        <Link href="/dashboard" className="px-2">
          <Logo />
        </Link>

        <p className="mt-9 px-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted/70">
          Workspace
        </p>
        <nav className="mt-2 flex flex-1 flex-col gap-0.5" aria-label="Main">
          {NAV.map((item) => {
            const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-150 ${
                  active
                    ? 'bg-signal-soft/60 text-signal-deep shadow-[inset_0_1px_0_rgba(255,255,255,0.6)] ring-1 ring-inset ring-signal/10'
                    : 'text-ink-muted hover:bg-paper hover:text-ink'
                }`}
              >
                <span
                  aria-hidden
                  className={`absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-signal transition-opacity duration-150 ${
                    active ? 'opacity-100' : 'opacity-0'
                  }`}
                />
                <span
                  className={`transition-colors duration-150 ${
                    active ? 'text-signal-deep' : 'text-ink-muted/70 group-hover:text-ink'
                  }`}
                >
                  {item.icon}
                </span>
                {item.label}
              </Link>
            );
          })}
        </nav>

        {me.user.isPlatformAdmin && (
          <Link
            href="/admin"
            className="group mb-3 flex items-center gap-3 rounded-xl bg-ink px-3 py-2.5 text-sm font-medium text-white/90 transition-colors hover:bg-ink/90"
          >
            <span className="text-signal-soft">
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
                <path d="M10 2.5 4 5v4.5c0 3.5 2.4 6.4 6 8 3.6-1.6 6-4.5 6-8V5l-6-2.5Z" strokeLinejoin="round" />
                <path d="M7.5 10l1.8 1.8L13 8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            Admin panel
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="ml-auto h-3.5 w-3.5 text-white/40 transition-transform group-hover:translate-x-0.5">
              <path d="M6 3.5 10.5 8 6 12.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
        )}

        <div className="rounded-2xl border border-line/70 bg-paper/80 p-3">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-signal to-signal-deep text-xs font-semibold text-white shadow-pop"
            >
              {initials(me.user.fullName)}
            </span>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-ink">{me.user.fullName}</p>
              <p className="truncate text-xs text-ink-muted">{me.user.email}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={signOut}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-line/80 bg-white px-3 py-1.5 text-xs font-medium text-ink-muted shadow-input transition-colors hover:border-ink-muted/40 hover:text-ink"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
              <path d="M6 2.5H3.5v11H6M10.5 5l3 3-3 3M13 8H6.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Topbar */}
        <header className="sticky top-0 z-30 flex items-center justify-between gap-4 border-b border-line/70 bg-white/80 px-6 py-3.5 backdrop-blur-md">
          <div className="flex min-w-0 items-center gap-3 md:hidden">
            <Logo size="sm" withText={false} />
          </div>
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="truncate font-display text-[15px] font-semibold tracking-tight text-ink">
              {me.tenant.companyName}
            </h1>
            <Badge tone={me.tenant.industry === 'CLINIC' ? 'success' : 'warning'}>
              {INDUSTRY_LABELS[me.tenant.industry]}
            </Badge>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-clinic/20 bg-clinic-soft/60 py-1 pl-2.5 pr-3">
            <span className="relative flex h-2 w-2">
              <span className="absolute h-full w-full animate-pulse-ring rounded-full bg-clinic" />
              <span className="relative h-2 w-2 rounded-full bg-clinic" />
            </span>
            <span className="text-xs font-semibold text-[#0b8a74]">Live</span>
          </div>
        </header>

        {/* Mobile nav */}
        <nav className="flex gap-1 border-b border-line/70 bg-white px-4 py-2 md:hidden" aria-label="Main">
          {NAV.map((item) => {
            const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  active ? 'bg-signal-soft/70 text-signal-deep' : 'text-ink-muted hover:text-ink'
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <main className="relative mx-auto w-full max-w-6xl flex-1 px-6 py-10">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-48 bg-[radial-gradient(60%_100%_at_50%_0%,rgba(14,107,99,0.05),transparent)]"
          />
          <div className="relative">{children}</div>
        </main>
      </div>
    </div>
  );
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <DashboardChrome>{children}</DashboardChrome>
    </RequireAuth>
  );
}
