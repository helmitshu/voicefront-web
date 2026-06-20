import { publicApiUrl } from '../../config/env';
import { getSettingValue } from '../platform-config.service';
import {
  CalendarApiError,
  type BusyInterval,
  type CalendarEventInput,
  type CalendarProvider,
  type OAuthTokens,
} from './types';

const AUTH_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const SCOPES = ['offline_access', 'openid', 'email', 'Calendars.ReadWrite'].join(' ');

function redirectUri(): string {
  if (!publicApiUrl) throw new CalendarApiError('Public API URL is not configured.', 500);
  return `${publicApiUrl}/api/calendar/microsoft/callback`;
}

async function clientCreds(): Promise<{ id: string; secret: string } | null> {
  const [id, secret] = await Promise.all([
    getSettingValue('MICROSOFT_OAUTH_CLIENT_ID'),
    getSettingValue('MICROSOFT_OAUTH_CLIENT_SECRET'),
  ]);
  return id && secret ? { id, secret } : null;
}

function emailFromIdToken(idToken?: string): string | undefined {
  if (!idToken) return undefined;
  try {
    const p = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8'));
    return (p.email as string) || (p.preferred_username as string) || undefined;
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
    throw new CalendarApiError(`Microsoft: ${desc}`, res.status, json.error === 'invalid_grant');
  }
  return json;
}

/** Graph wants "yyyy-MM-ddTHH:mm:ss" + a separate timeZone; we always send UTC. */
function utcNaive(d: Date): string {
  return d.toISOString().slice(0, 19);
}

function eventBody(event: CalendarEventInput) {
  return {
    subject: event.summary,
    body: { contentType: 'text', content: event.description ?? '' },
    start: { dateTime: utcNaive(event.start), timeZone: 'UTC' },
    end: { dateTime: utcNaive(event.end), timeZone: 'UTC' },
  };
}

async function apiError(res: Response, op: string): Promise<CalendarApiError> {
  const text = await res.text().catch(() => '');
  return new CalendarApiError(`Microsoft ${op} failed (${res.status}): ${text.slice(0, 200)}`, res.status, res.status === 401);
}

export const microsoftProvider: CalendarProvider = {
  id: 'MICROSOFT',

  async isConfigured() {
    return (await clientCreds()) !== null;
  },

  async authUrl(state) {
    const creds = await clientCreds();
    if (!creds) throw new CalendarApiError('Microsoft calendar is not configured.', 503);
    const params = new URLSearchParams({
      client_id: creds.id,
      response_type: 'code',
      redirect_uri: redirectUri(),
      response_mode: 'query',
      scope: SCOPES,
      state,
    });
    return `${AUTH_ENDPOINT}?${params.toString()}`;
  },

  async exchangeCode(code) {
    const creds = await clientCreds();
    if (!creds) throw new CalendarApiError('Microsoft calendar is not configured.', 503);
    const json = await postForm({
      client_id: creds.id,
      client_secret: creds.secret,
      code,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
      scope: SCOPES,
    });
    return tokensFromResponse(json);
  },

  async refresh(refreshToken) {
    const creds = await clientCreds();
    if (!creds) throw new CalendarApiError('Microsoft calendar is not configured.', 503);
    const json = await postForm({
      client_id: creds.id,
      client_secret: creds.secret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: SCOPES,
    });
    return tokensFromResponse(json, refreshToken);
  },

  // Microsoft v1 targets the user's default calendar; calendarId is unused.
  async getBusy(accessToken, _calendarId, from, to) {
    const url =
      `${GRAPH_BASE}/me/calendarView?startDateTime=${from.toISOString()}&endDateTime=${to.toISOString()}` +
      `&$select=start,end,showAs,isCancelled&$top=200`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.timezone="UTC"' },
    });
    if (!res.ok) throw await apiError(res, 'calendarView');
    const json = (await res.json()) as {
      value?: { start: { dateTime: string }; end: { dateTime: string }; showAs?: string; isCancelled?: boolean }[];
    };
    return (json.value ?? [])
      .filter((e) => !e.isCancelled && e.showAs !== 'free')
      .map((e): BusyInterval => ({
        // Graph returns naive UTC under the Prefer header — append Z to parse.
        start: new Date(`${e.start.dateTime}Z`),
        end: new Date(`${e.end.dateTime}Z`),
      }));
  },

  async createEvent(accessToken, _calendarId, event) {
    const res = await fetch(`${GRAPH_BASE}/me/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(eventBody(event)),
    });
    if (!res.ok) throw await apiError(res, 'createEvent');
    const json = (await res.json()) as { id?: string };
    if (!json.id) throw new CalendarApiError('Microsoft createEvent returned no id', 502);
    return json.id;
  },

  async updateEvent(accessToken, _calendarId, eventId, event) {
    const res = await fetch(`${GRAPH_BASE}/me/events/${encodeURIComponent(eventId)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(eventBody(event)),
    });
    if (!res.ok && res.status !== 404) throw await apiError(res, 'updateEvent');
  },

  async deleteEvent(accessToken, _calendarId, eventId) {
    const res = await fetch(`${GRAPH_BASE}/me/events/${encodeURIComponent(eventId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok && res.status !== 404) throw await apiError(res, 'deleteEvent');
  },
};
