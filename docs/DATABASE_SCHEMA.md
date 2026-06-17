# VoiceFront Database Schema

**Database:** PostgreSQL 16  
**ORM:** Prisma 5.x  
**Schema location:** `apps/api/prisma/schema.prisma`  
**Migrations:** `apps/api/prisma/migrations/`

---

## Entity Relationship Diagram

```
┌─────────────────┐
│     Tenant      │ (companies, clinics, businesses)
│─────────────────│
│ id (PK)         │
│ slug (unique)   │
│ companyName     │
│ industry        │
│ subscriptionSta │ ◄────┐
│ isBlocked       │      │
│ markupBps       │      │
│ monthlyMinLimit │      │
│ createdAt       │      │
│ updatedAt       │      │
└────────┬────────┘      │
         │               │
         ├───────────────┼─────────────────────┐
         │ 1:1           │ 1:N                 │
         ↓               ↓                     │
   ┌──────────────┐  ┌──────────┐        ┌─────────┐
   │AgentSettings │  │   User   │        │ OnBoarding
   │──────────────│  │──────────│        │──────────
   │tenantId (FK) │  │id (PK)   │        │tenantId(FK)
   │displayName   │  │tenantId  │        │hasConfigProf
   │systemPrompt  │  │email(U)  │        │hasConfigPrompt
   │firstMessage  │  │passHash  │        │hasTestedVoice
   │vmailGreeting │  │fullName  │        │isActive
   │businessHours │  │role      │        │demoCallLim
   │timezone      │  │createdAt │        │
   │voiceProvider │  │updatedAt │        │
   │voiceId       │  └──────────┘        └─────────┘
   │forwardingNums│
   │inboundNumber │
   │assistantId   │
   │createdAt     │
   │updatedAt     │
   └──────────────┘

         ┌──────────────────────────┬─────────────────────┐
         │ 1:N                      │ 1:N                 │
         ↓                          ↓                     │
    ┌──────────┐             ┌────────────┐       ┌────────────┐
    │ CallLog  │             │Appointment │       │  Document  │
    │──────────│             │────────────│       │────────────│
    │id (PK)   │             │id (PK)     │       │id (PK)     │
    │tenantId  │             │tenantId    │       │tenantId    │
    │extCallId │             │demoSession │       │fileName    │
    │direction │             │customerName│       │mimeType    │
    │phoneNum  │             │phone       │       │vapiFileId  │
    │startsAt  │             │reason      │       │status      │
    │endsAt    │             │startsAt    │       │createdAt   │
    │duration  │             │endsAt      │       │updatedAt   │
    │endedReason              │timezone    │       └────────────┘
    │providerCost│            │source      │
    │billedCost │             │status      │
    │summary    │             │createdAt   │
    │transcript │             │updatedAt   │
    │recordingUrl             │            │
    │createdAt  │             └────────────┘
    │updatedAt  │
    └──────────┘
```

```
┌──────────────────┐        ┌──────────────────┐
│    DemoLead      │        │    DemoCall      │
│──────────────────│        │──────────────────│
│id (PK)           │        │id (PK)           │
│demoSessionId (FK)│◄──┐    │demoSessionId (FK)│◄──┐
│name              │   │    │externalCallId (U)│   │
│email             │   │    │durationSeconds   │   │
│phone             │   │    │endedReason       │   │
│ipCountry         │   │    │summary           │   │
│phoneCountry      │   │    │transcript        │   │
│mode              │   │    │recordingUrl      │   │
│createdAt         │   │    │startedAt         │   │
└──────────────────┘   │    │endedAt           │   │
                       │    │createdAt         │   │
                       │    └──────────────────┘   │
                       │                           │
                       │        (isolated calendar)
                       │         per visitor
                       └───────────────────────────┘

┌──────────────────────┐
│ PlatformSetting      │
│──────────────────────│
│key (PK, unique)      │
│valueEnc (text)       │ ← NOT actually encrypted
│updatedBy             │
│updatedAt             │
└──────────────────────┘
```

---

## Core Tables

### Tenant

The multi-tenant root. Each clinic/business is a `Tenant`.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | text | PK, unique, default: cuid() | UUID-like identifier |
| `slug` | text | unique, not null | White-label slug (e.g., "acme-corp"); used for subdomain routing |
| `companyName` | text | not null | Display name (e.g., "ACME Corp") |
| `industry` | enum | not null | CLINIC \| CONSTRUCTION |
| `subscriptionStatus` | enum | default: TRIALING | TRIALING \| ACTIVE \| PAST_DUE \| CANCELED |
| `isBlocked` | bool | default: false | Operator can suspend the tenant |
| `markupBps` | int | default: 5000 | Markup in basis points (5000 = +50%) |
| `monthlyMinuteLimit` | int | default: 500 | Hard cap on answered-call minutes per month |
| `createdAt` | datetime | default: now(), not null | Creation timestamp (UTC) |
| `updatedAt` | datetime | not null, updated on change | Last modified (UTC) |

