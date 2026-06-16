# VoiceFront: Complete Architecture & Handoff

**Last Updated:** June 2026  
**Status:** Live on production (Railway)  
**Audience:** Engineers, operators, future maintainers, AI handoffs

---

## 1. Project Overview

**VoiceFront** is a B2B SaaS platform that gives medical clinics, law firms, and service businesses an **AI voice receptionist**. Built on Vapi's voice infrastructure (hidden from tenants), it provides:

- **For tenants:** A branded dashboard to manage their AI receptionist, review calls, set business hours, and configure call handling
- **For you (the operator):** A sales demo that prospects can watch *live* on a web calendar, plus a founder portal to control the sales experience and book follow-up calls
- **For prospects:** Two ways to experience the demo:
  1. **In-browser test** — talk to Ava (the sales agent) in the browser; watch her book appointments in real-time on a sample calendar
  2. **Outbound call** — Ava calls your phone; same full demo by voice, with caller ID routed by country (US/CA)

### The Business Model
- Multi-tenant SaaS: each clinic/business is a `Tenant` with their own assistant, settings, call logs
- Markup-based billing: operator sets a `markupBps` (basis points) per tenant; costs = `provider_cost × (1 + markupBps/10000)`
- Production deployment: API and Web are separate apps on Railway; webhooks from Vapi route back to the API

---

## 2. Architecture at a Glance

```
┌─────────────────────────────────────────────────────────────────┐
│                         Prospect / Clinic                        │
├─────────────────────────────────────────────────────────────────┤
│  Landing page (sales demo) OR   │  Clinic dashboard              │
│  └─ Lead capture form           │  ├─ Onboarding (3 steps)      │
│  └─ Choose: web test OR call    │  ├─ Receptionist settings     │
│  └─ Web: in-browser demo        │  ├─ Call history              │
│  └─ Call: Ava rings your phone  │  └─ Analytics                 │
└──────────────┬────────────────────────┬──────────────────────────┘
               │ HTTP/REST              │ HTTP/REST
               ↓                        ↓
        ┌──────────────────────────────────┐
        │      Web (Next.js :3000)         │  ← Founder admin portal
        │  ├─ Landing page                 │     ├─ Sales demo config
        │  ├─ Onboarding UI                │     ├─ My calendar
        │  ├─ Dashboard                    │     └─ Demo call logs
        │  └─ Admin panel                  │
        └──────────────┬───────────────────┘
                       │ HTTP/REST
                       ↓
        ┌──────────────────────────────────────────────────┐
        │       API (Express :4000)                        │
        │  ├─ Auth (JWT, register, login, me)             │
        │  ├─ Tenants & Users                             │
        │  ├─ Onboarding state machine                    │
        │  ├─ Agent settings & call logs                  │
        │  ├─ Billing (markup calculation)                │
        │  ├─ Sales demo (lead capture, sessions, calls)  │
        │  ├─ Founder portal (calendar, booking)          │
        │  └─ Vapi webhook handler (assistant-request,    │
        │      end-of-call-report)                        │
        └──────────────┬───────────────────────────────────┘
                       │ Webhook (HTTPS)
                       ↓
        ┌──────────────────────────────────────────────────┐
        │          Vapi (provider)                         │
        │  ├─ Voice API (inbound + outbound calls)        │
        │  ├─ Transient assistants (built per-call)       │
        │  └─ Recording + transcription                   │
        └──────────────────────────────────────────────────┘

        ┌──────────────────────────────────────────────────┐
        │      PostgreSQL (Docker :5433)                   │
        │  ├─ Tenants, Users, OnboardingStatus            │
        │  ├─ AgentSettings (prompt, voice, hours)        │
        │  ├─ CallLog (calls, transcript, recording)      │
        │  ├─ Document (knowledge base files)             │
        │  ├─ DemoLead, DemoCall (sales demo)            │
        │  └─ FounderEntry (founder calendar)             │
        └──────────────────────────────────────────────────┘
```

---

## 3. Data Model

### Core Tenant Model

