import type { CalendarConnection, CalendarProvider as DbProvider } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { seal, open } from '../lib/secret-box';
import { getProvider, ALL_PROVIDERS } from './calendar/registry';
import { CalendarApiError, type BusyInterval, type ProviderId } from './calendar/types';

/* ------------------------------- DTOs / status ---------------------------- */

export interface CalendarConnectionDto {
  provider: ProviderId;
  accountEmail: string | null;
  writeEnabled: boolean;
  blockBusy: boolean;
  lastError: string | null;
  connectedAt: string;
}

function toDto(c: CalendarConnection): CalendarConnectionDto {
  return {
    provider: c.provider,
    accountEmail: c.accountEmail,
    writeEnabled: c.writeEnabled,
    blockBusy: c.blockBusy,
    lastError: c.lastError,
    connectedAt: c.createdAt.toISOString(),
  };
}

export interface CalendarStatus {
  /** Providers the operator has configured OAuth credentials for. */
  availableProviders: ProviderId[];
  connections: CalendarConnectionDto[];
}

export async function getCalendarStatus(tenantId: string): Promise<CalendarStatus> {
  const [connections, availability] = await Promise.all([
    prisma.calendarConnection.findMany({ where: { tenantId } }),
    Promise.all(ALL_PROVIDERS.map(async (p) => ({ id: p.id, ok: await p.isConfigured() }))),
  ]);
  return {
    availableProviders: availability.filter((a) => a.ok).map((a) => a.id),
    connections: connections.map(toDto),
  };
}

/* --------------------------------- connect -------------------------------- */

export async function buildAuthUrl(provider: ProviderId, state: string): Promise<string> {
  return getProvider(provider).authUrl(state);
}

/** Exchange an OAuth code and upsert the tenant's connection for that provider. */
export async function connectFromCode(
  tenantId: string,
  provider: ProviderId,
  code: string,
): Promise<void> {
  const tokens = await getProvider(provider).exchangeCode(code);
  await prisma.calendarConnection.upsert({
    where: { tenantId_provider: { tenantId, provider: provider as DbProvider } },
    create: {
      tenantId,
      provider: provider as DbProvider,
      accessTokenEnc: seal(tokens.accessToken),
      refreshTokenEnc: seal(tokens.refreshToken ?? ''),
      expiresAt: tokens.expiresAt,
      accountEmail: tokens.accountEmail ?? null,
    },
    update: {
      accessTokenEnc: seal(tokens.accessToken),
      // Keep the prior refresh token if the provider didn't return a new one.
      ...(tokens.refreshToken ? { refreshTokenEnc: seal(tokens.refreshToken) } : {}),
      expiresAt: tokens.expiresAt,
      accountEmail: tokens.accountEmail ?? null,
      lastError: null,
    },
  });
}

export async function disconnect(tenantId: string, provider: ProviderId): Promise<void> {
  await prisma.calendarConnection.deleteMany({ where: { tenantId, provider: provider as DbProvider } });
}

export async function updateConnectionPrefs(
  tenantId: string,
  provider: ProviderId,
  prefs: { writeEnabled?: boolean; blockBusy?: boolean },
): Promise<void> {
  await prisma.calendarConnection.updateMany({
    where: { tenantId, provider: provider as DbProvider },
    data: prefs,
  });
}

/* ------------------------------ token refresh ----------------------------- */

const REFRESH_SKEW_MS = 2 * 60 * 1000;

/** A valid access token for the connection, refreshing + persisting if needed. */
async function validAccessToken(conn: CalendarConnection): Promise<string> {
  if (conn.expiresAt.getTime() - Date.now() > REFRESH_SKEW_MS) {
    return open(conn.accessTokenEnc);
  }
  const provider = getProvider(conn.provider);
  const refreshToken = open(conn.refreshTokenEnc);
  const tokens = await provider.refresh(refreshToken);
  await prisma.calendarConnection.update({
    where: { id: conn.id },
    data: {
      accessTokenEnc: seal(tokens.accessToken),
      ...(tokens.refreshToken ? { refreshTokenEnc: seal(tokens.refreshToken) } : {}),
      expiresAt: tokens.expiresAt,
      lastError: null,
    },
  });
  return tokens.accessToken;
}

