const SIZES = {
  sm: { box: 'h-[34px] w-[34px]', text: 'text-base' },
  md: { box: 'h-[42px] w-[42px]', text: 'text-[19px]' },
  lg: { box: 'h-12 w-12', text: 'text-2xl' },
} as const;

/** Bar heights (%), tallest center — the demo's waveform geometry. */
const BAR_HEIGHTS = [42, 68, 100, 64, 40];

/**
 * The VoiceFront mark, ported from the approved design demo: a dark teal
 * tile (identical in every theme) holding five gradient waveform bars, with
 * the wordmark set in the display face and its period in the theme glow.
 * `animated` (shell only) adds the orbiting ring, the equalizer motion and
 * the light sweep from globals.css — all stilled under reduced motion.
 */
export function Logo({
  size = 'md',
  tone = 'dark',
  withText = true,
  animated = false,
}: {
  size?: keyof typeof SIZES;
  tone?: 'dark' | 'light';
  withText?: boolean;
  animated?: boolean;
}) {
  const s = SIZES[size];
  return (
    <span className="inline-flex items-center gap-3">
      <span className="relative inline-flex flex-none">
        {animated && <span aria-hidden className="logo-ring" />}
        <span
          aria-hidden
          className={`logo-mark relative inline-flex shrink-0 items-center justify-center overflow-hidden ${s.box}`}
        >
          <span className="flex h-[56%] w-[62%] items-center justify-center gap-[9%]">
            {BAR_HEIGHTS.map((height, i) => (
              <span
                key={height}
                className={`logo-bar ${animated ? 'logo-eq-bar' : ''}`}
                style={{
                  height: `${height}%`,
                  ...(animated ? { animationDelay: `${i * 0.18}s` } : undefined),
                }}
              />
            ))}
          </span>
          {animated && <span aria-hidden className="logo-sweep" />}
        </span>
      </span>
      {withText && (
        <span
          className={`font-display font-bold tracking-[-0.02em] ${s.text} ${
            tone === 'light' ? 'text-white' : 'text-ink'
          }`}
        >
          VoiceFront<span className="text-glow">.</span>
        </span>
      )}
    </span>
  );
}
