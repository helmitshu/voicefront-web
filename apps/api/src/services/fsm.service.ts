import type { FsmProvider } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http';
import { seal, open } from '../lib/secret-box';
import { FSM_ADAPTERS, FSM_PROVIDERS, isFsmProvider, type FsmJobPayload } from '../domain/fsm';
import { isFeatureEnabled } from './features.service';

/**
 * Field-service-management connection management. Provider-agnostic: it stores
 * encrypted credentials, exposes connection state for the gated UI, and pushes
 * captured jobs into connected systems via each provider's adapter. Everything
 * is gated by the FSM_INTEGRATION feature, enforced here server-side.
 */

export interface FsmConnectionView {
  provider: FsmProvider;
  label: string;
  connected: boolean;
  accountLabel: string | null;
  status: string;
  lastError: string | null;
  pushJobs: boolean;
  /** Whether live job-push is wired for this provider yet. */
  pushReady: boolean;
  credentialFields: { key: string; label: string; secret: boolean; placeholder: string | null }[];
}

/** Connection state for every provider (for the client UI). */
export async function getFsmConnections(tenantId: string): Promise<FsmConnectionView[]> {
  const rows = await prisma.fsmConnection.findMany({ where: { tenantId } });
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  return FSM_PROVIDERS.map((p) => {
    const adapter = FSM_ADAPTERS[p];
    const row = byProvider.get(p);
    return {
      provider: p,
      label: adapter.label,
      connected: !!row && row.status !== 'DISCONNECTED',
      accountLabel: row?.accountLabel ?? null,
      status: row?.status ?? 'DISCONNECTED',
      lastError: row?.lastError ?? null,
      pushJobs: row?.pushJobs ?? true,
      pushReady: adapter.pushReady,
      credentialFields: adapter.credentialFields.map((f) => ({
        key: f.key,
        label: f.label,
        secret: !!f.secret,
        placeholder: f.placeholder ?? null,
      })),
    };
  });
}

async function assertEnabled(tenantId: string): Promise<void> {
  if (!(await isFeatureEnabled(tenantId, 'FSM_INTEGRATION'))) {
    throw new HttpError(403, 'Field service integration isn’t enabled for your workspace.', 'FSM_NOT_ENABLED');
  }
}

/** Store (or replace) a connection's encrypted credentials after a shape check. */
export async function connectFsm(
  tenantId: string,
  provider: string,
  creds: Record<string, string>,
): Promise<FsmConnectionView> {
  await assertEnabled(tenantId);
  if (!isFsmProvider(provider)) throw new HttpError(400, 'Unknown provider.', 'UNKNOWN_PROVIDER');
  const adapter = FSM_ADAPTERS[provider];

  let accountLabel: string;
  try {
    ({ accountLabel } = adapter.validateCredentials(creds));
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : 'Invalid credentials.', 'BAD_CREDENTIALS');
  }

  // Keep only the fields this adapter declares, then encrypt at rest.
  const clean: Record<string, string> = {};
  for (const f of adapter.credentialFields) clean[f.key] = (creds[f.key] ?? '').trim();
  const credentialsEnc = seal(JSON.stringify(clean));

  await prisma.fsmConnection.upsert({
    where: { tenantId_provider: { tenantId, provider } },
    create: { tenantId, provider, credentialsEnc, accountLabel, status: 'CONNECTED' },
    update: { credentialsEnc, accountLabel, status: 'CONNECTED', lastError: null },
  });
  const all = await getFsmConnections(tenantId);
  return all.find((c) => c.provider === provider)!;
}

export async function disconnectFsm(tenantId: string, provider: string): Promise<void> {
  await assertEnabled(tenantId);
  if (!isFsmProvider(provider)) throw new HttpError(400, 'Unknown provider.', 'UNKNOWN_PROVIDER');
  await prisma.fsmConnection.deleteMany({ where: { tenantId, provider } });
}

export async function setFsmPushJobs(tenantId: string, provider: string, pushJobs: boolean): Promise<void> {
  await assertEnabled(tenantId);
  if (!isFsmProvider(provider)) throw new HttpError(400, 'Unknown provider.', 'UNKNOWN_PROVIDER');
  await prisma.fsmConnection.updateMany({ where: { tenantId, provider }, data: { pushJobs } });
}

/**
 * Best-effort push of a captured job into every connected, push-enabled FSM.
 * Fire-and-forget from job creation; never throws. Providers whose live API
 * isn't wired yet (`pushReady` false) are skipped (logged), not failed.
 */
export async function pushJobToConnectedFsms(jobId: string): Promise<void> {
  const job = await prisma.jobRequest.findUnique({ where: { id: jobId } });
  if (!job || job.demoSessionId) return;
  if (!(await isFeatureEnabled(job.tenantId, 'FSM_INTEGRATION'))) return;

  const connections = await prisma.fsmConnection.findMany({
    where: { tenantId: job.tenantId, status: 'CONNECTED', pushJobs: true },
  });
  if (connections.length === 0) return;

  const payload: FsmJobPayload = {
    customerName: job.customerName,
    customerPhone: job.customerPhone,
    serviceAddress: job.serviceAddress,
    jobType: job.jobType,
    urgency: job.urgency,
    description: job.description,
    preferredCallback: job.preferredCallback,
  };

  for (const conn of connections) {
    const adapter = FSM_ADAPTERS[conn.provider];
    if (!adapter.pushReady || !adapter.pushJob) {
      console.log(`[fsm] ${adapter.label}: live push not wired yet — job ${jobId} not sent.`);
      continue;
    }
    try {
      const creds = JSON.parse(open(conn.credentialsEnc)) as Record<string, string>;
      await adapter.pushJob(creds, payload);
    } catch (err) {
      console.error(`[fsm] ${adapter.label} push failed for job ${jobId}:`, err);
      await prisma.fsmConnection
        .update({
          where: { id: conn.id },
          data: { status: 'ERROR', lastError: err instanceof Error ? err.message : 'Push failed.' },
        })
        .catch(() => {});
    }
  }
}