```
Tenant (the clinic/business)
├─ id (uuid, PK)
├─ slug (unique, white-label identifier)
├─ companyName (e.g., "Bayview Dental")
├─ industry (CLINIC | CONSTRUCTION)
├─ subscriptionStatus (TRIALING | ACTIVE | PAST_DUE | CANCELED)
├─ isBlocked (boolean, operator can suspend)
├─ markupBps (integer, default 5000 = +50% markup)
├─ monthlyMinuteLimit (integer, default 500; enforced per-call)
├─ createdAt, updatedAt

├─ 1:1 AgentSettings
│  ├─ tenantId (FK)
│  ├─ displayName (e.g., "Maya")
│  ├─ systemPrompt (text, composed at call-time)
│  ├─ firstMessage (greeting)
│  ├─ voicemailGreeting (text)
│  ├─ businessHours (JSON: {mon: {enabled, open, close}, ...})
│  ├─ timezone (IANA: "America/Vancouver")
│  ├─ voiceProvider ("vapi" | "elevenlabs")
│  ├─ voiceId (e.g., "Emma")
│  ├─ forwardingNumbers (JSON: [{number, label}, ...])
│  ├─ inboundPhoneNumber (E.164, e.g., "+15551234567")
│  ├─ assistantId (Vapi persistent assistant ID, if used)
│  └─ createdAt, updatedAt

├─ N:1 Users
│  ├─ id (uuid)
│  ├─ email (unique)
│  ├─ passwordHash (bcrypt)
│  ├─ fullName
│  ├─ role (OWNER | MANAGER | AGENT)
│  └─ createdAt, updatedAt

├─ 1:1 OnboardingStatus
│  ├─ tenantId (FK)
│  ├─ hasConfiguredProfile (bool)
│  ├─ hasConfiguredPrompt (bool)
│  ├─ hasTestedVoice (bool)
│  ├─ isActive (bool; user can use the platform)
│  └─ demoCallLimit (int; for free tier)

├─ N:1 CallLog
│  ├─ id (uuid)
│  ├─ tenantId (FK)
│  ├─ externalCallId (from Vapi)
│  ├─ direction (INBOUND | OUTBOUND)
│  ├─ phoneNumberE164 (caller or callee)
│  ├─ startsAt, endsAt (timestamps, UTC)
│  ├─ durationSeconds
│  ├─ endedReason (e.g., "COMPLETED", "VOICEMAIL", "FAILED")
│  ├─ providerCostCents (integer; NOT sent to tenant)
│  ├─ billedCostCents (providerCost × markup; what tenant sees)
│  ├─ aiSummary (text, auto-generated)
│  ├─ transcript (text)
│  ├─ recordingUrl (Vapi URL; proxied via /api/media/:token)
│  └─ createdAt, updatedAt

├─ N:1 Document (knowledge base)
│  ├─ id (uuid)
│  ├─ tenantId (FK)
│  ├─ fileName
│  ├─ mimeType
│  ├─ vapiFileId (Vapi's file store ID)
│  ├─ status (processing | done | failed)
│  └─ createdAt, updatedAt

├─ N:1 Appointment (shared demo + clinic bookings)
│  ├─ id (uuid)
│  ├─ tenantId (FK, usually __demo or __founder)
│  ├─ demoSessionId (FK; isolates per-visitor calendar)
│  ├─ customerName
│  ├─ customerPhone (optional)
│  ├─ reason (optional)
│  ├─ startsAt, endsAt (UTC)
│  ├─ timezone (tenant-local)
│  ├─ source (VOICE_AGENT | MANUAL)
│  ├─ status (CONFIRMED | CANCELLED | COMPLETED | NO_SHOW)
│  └─ createdAt, updatedAt
```

### Sales Demo Model

```
DemoLead (prospect who filled the form)
├─ id (uuid)
├─ demoSessionId (FK; links to isolated calendar)
├─ name (prospect's first/last)
├─ email
├─ phone (typed number; used for geo-gating & outbound call)
├─ ipCountry (ISO 2-letter, from ipapi.co; may be null)
├─ phoneCountry (ISO 2-letter, detected from +1 vs +44, etc.; may be null)
├─ mode (pending | web | call; set when they choose a demo mode)
└─ createdAt

DemoCall (captured call transcript + recording)
├─ id (uuid)
├─ demoSessionId (FK; which visitor's call)
├─ externalCallId (from Vapi; unique, used for idempotency)
├─ durationSeconds
├─ endedReason (e.g., "COMPLETED")
├─ summary (AI-generated recap)
├─ transcript (full call text)
├─ recordingUrl (Vapi recording; proxied via /api/media/:token)
├─ startedAt, endedAt (UTC)
└─ createdAt
```

