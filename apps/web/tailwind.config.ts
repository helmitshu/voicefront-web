import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Deep charcoal-green for text, and a soft (not harsh) dark band when
        // used as a background. Replaces the old near-black navy.
        ink: {
          DEFAULT: '#1E2421',
          soft: '#2C332E',
          muted: '#66706B',
        },
        // Warm off-white page canvas + tinted surface. `white` stays the pure
        // elevated surface; `paper` is the calm neutral behind it.
        paper: '#F6F7F3',
        surface: '#F1F4F1',
        line: '#E4E7E2',
        // Primary accent: deep, calm teal. Drives CTAs, active states, key
        // badges and small highlights — never large saturated blocks.
        signal: {
          DEFAULT: '#0E6B63',
          deep: '#0A574F',
          soft: '#D9EEEA',
        },
        clinic: {
          DEFAULT: '#0FA98E',
          soft: '#E2F6F1',
        },
        construction: {
          DEFAULT: '#A56A18',
          soft: '#F6ECD9',
        },
        danger: {
          DEFAULT: '#C0453F',
          soft: '#F8E7E5',
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
