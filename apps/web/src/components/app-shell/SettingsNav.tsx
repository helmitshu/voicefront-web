'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ITEMS = [
  { href: '/dashboard/settings', label: 'General' },
  { href: '/dashboard/providers', label: 'Providers' },
];

/**
 * Sub-navigation for the Settings home. The receptionist's configuration
 * (General) and the providers & services it books against live behind one
 * Settings entry in the main nav; this tab row is what gathers them. It is
 * rendered by the layouts of both routes so the two pages read as one place.
 */
export function SettingsNav() {
  const pathname = usePathname();

  return (
    <div className="mb-8">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">Settings</p>
      <nav aria-label="Settings" className="mt-3 flex gap-1 border-b border-line/70">
        {ITEMS.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={`relative -mb-px border-b-2 px-3.5 pb-2.5 pt-1 text-sm font-medium transition-colors ${
                active
                  ? 'border-signal text-ink'
                  : 'border-transparent text-ink-muted hover:border-line hover:text-ink'
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
