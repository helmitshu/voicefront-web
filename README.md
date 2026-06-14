# VoiceFront

A white-label B2B SaaS platform that gives medical clinics and construction companies an **AI voice receptionist** — powered by Vapi under the hood, fully invisible to your tenants. Tenants sign up, walk a three-step guided onboarding (profile → call-handling instructions → live in-browser voice test), then manage their receptionist and deep-dive every call from a branded dashboard.

```
voicefront/
├── apps/
│   ├── api/        Express + TypeScript + Prisma (PostgreSQL) backend
│   └── web/        Next.js 14 (App Router) + Tailwind frontend
├── docker-compose.yml   Local PostgreSQL 16
└── package.json         npm workspaces + dev orchestration
```

---

## Quick start

Requirements: **Node ≥ 18.18**, **Docker** (for Postgres), npm 9+.

### Windows (PowerShell) — one command

```powershell
.\scripts\setup-local.ps1          # bootstrap (keeps existing DB data)
.\scripts\setup-local.ps1 -Reset   # full wipe: drops the DB volume first

npm run dev                        # api :4000, web :3000
```

The script checks Docker/Node, strips accidental quotes from `.env` values
(Prisma P1012 on Windows), tears down stale containers/volumes (the cause of
Prisma P1000 when credentials change after first init), starts Postgres with
a healthcheck, installs dependencies, pushes the schema, seeds demo data, and
verifies an authenticated connection from the host.

### Manual steps (macOS/Linux)

```bash
# 1. Start PostgreSQL
docker compose up -d --wait

# 2. Install everything (both workspaces)
npm install

# 3. Configure environments
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
#    apps/api/.env works out of the box against the docker-compose DB.
#    Never wrap DATABASE_URL in quotes — Prisma fails validation (P1012).
#    Set JWT_SECRET + VAPI_WEBHOOK_SECRET to real values before any deploy.

# 4. Create schema + demo data
npm run db:setup

# 5. Run both apps (api :4000, web :3000)
npm run dev
```

> **Note on ports:** the container publishes Postgres on host port **5433**
> (not 5432) because many Windows machines run a native PostgreSQL service on
> 5432. The native service binds IPv4 while Docker falls back to IPv6 only, so
> `localhost:5432` connects to a *different* server depending on the client —
> the classic source of "impossible" P1000 authentication errors.
>
> **Note on credentials:** Postgres reads `POSTGRES_USER`/`POSTGRES_PASSWORD`
> only when the data volume is first initialized. If you ever change them,
> recreate the volume: `docker compose down -v` (or `setup-local.ps1 -Reset`).

**Demo login** (seeded, fully onboarded, 12 realistic call logs):

```
email:    demo@voicefront.dev
password: demo1234!
```

Or register a fresh tenant at `/register` to experience the full onboarding flow.

---

## Architecture

### Multi-tenant data model (Prisma)

`Tenant` (company, industry `CLINIC|CONSTRUCTION`, unique white-label `slug`, `subscriptionStatus`, `markupBps`) → `User` (bcrypt-hashed password, role `OWNER|MANAGER|AGENT`), `OnboardingStatus` (state machine flags + `isActive`), `AgentSettings` (system prompt, greeting, voicemail, business hours JSON, dynamic forwarding numbers, masked inbound number), `CallLog` (provider cost **and** billed cost, AI summary, transcript, recording URL — provider fields never leave the server).

### Backend (`apps/api`)

