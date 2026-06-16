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
}

export interface CallDetailDto extends CallDto {
  transcript: string | null;
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
  createdAt: string;
}

export interface AvailabilityResult {
  open: boolean;
  freeSlots: string[];
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
  deleteTenant: (id: string) => api<{ ok: true }>(`/api/admin/tenants/${id}`, { method: 'DELETE' }),
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
    api<{ settings: AdminSetting[] }>('/api/admin/settings', { signal }),
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
  salesConfig: (signal?: AbortSignal) =>
    api<SalesConfig>('/api/admin/demo/sales-config', { signal }),
  setSalesConfig: (patch: Partial<SalesConfig>) =>
    api<SalesConfig>('/api/admin/demo/sales-config', { method: 'PATCH', body: patch }),
  demoCalls: (signal?: AbortSignal) =>
    api<{ calls: DemoCallRecord[] }>('/api/admin/demo/calls', { signal }),
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
};

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

export const AppointmentsApi = {
  list: (range: { from: string; to: string }, signal?: AbortSignal) => {
    const query = new URLSearchParams({ from: range.from, to: range.to });
    return api<{ appointments: AppointmentDto[] }>(`/api/appointments?${query}`, { signal });
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

export const CallsApi = {
  list: (params: { page?: number; perPage?: number; search?: string; sinceDays?: number }, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (params.page) query.set('page', String(params.page));
    if (params.perPage) query.set('perPage', String(params.perPage));
    if (params.search) query.set('search', params.search);
    if (params.sinceDays) query.set('sinceDays', String(params.sinceDays));
    const qs = query.toString();
    return api<ListCallsResult>(`/api/calls${qs ? `?${qs}` : ''}`, { signal });
  },
  stats: () => api<{ stats: CallStats; usage: MonthlyUsage }>('/api/calls/stats'),
  detail: (id: string) => api<{ call: CallDetailDto; mediaToken: string | null }>(`/api/calls/${id}`),
};

/* ---------------------------- public demo (no auth) ---------------------- */

export interface DemoDay {
  date: string;
  dayLabel: string;
  timezone: string;
  open: string;
  close: string;
  slotMinutes: number;
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
}
export interface DemoLeadResponse {
  leadId: string;
  sessionId: string;
  name: string;
  phone: string;
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
  appointments: (sessionId: string) =>
    api<{ appointments: DemoAppointment[] }>(`/api/demo/appointments?sessionId=${encodeURIComponent(sessionId)}`),
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