### Founder Calendar Model

```
FounderEntry (via Appointment model with tenantId = __founder)
├─ id (uuid)
├─ tenantId = __founder (the founder's personal tenant)
├─ customerName (e.g., "Lunch" or "Client: Acme Inc")
├─ reason (optional; why this block)
├─ startsAt, endsAt (UTC)
├─ timezone (founder's timezone; used for scheduling)
├─ source (MANUAL for blocks; VOICE_AGENT for booked planning calls)
├─ status (CONFIRMED for active blocks)
└─ createdAt
```

### Platform Settings

```
PlatformSetting (operator-wide config, not encrypted)
├─ key (unique)
├─ valueEnc (text value, NOT encrypted despite the name)
├─ updatedBy (email of operator who set it)

Keys in use:
├─ VAPI_PUBLIC_KEY (Vapi org public key; safe to send to browser)
├─ VAPI_WEBHOOK_SECRET (Vapi webhook signing secret; server-only)
├─ PUBLIC_API_URL (e.g., https://api.voicefront.com)
├─ JWT_SECRET (for signing JWTs)
├─ DEMO_ENABLED (true|false; global on/off for sales demo)
├─ DEMO_SALES_AGENT_NAME (e.g., "Ava")
├─ DEMO_FOUNDER_NAME (e.g., "our founder")
├─ DEMO_SHOW_CALENDAR (true|false; toggle for demo calendar visibility)
├─ DEMO_NUMBER_US (JSON: {id, number}; US demo caller ID)
└─ DEMO_NUMBER_CA (JSON: {id, number}; CA demo caller ID)
```

---

## 4. Systems

### 4.1 Authentication & Authorization

**Flow:**
1. User registers at `/register` (rate-limited) → creates Tenant + User → returns JWT
2. User logs in at `/login` (rate-limited, timing-safe) → returns JWT
3. All protected routes require JWT bearer token in `Authorization: Bearer <token>`
4. Token lifetime: 7 days (can be configured)

**Security:**
- Passwords: bcrypt(12) rounds
- Timing-safe login: dummy hash compare for unknown emails (prevents email enumeration)
- Helmet + CORS allowlist on all routes
- Rate limiting on auth endpoints (20 req/15min per IP)

**Roles:**
- `OWNER`: can change settings, invite users, view all call logs
- `MANAGER`: can change settings, view call logs (not finances)
- `AGENT`: read-only (can only see call transcripts, not edit settings)

**Session:**
- `GET /api/auth/me` returns current user + tenant + onboarding view
- A global API error (401) signs out everywhere at once

---

### 4.2 Onboarding State Machine

**Flow:**
```
START → PROFILE → PROMPT → VOICE_TEST → ACTIVE
```

Prerequisites for each step:
- **PROFILE:** name, company, industry
- **PROMPT:** ≥40 characters of call-handling instructions
- **VOICE_TEST:** ≥1 successful browser call (or skip/mark complete if no public key)
- **ACTIVE:** all three steps complete → tenant can receive inbound calls

**Key insight:** Steps are *revisitable*. A tenant can complete all three, go live, then edit their prompt again. The *latest* prompt is what the next inbound call uses.

---

### 4.3 Transient Assistants

**Philosophy:** Nothing is persisted on Vapi. Every call gets a fresh assistant built from the tenant's *current* settings.

**What happens:**
1. Inbound call arrives → Vapi sends `assistant-request` webhook
2. VoiceFront maps the phone number → finds the Tenant
3. Fetches the tenant's AgentSettings (prompt, voice, forwarding numbers, etc.)
4. Builds a fresh Vapi assistant JSON with:
   - The tenant's system prompt (composed with live context: is the office open right now? what's today's date?)
   - A transfer directory (internal label + voicemail, no numbers in the prompt)
   - Business hours explained in plain English ("we're open Monday–Friday 9am–5pm Pacific")
   - Voice + ambience selected by the tenant
5. Returns it to Vapi → call connects → agent operates
6. When the call ends → `end-of-call-report` webhook ingests the call log

