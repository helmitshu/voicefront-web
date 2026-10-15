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

/**
 * The demo's shell treatment, shared by the tenant app and the platform
 * admin: the sidebar rides the shell gradient (shell-2 settling into shell)
 * with the demo's nav states, and the topbar is the theme's glass strip.
 * The two areas differ only in content, not in chrome.
 */
const CHROME = {
  sidebar: 'border-r border-shell-edge/15 bg-shell-grad text-shell-ink',
  topbar: 'border-line bg-[var(--vf-topbar)]',
  menuButton: 'text-ink-muted hover:bg-ink/[0.06] hover:text-ink',
  navActive:
    'border-shell-edge/[0.28] bg-[linear-gradient(92deg,rgba(20,184,166,0.28),rgba(14,165,198,0.14))] text-[#EFFFF9]',
  navIdle: 'border-transparent text-shell-mut hover:bg-white/[0.05] hover:text-shell-ink',
  iconActive: 'text-[#EFFFF9]',
  iconIdle: 'text-shell-mut group-hover:text-shell-ink',
};

interface SignedInShellProps {
  nav: ShellNavItem[];
  /** Accessible + visible name for the nav group ("Workspace" / "Platform"). */
  navLabel: string;
  theme: ShellTheme;
  /** Where the sidebar logo points ('/dashboard' or '/admin'). */
  homeHref: string;
  /** Block under the logo: role pill (admin). */
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
  children: ReactNode;
}

/**
 * The one signed-in chrome shared by the tenant app and the platform admin,
 * ported from the approved design demo: dark gradient sidebar (logo, demo
 * nav states, user card pinned to the bottom) and a sticky glass topbar on
 * desktop. On small screens the sidebar gives way to a slim topbar (menu
 * button, logo mark, workspace name, avatar) and a slide-in drawer carrying
 * the same nav plus the identity block — no scrolling nav strip.
 */
export function SignedInShell({
  nav,
  navLabel,
  theme: _theme,
  homeHref,
  sidebarTop,
  sidebarAboveUser,
  headerLeft,
  headerRight,
  mobileTitle,
  drawerHeader,
  children,
}: SignedInShellProps) {
  const pathname = usePathname();
  const t = CHROME;
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
          className={`group relative flex items-center gap-[11px] rounded-[10px] border px-3 py-2.5 text-[14.5px] font-semibold transition-all duration-200 ${
            active ? t.navActive : t.navIdle
          }`}
        >
          <span
            aria-hidden
            className={`bg-grad absolute -left-3 bottom-[22%] top-[22%] w-[3px] rounded-[3px] transition-opacity duration-200 ${
              active ? 'opacity-100' : 'opacity-0'
            }`}
          />
          <span className={`transition-colors duration-200 ${active ? t.iconActive : t.iconIdle}`}>{item.icon}</span>
          {item.label}
        </Link>
      );
    });

  return (
    <div className="flex min-h-screen bg-paper">
      {/* Sidebar */}
      <aside className={`sticky top-0 hidden h-screen w-[268px] flex-col md:flex ${t.sidebar}`}>
        <div className="px-5 pb-[18px] pt-[22px]">
          <Link href={homeHref}>
            <Logo tone="light" animated />
          </Link>
        </div>

        {sidebarTop && <div className="px-5">{sidebarTop}</div>}

        <nav className="mt-1 flex flex-1 flex-col gap-0.5 overflow-y-auto px-3" aria-label={navLabel}>
          <p
            aria-hidden
            className="px-2.5 pb-1.5 pt-3.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-shell-faint"
          >
            {navLabel}
          </p>
          {renderNavItems()}
        </nav>

        <div className="px-4 pb-4 pt-3">
          {sidebarAboveUser}
          <UserMenu />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Topbar: the demo's glass strip over the workspace. */}
        <header
          className={`sticky top-0 z-30 flex items-center justify-between gap-3.5 border-b px-3.5 py-[11px] backdrop-blur-[14px] sm:px-7 sm:py-[13px] ${t.topbar}`}
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
              <Logo size="sm" withText={false} animated />
            </span>
            <div className="hidden min-w-0 items-center gap-3 md:flex">{headerLeft}</div>
            <div className="min-w-0 md:hidden">{mobileTitle}</div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <div className="hidden items-center gap-3 md:flex">{headerRight}</div>
            <span className="flex md:hidden">
              <UserMenu variant="compact" />
            </span>
          </div>
        </header>

        <main className="relative mx-auto w-full max-w-[1240px] flex-1 px-3.5 pb-24 pt-[18px] sm:px-7 sm:pb-[70px] sm:pt-[30px]">
          {children}
        </main>
      </div>

      {/* Small-screen drawer: same nav as the sidebar, identity pinned below. */}
      <MobileDrawer open={drawerOpen} onClose={closeDrawer} label={navLabel} panelClassName={t.sidebar}>
        <div className="flex items-center justify-between">
          <Link href={homeHref} onClick={closeDrawer}>
            <Logo tone="light" animated />
          </Link>
          <button
            type="button"
            onClick={closeDrawer}
            aria-label="Close menu"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-shell-mut transition-colors hover:bg-white/[0.08] hover:text-shell-ink"
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

        <nav className="mt-4 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto" aria-label={navLabel}>
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