**Indexes:**
- `slug` (unique)
- `subscriptionStatus` (for operator queries)
- `createdAt` (for sorting/pagination)

---

### User

A person who logs into the platform.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | text | PK, default: cuid() | User UUID |
| `email` | text | unique, not null | Email address (case-insensitive in practice) |
| `passwordHash` | text | not null | bcrypt(12) hash |
| `fullName` | text | not null | Display name |
| `role` | enum | default: OWNER | OWNER \| MANAGER \| AGENT |
| `tenantId` | text | FK, not null | References `Tenant.id` |
| `createdAt` | datetime | default: now(), not null | Creation |
| `updatedAt` | datetime | not null | Last modified |

**Indexes:**
- `email` (unique)
- `tenantId` (FK, for listing users per tenant)

---

### AgentSettings

The receptionist config for a tenant. 1:1 with Tenant.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `tenantId` | text | PK, FK | References `Tenant.id` |
| `displayName` | text | not null | Agent's name (e.g., "Maya") |
| `systemPrompt` | text | not null | Full LLM system prompt |
| `firstMessage` | text | not null | Greeting on inbound call |
| `voicemailGreeting` | text | not null | Message left if no answer |
| `businessHours` | json | not null | {mon: {enabled, open, close}, ...} |
| `timezone` | text | not null | IANA timezone (e.g., "America/Vancouver") |
| `voiceProvider` | text | default: "vapi" | "vapi" \| "elevenlabs" |
| `voiceId` | text | not null | Provider's voice ID (e.g., "Emma") |
| `forwardingNumbers` | json | default: [] | [{number, label}, ...]; E.164 format |
| `inboundPhoneNumber` | text | nullable | Tenant's main number (E.164); used for number→tenant routing |
| `assistantId` | text | nullable | Vapi persistent assistant ID (if used) |
| `backgroundSound` | text | nullable | "office", "on_hold", etc. |
| `createdAt` | datetime | default: now() | Creation |
| `updatedAt` | datetime | not null | Last modified |

**Indexes:**
- `tenantId` (PK, unique)
- `inboundPhoneNumber` (for webhook routing: number→tenant lookup)

**Notes:**
- `businessHours` is a JSON object, parsed by the domain layer at call-time
- `forwardingNumbers` is JSON; no FK to a phone table
- `assistantId` is only populated if using persistent Vapi assistants (rare path)

---

### OnboardingStatus

State machine for the 3-step onboarding. 1:1 with Tenant.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `tenantId` | text | PK, FK | References `Tenant.id` |
| `hasConfiguredProfile` | bool | default: false | PROFILE step complete |
| `hasConfiguredPrompt` | bool | default: false | PROMPT step complete |
| `hasTestedVoice` | bool | default: false | VOICE_TEST step complete |
| `isActive` | bool | default: false | All steps done + activated |
| `demoCallLimit` | int | nullable | Free tier demo call limit |

---

### CallLog

A phone call (inbound or outbound). 1:N with Tenant.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | text | PK, default: cuid() | Call log ID |
| `tenantId` | text | FK, not null | References `Tenant.id` |
| `externalCallId` | text | unique, nullable | Vapi call ID; used for idempotency |
| `direction` | enum | not null | INBOUND \| OUTBOUND |
| `phoneNumber` | text | not null | E.164 caller or callee number |
| `startsAt` | datetime | not null, UTC | Call start |
| `endsAt` | datetime | nullable, UTC | Call end (null if in-progress) |
| `durationSeconds` | int | default: 0 | Calculated on end-of-call-report |
| `endedReason` | text | nullable | "CALL_ENDED", "VOICEMAIL", "FAILED", etc. |
| `aiSummary` | text | nullable | Auto-generated summary from Vapi |
| `transcript` | text | nullable | Full call transcript (text) |
| `recordingUrl` | text | nullable | Vapi recording URL (proxied via /api/media/:token) |
| `providerCostCents` | int | default: 0 | Vapi cost (cents); never sent to tenant |
| `billedCostCents` | int | default: 0 | Tenant-visible cost (with markup) |
| `createdAt` | datetime | default: now() | Log creation (usually ~1s after call ends) |
| `updatedAt` | datetime | not null | Last modified |

