'use client';

import { useEffect, useRef, useState } from 'react';
import {
  AgentApi,
  ApiError,
  OnboardingApi,
  VoiceApi,
  type OnboardingView,
} from '@/lib/api';
import { VoiceSession, type SimulatorPhase, type TranscriptEntry } from '@/lib/voice-client';
import { VAPI_VOICES, sampleUrlFor } from '@/domain/voice-catalog';
import { Button } from '@/components/ui/Button';
import { Waveform } from '@/components/ui/Waveform';
import { VoicePreviewButton } from '@/components/agent/VoicePreviewButton';

type UiPhase = 'idle' | 'requesting' | SimulatorPhase;

const PHASE_LABEL: Record<UiPhase, string> = {
  idle: 'Ready when you are',
  requesting: 'Preparing your receptionist…',
  connecting: 'Connecting…',
  listening: 'Listening — go ahead and speak',
  'assistant-speaking': 'Receptionist is speaking',
  ended: 'Call ended',
  error: 'Something went wrong',
};

export function StepVoiceTest({
  tested,
  personaName,
  initialVoiceId,
  onTested,
  onContinue,
  onError,
}: {
  tested: boolean;
  personaName: string;
  initialVoiceId: string;
  onTested: (view: OnboardingView) => void;
  /** Manual "move to the next step" — the user is in control of navigation. */
  onContinue: () => void;
  onError: (message: string) => void;
}) {
  const [phase, setPhase] = useState<UiPhase>('idle');
  const [volume, setVolume] = useState(0);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [callError, setCallError] = useState<string | null>(null);
  const [voiceUnavailable, setVoiceUnavailable] = useState(false);
  const [marking, setMarking] = useState(false);
  // The voice being tried in the simulator. Defaults to the saved voice; the
  // founder can switch it to A/B compare, and each pick is saved immediately.
  const [selectedVoiceId, setSelectedVoiceId] = useState(
    VAPI_VOICES.some((v) => v.id === initialVoiceId) ? initialVoiceId : VAPI_VOICES[0].id,
  );

  const sessionRef = useRef<VoiceSession | null>(null);
  const aliveRef = useRef(true);
  const hadCallRef = useRef(false);
  const completedRef = useRef(tested);
  const transcriptBoxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      sessionRef.current?.stop();
      sessionRef.current = null;
    };
  }, []);

  // Keep the live transcript pinned to the latest line.
  useEffect(() => {
    const box = transcriptBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [transcript]);

  async function markTested() {
    if (completedRef.current) return;
    completedRef.current = true;
    try {
      const { onboarding } = await OnboardingApi.completeStep('VOICE_TEST');
      if (aliveRef.current) onTested(onboarding);
    } catch (err) {
      completedRef.current = false;
      if (aliveRef.current) {
        onError(err instanceof ApiError ? err.message : 'Could not record the test. Please try again.');
      }
    }
  }

  async function startCall() {
    if (phase === 'requesting' || phase === 'connecting' || phase === 'listening' || phase === 'assistant-speaking') {
      return;
    }
    setCallError(null);
    setTranscript([]);
    setVolume(0);
    hadCallRef.current = false;
    setPhase('requesting');

    let sessionData;
    try {
      sessionData = await VoiceApi.webSession(selectedVoiceId);
    } catch (err) {
      if (!aliveRef.current) return;
      if (err instanceof ApiError && err.code === 'VOICE_NOT_CONFIGURED') {
        setVoiceUnavailable(true);
        setPhase('idle');
        return;
      }
      setPhase('error');
      setCallError(err instanceof ApiError ? err.message : 'Could not start the test call.');
      return;
    }
    if (!aliveRef.current) return;

    const session = new VoiceSession();
    sessionRef.current = session;
    await session.start(sessionData.publicKey, sessionData.assistant, {
      onPhase: (next) => {
        if (!aliveRef.current) return;
        if (next === 'listening') hadCallRef.current = true;
        setPhase(next);
        if (next === 'ended' && hadCallRef.current) void markTested();
      },
      onVolume: (level) => {
        if (aliveRef.current) setVolume(level);
      },
      onTranscript: (entry) => {
        if (aliveRef.current) setTranscript((current) => [...current, entry]);
      },
      onError: (message) => {
        if (aliveRef.current) setCallError(message);
      },
    });
  }

  function endCall() {
    sessionRef.current?.stop();
    sessionRef.current = null;
    setVolume(0);
    // If a real call was in flight, count it as a completed test.
    if (hadCallRef.current) {
      setPhase('ended');
      void markTested();
    } else {
      setPhase('idle');
    }
  }

  // Persist a voice change immediately, so going live (handled at the page
  // level) always uses the chosen voice without any deferred-save coupling.
  async function pickVoice(voiceId: string) {
    setSelectedVoiceId(voiceId);
    try {
      await AgentApi.update({ voiceProvider: 'vapi', voiceId });
    } catch {
      /* best-effort; the next save will catch it */
    }
  }

  const live = phase === 'connecting' || phase === 'listening' || phase === 'assistant-speaking';

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="font-display text-xl font-semibold text-ink">Talk to your receptionist</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Talk to {personaName} right here in your browser — exactly what your callers will experience. You&apos;ll
          need to allow microphone access.
        </p>
      </div>

      {/* Voice picker — compare voices live, then activate to keep the last one */}
      <div className="rounded-2xl border border-line bg-white p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">Voice</p>
            <p className="text-xs text-ink-muted">
              Switch and call again to compare. Your last pick is saved when you activate.
            </p>
          </div>
          <VoicePreviewButton
            sampleUrl={sampleUrlFor('vapi', selectedVoiceId)}
            voiceLabel={selectedVoiceId}
          />
        </div>
        <select
          value={selectedVoiceId}
          onChange={(e) => void pickVoice(e.target.value)}
          disabled={live}
          aria-label="Receptionist voice"
          className="mt-3 w-full rounded-xl border border-line bg-paper px-3 py-2.5 text-sm text-ink disabled:opacity-60"
        >
          {VAPI_VOICES.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label} — {v.description}
            </option>
          ))}
        </select>
        {live && (
          <p className="mt-1.5 text-xs text-ink-muted">End the call to switch voices, then call again.</p>
        )}
      </div>

      {/* Simulator stage */}
      <div className="flex flex-col items-center gap-5 rounded-2xl border border-line bg-ink px-6 py-10">
        <Waveform
          bars={32}
          active={live}
          level={phase === 'assistant-speaking' ? Math.max(volume, 0.55) : volume}
          tone="light"
          className="h-16 w-full max-w-md justify-center"
        />
        <p aria-live="polite" className="text-sm font-medium text-white/80">
          {PHASE_LABEL[phase]}
        </p>
        <div className="relative">
          {live && (
            <span
              aria-hidden
              className="absolute inset-0 animate-pulse-ring rounded-full bg-signal/50"
            />
          )}
          {live ? (
            <Button variant="danger" size="lg" onClick={endCall} className="relative">
              End test call
            </Button>
          ) : (
            <Button
              size="lg"
              onClick={startCall}
              loading={phase === 'requesting'}
              className="relative"
            >
              {tested || phase === 'ended' ? 'Call again' : `Start a test call with ${personaName}`}
            </Button>
          )}
        </div>
        {callError && (
          <p role="alert" className="max-w-md text-center text-sm text-[#ffb4ba]">
            {callError}
          </p>
        )}
      </div>

      {voiceUnavailable && (
        <div className="rounded-2xl border border-construction/40 bg-construction-soft p-5">
          <p className="text-sm font-semibold text-ink">Browser testing isn&apos;t configured on this server yet</p>
          <p className="mt-1 text-sm text-ink-muted">
            The platform operator hasn&apos;t added a voice public key, so in-browser calls are unavailable. You can
            still finish setup and test by phone once your number is connected.
          </p>
          {!tested && (
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              loading={marking}
              onClick={async () => {
                setMarking(true);
                await markTested();
                setMarking(false);
              }}
            >
              Mark this step complete
            </Button>
          )}
        </div>
      )}

      {/* Live transcript */}
      {transcript.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-medium text-ink">Live transcript</p>
          <div
            ref={transcriptBoxRef}
            className="flex max-h-64 flex-col gap-2.5 overflow-y-auto rounded-2xl border border-line bg-white p-4"
          >
            {transcript.map((entry, index) => (
              <div
                key={index}
                className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                  entry.role === 'assistant'
                    ? 'self-start bg-signal-soft text-ink'
                    : 'self-end bg-ink text-white'
                }`}
              >
                <span className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide opacity-60">
                  {entry.role === 'assistant' ? personaName : 'You'}
                </span>
                {entry.text}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Manual forward — the "go live" action lives at the page level so it's
          available wherever the user finishes setup. */}
      <div className="flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-ink-muted">
          {tested
            ? 'Sounds great, right? Finish the quick steps and you’re ready to go live.'
            : 'Have a quick chat with it, then continue to finish setup.'}
        </p>
        <Button size="lg" onClick={onContinue}>
          Continue →
        </Button>
      </div>
    </div>
  );
}
