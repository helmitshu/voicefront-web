import type { FsmProvider } from '@prisma/client';

/**
 * Field-service-management integration seam. Each provider (ServiceTitan,
 * Jobber, Housecall Pro) is an adapter implementing this contract, so the
 * connection lifecycle, the gated UI, and the job-push hook stay provider-
 * agnostic. The real OAuth/API calls live inside each adapter — until a
 * provider's `pushReady` is true, connections can be stored and managed but
 * jobs are not pushed live (the framework records intent instead of faking it).
 */

export interface CredentialField {
  key: string;
  label: string;
  /** Render as a password field; never echoed back to the client. */
  secret?: boolean;
  placeholder?: string;
}

/** The captured-job shape an adapter pushes — decoupled from Prisma models. */
export interface FsmJobPayload {
  customerName: string;
  customerPhone: string | null;
  serviceAddress: string | null;
  jobType: string | null;
  urgency: string;
  description: string | null;
  preferredCallback: string | null;
}

export interface FsmAdapter {
  provider: FsmProvider;
  label: string;
  /** Fields the connect form collects (and that get encrypted at rest). */
  credentialFields: CredentialField[];
  /**
   * Validate the credential shape locally (no network). Throws a human message
   * on bad input; returns a display label for the connected account.
   */
  validateCredentials(creds: Record<string, string>): { accountLabel: string };
  /**
   * Whether live job-push to this provider's API is wired up. False = the
   * integration point is scaffolded but awaiting real developer credentials +
   * sandbox validation, so the service skips the live call.
   */
  pushReady: boolean;
  /** Push a captured job to the provider. Only called when `pushReady`. */
  pushJob?(creds: Record<string, string>, job: FsmJobPayload): Promise<{ externalId: string }>;
}

/** Throws if any required field is blank; returns the trimmed values. */
function requireFields(creds: Record<string, string>, fields: CredentialField[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = (creds[f.key] ?? '').trim();
    if (!v) throw new Error(`${f.label} is required.`);
    out[f.key] = v;
  }
  return out;
}

const serviceTitan: FsmAdapter = {
  provider: 'SERVICETITAN',
  label: 'ServiceTitan',
  credentialFields: [
    { key: 'clientId', label: 'Client ID' },
    { key: 'clientSecret', label: 'Client secret', secret: true },
    { key: 'tenantId', label: 'Tenant ID' },
    { key: 'appKey', label: 'App key', secret: true },
  ],
  pushReady: false,
  validateCredentials(creds) {
    const c = requireFields(creds, this.credentialFields);
    return { accountLabel: `ServiceTitan tenant ${c.tenantId}` };
  },
};

const jobber: FsmAdapter = {
  provider: 'JOBBER',
  label: 'Jobber',
  credentialFields: [{ key: 'accessToken', label: 'API access token', secret: true }],
  pushReady: false,
  validateCredentials(creds) {
    requireFields(creds, this.credentialFields);
    return { accountLabel: 'Jobber account' };
  },
};

const housecall: FsmAdapter = {
  provider: 'HOUSECALL',
  label: 'Housecall Pro',
  credentialFields: [{ key: 'apiKey', label: 'API key', secret: true }],
  pushReady: false,
  validateCredentials(creds) {
    requireFields(creds, this.credentialFields);
    return { accountLabel: 'Housecall Pro account' };
  },
};

export const FSM_ADAPTERS: Record<FsmProvider, FsmAdapter> = {
  SERVICETITAN: serviceTitan,
  JOBBER: jobber,
  HOUSECALL: housecall,
};

export const FSM_PROVIDERS: FsmProvider[] = ['SERVICETITAN', 'JOBBER', 'HOUSECALL'];

export function isFsmProvider(value: string): value is FsmProvider {
  return value === 'SERVICETITAN' || value === 'JOBBER' || value === 'HOUSECALL';
}
