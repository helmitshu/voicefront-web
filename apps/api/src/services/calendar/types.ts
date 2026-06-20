/**
 * Provider-agnostic calendar interface. Google Calendar and Microsoft Graph
 * each implement it; the rest of the app speaks only in these terms so adding a
 * third provider later is a single new file.
 */

export type ProviderId = 'GOOGLE' | 'MICROSOFT';

export interface OAuthTokens {
  accessToken: string;
  /** May be absent on a refresh response — callers keep the prior one then. */
  refreshToken?: string;
  /** Absolute expiry of the access token. */
  expiresAt: Date;
  /** The connected account's email, when the provider returns it. */
  accountEmail?: string;
}

export interface BusyInterval {
  start: Date;
  end: Date;
}

export interface CalendarEventInput {
  summary: string;
  description?: string;
  start: Date;
  end: Date;
  /** IANA timezone the appointment is anchored to. */
  timezone: string;
}

export interface CalendarProvider {
  id: ProviderId;
  /** True only when the operator has configured this provider's OAuth client. */
  isConfigured(): Promise<boolean>;
  /** Consent URL to send the browser to; `state` round-trips our signed token. */
  authUrl(state: string): Promise<string>;
  /** Exchange an auth code for tokens (initial connect). */
  exchangeCode(code: string): Promise<OAuthTokens>;
  /** Trade a refresh token for a fresh access token. */
  refresh(refreshToken: string): Promise<OAuthTokens>;
  /** Busy intervals on the given calendar within [from, to]. */
  getBusy(accessToken: string, calendarId: string, from: Date, to: Date): Promise<BusyInterval[]>;
  /** Create an event; returns the provider's event id. */
  createEvent(accessToken: string, calendarId: string, event: CalendarEventInput): Promise<string>;
  /** Update an existing event in place. */
  updateEvent(accessToken: string, calendarId: string, eventId: string, event: CalendarEventInput): Promise<void>;
  /** Delete an event. Missing events are treated as already-gone (no throw). */
  deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void>;
}

/** Raised when a provider call fails so callers can record + surface it. */
export class CalendarApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    /** True when the failure means our tokens are dead and a reconnect is needed. */
    public readonly needsReconnect = false,
  ) {
    super(message);
    this.name = 'CalendarApiError';
  }
}
