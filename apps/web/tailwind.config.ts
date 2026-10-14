import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Every palette color resolves through a CSS variable (RGB triplet in
        // globals.css) so the signed-in app can re-theme by swapping variable
        // values under `[data-theme] .theme-root`. The `:root` values are the
        // original palette, so marketing/auth (outside .theme-root) never move.
        // Deep charcoal-green for text, and a soft (not harsh) dark band when
        // used as a background. Replaces the old near-black navy.
        ink: {
          DEFAULT: 'rgb(var(--vf-ink) / <alpha-value>)',
          soft: 'rgb(var(--vf-ink-soft) / <alpha-value>)',
          muted: 'rgb(var(--vf-ink-muted) / <alpha-value>)',
          // Near-black teal-charcoal for full-bleed "anchor" sections — the dark
          // moments that give the light pages contrast rhythm and a premium feel.
          deep: 'rgb(var(--vf-ink-deep) / <alpha-value>)',
          deeper: 'rgb(var(--vf-ink-deeper) / <alpha-value>)',
        },
        // Warm off-white page canvas + tinted surface. `card` is the elevated
        // surface (pure white in the light themes, deep ink in Midnight);
        // `paper` is the calm neutral behind it.
        paper: 'rgb(var(--vf-paper) / <alpha-value>)',
        surface: 'rgb(var(--vf-surface) / <alpha-value>)',
        card: 'rgb(var(--vf-card) / <alpha-value>)',
        line: 'rgb(var(--vf-line) / <alpha-value>)',
        // Primary accent: deep, calm teal. Drives CTAs, active states, key
        // badges and small highlights — never large saturated blocks.
        // Text/icon color that sits ON a signal fill (white on the light
        // themes' deep teal, deep ink on the dark themes' bright teal).
        onsignal: 'rgb(var(--vf-on-signal) / <alpha-value>)',
        signal: {
          DEFAULT: 'rgb(var(--vf-signal) / <alpha-value>)',
          deep: 'rgb(var(--vf-signal-deep) / <alpha-value>)',
          soft: 'rgb(var(--vf-signal-soft) / <alpha-value>)',
        },
        clinic: {
          DEFAULT: 'rgb(var(--vf-clinic) / <alpha-value>)',
          soft: 'rgb(var(--vf-clinic-soft) / <alpha-value>)',
        },
        construction: {
          DEFAULT: 'rgb(var(--vf-construction) / <alpha-value>)',
          soft: 'rgb(var(--vf-construction-soft) / <alpha-value>)',
        },
        // Secondary brand accent: a refined warm gold. Signals value/premium and
        // makes numbers and key marks glow against the dark anchor sections.
        // Used sparingly — never as a large fill. `light` is tuned to luminesce
        // on dark; `deep` reads on the light canvas.
        gold: {
          DEFAULT: 'rgb(var(--vf-gold) / <alpha-value>)',
          light: 'rgb(var(--vf-gold-light) / <alpha-value>)',
          deep: 'rgb(var(--vf-gold-deep) / <alpha-value>)',
          soft: 'rgb(var(--vf-gold-soft) / <alpha-value>)',
        },
        danger: {
          DEFAULT: 'rgb(var(--vf-danger) / <alpha-value>)',
          soft: 'rgb(var(--vf-danger-soft) / <alpha-value>)',
        },
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        sans: ['"Public Sans"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        // Soft, layered, low-opacity shadows — ambient + key light, the way a
        // physical card casts. Diffuse rather than hard for a calm, premium feel.
        card: '0 1px 2px rgba(20, 30, 25, 0.03), 0 6px 16px -6px rgba(20, 30, 25, 0.06), 0 14px 36px -14px rgba(20, 30, 25, 0.06)',
        'card-hover':
          '0 2px 4px rgba(20, 30, 25, 0.04), 0 12px 28px -8px rgba(20, 30, 25, 0.10), 0 28px 60px -18px rgba(20, 30, 25, 0.10)',
        lift: '0 4px 10px -4px rgba(20, 30, 25, 0.06), 0 24px 56px -20px rgba(20, 30, 25, 0.14)',
        pop: '0 1px 2px rgba(10, 87, 79, 0.20), 0 6px 18px -4px rgba(14, 107, 99, 0.26), inset 0 1px 0 rgba(255, 255, 255, 0.18)',
        input: '0 1px 2px rgba(20, 30, 25, 0.04)',
        // Premium "halo" lift for the hero's centerpiece — a soft teal glow so
        // the key product visual commands attention instead of receding.
        halo: '0 2px 6px rgba(20, 30, 25, 0.05), 0 20px 50px -16px rgba(14, 107, 99, 0.30), 0 40px 90px -40px rgba(11, 23, 20, 0.30)',
      },
      transitionTimingFunction: {
        // Apple-ish ease-out: quick to start, gentle settle. Used on interactions.
        smooth: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      keyframes: {
        'wave-bar': {
          '0%, 100%': { transform: 'scaleY(calc(var(--wave-max, 1) * 0.3))' },
          '50%': { transform: 'scaleY(var(--wave-max, 1))' },
        },
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-ring': {
          '0%': { transform: 'scale(1)', opacity: '0.6' },
          '100%': { transform: 'scale(1.8)', opacity: '0' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-8px)' },
        },
        'pop-in': {
          from: { opacity: '0', transform: 'scale(0.92) translateY(6px)' },
          to: { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
        // Coachmark pointer that bobs toward its target to draw the eye.
        nudge: {
          '0%, 100%': { transform: 'translateX(0)' },
          '50%': { transform: 'translateX(4px)' },
        },
        // Soft outline pulse to highlight a slot the prospect should click.
        highlight: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(14, 107, 99, 0)' },
          '50%': { boxShadow: '0 0 0 4px rgba(14, 107, 99, 0.20)' },
        },
        // Green confirmation flash when Ava books a slot — a ring that swells
        // then settles, drawing the eye to the just-booked appointment.
        'flash-green': {
          '0%': { boxShadow: '0 0 0 0 rgba(15, 169, 142, 0)' },
          '20%': { boxShadow: '0 0 0 5px rgba(15, 169, 142, 0.55)' },
          '100%': { boxShadow: '0 0 0 0 rgba(15, 169, 142, 0)' },
        },
        // Seamless horizontal drift for the background sound-wave field. The
        // wave layer is 200% wide with periodic content, so a -50% shift loops
        // back onto an identical phase — no visible jump.
        'wave-x': {
          from: { transform: 'translateX(0)' },
          to: { transform: 'translateX(-50%)' },
        },
      },
      animation: {
        'wave-bar': 'wave-bar 1.1s ease-in-out infinite',
        // 'backwards' (not 'both') so the transform is dropped once the
        // animation ends — a retained transform turns the wrapper into a
        // containing block and breaks position:fixed children (save dock).
        'fade-up': 'fade-up 0.35s ease-out backwards',
        'pulse-ring': 'pulse-ring 1.6s ease-out infinite',
        float: 'float 7s ease-in-out infinite',
        'pop-in': 'pop-in 0.4s cubic-bezier(0.16, 1, 0.3, 1) backwards',
        nudge: 'nudge 1.1s ease-in-out infinite',
        highlight: 'highlight 1.6s ease-in-out infinite',
        'flash-green': 'flash-green 2.6s ease-out',
        'wave-x': 'wave-x 30s linear infinite',
      },
    },
  },
  plugins: [],
};

export default config;
