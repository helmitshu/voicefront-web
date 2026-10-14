'use client';

import { useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@/lib/auth-context';
import { SignedInShell, type ShellNavItem } from '@/components/app-shell/SignedInShell';

interface NavItem extends ShellNavItem {
  /** When true, only full admins (not SUPPORT operators) see this item. */
  fullAdminOnly?: boolean;
}

const NAV: NavItem[] = [
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
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
        <circle cx="7" cy="7" r="3" />
        <path d="M2.5 16.5a4.5 4.5 0 0 1 9 0M13.5 4.5a3 3 0 0 1 0 5M14 12.5a4.5 4.5 0 0 1 3.5 4" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    href: '/admin/leads',
    label: 'Leads',
    fullAdminOnly: true,
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
        <circle cx="9" cy="9" r="5.5" />
        <path d="M13 13l4 4" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    href: '/admin/access-codes',
    label: 'Access codes',
    fullAdminOnly: true,
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
        <circle cx="7" cy="10" r="3.5" />
        <path d="M10 8.5h7.5M15 8.5v3M17.5 8.5v2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    href: '/admin/numbers',
    label: 'Phone numbers',
    fullAdminOnly: true,
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
        <path
          d="M5 3.5h2l1.2 3-1.4 1a8 8 0 0 0 3.7 3.7l1-1.4 3 1.2v2A1.5 1.5 0 0 1 14 17.5C8.5 17 3 11.5 2.5 6A1.5 1.5 0 0 1 4 4.5"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    href: '/admin/config',
    label: 'Keys & config',
    fullAdminOnly: true,
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
        <circle cx="7.5" cy="7.5" r="4" />
        <path d="M10.5 10.5 17 17M14 14l2-2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    href: '/admin/demo',
    label: 'Sales demo',
    fullAdminOnly: true,
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
        <path d="M4 4.5h12v8H11l-3 3v-3H4z" strokeLinejoin="round" />
        <path d="M7.5 8.5h5M7.5 6.5h5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    href: '/admin/calendar',
    label: 'My calendar',
    fullAdminOnly: true,
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
        <rect x="3" y="4.5" width="14" height="12" rx="2" />
        <path d="M3 8h14M7 3v3M13 3v3" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    href: '/admin/team',
    label: 'Team',
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
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
        <path d="M5 3.5h10v13H5zM8 7.5h4M8 10.5h4M8 13.5h2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
];

function AdminChrome({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const router = useRouter();
  const isAdmin = me?.user.isPlatformAdmin === true;
  const isFullAdmin = me?.user.adminRole === 'ADMIN';

  useEffect(() => {
    if (me && !isAdmin) router.replace('/dashboard');
  }, [me, isAdmin, router]);

  if (!me || !isAdmin) return null;

  // SUPPORT operators don't see full-admin destinations (keys, team).
  const nav = NAV.filter((item) => isFullAdmin || !item.fullAdminOnly);

  return (
    <SignedInShell
      theme="admin"
      navLabel="Admin"
      homeHref="/admin"
      nav={nav}
      sidebarTop={
        <span className="mx-2 mt-3 inline-flex w-fit items-center gap-1.5 rounded-full bg-signal/20 px-2.5 py-1 text-[11px] font-semibold text-signal-soft ring-1 ring-inset ring-signal/30">
          <span className="h-1.5 w-1.5 rounded-full bg-signal" aria-hidden />
          {isFullAdmin ? 'Founder control center' : 'Support access'}
        </span>
      }
      sidebarAboveUser={
        <Link
          href="/dashboard"
          className="mb-3 flex items-center justify-center gap-2 rounded-xl border border-white/15 px-3 py-2 text-xs font-medium text-white/70 transition-colors hover:bg-white/5 hover:text-white"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
            <path d="M9.5 3 5 8l4.5 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back to app
        </Link>
      }
      headerLeft={
        <h1 className="font-display text-[15px] font-semibold tracking-tight text-ink">
          Platform administration
        </h1>
      }
    >
      {children}
    </SignedInShell>
  );
}

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <AdminChrome>{children}</AdminChrome>
    </RequireAuth>
  );
}
