import type { BusinessHours, ForwardingNumber } from '@/domain/agent-config';

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

const TOKEN_KEY = 'voicefront.token';
export const UNAUTHORIZED_EVENT = 'voicefront:unauthorized';

/* ----------------------------- token storage ----------------------------- */
// localStorage keeps the demo simple (documented tradeoff in the README);
// every access is guarded so modules stay SSR-safe.

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable (private mode) — session just won't persist */
  }
}

/* --------------------------------- errors -------------------------------- */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorEnvelope {
  error?: { message?: string; code?: string; details?: unknown };
}

/* ---------------------------------- core --------------------------------- */

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

/** Parse a fetch Response into T, or throw a typed ApiError. Shared by the
 *  JSON `api` helper and the raw-binary document upload. */
async function handleResponse<T>(res: Response): Promise<T> {
  let payload: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    const envelope = (payload ?? {}) as ErrorEnvelope;
    const message = envelope.error?.message ?? `Request failed (${res.status})`;
    if (res.status === 401) {
      setToken(null);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
      }
    }
    throw new ApiError(res.status, message, envelope.error?.code, envelope.error?.details);
  }

  return payload as T;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.', 'NETWORK');
  }

  return handleResponse<T>(res);
}

/* --------------------------------- types --------------------------------- */

export type Role = 'OWNER' | 'MANAGER' | 'AGENT';
export type Industry = 'CLINIC' | 'CONSTRUCTION';
export type OnboardingStep = 'PROFILE' | 'PROMPT' | 'VOICE_TEST';
export type CallStatus = 'COMPLETED' | 'FORWARDED' | 'VOICEMAIL' | 'FAILED' | 'UNKNOWN';

export interface OnboardingView {
  hasConfiguredProfile: boolean;
  hasConfiguredPrompt: boolean;
  hasTestedVoice: boolean;
  isActive: boolean;
  completedAt: string | null;
  nextStep: OnboardingStep | null;
  progressPercent: number;
}

export interface Me {
  user: {
    id: string;
    email: string;
    fullName: string;
    role: Role;
    /** Founder/operator accounts — unlocks the /admin control panel. */
    isPlatformAdmin: boolean;
    /** Operator access level: 'ADMIN' (full) | 'SUPPORT' (limited) | null. */
    adminRole: AdminRole | null;
  };
  tenant: {
    id: string;
    companyName: string;
    slug: string;
    industry: Industry;
    subscriptionStatus: string;
  };
  onboarding: OnboardingView;
}

export type AuthResponse = Me & { token: string };

export interface AgentSettingsDto {
  displayName: string;
  systemPrompt: string;
  firstMessage: string;
  voicemailGreeting: string;
  businessHours: BusinessHours;
  forwardingNumbers: ForwardingNumber[];
  timezone: string;
  /** "vapi" (built-in) or "11labs" (ElevenLabs). */
  voiceProvider: string;
  voiceId: string;
  /** Ambient call audio: "office" | "off". */
  backgroundSound: string;
  /** Average revenue per appointment (whole dollars) — drives the ROI dashboard. */
  avgAppointmentValue: number;
  /** Spam screening: refuse calls with no caller ID. Opt-in, default false. */
  rejectAnonymousCallers: boolean;
  /** Hard call-length ceiling in seconds (safety backstop). */
  maxCallDurationSeconds: number;
  /** Hang up after this many seconds of total silence (dead air). */
  silenceTimeoutSeconds: number;
  /** Custom closing line for graceful wrap-up; null = built-in default. */
  wrapUpMessage: string | null;
  /** Trades: number texted the moment an EMERGENCY job is captured. Null = off. */
  emergencyAlertPhone: string | null;
  /** On-call dispatch roster (ordered): who the receptionist rings on an emergency. */
  onCallRoster: { name: string; phone: string }[];
  /** Seconds to wait for a contact to accept before escalating to the next. */
  dispatchEscalationSeconds: number;
  /** Missed-call text-back message; null = platform default. */
  missedCallTemplate: string | null;
  /** Serviced ZIPs/cities for the service-area check. */
  serviceAreaZips: string[];
  /** Optional human note shown with the service area. */
  serviceAreaNote: string | null;
  inboundPhoneNumber: string | null;
  /** Vapi assistant assigned by the founder; read-only for the customer. */
  assistantId: string | null;
  updatedAt: string;
}

/** Outcome of pushing settings to a customer's assigned Vapi assistant. */
export interface SyncStatus {
  synced: boolean;
  reason?: string;
}

export type AgentSettingsPatch = Partial<
  Pick<
    AgentSettingsDto,
    | 'displayName'
    | 'systemPrompt'
    | 'firstMessage'
    | 'voicemailGreeting'
    | 'businessHours'
    | 'forwardingNumbers'
    | 'timezone'
    | 'voiceProvider'
    | 'voiceId'
    | 'backgroundSound'
    | 'avgAppointmentValue'
    | 'rejectAnonymousCallers'
    | 'maxCallDurationSeconds'
    | 'silenceTimeoutSeconds'
    | 'wrapUpMessage'
    | 'emergencyAlertPhone'
    | 'onCallRoster'
    | 'dispatchEscalationSeconds'
    | 'missedCallTemplate'
    | 'serviceAreaZips'
    | 'serviceAreaNote'
    | 'inboundPhoneNumber'
  >
>;

export interface CallDto {
  id: string;
  channel: string;
  callerNumber: string | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  costCents: number;
  status: CallStatus;
  summary: string | null;
  hasRecording: boolean;
  // AI-extracted outcome (null on older calls / demos).
  intent: string | null;
  outcome: string | null;
  urgency: string | null;
  leadQuality: string | null;
  appointmentBooked: boolean | null;
  successScore: number | null;
}

export interface CallDetailDto extends CallDto {
  transcript: string | null;
  structuredData: Record<string, unknown> | null;
}

