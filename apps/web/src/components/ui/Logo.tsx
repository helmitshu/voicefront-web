const SIZES = {
  sm: { box: 'h-7 w-7 rounded-lg', svg: 'h-3.5 w-3.5', text: 'text-base' },
  md: { box: 'h-9 w-9 rounded-[10px]', svg: 'h-[18px] w-[18px]', text: 'text-lg' },
  lg: { box: 'h-12 w-12 rounded-xl', svg: 'h-6 w-6', text: 'text-2xl' },
} as const;

/** Voice waveform mark: five rounded bars, tallest center — a spoken word. */
const BARS = [
  { x: 1.4, h: 8 },
  { x: 6.1, h: 15 },
  { x: 10.8, h: 21 },
  { x: 15.5, h: 12 },
  { x: 20.2, h: 6 },
];

export function Logo({
  size = 'md',
  tone = 'dark',
  withText = true,
}: {
  size?: keyof typeof SIZES;
  tone?: 'dark' | 'light';
  withText?: boolean;
}) {
  const s = SIZES[size];
  return (
    <span className="inline-flex items-center gap-2.5">
      <span
        aria-hidden
        className={`${s.box} inline-flex shrink-0 items-center justify-center bg-gradient-to-br from-signal to-signal-deep shadow-pop ring-1 ring-inset ring-white/20`}
      >
        <svg viewBox="0 0 24 24" fill="none" className={s.svg}>
          {BARS.map((bar) => (
            <rect
              key={bar.x}
              x={bar.x}
              y={12 - bar.h / 2}
              width="2.4"
              height={bar.h}
              rx="1.2"
              fill="white"
              fillOpacity="0.95"
            />
          ))}
        </svg>
      </span>
      {withText && (
        <span
          className={`font-display font-semibold tracking-tight ${s.text} ${
            tone === 'light' ? 'text-white' : 'text-ink'
          }`}
        >
          VoiceFront
        </span>
      )}
    </span>
  );
}
