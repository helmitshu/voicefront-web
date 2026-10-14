'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Logo } from '@/components/ui/Logo';
import { DrawerUserSection, UserMenu } from './UserMenu';
import { MobileDrawer } from './MobileDrawer';

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
    menuButton: string;
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
    menuButton: 'text-white/75 hover:bg-white/[0.06]',
    accentBar: 'bg-gold-light',
    navActive: 'bg-white/[0.07] text-white ring-1 ring-inset ring-white/10',
    navIdle: 'text-white/55 hover:bg-white/[0.04] hover:text-white',
    iconActive: 'text-white',
    iconIdle: 'text-white/45 group-hover:text-white',
  },
  admin: {
    sidebar: 'bg-ink',
    topbar: 'border-line/70 bg-white/80',
    menuButton: 'text-ink/70 hover:bg-ink/[0.05]',
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
  /** Slim single-line title for the small-screen topbar (desktop keeps headerLeft). */
  mobileTitle?: ReactNode;
  /** Drawer header: workspace name with industry / live status as quiet subtext. */
  drawerHeader?: ReactNode;
  /** The dashboard's soft radial glow behind page content. */
  mainDecor?: boolean;
  children: ReactNode;
}

/**
 * The one signed-in chrome shared by the tenant app and the platform admin:
 * dark sidebar (logo, nav, user card pinned to the bottom) and a sticky
 * topbar on desktop. On small screens the sidebar gives way to a slim topbar
 * (menu button, logo mark, workspace name, avatar) and a slide-in drawer
 * carrying the same nav plus the identity block — no scrolling nav strip,
 * and the topbar pills stay on desktop where there is room for them.
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
  mobileTitle,
  drawerHeader,
  mainDecor = false,
  children,
}: SignedInShellProps) {
  const pathname = usePathname();
  const t = THEMES[theme];
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isActive = (item: ShellNavItem) =>
    item.exact ? pathname === item.href : pathname.startsWith(item.href);

  // Any navigation closes the drawer (nav links, "Back to app", account rows).
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  const closeDrawer = () => setDrawerOpen(false);

  const renderNavItems = (onNavigate?: () => void) =>
    nav.map((item) => {
      const active = isActive(item);
      return (
        <Link
          key={item.href}
          href={item.href}
          onClick={onNavigate}
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
          <span className={`transition-colors duration-150 ${active ? t.iconActive : t.iconIdle}`}>{item.icon}</span>
          {item.label}
        </Link>
      );
    });

  return (
    <div className="flex min-h-screen bg-paper">
      {/* Sidebar */}
      <aside className={`sticky top-0 hidden h-screen w-64 flex-col px-4 py-6 md:flex ${t.sidebar}`}>
        <Link href={homeHref} className="px-2">
          <Logo tone="light" />
        </Link>

        {sidebarTop}

        <nav className="mt-6 flex flex-1 flex-col gap-0.5" aria-label={navLabel}>
          {renderNavItems()}
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
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open menu"
              aria-expanded={drawerOpen}
              className={`-ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors md:hidden ${t.menuButton}`}
            >
              <svg
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                aria-hidden
                className="h-5 w-5"
              >
                <path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13" strokeLinecap="round" />
              </svg>
            </button>
            <span className="flex shrink-0 md:hidden">
              <Logo size="sm" withText={false} />
            </span>
            <div className="hidden min-w-0 items-center gap-3 md:flex">{headerLeft}</div>
            <div className="min-w-0 md:hidden">{mobileTitle}</div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <div className="hidden md:flex">{headerRight}</div>
            <span className="flex md:hidden">
              <UserMenu variant="compact" />
            </span>
          </div>
        </header>

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

      {/* Small-screen drawer: same nav as the sidebar, identity pinned below. */}
      <MobileDrawer open={drawerOpen} onClose={closeDrawer} label={navLabel} panelClassName={t.sidebar}>
        <div className="flex items-center justify-between px-2">
          <Link href={homeHref} onClick={closeDrawer}>
            <Logo tone="light" />
          </Link>
          <button
            type="button"
            onClick={closeDrawer}
            aria-label="Close menu"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-white/60 transition-colors hover:bg-white/[0.06] hover:text-white"
          >
            <svg
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              aria-hidden
              className="h-5 w-5"
            >
              <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {drawerHeader && <div className="mt-6">{drawerHeader}</div>}

        <nav className="mt-6 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto" aria-label={navLabel}>
          {renderNavItems(closeDrawer)}
        </nav>

        {sidebarAboveUser}

        <div className="mt-3">
          <DrawerUserSection onNavigate={closeDrawer} />
        </div>
      </MobileDrawer>
    </div>
  );
}