export interface ListCallsResult {
  calls: CallDto[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

export interface CallStats {
  callsLast7Days: number;
  callsLast30Days: number;
  minutesLast30Days: number;
  costCentsLast30Days: number;
  forwardedLast30Days: number;
  afterHoursShare: number;
}

/** Current-month minute usage against the tenant's monthly cap. */
export interface MonthlyUsage {
  periodStart: string;
  usedSeconds: number;
  usedMinutes: number;
  limitMinutes: number;
  remainingMinutes: number;
  /** 0..1 share of the cap consumed. */
  fractionUsed: number;
  overLimit: boolean;
}

/** Server-built transient assistant config; opaque to the client. */
export type WebAssistantConfig = Record<string, unknown>;

export interface WebSession {
  publicKey: string;
  assistant: WebAssistantConfig;
}

/* ------------------------------- endpoints ------------------------------- */

export const AuthApi = {
  register: (input: {
    companyName: string;
    industry: Industry;
    fullName: string;
    email: string;
    password: string;
    /** One-time invitation code from the founder (required for customers). */
    accessCode?: string;
  }) => api<AuthResponse>('/api/auth/register', { method: 'POST', body: input }),
  login: (input: { email: string; password: string }) =>
    api<AuthResponse>('/api/auth/login', { method: 'POST', body: input }),
  me: (signal?: AbortSignal) => api<Me>('/api/auth/me', { signal }),
};

export const OnboardingApi = {
  status: () => api<{ onboarding: OnboardingView }>('/api/onboarding/status'),
  completeStep: (step: OnboardingStep) =>
    api<{ onboarding: OnboardingView }>('/api/onboarding/complete-step', {
      method: 'POST',
      body: { step },
    }),
  activate: () => api<{ onboarding: OnboardingView }>('/api/onboarding/activate', { method: 'POST' }),
};

export const AgentApi = {
  get: () => api<{ settings: AgentSettingsDto }>('/api/agent/settings'),
  update: (patch: AgentSettingsPatch) =>
    api<{ settings: AgentSettingsDto; sync?: SyncStatus }>('/api/agent/settings', {
      method: 'PATCH',
      body: patch,
    }),
};

/** A knowledge-base document the receptionist can answer questions from. */
export interface DocumentDto {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Vapi processing state: "processing" | "done" | "failed". */
  status: string;
  createdAt: string;
}

export const DocumentsApi = {
  list: (signal?: AbortSignal) => api<{ documents: DocumentDto[] }>('/api/documents', { signal }),
  /**
   * Uploads one file as a raw binary body. Filename + type ride in headers and
   * the content type is forced to octet-stream so the API's JSON parser leaves
   * the bytes alone (matters for .json knowledge files especially).
   */
  upload: async (file: File): Promise<{ document: DocumentDto; sync?: SyncStatus }> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name),
      'X-File-Type': file.type || 'application/octet-stream',
    };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    let res: Response;
    try {
      res = await fetch(`${API_URL}/api/documents`, { method: 'POST', headers, body: file });
    } catch {
      throw new ApiError(0, 'Could not reach the server. Check your connection and try again.', 'NETWORK');
    }
    return handleResponse<{ document: DocumentDto; sync?: SyncStatus }>(res);
  },
  remove: (id: string) =>
    api<{ ok: true; sync?: SyncStatus }>(`/api/documents/${id}`, { method: 'DELETE' }),
};

export type AppointmentStatus = 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW';

export interface AppointmentDto {
  id: string;
  customerName: string;
  customerPhone: string | null;
  reason: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string;
  /** Wall-clock parts in the business timezone, ready to paint on a calendar. */
  local: { date: string; time: string };
  status: AppointmentStatus;
  source: 'VOICE_AGENT' | 'MANUAL';
  notes: string | null;
  /** Provider this appointment is with; null for single-resource/unassigned. */
  providerId: string | null;
  createdAt: string;
}

/** An event read from a connected external calendar (Google / Outlook). */
export interface ExternalCalendarEvent {
  provider: 'GOOGLE' | 'MICROSOFT';
  accountEmail: string | null;
  /** ISO start/end in UTC. */
  start: string;
  end: string;
  title: string;
  allDay: boolean;
  /** Wall-clock parts in the business timezone, for bucketing onto a day. */
  local: { date: string; time: string };
}

export interface AvailabilityResult {
  open: boolean;
  freeSlots: string[];
  /** Full day grid — every future start in the business window with whether it's
   *  bookable. Busy entries fold in both in-app bookings and external (Google/
   *  Outlook) busy time. Powers the day schedule table. */
  slots: { time: string; available: boolean }[];
  dayLabel: string;
}

/* ------------------------------ founder admin ------------------------------ */

export type AdminRole = 'ADMIN' | 'SUPPORT';

export interface AdminTeamMember {
  email: string;
  role: AdminRole;
  source: 'bootstrap' | 'granted';
  createdBy: string | null;
  createdAt: string | null;
  removable: boolean;
  hasLogin: boolean;
}

export interface AddAdminResult {
  email: string;
  role: AdminRole;
  /** Present only when a new staff login was created — show once. */
  tempPassword: string | null;
  /** True when an existing account was promoted (no new login created). */
  promoted: boolean;
}

export interface AdminOverview {
  tenants: number;
  activeReceptionists: number;
  calls30d: number;
  callsToday: number;
  minutes30d: number;
  billed30dCents: number;
  providerCost30dCents: number;
  profit30dCents: number;
  bookings30d: number;
  config: Array<{ key: string; configured: boolean; source: 'admin' | 'env' | 'unset' }>;
  recentCalls: Array<{
    id: string;
    company: string;
    startedAt: string;
    durationSeconds: number;
    status: CallStatus;
    channel: string;
    callerNumber: string | null;
    billedCents: number;
  }>;
}

export interface AdminTenantRow {
  id: string;
  companyName: string;
  slug: string;
  industry: Industry;
  subscriptionStatus: string;
  markupBps: number;
  blocked: boolean;
  receptionistActive: boolean;
  inboundPhoneNumber: string | null;
  voice: string | null;
  ownerEmail: string | null;
  ownerName: string | null;
  userCount: number;
  calls30d: number;
  billed30dCents: number;
  profit30dCents: number;
  upcomingAppointments: number;
  createdAt: string;
}

