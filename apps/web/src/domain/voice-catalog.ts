/**
 * Voice options shown in the receptionist settings. Mirrors the API's
 * domain/voice-catalog.ts and the provider's public catalog — all built-in
 * entries are Vapi V2 voices (the realistic "sounds human" generation);
 * the server opts them into version 2 on every call.
 */

export type VoiceProvider = 'vapi' | '11labs';

export interface VoiceOption {
  id: string;
  label: string;
  description: string;
  /** Local audio sample so customers can hear the voice before saving. */
  sampleUrl?: string;
}

export const VOICE_PROVIDER_OPTIONS: Array<{ value: VoiceProvider; label: string }> = [
  { value: 'vapi', label: 'Built-in voices (recommended)' },
  { value: '11labs', label: 'ElevenLabs' },
];

/** Vapi V2 voices — docs.vapi.ai/providers/voice/vapi-voices. */
export const VAPI_VOICES: VoiceOption[] = [
  { id: 'Emma', label: 'Emma', description: 'Female · warm, conversational — most human', sampleUrl: '/voice-samples/emma.wav' },
  { id: 'Clara', label: 'Clara', description: 'Female · warm, professional', sampleUrl: '/voice-samples/clara.wav' },
  { id: 'Layla', label: 'Layla', description: 'Female · bright, cheerful', sampleUrl: '/voice-samples/layla.wav' },
  { id: 'Savannah', label: 'Savannah', description: 'Female · Southern, straightforward', sampleUrl: '/voice-samples/savannah.wav' },
  { id: 'Naina', label: 'Naina', description: 'Female · calm, collected, professional', sampleUrl: '/voice-samples/naina.wav' },
  { id: 'Elliot', label: 'Elliot', description: 'Male · friendly, soothing, professional', sampleUrl: '/voice-samples/elliot.wav' },
  { id: 'Kai', label: 'Kai', description: 'Male · friendly, relaxed, approachable', sampleUrl: '/voice-samples/kai.wav' },
  { id: 'Nico', label: 'Nico', description: 'Male · young, casual, natural', sampleUrl: '/voice-samples/nico.wav' },
  { id: 'Sid', label: 'Sid', description: 'Male · smooth, deep-toned, laid-back', sampleUrl: '/voice-samples/sid.wav' },
  { id: 'Neil', label: 'Neil', description: 'Male · clear, professional', sampleUrl: '/voice-samples/neil.wav' },
  { id: 'Sagar', label: 'Sagar', description: 'Male · steady, professional', sampleUrl: '/voice-samples/sagar.wav' },
  { id: 'Godfrey', label: 'Godfrey', description: 'Male · young, energetic', sampleUrl: '/voice-samples/godfrey.wav' },
];

/** Look up a voice's sample URL by provider + id, if one exists locally. */
export function sampleUrlFor(provider: VoiceProvider, voiceId: string): string | undefined {
  const list = provider === 'vapi' ? VAPI_VOICES : ELEVENLABS_PRESETS;
  return list.find((v) => v.id === voiceId)?.sampleUrl;
}

/**
 * ElevenLabs premade voices (same IDs in every ElevenLabs account).
 * Requires your ElevenLabs API key under Integrations in the provider
 * dashboard; custom/cloned voices work too — paste any voice ID.
 */
export const ELEVENLABS_PRESETS: VoiceOption[] = [
  { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel', description: 'Female · calm, natural narration' },
  { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Bella', description: 'Female · soft, friendly' },
  { id: 'AZnzlk1XvdvUeBnXmlld', label: 'Domi', description: 'Female · confident, upbeat' },
  { id: 'pNInz6obpgDQGcFmaJgB', label: 'Adam', description: 'Male · deep, assured' },
  { id: 'ErXwobaYiN019PkySvjV', label: 'Antoni', description: 'Male · well-rounded, warm' },
  { id: 'TxGEqnHWrfWFTfGW9XjX', label: 'Josh', description: 'Male · deep, calm' },
];

export const BACKGROUND_SOUND_OPTIONS = [
  {
    value: 'office',
    label: 'Office ambience (recommended)',
    description: 'Subtle front-desk background noise — callers hear a real office, not a bot in a vacuum.',
  },
  { value: 'off', label: 'Off', description: 'Studio-clean audio with no background.' },
] as const;

export function isPresetElevenLabsVoice(voiceId: string): boolean {
  return ELEVENLABS_PRESETS.some((voice) => voice.id === voiceId);
}
