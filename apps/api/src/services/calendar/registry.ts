import type { CalendarProvider, ProviderId } from './types';
import { googleProvider } from './google';
import { microsoftProvider } from './microsoft';

const PROVIDERS: Record<ProviderId, CalendarProvider> = {
  GOOGLE: googleProvider,
  MICROSOFT: microsoftProvider,
};

export function getProvider(id: ProviderId): CalendarProvider {
  return PROVIDERS[id];
}

export const ALL_PROVIDERS: CalendarProvider[] = [googleProvider, microsoftProvider];