- **Auth** — JWT bearer tokens (7d default), bcrypt(12), rate-limited auth routes, timing-safe login (dummy hash compare for unknown emails), helmet + CORS allow-list.
- **Onboarding state machine** — `PROFILE → PROMPT → VOICE_TEST` enforced server-side with prerequisites (e.g. the prompt step requires ≥40 chars of instructions actually saved). `POST /activate` flips the tenant live.
- **Transient assistants** — nothing is persisted on Vapi. On every inbound call (`assistant-request` webhook) or browser test, the server composes a fresh assistant JSON from the tenant's *current* settings: system prompt + live call context (open/closed right now, business hours in words) + a transfer directory (labels only — numbers go in tool config, never in prompt text). Settings changes therefore apply to the very next call.
- **Webhook security** — `POST /api/vapi/inbound` requires the `x-vapi-secret` header, compared with SHA-256 + `timingSafeEqual`. Inbound number → tenant mapping; unmapped numbers, canceled subscriptions, and not-yet-activated tenants are politely rejected. `end-of-call-report` ingestion is idempotent (upsert on the provider call id) and **always returns 200** so the provider never retries into a loop.
- **Provider masking** — tenant-facing DTOs strip `providerCostCents`, `externalCallId`, raw `recordingUrl`, and `endedReason`. Audio plays through `GET /api/media/:token` — a short-lived signed JWT media token minted per detail-view, proxied server-side with HTTP Range passthrough so seeking works. The web UI never mentions the provider by name.
- **Billing markup** — costs are integer **cents**. `billed = round(providerCost × (10000 + markupBps) / 10000)`; `markupBps` lives on the Tenant (default `5000` = +50%) so operators can adjust per-tenant profit margins in the DB.
- **Error model** — every error is `{ error: { message, code?, details? } }`; Zod → 400, unique-violation → 409, async handlers everywhere, graceful SIGTERM shutdown with a hard 10s cap.

### Frontend (`apps/web`)

- Next 14 App Router, strict TS, Tailwind with a custom design system (Space Grotesk / Public Sans / IBM Plex Mono via self-hosted `@fontsource`, signature waveform motif, `prefers-reduced-motion` respected).
- **Route guards** — `RequireAuth` / `RedirectIfAuthed` render nothing until the session is resolved *and* the user is in the right area (`/onboarding` vs `/dashboard` based on `isActive`), so there is never a flash of the wrong screen. A global 401 event from the API client signs out everywhere at once.
- **Onboarding** — revisitable step rail; Step 3 is a real in-browser call to the tenant's assistant via the voice web SDK (dynamically imported client-side only): reactive sound-wave visualization driven by live volume events, live transcript bubbles, automatic step completion when a real call ends, and a graceful fallback when the operator hasn't configured a public key yet.
- **Dashboard** — stats overview, live settings editor (dirty-tracking sticky save bar, role-aware read-only mode for `AGENT`s, template re-apply), call history with debounced search + range filter + abortable pagination, and a call detail page with a custom audio player (seek, speed cycle, duration fallback for chunked streams) and a speaker-attributed transcript view.

---

## API reference

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/register` | — | Create tenant + owner, returns JWT (rate-limited) |
| POST | `/api/auth/login` | — | Login, returns JWT (rate-limited, timing-safe) |
| GET | `/api/auth/me` | JWT | Session: user + tenant + onboarding view |
| GET | `/api/onboarding/status` | JWT | Current onboarding state |
| POST | `/api/onboarding/complete-step` | JWT | Complete `PROFILE`/`PROMPT`/`VOICE_TEST` (ordered) |
| POST | `/api/onboarding/activate` | JWT | Go live (requires all steps) |
| GET | `/api/agent/settings` | JWT | Receptionist settings DTO |
| PATCH | `/api/agent/settings` | JWT (OWNER/MANAGER) | Update settings (validated) |
| GET | `/api/calls` | JWT | Paginated list, `?search=&sinceDays=&page=&perPage=` |
| GET | `/api/calls/stats` | JWT | 7/30-day stats for the overview |
| GET | `/api/calls/:id` | JWT | Detail + transcript + one-time media token |
| GET | `/api/media/:token` | media JWT | Masked recording proxy (Range supported) |
| POST | `/api/voice/web-session` | JWT | Public key + transient assistant for browser test |
| POST | `/api/vapi/inbound` | `x-vapi-secret` | Provider webhook (assistant-request, end-of-call-report) |
| GET | `/api/health` | — | Liveness |

---

## Operator runbook (connecting Vapi)

Tenants never see Vapi; you, the platform operator, wire it up once:

1. In your Vapi dashboard, create a **server webhook secret** and set the same value as `VAPI_WEBHOOK_SECRET` in `apps/api/.env`.
2. Set your org's **public key** as `VAPI_PUBLIC_KEY` in `apps/api/.env` — this powers the in-browser test call (it is served to clients at session time; web public keys are designed to be client-visible). Without it, onboarding offers a graceful "mark complete" fallback.
3. Buy a phone number in Vapi and point its **Server URL** at `https://<your-api-host>/api/vapi/inbound` (for local dev, expose port 4000 with ngrok). Configure the number/server to send the secret header.
4. Assign the number to a tenant: in the dashboard, open **Receptionist → Your receptionist number** and paste the E.164 number (e.g. `+15551234567`), or set `agent_settings.inbound_phone_number` directly in SQL. Numbers are unique across tenants — assigning an already-used number returns a clear 409.
5. Voice & ambience are tenant-configurable under **Receptionist → Voice & sound**: built-in Vapi V2 voices (realistic, human — Emma is the default) or ElevenLabs voices (`11labs` provider; add your ElevenLabs API key under Integrations in the Vapi dashboard, then pick a preset or paste any voice ID from your library, including clones). Background sound (`office`/`off`) is mixed in by the provider per call.
6. Calls now flow: inbound ring → `assistant-request` → VoiceFront maps number → tenant → returns a transient assistant built from live settings → call proceeds → `end-of-call-report` → call log ingested with markup-applied billing.

