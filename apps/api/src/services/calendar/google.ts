import { publicApiUrl } from '../../config/env';
import { getSettingValue } from '../platform-config.service';
import {
  CalendarApiError,
  type BusyInterval,
  type CalendarEventInput,
  type CalendarProvider,
  type OAuthTokens,
} from './types';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/calendar/v3';
// events: create/update/delete · calendar.readonly: freeBusy · openid/email: account label
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'openid',
  'email',
].join(' ');

function redirectUri(): string {
  if (!publicApiUrl) throw new CalendarApiError('Public API URL is not configured.', 500);
  return `${publicApiUrl}/api/calendar/google/callback`;
}

async function clientCreds(): Promise<{ id: string; secret: string } | null> {
  const [id, secret] = await Promise.all([
    getSettingValue('GOOGLE_OAUTH_CLIENT_ID'),
    getSettingValue('GOOGLE_OAUTH_CLIENT_SECRET'),
  ]);
  return id && secret ? { id, secret } : null;
}

/** Pull the email claim out of a Google id_token without verifying (TLS-trusted). */
function emailFromIdToken(idToken?: string): string | undefined {
  if (!idToken) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8'));
    return typeof payload.email === 'string' ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

function tokensFromResponse(json: Record<string, unknown>, fallbackRefresh?: string): OAuthTokens {
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
  return {
    accessToken: String(json.access_token),
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : fallbackRefresh,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    accountEmail: emailFromIdToken(json.id_token as string | undefined),
  };
}

async function postForm(body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const desc = (json.error_description as string) || (json.error as string) || 'token request failed';
    // invalid_grant on refresh = the user revoked us; force a reconnect.
    throw new CalendarApiError(`Google: ${desc}`, res.status, json.error === 'invalid_grant');
  }
  return json;
}

export const googleProvider: CalendarProvider = {
  id: 'GOOGLE',

  async isConfigured() {
    return (await clientCreds()) !== null;
  },

  async authUrl(state) {
    const creds = await clientCreds();
    if (!creds) throw new CalendarApiError('Google calendar is not configured.', 503);
    const params = new URLSearchParams({
      client_id: creds.id,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent', // force a refresh_token even on re-consent
      state,
    });
    return `${AUTH_ENDPOINT}?${params.toString()}`;
  },

  async exchangeCode(code) {
    const creds = await clientCreds();
    if (!creds) throw new CalendarApiError('Google calendar is not configured.', 503);
    const json = await postForm({
      code,
      client_id: creds.id,
      client_secret: creds.secret,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    });
    return tokensFromResponse(json);
  },

  async refresh(refreshToken) {
    const creds = await clientCreds();
    if (!creds) throw new CalendarApiError('Google calendar is not configured.', 503);
    const json = await postForm({
      refresh_token: refreshToken,
      client_id: creds.id,
      client_secret: creds.secret,
      grant_type: 'refresh_token',
    });
    return tokensFromResponse(json, refreshToken);
  },

  async getBusy(accessToken, calendarId, from, to) {
    const res = await fetch(`${API_BASE}/freeBusy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        items: [{ id: calendarId }],
      }),
    });
    if (!res.ok) throw await apiError(res, 'freeBusy');
    const json = (await res.json()) as {
      calendars?: Record<string, { busy?: { start: string; end: string }[] }>;
    };
    // Google resolves "primary" to the user's actual email in the response key,
    // so looking up by the sent calendarId misses. Flatten all returned calendars.
    const busy = Object.values(json.calendars ?? {}).flatMap((c) => c.busy ?? []);
    return busy.map((b): BusyInterval => ({ start: new Date(b.start), end: new Date(b.end) }));
  },

  async createEvent(accessToken, calendarId, event) {
    const res = await fetch(`${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(eventBody(event)),
    });
    if (!res.ok) throw await apiError(res, 'createEvent');
    const json = (await res.json()) as { id?: string };
    if (!json.id) throw new CalendarApiError('Google createEvent returned no id', 502);
    return json.id;
  },

  async updateEvent(accessToken, calendarId, eventId, event) {
    const res = await fetch(
      `${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(eventBody(event)),
      },
    );
    if (!res.ok && res.status !== 404 && res.status !== 410) throw await apiError(res, 'updateEvent');
  },

  async deleteEvent(accessToken, calendarId, eventId) {
    const res = await fetch(
      `${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
    );
    // 410 = already deleted, 404 = never existed — both fine for our purposes.
    if (!res.ok && res.status !== 404 && res.status !== 410) throw await apiError(res, 'deleteEvent');
  },
};

function eventBody(event: CalendarEventInput) {
  return {
    summary: event.summary,
    description: event.description,
    start: { dateTime: event.start.toISOString(), timeZone: event.timezone },
    end: { dateTime: event.end.toISOString(), timeZone: event.timezone },
  };
}

async function apiError(res: Response, op: string): Promise<CalendarApiError> {
  const text = await res.text().catch(() => '');
  return new CalendarApiError(`Google ${op} failed (${res.status}): ${text.slice(0, 200)}`, res.status, res.status === 401);
}
