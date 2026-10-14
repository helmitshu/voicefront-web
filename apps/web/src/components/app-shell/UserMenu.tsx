'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';

/** Up-to-two-letter avatar initials from a full name ("Ada Lovelace" → "AL"). */
export function userInitials(fullName: string): string {
  return fullName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export function Avatar({ fullName, size = 'md' }: { fullName: string; size?: 'md' | 'sm' }) {
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-signal to-signal-deep font-semibold text-white shadow-pop ring-1 ring-inset ring-white/15 ${
        size === 'md' ? 'h-9 w-9 text-xs' : 'h-8 w-8 text-[11px]'
      }`}
    >
      {userInitials(fullName)}
    </span>
  );
}

const MENU_ITEM =
  'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-white/75 transition-colors hover:bg-white/[0.07] hover:text-white';

function MenuItems({ onNavigate }: { onNavigate: () => void }) {
  const { me, signOut } = useAuth();
  if (!me) return null;

  return (
    <>
      <Link href="/dashboard/account" role="menuitem" onClick={onNavigate} className={MENU_ITEM}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4 shrink-0">
          <circle cx="8" cy="5.5" r="2.5" />
          <path d="M3 13.5a5 5 0 0 1 10 0" strokeLinecap="round" />
        </svg>
        Account
      </Link>
      {me.user.isPlatformAdmin && (
        <Link href="/admin" role="menuitem" onClick={onNavigate} className={MENU_ITEM}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4 shrink-0">
            <path d="M8 2 3.5 4v3.5c0 2.8 1.9 5 4.5 6.5 2.6-1.5 4.5-3.7 4.5-6.5V4L8 2Z" strokeLinejoin="round" />
            <path d="M6 8l1.4 1.4L10.5 6.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Platform Admin
        </Link>
      )}
      <div aria-hidden className="mx-2 my-1.5 h-px bg-white/10" />
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onNavigate();
          signOut();
        }}
        className={MENU_ITEM}
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4 shrink-0">
          <path d="M6 2.5H3.5v11H6M10.5 5l3 3-3 3M13 8H6.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Sign out
      </button>
    </>
  );
}

/**
 * The identity block at the bottom of the small-screen drawer: avatar, full
 * name and email up top, then Account / Platform Admin / Sign out as plain
 * rows (no nested popover — the drawer is the menu). Shares its rows with the
 * sidebar card's popover so both surfaces always offer the same actions.
 */
export function DrawerUserSection({ onNavigate }: { onNavigate: () => void }) {
  const { me } = useAuth();
  if (!me) return null;

  return (
    <div>
      <div className="flex items-center gap-3 px-3 py-2">
        <Avatar fullName={me.user.fullName} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-white">{me.user.fullName}</span>
          <span className="block truncate text-xs text-white/50">{me.user.email}</span>
        </span>
      </div>
      <div aria-hidden className="mx-2 my-1.5 h-px bg-white/10" />
      <MenuItems onNavigate={onNavigate} />
    </div>
  );
}

/**
 * The signed-in user's identity block. The sidebar variant is a full card at
 * the bottom of the sidebar — name and email always visible, no click needed —
 * and the whole card opens the menu (Account / Platform Admin / Sign out).
 * The compact variant is the topbar form for small screens, where the sidebar
 * is hidden: avatar + email button, menu drops down.
 */
export function UserMenu({ variant = 'sidebar' }: { variant?: 'sidebar' | 'compact' }) {
  const { me } = useAuth();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on navigation, outside click, or Escape.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open ]);

  if (!me) return null;

  const chevron = (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden
      className={`h-4 w-4 shrink-0 text-white/40 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
    >
      <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );

  if (variant === 'compact') {
    return (
      <div ref={rootRef} className="relative">
        {open && (
          <div
            role="menu"
            className="absolute right-0 top-full z-50 mt-2 w-72 rounded-2xl bg-ink-soft p-1.5 shadow-lift ring-1 ring-white/15"
          >
            <div className="px-3 pb-2 pt-2.5">
              <p className="truncate text-[13px] font-semibold text-white">{me.user.fullName}</p>
              <p className="truncate text-xs text-white/50">{me.user.email}</p>
            </div>
            <div aria-hidden className="mx-2 mb-1.5 h-px bg-white/10" />
            <MenuItems onNavigate={() => setOpen(false)} />
          </div>
        )}
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Account menu for ${me.user.email}`}
          className="flex items-center gap-2.5 rounded-full py-1 pl-1 pr-2 transition-colors hover:bg-white/[0.06]"
        >
          <Avatar fullName={me.user.fullName} size="sm" />
          <span className="hidden max-w-[160px] truncate text-[13px] font-medium text-white min-[480px]:block">
            {me.user.email}
          </span>
          {chevron}
        </button>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      {open && (
        <div
          role="menu"
          className="absolute inset-x-0 bottom-full z-50 mb-2 rounded-2xl bg-ink-soft p-1.5 shadow-lift ring-1 ring-white/15"
        >
          <MenuItems onNavigate={() => setOpen(false)} />
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-left transition-colors hover:bg-white/[0.07]"
      >
        <Avatar fullName={me.user.fullName} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-white">{me.user.fullName}</span>
          <span className="block truncate text-xs text-white/50">{me.user.email}</span>
        </span>
        {chevron}
      </button>
    </div>
  );
}
