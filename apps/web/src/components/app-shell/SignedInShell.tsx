'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Logo } from '@/components/ui/Logo';
import { UserMenu } from './UserMenu';

export interface ShellNavItem {
  href: string;
  label: string;
  exact?: boolean;
  icon: ReactNode;
}

type ShellTheme = 'app' | 'admin';

const THEMES: Record<
  ShellTheme,
  {
    sidebar: string;
    topbar: string;
    mobileNav: string;
    mobileActive: string;
    mobileIdle: string;
    accentBar: string;
    navActive: string;
    navIdle: string;
    iconActive: string;
    iconIdle: string;
  }
> = {
  app: {
    sidebar: 'border-r border-white/10 bg-ink-deep',
    topbar: 'border-white/10 bg-ink-deep/90',
    mobileNav: 'border-white/10 bg-ink-deep',
    mobileActive: 'bg-white/[0.08] text-white',
    mobileIdle: 'text-white/55 hover:text-white',
    accentBar: 'bg-gold-light',
    navActive: 'bg-white/[0.07] text-white ring-1 ring-inset ring-white/10',
    navIdle: 'text-white/55 hover:bg-white/[0.04] hover:text-white',
    iconActive: 'text-white',
    iconIdle: 'text-white/45 group-hover:text-white',
  },
  admin: {
    sidebar: 'bg-ink',
    topbar: 'border-line/70 bg-white/80',
    mobileNav: 'border-line/70 bg-white',
    mobileActive: 'bg-signal-soft/70 text-signal-deep',
    mobileIdle: 'text-ink-muted hover:text-ink',
    accentBar: 'bg-signal',
    navActive: 'bg-white/10 text-white ring-1 ring-inset ring-white/10',
    navIdle: 'text-white/50 hover:bg-white/5 hover:text-white',
    iconActive: 'text-signal-soft',
    iconIdle: 'text-white/40 group-hover:text-white/70',
  },
};

interface SignedInShellProps {
  nav: ShellNavItem[];
  /** Accessible name for the nav landmarks ("Main" / "Admin"). */
  navLabel: string;
  theme: ShellTheme;
  /** Where the sidebar logo points ('/dashboard' or '/admin'). */
  homeHref: string;
  /** Block under the logo: workspace name (app) or role pill (admin). */
  sidebarTop?: ReactNode;
  /** Block between the nav and the user card (admin's "Back to app"). */
  sidebarAboveUser?: ReactNode;
  /** Left cluster of the topbar, after the small-screen logo mark. */
  headerLeft: ReactNode;
  /** Right cluster of the topbar, before the small-screen user menu. */
  headerRight?: ReactNode;
  /** The dashboard's soft radial glow behind page content. */
  mainDecor?: boolean;
  children: ReactNode;
}

/**
 * The one signed-in chrome shared by the tenant app and the platform admin:
 * dark sidebar (logo, nav, user card pinned to the bottom), sticky topbar,
 * and a horizontal nav row on small screens where the sidebar is hidden —
 * there the user card moves into the topbar so identity and sign out are
 * always reachable.
 */
export function SignedInShell({
  nav,
  navLabel,
  theme,
  homeHref,
  sidebarTop,
  sidebarAboveUser,
  headerLeft,
  headerRight,
  mainDecor = false,
  children,
}: SignedInShellProps) {
  const pathname = usePathname();
  const t = THEMES[theme];
  const isActive = (item: ShellNavItem) =>
    item.exact ? pathname === item.href : pathname.startsWith(item.href);

  return (
    <div className="flex min-h-screen bg-paper">
      {/* Sidebar */}
      <aside className={`sticky top-0 hidden h-screen w-64 flex-col px-4 py-6 md:flex ${t.sidebar}`}>
        <Link href={homeHref} className="px-2">
          <Logo tone="light" />
        </Link>

        {sidebarTop}

        <nav className="mt-6 flex flex-1 flex-col gap-0.5" aria-label={navLabel}>
          {nav.map((item) => {
            const active = isActive(item);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-150 ${
                  active ? t.navActive : t.navIdle
                }`}
              >
                <span
                  aria-hidden
                  className={`absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full transition-opacity duration-150 ${t.accentBar} ${
                    active ? 'opacity-100' : 'opacity-0'
                  }`}
                />
                <span className={`transition-colors duration-150 ${active ? t.iconActive : t.iconIdle}`}>
                  {item.icon}
                </span>
                {item.label}
              </Link>
            );
          })}
        </nav>

        {sidebarAboveUser}

        <UserMenu />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Topbar */}
        <header
          className={`sticky top-0 z-30 flex items-center justify-between gap-4 border-b px-6 py-3.5 backdrop-blur-md ${t.topbar}`}
        >
          <div className="flex min-w-0 items-center gap-3">
            {theme === 'app' && (
              <span className="flex md:hidden">
                <Logo size="sm" withText={false} />
              </span>
            )}
            {headerLeft}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {headerRight}
            <span className="flex md:hidden">
              <UserMenu variant="compact" />
            </span>
          </div>
        </header>

        {/* Mobile nav */}
        <nav className={`flex gap-1 overflow-x-auto border-b px-4 py-2 md:hidden ${t.mobileNav}`} aria-label={navLabel}>
          {nav.map((item) => {
            const active = isActive(item);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  active ? t.mobileActive : t.mobileIdle
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <main className="relative mx-auto w-full max-w-6xl flex-1 px-6 py-10">
          {mainDecor ? (
            <>
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 h-48 bg-[radial-gradient(60%_100%_at_50%_0%,rgba(14,107,99,0.05),transparent)]"
              />
              <div className="relative">{children}</div>
            </>
          ) : (
            children
          )}
        </main>
      </div>
    </div>
  );
}
