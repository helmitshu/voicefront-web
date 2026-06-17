import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: '#0B1220',
          soft: '#1C2435',
          muted: '#5B6475',
        },
        paper: '#F8FAFC',
        line: '#E2E8F0',
        signal: {
          DEFAULT: '#6D5BFF',
          deep: '#4F3DF5',
          soft: '#EDEAFF',
        },
        clinic: {
          DEFAULT: '#0FA98E',
          soft: '#E2F6F1',
        },
        construction: {
          DEFAULT: '#E8A33D',
          soft: '#FBF1DF',
        },
        danger: {
          DEFAULT: '#D64550',
          soft: '#FBE9EA',
        },
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        sans: ['"Public Sans"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 3px rgba(0, 0, 0, 0.05), 0 10px 20px -5px rgba(0, 0, 0, 0.03)',
        'card-hover':
          '0 1px 3px rgba(0, 0, 0, 0.06), 0 12px 28px -6px rgba(11, 18, 32, 0.10)',
        lift: '0 2px 4px rgba(11, 18, 32, 0.04), 0 24px 48px -16px rgba(11, 18, 32, 0.14)',
        pop: '0 1px 2px rgba(79, 61, 245, 0.4), 0 10px 24px -6px rgba(79, 61, 245, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.18)',
        input: '0 1px 2px rgba(11, 18, 32, 0.04)',
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
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(109, 91, 255, 0)' },
          '50%': { boxShadow: '0 0 0 4px rgba(109, 91, 255, 0.22)' },
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
      },
    },
  },
  plugins: [],
};

export default config;