/** Record a sync failure on the connection so the dashboard can prompt a reconnect. */
async function recordError(connId: string, err: unknown): Promise<void> {
  const message =
    err instanceof CalendarApiError
      ? err.needsReconnect
        ? 'Access was revoked — please reconnect this calendar.'
        : err.message
      : 'Calendar sync failed.';
  await prisma.calendarConnection.update({ where: { id: connId }, data: { lastError: message } }).catch(() => {});
}

/* ------------------------------ inbound (busy) ---------------------------- */

/**
 * Busy intervals across every connected calendar that has blockBusy on, within
 * [from, to]. Best-effort: a failing connection is recorded and skipped, never
 * blocking availability. Returns [] when the tenant has no busy-blocking
 * connections so the caller can cheaply skip the merge.
 */
export async function getExternalBusy(tenantId: string, from: Date, to: Date): Promise<BusyInterval[]> {
  const conns = await prisma.calendarConnection.findMany({ where: { tenantId, blockBusy: true } });
  if (conns.length === 0) return [];

  const results = await Promise.all(
    conns.map(async (conn) => {
      try {
        const token = await validAccessToken(conn);
        return await getProvider(conn.provider).getBusy(token, conn.calendarId, from, to);
      } catch (err) {
        await recordError(conn.id, err);
        return [] as BusyInterval[];
      }
    }),
  );
  return results.flat();
}

/** True when any blockBusy connection reports the window as busy. */
export async function isWindowBusyExternally(tenantId: string, start: Date, end: Date): Promise<boolean> {
  const busy = await getExternalBusy(tenantId, start, end);
  return busy.some((b) => b.start < end && b.end > start);
}

/* ----------------------------- outbound (mirror) -------------------------- */

type EventIdMap = Record<string, string>;

function eventIdsOf(value: unknown): EventIdMap {
  return value && typeof value === 'object' ? { ...(value as EventIdMap) } : {};
}

/**
 * Push an appointment (create or reschedule) to every writeEnabled calendar and
 * persist the resulting event ids on the appointment. Fire-and-forget from the
 * booking paths — never throws into the booking flow.
 */
export async function mirrorUpsert(appointmentId: string): Promise<void> {
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { tenant: { select: { companyName: true } } },
  });
  if (!appt || appt.demoSessionId) return;

  const conns = await prisma.calendarConnection.findMany({
    where: { tenantId: appt.tenantId, writeEnabled: true },
  });
  if (conns.length === 0) return;

  const event = {
    summary: `${appt.customerName}${appt.reason ? ` — ${appt.reason}` : ''}`,
    description: [
      appt.customerPhone ? `Phone: ${appt.customerPhone}` : null,
      appt.reason ? `Reason: ${appt.reason}` : null,
      'Booked via VoiceFront',
    ]
      .filter(Boolean)
      .join('\n'),
    start: appt.startsAt,
    end: appt.endsAt,
    timezone: appt.timezone,
  };

  const ids = eventIdsOf(appt.externalEventIds);
  let changed = false;

  for (const conn of conns) {
    const provider = getProvider(conn.provider);
    const key = conn.provider.toLowerCase();
    try {
      const token = await validAccessToken(conn);
      const existing = ids[key];
      if (existing) {
        await provider.updateEvent(token, conn.calendarId, existing, event);
      } else {
        ids[key] = await provider.createEvent(token, conn.calendarId, event);
        changed = true;
      }
    } catch (err) {
      await recordError(conn.id, err);
    }
  }

  if (changed) {
    await prisma.appointment.update({ where: { id: appointmentId }, data: { externalEventIds: ids } });
  }
}

/** Remove an appointment's mirrored events (on cancellation). */
export async function mirrorDelete(appointmentId: string): Promise<void> {
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!appt) return;
  const ids = eventIdsOf(appt.externalEventIds);
  if (Object.keys(ids).length === 0) return;

  const conns = await prisma.calendarConnection.findMany({ where: { tenantId: appt.tenantId } });
  let changed = false;

  for (const conn of conns) {
    const key = conn.provider.toLowerCase();
    const eventId = ids[key];
    if (!eventId) continue;
    try {
      const token = await validAccessToken(conn);
      await getProvider(conn.provider).deleteEvent(token, conn.calendarId, eventId);
      delete ids[key];
      changed = true;
    } catch (err) {
      await recordError(conn.id, err);
    }
  }

  if (changed) {
    await prisma.appointment.update({ where: { id: appointmentId }, data: { externalEventIds: ids } });
  }
}
