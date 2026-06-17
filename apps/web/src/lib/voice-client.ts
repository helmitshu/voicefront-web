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
  /** Ava called set_demo_screen — switch the on-screen panel to `screen`.
   *  Fired live from the SDK's tool-call event for instant, in-step visuals. */
  onScreen?: (screen: string) => void;
}

interface TranscriptMessage {
  type?: string;
  transcriptType?: string;
  role?: string;
  transcript?: string;
}

/** A function/tool call surfaced by the SDK's `message` event. Vapi has used a
 *  couple of shapes over versions, so we read all of them defensively. */
interface ToolCallMessage {
  type?: string;
  toolCalls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
  toolCallList?: Array<{ function?: { name?: string; arguments?: unknown } }>;
  functionCall?: { name?: string; parameters?: unknown };
}

/** Pulls the `screen` out of a set_demo_screen tool call, or null if this
 *  message isn't one. Handles arguments as an object or a JSON string. */
function readScreenFromToolCall(msg: ToolCallMessage): string | null {
  const fromList = [...(msg.toolCalls ?? []), ...(msg.toolCallList ?? [])].find(
    (c) => c.function?.name === 'set_demo_screen',
  );
  let raw: unknown;
  if (fromList) raw = fromList.function?.arguments;
  else if (msg.functionCall?.name === 'set_demo_screen') raw = msg.functionCall.parameters;
  else return null;

  let args: unknown = raw;
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const screen = (args as { screen?: unknown } | null)?.screen;
  return typeof screen === 'string' ? screen : null;
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
      const msg = raw as TranscriptMessage & ToolCallMessage;
      // Ava driving the prospect's screen — react instantly, no server round-trip.
      if (msg?.type === 'tool-calls' || msg?.type === 'function-call') {
        const screen = readScreenFromToolCall(msg);
        if (screen && handlers.onScreen) handlers.onScreen(screen);
        return;
      }
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
