'use client';

import { THEMES, useTheme, type AppTheme } from '@/lib/theme';
import { Card, CardHeader } from '@/components/ui/Card';
import { Toggle } from '@/components/ui/Toggle';

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
 * with its name, a line of description, and a swatch trio, plus the calm
 * mode toggle. Choices apply immediately and save to the account
 * (ThemeProvider + globals.css tokens), with this device as the cache.
 */
export function AppearanceCard() {
  const { theme, setTheme, calm, setCalm } = useTheme();

  return (
    <Card>
      <CardHeader
        title="Appearance"
        description="How the app looks. Choices save to your account and follow you across devices. Midnight is the default."
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
      <div className="mt-5 border-t border-line pt-5">
        <Toggle
          checked={calm}
          onChange={setCalm}
          label="Reduce motion and effects"
          description="Calms the animated logo, the live waveform, and the other moving touches across the app."
        />
      </div>
    </Card>
  );
}

/**
 * The demo's topbar preset switch: a segmented pill (surface-3 track, card
 * thumb) for one-tap theme changes from the desktop topbar. Same provider,
 * same storage as every other picker — this is a second surface for the one
 * choice, not a separate setting.
 */
export function PresetSwitch() {
  const { theme, setTheme } = useTheme();

  return (
    <div
      role="group"
      aria-label="Theme preset"
      className="hidden items-center gap-0.5 rounded-full border border-line bg-surface3 p-[3px] lg:flex"
    >
      {THEMES.map((option) => {
        const active = option.key === theme;
        return (
          <button
            key={option.key}
            type="button"
            aria-pressed={active}
            onClick={() => setTheme(option.key)}
            className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-bold transition-all duration-200 ${
              active ? 'bg-card text-ink shadow-demo-sm' : 'text-ink-muted hover:text-ink'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
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
