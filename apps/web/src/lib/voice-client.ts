import type { WebAssistantConfig } from '@/lib/api';

/**
 * Thin wrapper around the voice web SDK so UI components never import it
 * directly. The SDK touches browser-only APIs at module scope, so it is
 * loaded with a dynamic import on first use (client side only).
 */

type VapiCtor = typeof import('@vapi-ai/web').default;
type VapiInstance = InstanceType<VapiCtor>;

export type SimulatorPhase =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'assistant-speaking'
  | 'ended'
  | 'error';

export interface TranscriptEntry {
  role: 'assistant' | 'user';
  text: string;
}

export interface VoiceSessionHandlers {
  onPhase: (phase: SimulatorPhase) => void;
  /** Microphone/assistant level, 0..1 — drives the waveform. */
  onVolume: (level: number) => void;
  onTranscript: (entry: TranscriptEntry) => void;
  onError: (message: string) => void;
}

interface TranscriptMessage {
  type?: string;
  transcriptType?: string;
  role?: string;
  transcript?: string;
}

export class VoiceSession {
  private vapi: VapiInstance | null = null;
  private stopped = false;

  /**
   * Must be called from a user gesture (mic permission + autoplay policies).
   * Safe to call stop() at any point, including while start() is loading.
   */
  async start(publicKey: string, assistant: WebAssistantConfig, handlers: VoiceSessionHandlers): Promise<void> {
    handlers.onPhase('connecting');
    let Vapi: VapiCtor;
    try {
      Vapi = (await import('@vapi-ai/web')).default;
    } catch {
      handlers.onPhase('error');
      handlers.onError('The voice module failed to load. Check your connection and try again.');
      return;
    }
    if (this.stopped) return; // user cancelled while the module was loading

    const vapi = new Vapi(publicKey);
    this.vapi = vapi;

    vapi.on('call-start', () => handlers.onPhase('listening'));
    vapi.on('speech-start', () => handlers.onPhase('assistant-speaking'));
    vapi.on('speech-end', () => handlers.onPhase('listening'));
    vapi.on('volume-level', (level: number) => {
      handlers.onVolume(Math.max(0, Math.min(1, level)));
    });
    vapi.on('call-end', () => {
      handlers.onVolume(0);
      handlers.onPhase('ended');
    });
    vapi.on('error', (err: unknown) => {
      const message =
        typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message: unknown }).message === 'string'
          ? (err as { message: string }).message
          : 'The call hit a problem and had to end.';
      handlers.onVolume(0);
      handlers.onPhase('error');
      handlers.onError(message);
    });
    vapi.on('message', (raw: unknown) => {
      const msg = raw as TranscriptMessage;
      if (msg?.type !== 'transcript' || msg.transcriptType !== 'final') return;
      if (typeof msg.transcript !== 'string' || msg.transcript.trim().length === 0) return;
      handlers.onTranscript({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        text: msg.transcript.trim(),
      });
    });

    try {
      // The assistant payload is built server-side; the SDK accepts it as an
      // inline assistant config. Cast is intentional: the shape is owned by
      // the server's assistant-builder, not duplicated here.
      await vapi.start(assistant as never);
    } catch (err) {
      if (this.stopped) return;
      handlers.onPhase('error');
      handlers.onError(
        err instanceof Error && err.message
          ? err.message
          : 'Could not start the test call. Check microphone permissions and try again.',
      );
    }
  }

  /** Idempotent; detaches listeners so late events cannot touch unmounted UI. */
  stop(): void {
    this.stopped = true;
    if (this.vapi) {
      try {
        this.vapi.removeAllListeners();
        this.vapi.stop();
      } catch {
        /* already stopped */
      }
      this.vapi = null;
    }
  }
}