export interface AdminTenantDetail {
  id: string;
  companyName: string;
  slug: string;
  industry: Industry;
  subscriptionStatus: string;
  markupBps: number;
  monthlyMinuteLimit: number;
  usage: MonthlyUsage;
  blocked: boolean;
  /** Set when soft-deleted (recoverable); null = live. */
  deletedAt: string | null;
  /** Operator entitlement: multi-provider booking on/off for this customer. */
  multiProviderEnabled: boolean;
  /** Whether the customer may flip multiProviderEnabled themselves. */
  multiProviderSelfManage: boolean;
  createdAt: string;
  receptionistActive: boolean;
  settings: {
    displayName: string;
    timezone: string;
    inboundPhoneNumber: string | null;
    voiceProvider: string;
    voiceId: string;
    backgroundSound: string;
    firstMessage: string;
    assistantId: string | null;
  } | null;
  users: Array<{ id: string; email: string; fullName: string; role: Role; createdAt: string }>;
  recentCalls: Array<{
    id: string;
    startedAt: string;
    durationSeconds: number;
    status: CallStatus;
    channel: string;
    callerNumber: string | null;
    billedCostCents: number;
    summary: string | null;
  }>;
  upcomingAppointments: Array<{
    id: string;
    customerName: string;
    customerPhone: string | null;
    startsAt: string;
    status: string;
    source: string;
    reason: string | null;
  }>;
}

export interface AdminSetting {
  key: string;
  label: string;
  description: string;
  secret: boolean;
  placeholder: string;
  source: 'admin' | 'env' | 'unset';
  preview: string | null;
}

/** The effective Vapi webhook URL + whether it's safe for production calls. */
export interface AdminWebhookInfo {
  baseUrl: string | null;
  webhookUrl: string | null;
  host: string | null;
  productionSafe: boolean;
  reason: string | null;
}