## Security notes & deliberate tradeoffs

- **JWT in `localStorage`** — chosen for demo simplicity (no CSRF surface, trivial to inspect). For production, move to httpOnly cookies + CSRF tokens; the API client is isolated in `apps/web/src/lib/api.ts` so the swap is contained.
- **Masking boundary** — provider identifiers/costs are stripped server-side and recordings are proxied, so tenants can't see raw provider URLs in the app. Caveat stated honestly: during the *browser test call*, the voice SDK necessarily talks to provider endpoints, which a tenant could observe in devtools. Phone callers and all dashboard data remain fully masked.
- **Webhook** auth is constant-time; media tokens are scoped to a single call log + tenant and expire (default 5 min).
- **HIPAA / recording consent** — this codebase is a foundation, not a compliance kit: clinics handling PHI need a BAA with the voice/LLM vendors, and several states require two-party consent disclosure for recording. Add a consent line to the greeting where required.

## Extension points

- **Roles** exist end-to-end (`OWNER/MANAGER/AGENT` — settings writes already gated); an invite-teammates flow is the natural next API.
- **White-label slug** is unique per tenant and ready for subdomain routing (`acme.yourbrand.com` → tenant by slug); DNS/middleware wiring is deployment-specific and intentionally not hardcoded.
- **Billing**: `markupBps` + integer-cent costs make Stripe metering straightforward.
- `afterHoursShare` in `/api/calls/stats` is reserved (returns 0) until per-call after-hours tagging is added.

## What was verified (and what wasn't)

Ran in a clean Linux container against this exact tree:

- `tsc --noEmit` — **clean** for both `apps/api` and `apps/web` (strict mode).
- `next build` — **succeeds**; all 10 routes compile and prerender.
- `prisma validate` — schema **valid**; Prisma Client generates.
- API booted without a DB: `/api/health` 200; unsigned webhook → 401; signed unknown event → 200; protected route w/o token → 401; unknown route → 404 envelope — all correct.
- Domain spot-checks: markup rounding (incl. 0 bps), dollars→cents, timezone-aware open-hours including **overnight windows**, and call-status derivation — 12/12 pass.

Not verified here (requires live services): end-to-end Postgres migrations + seed against a running DB, and real Vapi calls/webhooks. The seed and webhook flows follow the provider's documented payload shapes and are written defensively (idempotent upserts, tolerant parsing), but exercise them in staging before launch.

— Built with Next `^14.2` deliberately (stable App Router params/typing); upgrade to 15 is mechanical when desired.
