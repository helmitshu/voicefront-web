/**
 * Voice options the platform exposes to tenants. Kept in lockstep with the
 * provider's public catalog (docs.vapi.ai/providers/voice/vapi-voices):
 * all Vapi-native entries are V2 voices ("realistic, human") and the
 * assistant builder opts them into version 2.
 *
 * For ElevenLabs the voiceId is a free-form ElevenLabs voice ID — the
 * operator adds their ElevenLabs API key in the provider dashboard
 * (Integrations), which syncs their voice library.
 */
export const VOICE_PROVIDERS = ['vapi', '11labs'] as const;
export type VoiceProvider = (typeof VOICE_PROVIDERS)[number];

export const VAPI_VOICE_IDS = [
  // Female
  'Emma',
  'Clara',
  'Layla',
  'Savannah',
  'Naina',
  // Male
  'Elliot',
  'Kai',
  'Nico',
  'Sid',
  'Neil',
  'Sagar',
  'Godfrey',
] as const;

export const BACKGROUND_SOUNDS = ['office', 'off'] as const;
export type BackgroundSound = (typeof BACKGROUND_SOUNDS)[number];

export function isKnownVapiVoice(voiceId: string): boolean {
  return (VAPI_VOICE_IDS as readonly string[]).includes(voiceId);
}