export interface AdminAuditEntry {
  id: string;
  adminEmail: string;
  action: string;
  target: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export const AdminApi = {
  overview: (signal?: AbortSignal) =>
    api<{ overview: AdminOverview }>('/api/admin/overview', { signal }),
  tenants: (signal?: AbortSignal) =>
    api<{ tenants: AdminTenantRow[] }>('/api/admin/tenants', { signal }),
  tenant: (id: string, signal?: AbortSignal) =>
    api<{ tenant: AdminTenantDetail }>(`/api/admin/tenants/${id}`, { signal }),
  updateTenant: (
    id: string,
    patch: Partial<{
      subscriptionStatus: string;
      receptionistActive: boolean;
      markupBps: number;
      monthlyMinuteLimit: number;
      blocked: boolean;
      multiProviderEnabled: boolean;
      multiProviderSelfManage: boolean;
    }>,
  ) => api<{ ok: true }>(`/api/admin/tenants/${id}`, { method: 'PATCH', body: patch }),
  /** Create a whole workspace (tenant + owner login). Returns a one-time owner password. */
  createTenant: (input: {
    companyName: string;
    industry: Industry;
    ownerName: string;
    ownerEmail: string;
  }) =>
    api<{ tenantId: string; email: string; tempPassword: string }>('/api/admin/tenants', {
      method: 'POST',
      body: input,
    }),
  /** Permanently delete a workspace and all its data. */
  /** Soft-delete (recoverable): blocks + marks deleted, keeps the data. */
  deleteTenant: (id: string) => api<{ ok: true }>(`/api/admin/tenants/${id}`, { method: 'DELETE' }),
  /** Undo a soft-delete. */
  restoreTenant: (id: string) => api<{ ok: true }>(`/api/admin/tenants/${id}/restore`, { method: 'POST' }),
  /** Irreversible hard-delete — only allowed after a soft-delete. */
  permanentlyDeleteTenant: (id: string) =>
    api<{ ok: true }>(`/api/admin/tenants/${id}/permanent`, { method: 'DELETE' }),
  /** The customer's gated-feature states (entitlement, self-manage, on/off). */
  listFeatures: (tenantId: string, signal?: AbortSignal) =>
    api<{ features: FeatureState[] }>(`/api/admin/tenants/${tenantId}/features`, { signal }),
  /** Operator control: grant/revoke entitlement, allow self-manage, or flip on/off. */
  setFeature: (
    tenantId: string,
    feature: FeatureKey,
    patch: Partial<{ entitled: boolean; selfManage: boolean; enabled: boolean }>,
  ) =>
    api<{ feature: FeatureState }>(`/api/admin/tenants/${tenantId}/features/${feature}`, {
      method: 'PATCH',
      body: patch,
    }),
  /** Add a login to a customer workspace. Returns a one-time password. */
  inviteUser: (tenantId: string, input: { email: string; fullName: string; role: Role }) =>
    api<{ email: string; role: Role; tempPassword: string }>(`/api/admin/tenants/${tenantId}/users`, {
      method: 'POST',
      body: input,
    }),
  resetPassword: (tenantId: string, userId: string) =>
    api<{ tempPassword: string; email: string }>(
      `/api/admin/tenants/${tenantId}/users/${userId}/reset-password`,
      { method: 'POST' },
    ),
  /** Assign (or clear, with '') a Vapi assistant for a customer. Validates against Vapi. */
  setAssistant: (tenantId: string, assistantId: string) =>
    api<{
      assistantId: string | null;
      assistantName: string | null;
      synced: boolean;
      syncNote: string | null;
      /** Phone number pulled from Vapi for this assistant, if one is attached. */
      phoneNumber?: string | null;
      phoneNote?: string | null;
    }>(`/api/admin/tenants/${tenantId}/assistant`, { method: 'PATCH', body: { assistantId } }),
  createAssistant: (tenantId: string) =>
    api<{ assistantId: string; created: boolean }>(`/api/admin/tenants/${tenantId}/assistant/create`, {
      method: 'POST',
    }),
  syncAssistant: (tenantId: string) =>
    api<{ synced: boolean; reason?: string }>(`/api/admin/tenants/${tenantId}/assistant/sync`, {
      method: 'POST',
    }),
  settings: (signal?: AbortSignal) =>
    api<{ settings: AdminSetting[]; webhook: AdminWebhookInfo }>('/api/admin/settings', { signal }),
  setSetting: (key: string, value: string) =>
    api<{ ok: true }>(`/api/admin/settings/${key}`, { method: 'PATCH', body: { value } }),
  unsetSetting: (key: string) =>
    api<{ ok: true }>(`/api/admin/settings/${key}`, { method: 'DELETE' }),
  demoEnabled: (signal?: AbortSignal) =>
    api<{ enabled: boolean }>('/api/admin/demo', { signal }),
  setDemoEnabled: (enabled: boolean) =>
    api<{ enabled: boolean }>('/api/admin/demo', { method: 'PATCH', body: { enabled } }),
  migrateWebhooks: () =>
    api<{ serverUrl: string; total: number; updated: number; failed: number; details: Array<{ number: string; ok: boolean }> }>(
      '/api/admin/migrate-webhooks',
      { method: 'POST' },
    ),
  syncAllAssistants: () =>
    api<{ total: number; synced: number; failed: number; details: Array<{ company: string; synced: boolean; reason?: string }> }>(
      '/api/admin/assistants/sync-all',
      { method: 'POST' },
    ),
  salesConfig: (signal?: AbortSignal) =>
    api<SalesConfig>('/api/admin/demo/sales-config', { signal }),
  setSalesConfig: (patch: Partial<SalesConfig>) =>
    api<SalesConfig>('/api/admin/demo/sales-config', { method: 'PATCH', body: patch }),
  demoCalls: (signal?: AbortSignal) =>
    api<{ calls: DemoCallRecord[] }>('/api/admin/demo/calls', { signal }),
  demoNumbers: (signal?: AbortSignal) =>
    api<{ available: VapiNumberOption[]; assigned: DemoNumbers }>('/api/admin/demo/numbers', { signal }),
  setDemoNumbers: (patch: { us?: VapiNumberOption | null; ca?: VapiNumberOption | null }) =>
    api<{ assigned: DemoNumbers }>('/api/admin/demo/numbers', { method: 'PATCH', body: patch }),
  audit: (signal?: AbortSignal) =>
    api<{ entries: AdminAuditEntry[] }>('/api/admin/audit', { signal }),
  team: (signal?: AbortSignal) =>
    api<{ admins: AdminTeamMember[] }>('/api/admin/team', { signal }),
  addTeamMember: (email: string, role: AdminRole) =>
    api<AddAdminResult>('/api/admin/team', { method: 'POST', body: { email, role } }),
  removeTeamMember: (email: string) =>
    api<{ ok: true }>(`/api/admin/team/${encodeURIComponent(email)}`, { method: 'DELETE' }),
  numbers: (signal?: AbortSignal) =>
    api<{ available: number; numbers: PooledNumberRow[] }>('/api/admin/numbers', { signal }),
  addNumber: (input: { number: string; country?: string; vapiPhoneId?: string }) =>
    api<{ number: PooledNumberRow }>('/api/admin/numbers', { method: 'POST', body: input }),
  createNumber: (areaCode?: string) =>
    api<{ number: PooledNumberRow }>('/api/admin/numbers/create', { method: 'POST', body: { areaCode } }),
  removeNumber: (id: string) => api<{ ok: true }>(`/api/admin/numbers/${id}`, { method: 'DELETE' }),
  // Founder's own planning-call calendar.
  founderCalendar: (range: { from: string; to: string }, signal?: AbortSignal) => {
    const query = new URLSearchParams({ from: range.from, to: range.to });
    return api<{ entries: FounderEntry[]; timezone: string }>(`/api/admin/founder/calendar?${query}`, { signal });
  },
  founderAvailability: (date: string) =>
    api<{ availability: AvailabilityResult }>(`/api/admin/founder/availability?date=${date}`),
  blockFounderTime: (input: { date: string; time: string; durationMinutes?: number; label?: string }) =>
    api<{ entry: FounderEntry }>('/api/admin/founder/block', { method: 'POST', body: input }),
  removeFounderEntry: (id: string) =>
    api<{ ok: true }>(`/api/admin/founder/calendar/${id}`, { method: 'DELETE' }),
  // Founder calendar sync (Google/Outlook) — bound to the __founder tenant.
  founderCalendarStatus: () => api<CalendarStatus>('/api/admin/founder/calendar-sync'),
  founderCalendarConnectUrl: (provider: CalendarProviderId) =>
    api<{ url: string }>(`/api/admin/founder/calendar-sync/${provider.toLowerCase()}/connect`),
  founderCalendarDisconnect: (provider: CalendarProviderId) =>
    api<{ ok: true }>(`/api/admin/founder/calendar-sync/${provider.toLowerCase()}/disconnect`, {
      method: 'POST',
    }),
  founderCalendarPrefs: (
    provider: CalendarProviderId,
    prefs: { writeEnabled?: boolean; blockBusy?: boolean },
  ) =>
    api<{ ok: true }>(`/api/admin/founder/calendar-sync/${provider.toLowerCase()}`, {
      method: 'PATCH',
      body: prefs,
    }),
  founderExternalEvents: (range: { from: string; to: string }, signal?: AbortSignal) => {
    const query = new URLSearchParams({ from: range.from, to: range.to });
    return api<{ events: ExternalCalendarEvent[] }>(
      `/api/admin/founder/external-events?${query}`,
      { signal },
    );
  },
  // One-time signup invitation codes.
  accessCodes: (signal?: AbortSignal) =>
    api<{ codes: AccessCodeRow[] }>('/api/admin/access-codes', { signal }),
  createAccessCode: (input: { label?: string; email?: string }) =>
    api<{ code: AccessCodeRow }>('/api/admin/access-codes', { method: 'POST', body: input }),
  revokeAccessCode: (id: string) =>
    api<{ ok: true }>(`/api/admin/access-codes/${id}`, { method: 'DELETE' }),

  // Lead generation (founder outbound prospecting).
  leads: (
    params: { status?: string; hasEmail?: boolean; q?: string; sort?: 'newest' | 'rating'; page?: number } = {},
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.hasEmail !== undefined) query.set('hasEmail', String(params.hasEmail));
    if (params.q) query.set('q', params.q);
    if (params.sort) query.set('sort', params.sort);
    if (params.page) query.set('page', String(params.page));
    const qs = query.toString();
    return api<LeadListResult>(`/api/admin/leads${qs ? `?${qs}` : ''}`, { signal });
  },
  bulkLeads: (ids: string[], action: 'delete' | 'status', status?: string) =>
    api<{ count: number }>('/api/admin/leads/bulk', {
      method: 'POST',
      body: { ids, action, ...(status ? { status } : {}) },
    }),
  sourceLeads: (input: { trade: string; city: string; limit?: number }) =>
    api<{ sourced: number; created: number; updated: number }>('/api/admin/leads/source', {
      method: 'POST',
      body: input,
    }),
  scrapeLeadEmails: (limit?: number) =>
    api<{ scanned: number; found: number }>('/api/admin/leads/scrape-emails', {
      method: 'POST',
      body: limit ? { limit } : {},
    }),
  scrapeLeadEmail: (id: string) =>
    api<{ email: string | null }>(`/api/admin/leads/${id}/scrape-email`, { method: 'POST' }),
  updateLead: (id: string, patch: { status?: string; notes?: string; email?: string | null }) =>
    api<{ lead: LeadRow }>(`/api/admin/leads/${id}`, { method: 'PATCH', body: patch }),
  deleteLead: (id: string) => api<{ ok: true }>(`/api/admin/leads/${id}`, { method: 'DELETE' }),
  leadEmail: (id: string) => api<{ email: OutreachEmailDto }>(`/api/admin/leads/${id}/email`),
  testEmail: (recipients: string[], leadId?: string) =>
    api<{ sent: number; total: number; results: { to: string; ok: boolean; error?: string }[] }>(
      '/api/admin/leads/test-email',
      { method: 'POST', body: { recipients, ...(leadId ? { leadId } : {}) } },
    ),
};

