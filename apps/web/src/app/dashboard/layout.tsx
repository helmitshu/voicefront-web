'use client';

import type { ReactNode } from 'react';
import { RequireAuth, useAuth } from '@/lib/auth-context';
import { SignedInShell, type ShellNavItem } from '@/components/app-shell/SignedInShell';
import { Badge } from '@/components/ui/Card';
import { INDUSTRY_LABELS } from '@/domain/prompt-templates';

interface NavItem extends ShellNavItem {
  /** When true, only show this item for trades (CONSTRUCTION) workspaces. */
  constructionOnly?: boolean;
}

const NAV: NavItem[] = [
  {
    href: '/dashboard',
    label: 'Dashboard',
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
    href: '/dashboard/calls',
    label: 'Calls',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
        <path
          d="M4 3.5h3l1.5 4-2 1.5a11 11 0 0 0 4.5 4.5l1.5-2 4 1.5v3a1.5 1.5 0 0 1-1.6 1.5C8.3 16.9 3.1 11.7 2.5 5.1A1.5 1.5 0 0 1 4 3.5Z"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    href: '/dashboard/calendar',
    label: 'Calendar',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
        <rect x="3" y="4" width="14" height="13" rx="2" />
        <path d="M3 8.5h14M7 2.5v3M13 2.5v3" strokeLinecap="round" />
        <path d="M6.5 12h2M11.5 12h2M6.5 14.5h2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    href: '/dashboard/analytics',
    label: 'Analytics',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
        <path d="M3 17V3M3 17h14" strokeLinecap="round" />
        <path d="M6.5 13.5l3-3.5 2.5 2 3.5-5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    href: '/dashboard/jobs',
    label: 'Jobs',
    constructionOnly: true,
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
        <path d="M8 3.5h4l.5 2h2a1.5 1.5 0 0 1 1.5 1.5V14a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 14V7a1.5 1.5 0 0 1 1.5-1.5h2L8 3.5Z" strokeLinejoin="round" />
        <path d="M10 9v3M8.5 10.5h3" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    href: '/dashboard/waitlist',
    label: 'Waitlist',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
        <circle cx="10" cy="10" r="7.5" />
        <path d="M10 5.5V10l3 1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    href: '/dashboard/providers',
    label: 'Providers',
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
    label: 'Settings',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
        <path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13" strokeLinecap="round" />
        <circle cx="7.5" cy="5.5" r="1.9" fill="currentColor" stroke="none" />
        <circle cx="12.5" cy="10" r="1.9" fill="currentColor" stroke="none" />
        <circle cx="7" cy="14.5" r="1.9" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
];

function DashboardChrome({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  if (!me) return null;

  // Trades-only tabs (Jobs) are hidden for clinics, matching the agent-side
  // gating where the job-capture tool only attaches for CONSTRUCTION.
  const nav = NAV.filter((item) => !item.constructionOnly || me.tenant.industry === 'CONSTRUCTION');

  return (
    <SignedInShell
      theme="app"
      navLabel="Main"
      homeHref="/dashboard"
      nav={nav}
      sidebarTop={
        <div className="mt-8 px-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/40">Workspace</p>
          <p className="mt-1 truncate text-sm font-semibold text-white">{me.tenant.companyName}</p>
        </div>
      }
      headerLeft={
        <>
          <h1 className="truncate font-display text-[15px] font-semibold tracking-tight text-white">
            {me.tenant.companyName}
          </h1>
          <Badge tone={me.tenant.industry === 'CLINIC' ? 'success' : 'warning'}>
            {INDUSTRY_LABELS[me.tenant.industry]}
          </Badge>
        </>
      }
      headerRight={
        <div className="flex items-center gap-2 rounded-full border border-clinic/20 bg-clinic-soft/60 py-1 pl-2.5 pr-3">
          <span className="relative flex h-2 w-2">
            <span className="absolute h-full w-full animate-pulse-ring rounded-full bg-clinic" />
            <span className="relative h-2 w-2 rounded-full bg-clinic" />
          </span>
          <span className="text-xs font-semibold text-[#0b8a74]">Live</span>
        </div>
      }
      mainDecor
    >
      {children}
    </SignedInShell>
  );
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <DashboardChrome>{children}</DashboardChrome>
    </RequireAuth>
  );
}
