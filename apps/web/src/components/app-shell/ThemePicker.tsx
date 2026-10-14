'use client';

import { THEMES, useTheme, type AppTheme } from '@/lib/theme';
import { Card, CardHeader } from '@/components/ui/Card';

/** Three-dot swatch previewing a theme's canvas, surface, and accent. */
function Swatches({ colors }: { colors: [string, string, string] }) {
  return (
    <span aria-hidden className="flex shrink-0 -space-x-1.5">
      {colors.map((color) => (
        <span
          key={color}
          className="h-5 w-5 rounded-full ring-2 ring-card"
          style={{ backgroundColor: color }}
        />
      ))}
    </span>
  );
}

/**
 * Full theme picker for Settings → General: one selectable card per theme
 * with its name, a line of description, and a swatch trio. The choice saves
 * to this device and applies immediately (ThemeProvider + globals.css tokens).
 */
export function AppearanceCard() {
  const { theme, setTheme } = useTheme();

  return (
    <Card>
      <CardHeader
        title="Appearance"
        description="How the app looks on this device. Midnight is the default."
      />
      <div role="radiogroup" aria-label="App theme" className="grid gap-3 sm:grid-cols-3">
        {THEMES.map((option) => {
          const active = option.key === theme;
          return (
            <button
              key={option.key}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setTheme(option.key)}
              className={`flex items-center gap-3 rounded-xl border px-4 py-3.5 text-left transition-all duration-150 ${
                active
                  ? 'border-signal bg-signal-soft/40 ring-1 ring-signal'
                  : 'border-line bg-paper/60 hover:border-ink-muted/40 hover:bg-paper'
              }`}
            >
              <Swatches colors={option.swatches} />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink">{option.label}</span>
                <span className="block truncate text-xs text-ink-muted">{option.blurb}</span>
              </span>
              {active && (
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden
                  className="ml-auto h-4 w-4 shrink-0 text-signal"
                >
                  <path d="M3 8.5 6.5 12 13 4.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

/**
 * Compact switch for the user menu (sidebar popover, topbar menu, and the
 * drawer all share it): one row per theme with its swatches, active checked.
 */
export function ThemeSwitch({ onNavigate }: { onNavigate: () => void }) {
  const { theme, setTheme } = useTheme();

  const pick = (next: AppTheme) => {
    setTheme(next);
    onNavigate();
  };

  return (
    <div role="radiogroup" aria-label="App theme">
      <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/40">
        Theme
      </p>
      {THEMES.map((option) => {
        const active = option.key === theme;
        return (
          <button
            key={option.key}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => pick(option.key)}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-white/75 transition-colors hover:bg-white/[0.07] hover:text-white"
          >
            <Swatches colors={option.swatches} />
            {option.label}
            {active && (
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden
                className="ml-auto h-4 w-4 shrink-0 text-white"
              >
                <path d="M3 8.5 6.5 12 13 4.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        );
      })}
    </div>
  );
}
