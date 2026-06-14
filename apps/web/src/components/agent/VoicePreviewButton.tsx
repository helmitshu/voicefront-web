'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Plays a short sample of the selected voice so customers can hear it before
 * saving — the same samples Vapi uses in its dashboard. Self-contained: owns
 * one <audio> element, toggles play/pause, and resets when the clip ends.
 */
export function VoicePreviewButton({
  sampleUrl,
  voiceLabel,
  disabled = false,
}: {
  sampleUrl?: string;
  voiceLabel: string;
  disabled?: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  // Swap the source whenever the selected voice changes; stop any playback.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
    setPlaying(false);
    setFailed(false);
  }, [sampleUrl]);

  if (!sampleUrl) return null;

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      audio.currentTime = 0;
      setPlaying(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    audio
      .play()
      .then(() => {
        setPlaying(true);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
        setFailed(true);
      });
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={toggle}
        disabled={disabled || loading}
        aria-label={playing ? `Stop ${voiceLabel} preview` : `Hear ${voiceLabel}`}
        className="inline-flex items-center gap-2 rounded-full border border-signal/30 bg-signal-soft/50 px-3.5 py-1.5 text-[13px] font-semibold text-signal-deep transition-colors hover:bg-signal-soft disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? (
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 animate-spin" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M12 3a9 9 0 1 0 9 9" strokeLinecap="round" />
          </svg>
        ) : playing ? (
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor">
            <rect x="4" y="3" width="3.2" height="10" rx="1" />
            <rect x="8.8" y="3" width="3.2" height="10" rx="1" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor">
            <path d="M5 3.2v9.6c0 .5.55.82.98.56l7.2-4.8a.67.67 0 0 0 0-1.12l-7.2-4.8A.67.67 0 0 0 5 3.2Z" />
          </svg>
        )}
        {playing ? 'Stop' : `Hear ${voiceLabel}`}
      </button>
      {failed && <span className="text-xs text-ink-muted">Sample unavailable.</span>}
      <audio
        ref={audioRef}
        src={sampleUrl}
        preload="none"
        onEnded={() => setPlaying(false)}
        onError={() => {
          setPlaying(false);
          setLoading(false);
          setFailed(true);
        }}
      />
    </span>
  );
}