**Indexes:**
- `tenantId` (FK, for listing calls per tenant)
- `externalCallId` (unique, for idempotency)
- `createdAt DESC` (for sorted list/pagination)

**Notes:**
- `providerCostCents` is server-only, never in DTOs sent to tenants
- Billing calculation: `billedCostCents = round(providerCostCents × (10000 + tenant.markupBps) / 10000)`

---

### Appointment

A calendar slot. Shared by clinics (real bookings), demo sessions (isolated per-visitor), and founder calendar (__founder tenant).

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | text | PK, default: cuid() | Appointment ID |
| `tenantId` | text | FK, not null | References `Tenant.id` (e.g., "acme-corp" or "__demo" or "__founder") |
| `demoSessionId` | text | nullable | If set, scopes appointment to one visitor's session |
| `customerName` | text | not null | Caller/visitor name or "Blocked (you)" for manual blocks |
| `customerPhone` | text | nullable | E.164 or null |
| `reason` | text | nullable | "Cleaning", "Consultation", "Planning call", etc. |
| `startsAt` | datetime | not null, UTC | Appointment start |
| `endsAt` | datetime | not null, UTC | Appointment end |
| `timezone` | text | not null | IANA timezone (stored so history is timezone-independent) |
| `source` | enum | not null | VOICE_AGENT \| MANUAL |
| `status` | enum | default: CONFIRMED | CONFIRMED \| CANCELLED \| COMPLETED \| NO_SHOW |
| `externalCallId` | text | nullable | If booked during a call, the call ID |
| `notes` | text | nullable | Internal notes |
| `createdAt` | datetime | default: now() | Creation |
| `updatedAt` | datetime | not null | Last modified |

**Indexes:**
- `tenantId, demoSessionId` (composite, for query: "all appointments in this visitor's session")
- `startsAt` (for range queries by date)
- `createdAt` (for sorting)

**Notes:**
- `demoSessionId` is non-null only for demo visitors; real tenants have null here
- Overlap prevention: Postgres advisory lock on `(tenantId, demoSessionId)` during booking
- Founder calendar uses tenantId = "__founder" (special tenant)

---

### Document

A tenant's uploaded knowledge-base file.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | text | PK, default: cuid() | Document ID |
| `tenantId` | text | FK, not null | References `Tenant.id` |
| `fileName` | text | not null | Original filename (e.g., "pricing.pdf") |
| `mimeType` | text | not null | File MIME type |
| `vapiFileId` | text | nullable | Vapi's file store ID (set after upload) |
| `status` | text | default: "processing" | "processing" \| "done" \| "failed" |
| `createdAt` | datetime | default: now() | Upload timestamp |
| `updatedAt` | datetime | not null | Last status change |

**Indexes:**
- `tenantId` (FK, for listing documents per tenant)
- `status` (for finding "done" or "failed" documents)

---

### DemoLead

A prospect who filled the lead form on the landing page.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | text | PK, default: cuid() | Lead ID |
| `demoSessionId` | text | FK, not null | References the isolated demo session |
| `name` | text | not null | Prospect name |
| `email` | text | not null | Email |
| `phone` | text | not null | Phone (typed as-is by user, later coerced to E.164) |
| `ipCountry` | text | nullable | ISO 2-letter country from ipapi.co lookup; may be null |
| `phoneCountry` | text | nullable | ISO 2-letter country detected from phone number; may be null |
| `mode` | text | default: "pending" | "pending" \| "web" \| "call" |
| `createdAt` | datetime | default: now() | Form submission time |

**Indexes:**
- `demoSessionId` (FK, 1:1 relationship ideally but stored as nullable join)
- `createdAt` (for audit trail)

---

### DemoCall

A captured demo call (transcript + recording + summary).

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | text | PK, default: cuid() | Demo call ID |
| `demoSessionId` | text | FK, not null | References the visitor's session |
| `externalCallId` | text | unique, nullable | Vapi call ID; used for idempotency on webhook |
| `durationSeconds` | int | default: 0 | Call duration |
| `endedReason` | text | nullable | "CALL_ENDED", etc. |
| `summary` | text | nullable | AI-generated recap |
| `transcript` | text | nullable | Full transcript |
| `recordingUrl` | text | nullable | Vapi recording URL |
| `startedAt` | datetime | nullable | Call start |
| `endedAt` | datetime | nullable | Call end |
| `createdAt` | datetime | default: now() | Row creation (usually ~1s after call ends) |

**Indexes:**
- `demoSessionId` (FK)
- `externalCallId` (unique, for idempotency)
- `createdAt DESC` (for sorted list on admin page)

---

### PlatformSetting