/** A rendered outreach email for a lead: subject + HTML + plain-text fallback. */
export interface OutreachEmailDto {
  subject: string;
  html: string;
  text: string;
}

/** Public (no-auth) endpoints reachable from marketing pages. */
export const PublicApi = {
  /** Behind the CAN-SPAM unsubscribe link in outreach emails. */
  unsubscribe: (leadId: string) =>
    api<{ ok: true }>('/api/unsubscribe', { method: 'POST', body: { leadId } }),
};

export interface LeadRow {
  id: string;
  businessName: string;
  trade: string;
  city: string;
  phone: string | null;
  website: string | null;
  address: string | null;
  email: string | null;
  emailSource: string | null;
  rating: number | null;
  reviewCount: number | null;
  status: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface LeadStats {
  total: number;
  withEmail: number;
  withPhone: number;
  byStatus: Record<string, number>;
}
export interface LeadListResult {
  leads: LeadRow[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
  stats: LeadStats;
}

/** A one-time signup invitation code issued by the founder. */
export interface AccessCodeRow {
  id: string;
  code: string;
  label: string | null;
  email: string | null;
  createdBy: string;
  used: boolean;
  usedAt: string | null;
  createdAt: string;
}

/** An entry on the founder's planning-call calendar. */
export interface FounderEntry {
  id: string;
  kind: 'block' | 'call';
  label: string;
  reason: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string;
  local: { date: string; time: string };
  durationMinutes: number;
  status: string;
}

/** A number in the shared provisioning pool. */
export interface PooledNumberRow {
  id: string;
  number: string;
  country: string;
  vapiPhoneId: string | null;
  assignedTenantId: string | null;
  assignedCompany: string | null;
  assignedAt: string | null;
  createdAt: string;
}

/** A day in the public founder-booking calendar. */
export interface BookingDay {
  date: string;
  dayLabel: string;
  open: boolean;
  /** Free "HH:MM" starts in founder-local time. */
  slots: string[];
  /** Full day grid — every future start with whether it's bookable. Busy hours
   *  (blocked on the founder's connected calendar) come back available:false. */
  hours: { time: string; available: boolean }[];
}

export const BookingApi = {
  /** Founder availability for the next `days` days (public, no auth). */
  slots: (days = 14, signal?: AbortSignal) =>
    api<{ timezone: string; days: BookingDay[] }>(`/api/booking/slots?days=${days}`, { signal }),
  /** Books an intro call into the founder's calendar (public, no auth). */
  book: (input: {
    name: string;
    businessType: string;
    phone: string;
    email?: string;
    notes?: string;
    customSystem?: boolean;
    date: string;
    time: string;
  }) =>
    api<{ ok: true; timezone: string; date: string; time: string; durationMinutes: number }>(
      '/api/booking',
      { method: 'POST', body: input },
    ),
};

export const AppointmentsApi = {
  list: (range: { from: string; to: string }, signal?: AbortSignal) => {
    const query = new URLSearchParams({ from: range.from, to: range.to });
    return api<{ appointments: AppointmentDto[] }>(`/api/appointments?${query}`, { signal });
  },
  /** Events pulled from the tenant's connected (Google/Outlook) calendars, for
   *  overlaying onto the in-app calendar. Best-effort — empty if none connected. */
  external: (range: { from: string; to: string }, signal?: AbortSignal) => {
    const query = new URLSearchParams({ from: range.from, to: range.to });
    return api<{ events: ExternalCalendarEvent[] }>(`/api/appointments/external?${query}`, { signal });
  },
  availability: (date: string) =>
    api<{ availability: AvailabilityResult }>(`/api/appointments/availability?date=${date}`),
  create: (input: {
    customerName: string;
    customerPhone?: string;
    reason?: string;
    date: string;
    time: string;
    durationMinutes?: number;
    /** Multi-provider only: book a specific provider (omit for first-available). */
    providerId?: string | null;
    /** Multi-provider only: the service type (sets the length). */
    serviceId?: string | null;
  }) => api<{ appointment: AppointmentDto }>('/api/appointments', { method: 'POST', body: input }),
  update: (
    id: string,
    patch: Partial<{
      status: AppointmentStatus;
      date: string;
      time: string;
      durationMinutes: number;
      notes: string | null;
    }>,
  ) => api<{ appointment: AppointmentDto }>(`/api/appointments/${id}`, { method: 'PATCH', body: patch }),
};

/* -------------------------------- jobs (trades) -------------------------------- */

export type JobUrgency = 'EMERGENCY' | 'URGENT' | 'ROUTINE';
export type JobStatus = 'NEW' | 'CONTACTED' | 'SCHEDULED' | 'CLOSED';

export interface JobDto {
  id: string;
  customerName: string;
  customerPhone: string | null;
  serviceAddress: string | null;
  jobType: string | null;
  urgency: JobUrgency;
  description: string | null;
  preferredCallback: string | null;
  status: JobStatus;
  source: string;
  notes: string | null;
  createdAt: string;
}

export const JobsApi = {
  list: (status?: JobStatus, signal?: AbortSignal) => {
    const query = status ? `?status=${status}` : '';
    return api<{ jobs: JobDto[] }>(`/api/jobs${query}`, { signal });
  },
  create: (input: {
    customerName: string;
    customerPhone?: string;
    serviceAddress?: string;
    jobType?: string;
    urgency: JobUrgency;
    description?: string;
    preferredCallback?: string;
  }) => api<{ job: JobDto }>('/api/jobs', { method: 'POST', body: input }),
  update: (id: string, patch: Partial<{ status: JobStatus; notes: string | null }>) =>
    api<{ job: JobDto }>(`/api/jobs/${id}`, { method: 'PATCH', body: patch }),
};

/* ------------------------------ gated features ------------------------------ */

export type FeatureKey = 'ON_CALL_DISPATCH' | 'MISSED_CALL_TEXTBACK' | 'SERVICE_AREA' | 'FSM_INTEGRATION';

/** A feature's resolved state for one tenant — mirrors the API's ResolvedFeature. */
export interface FeatureState {
  key: FeatureKey;
  label: string;
  description: string;
  /** Platform reqs met + offered to this industry. */
  available: boolean;
  unavailableReason: string | null;
  /** Operator master switch. */
  entitled: boolean;
  /** Operator grant: may the client toggle it themselves. */
  selfManage: boolean;
  enabled: boolean;
  /** available && entitled && enabled. */
  effective: boolean;
}

export const FeaturesApi = {
  list: (signal?: AbortSignal) => api<{ features: FeatureState[] }>('/api/features', { signal }),
  setEnabled: (feature: FeatureKey, enabled: boolean) =>
    api<{ feature: FeatureState }>(`/api/features/${feature}`, { method: 'PATCH', body: { enabled } }),
};

/* --------------------------- field service software --------------------------- */

export type FsmProvider = 'SERVICETITAN' | 'JOBBER' | 'HOUSECALL';

export interface FsmCredentialField {
  key: string;
  label: string;
  secret: boolean;
  placeholder: string | null;
}

export interface FsmConnection {
  provider: FsmProvider;
  label: string;
  connected: boolean;
  accountLabel: string | null;
  status: string;
  lastError: string | null;
  pushJobs: boolean;
  /** Whether live job-push to this provider is wired up yet. */
  pushReady: boolean;
  credentialFields: FsmCredentialField[];
}

export const FsmApi = {
  list: (signal?: AbortSignal) => api<{ connections: FsmConnection[] }>('/api/fsm', { signal }),
  connect: (provider: FsmProvider, credentials: Record<string, string>) =>
    api<{ connection: FsmConnection }>('/api/fsm/connect', { method: 'POST', body: { provider, credentials } }),
  setPush: (provider: FsmProvider, pushJobs: boolean) =>
    api<{ ok: true }>(`/api/fsm/${provider}`, { method: 'PATCH', body: { pushJobs } }),
  disconnect: (provider: FsmProvider) => api<{ ok: true }>(`/api/fsm/${provider}`, { method: 'DELETE' }),
};

/* ----------------------------- providers/services ----------------------------- */

export interface ProviderDto {
  id: string;
  name: string;
  title: string | null;
  active: boolean;
  /** Services this provider can perform; empty = any service. */
  serviceIds: string[];
}
export interface ServiceDto {
  id: string;
  name: string;
  durationMinutes: number;
  description: string | null;
  active: boolean;
  /** Providers qualified for this service; empty = any provider. */
  providerIds: string[];
}
export interface ProvidersConfig {
  /** Operator entitlement: is multi-provider mode on for this tenant. */
  enabled: boolean;
  /** Whether the customer may flip `enabled` from their dashboard. */
  selfManage: boolean;
  /** Proactively offer the provider list vs. book first-available. */
  offerProviderChoice: boolean;
}
export interface ProvidersResponse {
  providers: ProviderDto[];
  services: ServiceDto[];
  config: ProvidersConfig;
}

export type ProviderInput = { name: string; title?: string | null; active?: boolean; serviceIds?: string[] };
export type ServiceInput = {
  name: string;
  durationMinutes: number;
  description?: string | null;
  active?: boolean;
  providerIds?: string[];
};

export const ProvidersApi = {
  list: (signal?: AbortSignal) => api<ProvidersResponse>('/api/providers', { signal }),
  setConfig: (patch: Partial<Pick<ProvidersConfig, 'enabled' | 'offerProviderChoice'>>) =>
    api<{ ok: true }>('/api/providers/config', { method: 'PATCH', body: patch }),
  createProvider: (input: ProviderInput) =>
    api<{ provider: ProviderDto }>('/api/providers', { method: 'POST', body: input }),
  updateProvider: (id: string, patch: Partial<ProviderInput>) =>
    api<{ provider: ProviderDto }>(`/api/providers/${id}`, { method: 'PATCH', body: patch }),
  deleteProvider: (id: string) => api<{ ok: true }>(`/api/providers/${id}`, { method: 'DELETE' }),
  createService: (input: ServiceInput) =>
    api<{ service: ServiceDto }>('/api/providers/services', { method: 'POST', body: input }),
  updateService: (id: string, patch: Partial<ServiceInput>) =>
    api<{ service: ServiceDto }>(`/api/providers/services/${id}`, { method: 'PATCH', body: patch }),
  deleteService: (id: string) => api<{ ok: true }>(`/api/providers/services/${id}`, { method: 'DELETE' }),
};

/* ---------------------------------- SMS ---------------------------------- */

export interface SmsSettings {
  enabled: boolean;
  confirmation: boolean;
  reminder24h: boolean;
  reminder1h: boolean;
  waitlist: boolean;
  confirmationTemplate: string;
  reminder24hTemplate: string;
  reminder1hTemplate: string;
  waitlistTemplate: string;
}

export interface SmsSettingsResponse {
  /** True when the platform operator has configured Twilio credentials. */
  available: boolean;
  settings: SmsSettings;
}

export const SmsApi = {
  getSettings: () => api<SmsSettingsResponse>('/api/sms/settings'),
  updateSettings: (patch: Partial<SmsSettings>) =>
    api<{ ok: true }>('/api/sms/settings', { method: 'PATCH', body: patch }),
};

/* -------------------------------- waitlist -------------------------------- */

export type WaitlistStatus = 'WAITING' | 'NOTIFIED' | 'CONVERTED' | 'CANCELLED';

export interface WaitlistEntry {
  id: string;
  customerName: string;
  customerPhone: string;
  providerId: string | null;
  serviceId: string | null;
  note: string | null;
  status: WaitlistStatus;
  notifiedAt: string | null;
  createdAt: string;
}

export const WaitlistApi = {
  list: (status?: WaitlistStatus, signal?: AbortSignal) => {
    const qs = status ? `?status=${status}` : '';
    return api<{ waitlist: WaitlistEntry[] }>(`/api/waitlist${qs}`, { signal });
  },
  create: (input: {
    customerName: string;
    customerPhone: string;
    providerId?: string | null;
    serviceId?: string | null;
    note?: string | null;
  }) => api<{ entry: WaitlistEntry }>('/api/waitlist', { method: 'POST', body: input }),
  setStatus: (id: string, status: WaitlistStatus) =>
    api<{ entry: WaitlistEntry }>(`/api/waitlist/${id}`, { method: 'PATCH', body: { status } }),
  remove: (id: string) => api<void>(`/api/waitlist/${id}`, { method: 'DELETE' }),
};

/* ------------------------------ reactivation ------------------------------ */

export interface ReactivationSettings {
  enabled: boolean;
  inactivityDays: number;
  template: string;
}

export interface ReactivationSettingsResponse {
  /** True when the platform operator has configured Twilio credentials. */
  available: boolean;
  /** How many lapsed customers would be texted on the next run. */
  eligibleCount: number;
  settings: ReactivationSettings;
}

export const ReactivationApi = {
  getSettings: () => api<ReactivationSettingsResponse>('/api/reactivation/settings'),
  updateSettings: (patch: Partial<ReactivationSettings>) =>
    api<{ ok: true }>('/api/reactivation/settings', { method: 'PATCH', body: patch }),
};

/* ----------------------------- calendar sync ------------------------------ */

export type CalendarProviderId = 'GOOGLE' | 'MICROSOFT';

export interface CalendarConnectionDto {
  provider: CalendarProviderId;
  accountEmail: string | null;
  writeEnabled: boolean;
  blockBusy: boolean;
  lastError: string | null;
  connectedAt: string;
}

export interface CalendarStatus {
  /** Providers the operator has configured OAuth credentials for. */
  availableProviders: CalendarProviderId[];
  connections: CalendarConnectionDto[];
}

export const CalendarApi = {
  status: () => api<CalendarStatus>('/api/calendar/status'),
  connectUrl: (provider: CalendarProviderId) =>
    api<{ url: string }>(`/api/calendar/${provider.toLowerCase()}/connect`),
  disconnect: (provider: CalendarProviderId) =>
    api<{ ok: true }>(`/api/calendar/${provider.toLowerCase()}/disconnect`, { method: 'POST' }),
  setPrefs: (provider: CalendarProviderId, prefs: { writeEnabled?: boolean; blockBusy?: boolean }) =>
    api<{ ok: true }>(`/api/calendar/${provider.toLowerCase()}`, { method: 'PATCH', body: prefs }),
};

export const CallsApi = {
  list: (
    params: {
      page?: number;
      perPage?: number;
      search?: string;
      sinceDays?: number;
      outcome?: string;
      urgency?: string;
      leadQuality?: string;
    },
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams();
    if (params.page) query.set('page', String(params.page));
    if (params.perPage) query.set('perPage', String(params.perPage));
    if (params.search) query.set('search', params.search);
    if (params.sinceDays) query.set('sinceDays', String(params.sinceDays));
    if (params.outcome) query.set('outcome', params.outcome);
    if (params.urgency) query.set('urgency', params.urgency);
    if (params.leadQuality) query.set('leadQuality', params.leadQuality);
    const qs = query.toString();
    return api<ListCallsResult>(`/api/calls${qs ? `?${qs}` : ''}`, { signal });
  },
  stats: () => api<{ stats: CallStats; usage: MonthlyUsage }>('/api/calls/stats'),
  detail: (id: string) => api<{ call: CallDetailDto; mediaToken: string | null }>(`/api/calls/${id}`),
};

/* ------------------------------- screening -------------------------------- */

export interface BlockedCallerDto {
  id: string;
  phone: string;
  reason: string | null;
  createdAt: string;
}

export interface ScreenedCallDto {
  callerNumber: string | null;
  /** "blocked" (on the list) | "anonymous" (opted-in withheld-id refusal). */
  reason: string;
  createdAt: string;
}

export interface ScreeningOverview {
  blocked: BlockedCallerDto[];
  /** Count of calls refused at the gate in the last 30 days. */
  screenedLast30Days: number;
  recent: ScreenedCallDto[];
}

export const ScreeningApi = {
  overview: (signal?: AbortSignal) => api<ScreeningOverview>('/api/screening', { signal }),
  block: (phone: string, reason?: string) =>
    api<{ blocked: BlockedCallerDto }>('/api/screening/block', {
      method: 'POST',
      body: { phone, ...(reason ? { reason } : {}) },
    }),
  unblock: (id: string) => api<{ ok: true }>(`/api/screening/block/${id}`, { method: 'DELETE' }),
};

/* -------------------------------- analytics ------------------------------- */

export interface AnalyticsOverview {
  rangeDays: number;
  totalCalls: number;
  totalBookings: number;
  bookingsBySource: { voice: number; manual: number };
  bookingsByStatus: { confirmed: number; completed: number; cancelled: number; noShow: number };
  noShowRate: number;
  conversionRate: number;
  daily: { date: string; calls: number; bookings: number }[];
  byHour: { hour: number; bookings: number }[];
  byWeekday: { weekday: number; bookings: number }[];
  callOutcomes: {
    analyzedCalls: number;
    byOutcome: {
      BOOKED: number;
      RESCHEDULED: number;
      CANCELLED: number;
      JOB_LOGGED: number;
      MESSAGE_TAKEN: number;
      TRANSFERRED: number;
      NO_ACTION: number;
    };
    urgency: { emergency: number; urgent: number; routine: number };
    leads: { hot: number; warm: number; cold: number };
    avgQualityScore: number | null;
    scoredCalls: number;
    qualityTrend: { date: string; avgScore: number | null }[];
  };
  revenue: {
    avgAppointmentValue: number;
    capturedBookings: number;
    estimatedRevenue: number;
    afterHoursCalls: number;
    afterHoursBookings: number;
  };
}

export const AnalyticsApi = {
  overview: (days = 30, signal?: AbortSignal) =>
    api<{ overview: AnalyticsOverview }>(`/api/analytics/overview?days=${days}`, { signal }),
};

/* ---------------------------- public demo (no auth) ---------------------- */

export type DemoIndustry = 'clinic' | 'contractor' | 'other';
/** The on-screen panel Ava drives via her set_demo_screen tool. */
export type DemoScreen = 'intro' | 'booking' | 'doublebook' | 'summary' | 'close';
/** A live recap of the call Ava pushes to the summary panel via show_call_summary. */
export interface DemoCallSummary {
  headline: string;
  recap: string;
}
export interface DemoDay {
  date: string;
  dayLabel: string;
  timezone: string;
  open: string;
  close: string;
  slotMinutes: number;
  /** Industry the sample calendar is dressed for. */
  industry: DemoIndustry;
  /** Sample business name shown atop the calendar, matched to the industry. */
  sampleCompany: string;
}
export interface DemoAppointment {
  id: string;
  time: string; // "HH:MM" local
  label: string;
  kind: 'seed' | 'blocked' | 'voice';
}
export interface DemoSessionResponse {
  publicKey: string;
  assistant: WebAssistantConfig;
  sessionId: string;
  day: DemoDay;
  appointments: DemoAppointment[];
  /** Founder toggle: whether to show the live sample calendar to the prospect. */
  showCalendar: boolean;
}
export interface DemoLeadInput {
  name: string;
  email: string;
  phone: string;
  industry: DemoIndustry;
  /** Optional: the prospect's own business name, shown on the sample calendar. */
  businessName?: string;
}
export interface DemoLeadResponse {
  leadId: string;
  sessionId: string;
  name: string;
  phone: string;
  industry: DemoIndustry;
  /** True when the visitor may receive an outbound demo call (US/CA or +1). */
  callAllowed: boolean;
  ipCountry: string | null;
  phoneCountry: string | null;
  day: DemoDay;
  appointments: DemoAppointment[];
}
export interface DemoStartInput {
  sessionId?: string;
  leadId?: string;
  name?: string;
}

export interface SalesConfig {
  agentName: string;
  founderName: string;
  showCalendar: boolean;
}
/** A phone number on the Vapi account, for the demo caller-ID picker. */
export interface VapiNumberOption {
  id: string;
  number: string;
}
export interface DemoNumbers {
  us: VapiNumberOption | null;
  ca: VapiNumberOption | null;
}
export interface DemoCallResponse {
  ok: boolean;
  callId: string;
  fromNumber: string;
  country: string | null;
}
export interface DemoCallRecord {
  id: string;
  durationSeconds: number;
  endedReason: string | null;
  summary: string | null;
  transcript: string | null;
  recordingUrl: string | null;
  createdAt: string;
  lead: { name: string; email: string; phone: string; mode: string } | null;
}

export const DemoApi = {
  status: () => api<{ enabled: boolean }>('/api/demo/status'),
  lead: (input: DemoLeadInput) =>
    api<DemoLeadResponse>('/api/demo/lead', { method: 'POST', body: input }),
  start: (input: DemoStartInput = {}) =>
    api<DemoSessionResponse>('/api/demo/session', { method: 'POST', body: input }),
  call: (input: { sessionId: string; leadId?: string; name?: string; phone: string }) =>
    api<DemoCallResponse>('/api/demo/call', { method: 'POST', body: input }),
  appointments: (sessionId: string) =>
    api<{ appointments: DemoAppointment[]; screen: DemoScreen | null; summary: DemoCallSummary | null }>(
      `/api/demo/appointments?sessionId=${encodeURIComponent(sessionId)}`,
    ),
  block: (sessionId: string, date: string, time: string) =>
    api<{ appointments: DemoAppointment[] }>('/api/demo/block', { method: 'POST', body: { sessionId, date, time } }),
  reset: (sessionId: string) =>
    api<{ day: DemoDay; appointments: DemoAppointment[] }>('/api/demo/reset', { method: 'POST', body: { sessionId } }),
};

export const VoiceApi = {
  webSession: (voiceId?: string) =>
    api<WebSession>('/api/voice/web-session', { method: 'POST', body: voiceId ? { voiceId } : {} }),
};

/** Masked, token-gated audio URL for <audio> elements. */
export function mediaUrl(mediaToken: string): string {
  return `${API_URL}/api/media/${mediaToken}`;
}