**Benefit:** If a tenant changes their prompt, the very next call uses the new one. No sync delay.

---

### 4.4 Call Booking Engine

**How it works:**
1. Agent calls `checkAvailability(date)` → returns free slots in `HH:MM` format
2. Agent calls `bookAppointment(customerName, phone, date, time, durationMinutes)` → creates a CONFIRMED appointment
3. Slot overlap is prevented by an atomic **Postgres advisory lock** per tenant:
   ```sql
   SELECT pg_advisory_xact_lock(hashtext(tenantId));
   -- now check for conflicts
   -- if no conflict, insert
   ```

**Business Hours:**
- Stored as JSON on AgentSettings: `{mon: {enabled: true, open: "09:00", close: "17:00"}, ...}`
- Parsed at call-time; open hours are explained to the agent in plain English
- Overnight windows (e.g., close: "01:00" for graveyard shift) are supported

**Demo vs. Real:**
- Real tenants book on their own calendar (same Tenant)
- Demo visitors book on an isolated calendar (tenantId = `__demo`, demoSessionId = unique per visitor)
- Founder books a planning call on their own calendar (tenantId = `__founder`)
- All three use the same booking engine → same overlap prevention

---

### 4.5 Call Billing & Markup

**Data flow:**
1. Vapi sends `end-of-call-report` with `cost.total` (integer cents, provider's price)
2. VoiceFront stores `providerCostCents` (server-side, never sent to tenant)
3. Calculates `billedCostCents = round(providerCostCents × (10000 + markupBps) / 10000)`
   - Example: cost = 100¢, markupBps = 5000 (50%) → billed = 100 × 1.5 = 150¢
4. Tenant sees only `billedCostCents` on their dashboard (provider is masked)

**Why:** Operator sets markupBps per tenant (configurable in DB) → different tenants can have different margins.

---

### 4.6 Sales Demo System

#### 4.6.1 Lead Capture & Geo-Gating

**Endpoint:** `POST /api/demo/lead`

**Input:** name, email, phone  
**Output:** leadId, sessionId, name, phone, callAllowed, ipCountry, phoneCountry, day, appointments

**Geo-gating logic:**
- Fetches visitor's IP (via X-Forwarded-For header) → calls `ipapi.co` for country
- Parses the phone number → detects if it's a North American (+1) number
- Decision:
  - `callAllowed = true` if IP is US/CA OR phone is +1
  - `callAllowed = false` otherwise (web test still available)

**What it creates:**
1. A new `DemoLead` row (name, email, phone, ipCountry, phoneCountry, mode=pending)
2. A new isolated `DemoSession` (UUID, keyed by sessionId)
3. Seeds the session calendar with 3 pre-booked slots (9am huddle, 10:30am cleaning, 1:30pm consult)
4. Returns the session + day + free slots + callAllowed flag

---

#### 4.6.2 Web Demo Flow

**Endpoint:** `POST /api/demo/session`

**Input:** sessionId (from lead capture), name (optional), leadId (optional)  
**Output:** publicKey, assistant (Vapi transient), sessionId, day, appointments, showCalendar

**What it does:**
1. Resumes the visitor's isolated session (no re-seeding)
2. Builds "Ava" — the sales agent:
   - System prompt: `composeSalesPrompt(ctx)` with the sales playbook
   - Voice: Savannah (Vapi V2)
   - Background sound: office ambience
   - Tools: `checkAvailability`, `bookAppointment` (demo clinic), `checkFounderAvailability`, `bookPlanningCall` (founder)
   - FirstMessage: "Hey {name}! This is Ava with VoiceFront. Real quick — I'm actually one of the AI agents we build..."
3. Tags the assistant with the session ID (so tool-calls land on THIS visitor's calendar)
4. Returns the assistant + Vapi public key + showCalendar flag

**Frontend:**
- Renders a live voice call UI (waveform, transcript bubbles)
- Polls `/api/demo/appointments?sessionId=...` every 1s to watch the calendar update
- Uses `detectStage()` to identify which demo step Ava is on (intro → booking → double-book → summary → close)
- Shows the calendar, stage panel, and scenario chips that highlight as Ava progresses

---

#### 4.6.3 Outbound "Get a Call" Flow

**Endpoint:** `POST /api/demo/call`

**Input:** sessionId, leadId (optional), name (optional), phone  
**Output:** ok, callId, fromNumber, country

**What it does:**
1. Re-runs geo-gate: checks if the prospect is allowed a call (US/CA IP or +1 phone)
2. Coerces the phone number to E.164 format (e.g., `604 555 0188` → `+16045550188`)
3. Picks the caller-ID:
   - If IP country is CA AND a CA demo number is configured → use it
   - Else → use US demo number
   - If no numbers configured → 503 error ("calling not set up yet")
4. Builds the same Ava assistant (with founder-booking tools)
5. Calls `placeOutboundCall(phoneNumberId, customerNumber, assistant)` → Vapi places the call
6. Records that the lead chose "call" mode
7. Returns the call ID + caller-ID number + their IP country

**Frontend:**
- Shows "Your phone's about to ring from +1 (604) 555-0188"
- Prospect picks up on their phone
- Ava runs the full demo by voice
- Call records (transcript, summary, recording) are captured the same way as web calls

---

#### 4.6.4 Founder Booking Integration

**How Ava books the planning call:**
1. At the close of the demo, Ava says: "Let me grab you fifteen minutes with [founder name] to set this up."
2. Calls `checkFounderAvailability(prospectPreferredDate)` → returns the founder's open slots (from their calendar)
3. Offers 2–3 of the founder's available times
4. When the prospect picks one, calls `bookPlanningCall(prospectName, prospectPhone, date, time)` → creates a 15-min appointment on the founder's calendar
5. Confirms with the prospect: "Booked: Sarah Chen on Thursday, June 18 at 2pm. Confirm this with the caller."

**Key:** The founder's calendar is a real Tenant (`__founder`) with real Appointments. The booking engine's overlap prevention applies — Ava cannot double-book the founder.

---

#### 4.6.5 Demo Call Capture

**Endpoint:** `POST /api/vapi/inbound` (webhook handler)

**When a demo call ends:**
1. Vapi sends `end-of-call-report` with call metadata (start, end, reason, summary, transcript, recordingUrl)
2. VoiceFront checks the `demoSessionId` in the assistant metadata
3. Calls `captureDemoCall(demoSessionId, externalCallId, summary, transcript, recordingUrl, ...)`
4. Creates or updates a `DemoCall` row (idempotent on externalCallId)
5. Calculates durationSeconds, stores transcript + recording URL

**Founder reviews:**
- Admin panel at `/admin/demo` lists all captured demo calls
- Click to expand: see the lead (name, email, phone), duration, summary, full transcript, and recording player
- Helps the founder tune Ava's performance

---

### 4.7 Founder Portal

#### 4.7.1 Sales Agent Control

**Page:** `/admin/demo`

**Controls:**
- **Agent name** — rename Ava (updates in all future calls)
- **Founder name** — how Ava refers to you (updates in all future calls)
- **Calendar visibility** — toggle whether prospects see the live sample calendar during the demo
- **Demo numbers** — dropdowns to assign US and CA caller-IDs from your Vapi account

**Backend:**
- Settings stored in PlatformSetting rows (not encrypted, plain text)
- Changes apply to the very next demo call (no sync delay)

---

#### 4.7.2 Founder Calendar

**Page:** `/admin/calendar`

**Features:**
- Month grid (click any day to see that day's schedule)
- Block time: "I'm busy 2–3pm Thursday" → creates a CONFIRMED appointment on the `__founder` tenant
- See booked planning calls (blue) vs. blocks (amber)
- Remove any entry
- Timezone-aware (founder's timezone determines what "Thursday 2pm" means)

**Backend:**
- Stores as Appointments on tenantId = `__founder`
- Uses the same booking engine with overlap prevention
- When Ava tries to `bookPlanningCall`, she gets free slots from the same calendar

---

### 4.8 Webhook Security & Idempotency

**Vapi sends webhooks to:** `POST https://<api-host>/api/vapi/inbound`

**Security:**
- Vapi signs each webhook with a header: `x-vapi-secret: <hash>`
- VoiceFront compares with `timingSafeEqual(hash, VAPI_WEBHOOK_SECRET)` → 401 if mismatch
- Never log the secret; never send it to the browser

**Idempotency:**
- Both `assistant-request` and `end-of-call-report` include a `call.id` (Vapi's ID)
- CallLog rows are upserted on `externalCallId` (the Vapi call ID)
- If the same webhook arrives twice → second upsert succeeds silently (no error)
- **Important:** All webhook responses are 200, even on error → Vapi never retries

---

## 5. Deployment

### 5.1 Architecture

```
Production:
├─ API (voicefront repo)
│  └─ Railway app "voicefront-api"
│     ├─ Node.js + Express
│     ├─ PostgreSQL (managed Railway DB)
│     ├─ Environment: VAPI_PUBLIC_KEY, VAPI_WEBHOOK_SECRET, JWT_SECRET, etc.
│     └─ Webhook endpoint: https://voicefrontapi-production.up.railway.app/api/vapi/inbound
│
├─ Web (voicefront-web repo)
│  └─ Railway app "voicefront-web"
│     ├─ Next.js 14 App Router
│     ├─ Static hosting
│     ├─ Environment: NEXT_PUBLIC_API_URL=https://voicefrontapi-production.up.railway.app
│     └─ Deployed to: https://voicefrontapi-production.up.railway.app (web remote)
│
└─ Vapi (external)
   ├─ Phone numbers (inbound, outbound)
   ├─ Webhook secret (matched in API's env)
   └─ Public key (sent to web at runtime)
```

### 5.2 Environment Variables

**API (`apps/api/.env`):**
```
# Database
DATABASE_URL=postgresql://user:pass@host:5433/voicefront

# JWT & auth
JWT_SECRET=<random-64-char-string>

# Vapi
VAPI_PUBLIC_KEY=<org-public-key>
VAPI_WEBHOOK_SECRET=<webhook-signing-secret>
VAPI_PRIVATE_KEY=<org-private-key; optional, for persistent assistants>

# Platform config
PUBLIC_API_URL=https://voicefrontapi-production.up.railway.app
NODE_ENV=production
PORT=4000
```

**Web (`apps/web/.env.local`):**
```
NEXT_PUBLIC_API_URL=https://voicefrontapi-production.up.railway.app
```

### 5.3 Deployment Steps

**First-time setup:**

1. Create two Railway projects:
   - "voicefront-api" (connected to voicefront repo, branch: main)
   - "voicefront-web" (connected to voicefront-web repo, branch: main)

2. API app:
   - Add a PostgreSQL plugin (managed by Railway)
   - Set environment variables (DATABASE_URL is auto-filled; add JWT_SECRET, VAPI_* keys)
   - Deploy (Railway watches main, auto-deploys on push)

3. Web app:
   - Set NEXT_PUBLIC_API_URL to the API's Railway URL
   - Deploy (auto-deploys on push to voicefront-web/main)

4. Vapi:
   - Go to your Vapi dashboard
   - Create a webhook secret (copy to API env)
   - Add a server webhook: `https://<api-railway-url>/api/vapi/inbound` with the secret
   - Assign phone numbers to the webhook
   - Vapi → Integrations → get your public + private keys

5. Test:
   - Visit `https://<web-railway-url>` → should load
   - Register → should create a Tenant
   - Complete onboarding → should test voice (if public key is set)
   - Inbound call to a number → should route to the tenant

---

## 6. How Data Flows

### 6.1 A Prospect Experiences the Demo

```
1. Visits voicefront.com (landing page)

2. Fills out the form: name, email, phone
   POST /api/demo/lead
   → Creates DemoLead (pending mode)
   → Starts DemoSession
   → Returns: leadId, sessionId, callAllowed (US/CA or +1?)

3. Chooses a mode:
   - "Test on web" (always available) OR
   - "Get a call" (only if callAllowed=true)

4a. WEB TEST:
   POST /api/demo/session (sessionId, name)
   → Builds Ava with all tools
   → Returns: publicKey, assistant
   → Frontend: connects to Vapi via public key
   → Prospect talks to Ava in the browser
   → Polls /api/demo/appointments to watch calendar update
   → When done, transcript+recording captured by webhook

4b. GET A CALL:
   POST /api/demo/call (sessionId, phone)
   → Re-gates (US/CA IP or +1?)
   → Picks caller-ID (US or CA number)
   → Places outbound call via Vapi
   → Prospect answers on their phone
   → Same Ava, same demo, by voice
   → When done, transcript+recording captured by webhook

5. Ava books the planning call:
   → Checks founder's calendar (founder calendar is a real tenant)
   → Offers available times
   → Prospect agrees
   → bookPlanningCall creates an Appointment on __founder tenant
   → Confirms: "Booked with [founder name] on [day] at [time]"

6. Call ends:
   Vapi sends end-of-call-report webhook
   → VoiceFront captures DemoCall (transcript, summary, recording)
   → Founder can review in /admin/demo
```

### 6.2 A Clinic Receives a Call

```
1. Prospect dials: +1 (555) 123-4567
   → Vapi receives inbound ring
   → Sends assistant-request webhook to /api/vapi/inbound

2. VoiceFront looks up the number:
   → Finds AgentSettings.inboundPhoneNumber = "+15551234567"
   → Finds Tenant (e.g., "Bayview Dental")
   → Fetches AgentSettings (prompt, voice, hours, forwarding #s)
   → Builds a fresh assistant

3. Returns assistant to Vapi:
   → Vapi connects the call
   → Agent answers: "Hi! This is Maya with Bayview Dental..."

4. Agent books an appointment:
   → Calls checkAvailability("2026-06-18")
   → Returns free slots (9am, 9:30am, 10am, etc.)
   → Caller agrees to 9:30am
   → Calls bookAppointment
   → Appointment is created on Bayview Dental's calendar

5. Call ends:
   → Vapi sends end-of-call-report
   → VoiceFront creates a CallLog
   → Stores: transcript, summary, providerCostCents, billedCostCents (with markup), recording

6. Clinic owner logs in:
   → Sees the call on their dashboard
   → Reads transcript, listens to recording
   → Sees the appointment was booked
```

---

## 7. Key Design Decisions

### Why Transient Assistants?

**Decision:** Build a fresh assistant from settings on every call.

**Tradeoffs:**
- ✅ Settings changes apply instantly (no sync wait)
- ✅ Simpler code (fewer API calls to Vapi)
- ❌ Slightly higher latency on each call (but <100ms in practice)

**Alternative:** Persistent assistants (create once, update on settings change).
- ✅ Lower call latency
- ❌ Sync complexity (must push every setting change to Vapi)
- ❌ If a tenant changes settings and a call is in-flight, which version do they get?

---

### Why Demo Isolation?

**Decision:** Each demo visitor gets a `demoSessionId` that scopes their calendar.

**Why:**
- 🔒 Visitors can't interfere with each other's calendars
- 🧹 Sessions auto-expire after 2 hours (garbage collected)
- 📊 Founder can A/B test different prompts without polluting the clinic calendar
- 💼 Real clinics aren't confused by fake bookings

---

### Why Two Repos?

**Decision:** `voicefront` (API) and `voicefront-web` (frontend) are separate Git repos.

**Why:**
- 🚀 Independent deploys (API v1.5 + Web v1.3 is valid)
- 🔍 Web is static hosting (CDN-friendly)
- 👁️ Cleaner permissions (web can't access API secrets)
- 📦 Easier to open-source the web frontend later

---

### Why Country-Routed Caller IDs?

**Decision:** US prospects see US caller ID, Canadian prospects see CA caller ID.

**Why:**
- 📱 Prospects recognize the area code (more likely to pick up)
- 🌍 Compliance (some regions restrict outbound from wrong country)
- 👨‍💼 Professionalism (looks like a local business is calling)

---

## 8. Known Limitations & TODOs

### Current Gaps

- **Companion phone UI:** When a prospect gets an outbound call, they see nothing on screen. Future: sync the call state to their browser in real-time (WebSocket), so they can see Ava's progress while on the call.
- **Multi-language:** All prompts are in English. Can add i18n later.
- **Vapi fallback:** If Vapi is down, inbound calls fail silently. Could add a fallback voicemail flow.
- **Recording retention:** Vapi keeps recordings forever. Add archival/deletion policy.

### Performance

- **Transient assistants:** Built fresh on each call (~100ms overhead). Acceptable for <100 concurrent calls; consider caching if usage grows.
- **Calendar poll:** Frontend polls appointments every 1s during the demo. Could switch to WebSocket for instant updates.

### Security Notes

- **Webhook secret:** Stored in plain-text environment variable. Rotate monthly.
- **Media token:** 5-min expiry; auto-refresh on demand.
- **HIPAA:** This codebase is not HIPAA-compliant. Clinics handling PHI need a BAA with Vapi + your org.
- **Recording consent:** Some states require explicit disclosure. Add a consent banner in the greeting.

---

## 9. Extension Points

### Adding a New Tenant Type

1. Add industry to `enum Industry` in Prisma schema
2. Add defaults in `industryDefaults()` in prompt-templates.ts
3. Create onboarding persona (Maya for clinic, Marcus for construction, etc.)
4. Deploy + test

### Adding a New Booking Tool

1. Create the tool in `buildBookingTools()` → `assistant-builder.ts`
2. Add the handler in `handleToolCalls()` → `inbound.routes.ts`
3. Write a test case
4. Deploy

### Adding Persistent Assistants (vs. Transient)

1. Modify `buildTransientAssistant()` to opt-in to persistence
2. After building, POST to Vapi once and store the ID
3. For subsequent calls, use the ID directly (don't rebuild)
4. Add an "Sync to Vapi" button in settings to push changes
5. Handle the case where Vapi is out of sync with local settings

### White-Labeling

1. Tenant slugs already map to subdomains (if DNS + middleware is configured)
2. Store tenant logo/colors in AgentSettings
3. Customize the dashboard UI based on tenant branding
4. Customize Ava's greeting based on tenant name

---

## 10. Testing & Verification

### What's Been Verified

- ✅ TypeScript strict mode (both API + Web)
- ✅ Next.js build (14 routes compile, prerender)
- ✅ Prisma schema valid
- ✅ Core domain logic (markup math, business-hours parsing, timezone math, booking overlap)
- ✅ Auth flow (register, login, JWT, role gating)
- ✅ Webhook handler (idempotency, secret validation, error responses)

### What Needs Testing

- 🔴 End-to-end: full onboarding → call → booking → dashboard review
- 🔴 Vapi integration: real assistant-request + end-of-call-report payloads
- 🔴 Outbound calling: actual phone dial + RTP media
- 🔴 Load testing: concurrent visitors in the demo
- 🔴 HIPAA compliance (if serving healthcare clinics)

---

## 11. Runbooks

### Starting Servers Locally

```bash
# Terminal 1: Docker + API
docker compose up --wait
npm install
npm run db:setup
npm run dev:api   # :4000

# Terminal 2: Web
npm run dev:web   # :3000
```

### Creating a Tenant Manually

```sql
-- Via psql
INSERT INTO tenants (id, slug, company_name, industry, subscription_status)
VALUES (
  'tenant-123',
  'acme-corp',
  'ACME Corp',
  'CLINIC',
  'ACTIVE'
);

INSERT INTO agent_settings (tenant_id, display_name, voice_id, timezone)
VALUES (
  'tenant-123',
  'Maya',
  'Emma',
  'America/Los_Angeles'
);

INSERT INTO users (id, tenant_id, email, password_hash, full_name, role)
VALUES (
  'user-456',
  'tenant-123',
  'alice@acme.com',
  '<bcrypt-hash>',
  'Alice Acme',
  'OWNER'
);

UPDATE onboarding_status
SET has_configured_profile = true,
    has_configured_prompt = true,
    has_tested_voice = true,
    is_active = true
WHERE tenant_id = 'tenant-123';
```

### Testing the Webhook Locally

```bash
# Use ngrok to expose :4000 to the internet
ngrok http 4000

# In Vapi dashboard, set webhook URL to: https://<ngrok-url>/api/vapi/inbound
# Make a test call; should see logs on your terminal
```

---

## 12. Contact & Support

- **Questions about architecture?** Check this doc first, then ask in #engineering on Slack.
- **Bugs or security issues?** Open an issue on GitHub or DM @admin.
- **Vapi issues?** Check Vapi's docs or contact their support.
- **Database locks or migrations?** Prisma docs: https://www.prisma.io/docs/

---

**Last reviewed:** June 2026  
**Maintainer:** @admin  
**Next review:** December 2026