Operator-wide configuration (not encrypted, despite the `valueEnc` column name).

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `key` | text | PK, unique | Setting key (e.g., "VAPI_PUBLIC_KEY") |
| `valueEnc` | text | not null | Plain-text value (NOT encrypted) |
| `updatedBy` | text | not null | Email of operator who set it |
| `updatedAt` | datetime | not null | Last change |

**Settings in use:**
- `VAPI_PUBLIC_KEY` — Vapi org public key (safe for browser)
- `VAPI_WEBHOOK_SECRET` — Vapi webhook signing secret (server-only)
- `PUBLIC_API_URL` — API base URL (for web app config)
- `JWT_SECRET` — JWT signing key (server-only)
- `DEMO_ENABLED` — Is sales demo on? ("true" / "false" text)
- `DEMO_SALES_AGENT_NAME` — Agent display name (default "Ava")
- `DEMO_FOUNDER_NAME` — Founder display name (default "our founder")
- `DEMO_SHOW_CALENDAR` — Show calendar in demo? ("true" / "false" text)
- `DEMO_NUMBER_US` — US demo caller ID, stored as JSON: `{"id": "...", "number": "..."}`
- `DEMO_NUMBER_CA` — CA demo caller ID, same JSON format
- `FOUNDER_TIMEZONE` — Founder's timezone (e.g., "America/Vancouver")

---

## Enums

### Industry
```
CLINIC | CONSTRUCTION
```

### SubscriptionStatus
```
TRIALING | ACTIVE | PAST_DUE | CANCELED
```

### Role
```
OWNER | MANAGER | AGENT
```

### AppointmentStatus
```
CONFIRMED | CANCELLED | COMPLETED | NO_SHOW
```

### AppointmentSource
```
VOICE_AGENT | MANUAL
```

### CallDirection
```
INBOUND | OUTBOUND
```

---

## Special Tenants

| slug | Purpose | Notes |
|------|---------|-------|
| `__demo` | Sales demo isolated calendar | One session per visitor; auto-GC'd after 2 hours idle |
| `__founder` | Founder's planning-call calendar | Real tenant; blocks + booked calls |
| `__platform` | (Reserved) Platform admin tenant | For future multi-admin features |

---

## Foreign Key Relationships

| Table | Column | References | Cascade |
|-------|--------|-----------|---------|
| User | tenantId | Tenant.id | CASCADE DELETE |
| AgentSettings | tenantId | Tenant.id | CASCADE DELETE |
| OnboardingStatus | tenantId | Tenant.id | CASCADE DELETE |
| CallLog | tenantId | Tenant.id | CASCADE DELETE |
| Appointment | tenantId | Tenant.id | CASCADE DELETE |
| Document | tenantId | Tenant.id | CASCADE DELETE |
| DemoLead | demoSessionId | (no FK, just UUID) | — |
| DemoCall | demoSessionId | (no FK, just UUID) | — |

**Notes:**
- Cascading deletes mean removing a Tenant wipes all its data (users, calls, appointments)
- Demo tables (DemoLead, DemoCall) use demoSessionId as a string UUID, not a foreign key (for simplicity; sessions are ephemeral)

---

## Indexing Strategy

**High-priority indexes (created):**
- `CallLog.tenantId` + `CallLog.createdAt DESC` — for paginated call lists
- `Appointment.tenantId + demoSessionId` — for demo session isolation
- `AgentSettings.inboundPhoneNumber` — for webhook number→tenant routing
- `User.tenantId` — for listing users per tenant
- All primary keys and unique constraints

**Low-priority (no index yet):**
- `Document.status` — small table, linear scan acceptable
- `PlatformSetting.key` — tiny table, all settings usually cached

---

## Data Retention & Cleanup

- **CallLog:** Kept indefinitely (compliance + audit)
- **Appointment:** Kept indefinitely
- **DemoLead/DemoCall:** Kept indefinitely (founder review)
- **Appointment (demo):** Auto-deleted after 2 hours idle (session GC in `startDemoSession()`)
- **Document:** Deleted when user removes from UI (hard delete)

---

## Growth Estimates

For 100 active clinics + 500 calls/month per clinic:

| Table | Rows | Size |
|-------|------|------|
| Tenant | 100 | <1 MB |
| User | 500 | <1 MB |
| AgentSettings | 100 | <1 MB |
| CallLog | 60,000 (over 1y) | ~10 MB |
| Appointment | 60,000 (over 1y) | ~10 MB |
| Document | 500 | ~5 MB |
| DemoLead/DemoCall | 10,000 (over 1y) | ~5 MB |

**Total:** ~40 MB over 1 year. Scaling issue is API throughput, not database size.

---

**Last updated:** June 2026  
**Prisma version:** 5.x
