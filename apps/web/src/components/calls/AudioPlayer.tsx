'use client';

import { useEffect, useRef, useState } from 'react';
import { formatDuration } from '@/lib/format';

const RATES = [1, 1.25, 1.5, 2] as const;

export function AudioPlayer({
  src,
  fallbackDurationSeconds,
}: {
  src: string;
  /** Used when the stream doesn't report a finite duration up front. */
  fallbackDurationSeconds: number;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(fallbackDurationSeconds);
  const [rateIndex, setRateIndex] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      audio?.pause();
    };
  }, []);

  function readDuration(audio: HTMLAudioElement) {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      setDuration(audio.duration);
    }
  }

  async function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
    } else {
      try {
        await audio.play();
      } catch {
        setFailed(true);
      }
    }
  }

  function seek(value: number) {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = value;
    setCurrent(value);
  }

  function cycleRate() {
    const next = (rateIndex + 1) % RATES.length;
    setRateIndex(next);
    if (audioRef.current) audioRef.current.playbackRate = RATES[next];
  }

  if (failed) {
    return (
      <p className="rounded-xl bg-paper px-4 py-3 text-sm text-ink-muted">
        The recording couldn&apos;t be played. Reload the page to get a fresh audio link.
      </p>
    );
  }

  return (
    <div className="flex items-center gap-4 rounded-2xl bg-ink px-4 py-3.5">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(e) => readDuration(e.currentTarget)}
        onDurationChange={(e) => readDuration(e.currentTarget)}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
        }}
        onError={() => setFailed(true)}
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pause recording' : 'Play recording'}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-signal text-white shadow-pop transition-colors hover:bg-signal-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        {playing ? (
          <span aria-hidden className="flex gap-1">
            <span className="h-3.5 w-1 rounded-sm bg-white" />
            <span className="h-3.5 w-1 rounded-sm bg-white" />
          </span>
        ) : (
          <span
            aria-hidden
            className="ml-0.5 block h-0 w-0 border-y-[7px] border-l-[11px] border-y-transparent border-l-white"
          />
        )}
      </button>
      <span className="w-12 shrink-0 text-right font-mono text-xs text-white/80">{formatDuration(current)}</span>
      <input
        type="range"
        min={0}
        max={Math.max(duration, 1)}
        step={0.1}
        value={Math.min(current, duration)}
        onChange={(e) => seek(Number(e.target.value))}
        aria-label="Seek"
        className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-white/20 accent-signal"
      />
      <span className="w-12 shrink-0 font-mono text-xs text-white/80">{formatDuration(duration)}</span>
      <button
        type="button"
        onClick={cycleRate}
        aria-label="Change playback speed"
        className="shrink-0 rounded-lg border border-white/20 px-2 py-1 font-mono text-xs text-white/90 transition-colors hover:bg-white/10"
      >
        {RATES[rateIndex]}×
      </button>
    </div>
  );
}
