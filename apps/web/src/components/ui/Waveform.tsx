'use client';

/**
 * The VoiceFront signature element: a row of sound bars.
 * - `active` animates the bars (CSS keyframes, GPU-friendly transforms).
 * - `level` (0..1) scales amplitude so live calls visibly react to audio.
 * - Honors prefers-reduced-motion via globals.css (animation is disabled and
 *   bars settle at a level-derived static height).
 */
export function Waveform({
  bars = 24,
  active = false,
  level = 0,
  tone = 'signal',
  // Height + alignment live here (not the base class) so callers can size the
  // mark down — `h-12`/`justify-center` are only the defaults, not locked in.
  className = 'h-12 justify-center',
}: {
  bars?: number;
  active?: boolean;
  level?: number;
  tone?: 'signal' | 'light' | 'muted' | 'gold';
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(1, level));
  const color =
    tone === 'light'
      ? 'bg-white/80'
      : tone === 'muted'
        ? 'bg-ink-muted/40'
        : tone === 'gold'
          ? 'bg-gold-light'
          : 'bg-signal';

  return (
    <div aria-hidden className={`flex items-center gap-[3px] ${className}`}>
      {Array.from({ length: bars }, (_, i) => {
        // Deterministic pseudo-random heights so SSR and client markup match.
        const seed = Math.abs(Math.sin((i + 1) * 12.9898) * 43758.5453) % 1;
        const base = 0.25 + seed * 0.75;
        // Round to 3 dp so server- and client-rendered transforms match exactly
        // (raw floats drift at ~1e-15 between Node and the browser → hydration warning).
        const amplitude = Number((active ? base * (0.35 + clamped * 0.65) : base * 0.3).toFixed(3));
        return (
          <span
            key={i}
            className={`w-[3px] rounded-full ${color} ${active ? 'animate-wave-bar' : 'transition-transform duration-300'}`}
            style={{
              height: '100%',
              transform: active ? undefined : `scaleY(${amplitude})`,
              animationDelay: active ? `${(i % 8) * 0.09}s` : undefined,
              // Custom property consumed by the keyframes ceiling via scale.
              ...(active ? { ['--wave-max' as string]: String(amplitude) } : {}),
            }}
          />
        );
      })}
    </div>
  );
}
