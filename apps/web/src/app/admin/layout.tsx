'use client';

import { useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@/lib/auth-context';
import { Logo } from '@/components/ui/Logo';

const NAV = [
  {
    href: '/admin',
    label: 'Overview',
    exact: true,
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
        <path d="M3 11.5 10 4l7 7.5M5.5 9.5V16h3v-3.5h3V16h3V9.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    href: '/admin/customers',
    label: 'Customers',
    exact: false,
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
        <circle cx="7" cy="7" r="3" />
        <path d="M2.5 16.5a4.5 4.5 0 0 1 9 0M13.5 4.5a3 3 0 0 1 0 5M14 12.5a4.5 4.5 0 0 1 3.5 4" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    href: '/admin/config',
    label: 'Keys & config',
    exact: false,
    fullAdminOnly: true,
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
        <circle cx="7.5" cy="7.5" r="4" />
        <path d="M10.5 10.5 17 17M14 14l2-2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    href: '/admin/team',
    label: 'Team',
    exact: false,
    fullAdminOnly: true,
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
        <circle cx="10" cy="6" r="3" />
        <path d="M4 16.5a6 6 0 0 1 12 0" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    href: '/admin/audit',
    label: 'Audit log',
    exact: false,
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
        <path d="M5 3.5h10v13H5zM8 7.5h4M8 10.5h4M8 13.5h2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
] as const;

function AdminChrome({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const isAdmin = me?.user.isPlatformAdmin === true;
  const isFullAdmin = me?.user.adminRole === 'ADMIN';

  useEffect(() => {
    if (me && !isAdmin) router.replace('/dashboard');
  }, [me, isAdmin, router]);

  if (!me || !isAdmin) return null;

  // SUPPORT operators don't see full-admin destinations (keys, team).
  const nav = NAV.filter((item) => isFullAdmin || !('fullAdminOnly' in item && item.fullAdminOnly));

  return (
    <div className="flex min-h-screen bg-paper">
      {/* Dark operator sidebar — visually distinct from the tenant dashboard */}
      <aside className="sticky top-0 hidden h-screen w-64 flex-col bg-ink px-4 py-6 md:flex">
        <Link href="/admin" className="px-2">
          <Logo tone="light" />
        </Link>
        <span className="mx-2 mt-3 inline-flex w-fit items-center gap-1.5 rounded-full bg-signal/20 px-2.5 py-1 text-[11px] font-semibold text-signal-soft ring-1 ring-inset ring-signal/30">
          <span className="h-1.5 w-1.5 rounded-full bg-signal" aria-hidden />
          {isFullAdmin ? 'Founder control center' : 'Support access'}
        </span>

        <nav className="mt-8 flex flex-1 flex-col gap-0.5" aria-label="Admin">
          {nav.map((item) => {
            const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-150 ${
                  active ? 'bg-white/10 text-white ring-1 ring-inset ring-white/10' : 'text-white/50 hover:bg-white/5 hover:text-white'
                }`}
              >
                <span
                  aria-hidden
                  className={`absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-signal transition-opacity duration-150 ${
                    active ? 'opacity-100' : 'opacity-0'
                  }`}
                />
                <span className={active ? 'text-signal-soft' : 'text-white/40 group-hover:text-white/70'}>
                  {item.icon}
                </span>
                {item.label}
              </Link>
            );
          })}
        </nav>

        <Link
          href="/dashboard"
          className="flex items-center justify-center gap-2 rounded-xl border border-white/15 px-3 py-2 text-xs font-medium text-white/70 transition-colors hover:bg-white/5 hover:text-white"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
            <path d="M9.5 3 5 8l4.5 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back to dashboard
        </Link>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between gap-4 border-b border-line/70 bg-white/80 px-6 py-3.5 backdrop-blur-md">
          <h1 className="font-display text-[15px] font-semibold tracking-tight text-ink">Platform administration</h1>
          <p className="text-xs text-ink-muted">
            Signed in as <span className="font-semibold text-ink">{me.user.email}</span>
          </p>
        </header>

        {/* Mobile nav */}
        <nav className="flex gap-1 border-b border-line/70 bg-white px-4 py-2 md:hidden" aria-label="Admin">
          {nav.map((item) => {
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

        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">{children}</main>
      </div>
    </div>
  );
}

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <AdminChrome>{children}</AdminChrome>
    </RequireAuth>
  );
}
