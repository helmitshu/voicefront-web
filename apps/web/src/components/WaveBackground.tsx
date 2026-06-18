/**
 * Ambient backdrop for the marketing site — a soft, premium sound-wave field.
 *
 * Two things layer up: blurred aurora blobs that give the canvas depth and a
 * gentle teal glow, and a few translucent gradient wave ribbons that drift and
 * parallax against each other so the field feels alive without ever being
 * busy. Everything animates by transform only, so the heavy blur is cached and
 * GPU-composited — the motion stays buttery, which is what makes it easy on the
 * eyes. Purely decorative: fixed, behind content, click-through, and it holds
 * still for anyone who prefers reduced motion.
 */

const VW = 1200;
const VH = 600;

/** A filled sine wave across the canvas, closed to the bottom edge. */
function wavePath(phase: number, amplitude: number, baseline: number): string {
  const period = 560;
  const step = 20;
  let d = '';
  for (let x = 0; x <= VW; x += step) {
    const y = baseline + amplitude * Math.sin((x / period) * Math.PI * 2 + phase);
    d += x === 0 ? `M ${x} ${y.toFixed(2)}` : ` L ${x} ${y.toFixed(2)}`;
  }
  d += ` L ${VW} ${VH} L 0 ${VH} Z`;
  return d;
}

interface WaveLayer {
  id: string;
  phase: number;
  amplitude: number;
  baseline: number;
  color: string;
  alpha: number;
  sway: string;
  blur: number;
  /** Bright crest highlight, for the front ribbon only. */
  crest?: boolean;
}

const WAVES: WaveLayer[] = [
  { id: 'bgw1', phase: 3.3, amplitude: 30, baseline: 410, color: '#0A574F', alpha: 0.1, sway: 'bg-wave-3', blur: 14 },
  { id: 'bgw2', phase: 1.7, amplitude: 36, baseline: 350, color: '#10A98E', alpha: 0.14, sway: 'bg-wave-2', blur: 10 },
  { id: 'bgw3', phase: 0, amplitude: 44, baseline: 300, color: '#0E6B63', alpha: 0.2, sway: 'bg-wave-1', blur: 6, crest: true },
];

export function WaveBackground() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {/* Aurora glow — soft, blurred color fields drifting for depth. */}
      <div
        className="bg-aurora-a absolute -left-[15%] -top-[20%] h-[75vh] w-[75vh] rounded-full"
        style={{
          background: 'radial-gradient(circle, rgba(16,169,142,0.34), transparent 68%)',
          filter: 'blur(60px)',
        }}
      />
      <div
        className="bg-aurora-b absolute -right-[12%] top-[18%] h-[70vh] w-[70vh] rounded-full"
        style={{
          background: 'radial-gradient(circle, rgba(14,107,99,0.32), transparent 68%)',
          filter: 'blur(64px)',
        }}
      />
      <div
        className="bg-aurora-c absolute bottom-[-18%] left-[28%] h-[68vh] w-[68vh] rounded-full"
        style={{
          background: 'radial-gradient(circle, rgba(45,125,79,0.22), transparent 70%)',
          filter: 'blur(72px)',
        }}
      />

      {/* Gradient wave ribbons — translucent, blurred, parallaxing. */}
      {WAVES.map((w) => (
        <div
          key={w.id}
          className={`${w.sway} absolute inset-x-[-6%] bottom-0 top-0`}
          style={{ filter: `blur(${w.blur}px)` }}
        >
          <svg viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="none" className="h-full w-full">
            <defs>
              <linearGradient id={w.id} x1="0" y1={w.baseline - w.amplitude} x2="0" y2={VH} gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor={w.color} stopOpacity={w.alpha} />
                <stop offset="55%" stopColor={w.color} stopOpacity={w.alpha * 0.35} />
                <stop offset="100%" stopColor={w.color} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={wavePath(w.phase, w.amplitude, w.baseline)} fill={`url(#${w.id})`} />
            {w.crest && (
              <path
                d={wavePath(w.phase, w.amplitude, w.baseline)}
                fill="none"
                stroke={w.color}
                strokeOpacity={0.28}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
        </div>
      ))}
    </div>
  );
}
