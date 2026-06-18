# VoiceFront

**An AI voice receptionist, sold as a white-label B2B SaaS — plus the live sales machine that sells it.**

VoiceFront gives clinics, contractors, and service businesses an AI receptionist that answers every call 24/7, books appointments straight into a calendar, captures leads, answers questions, and routes urgent calls to a human — powered by [Vapi](https://vapi.ai) under the hood, completely invisible to the end customer. The platform also includes a **live, self-selling marketing site**: prospects watch the product work on screen, talk to the agent in their browser (or get a call), and book a setup call with the founder — whose calendar the agent reads in real time.

- **Live:** Web `https://voicefrontweb-production.up.railway.app` · API `https://voicefrontapi-production.up.railway.app`
- **Stack:** Next.js 14 (App Router) + Tailwind · Express + TypeScript + Prisma · PostgreSQL · Vapi voice · Railway

```
voicefront/
├── apps/
│   ├── api/     Express + TypeScript + Prisma (PostgreSQL) backend
│   └── web/     Next.js 14 (App Router) + Tailwind frontend
├── docs/        Architecture handoff (CLAUDE.md), API reference, DB schema
├── scripts/     Local setup (setup-local.ps1)
└── docker-compose.yml   Local PostgreSQL
```

> **Deep dive:** [`docs/CLAUDE.md`](docs/CLAUDE.md) is the full architecture & handoff document (data model, every system, data-flow walkthroughs, deployment, design decisions). Use it as the knowledge base for a Claude Project. [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md) and [`docs/DATABASE_SCHEMA.md`](docs/DATABASE_SCHEMA.md) cover the contract and schema in detail.

---

## Who it's for

1. **Tenants (clinics, contractors, businesses)** — a branded dashboard to manage their AI receptionist: onboarding, call-handling settings, voice & hours, knowledge-base documents, usage, and a searchable call history with transcripts and recordings.
2. **The operator / founder** — a platform-admin portal to manage customers, assign Vapi assistants, control the public sales demo, review demo calls, manage their own booking calendar, and issue signup invitations.
3. **Prospects** — a marketing site that *demonstrates* the product live (on-screen workflow, in-browser voice test, or an outbound call), proves it never double-books, and lets them self-book a call with the founder.

---

## Everything that's been built

### Core receptionist platform
- **Multi-tenant SaaS** — `Tenant` (industry, white-label `slug`, subscription status, `isBlocked`, `markupBps`, `monthlyMinuteLimit`) → `User` (roles `OWNER/MANAGER/AGENT`, bcrypt), `AgentSettings`, `OnboardingStatus`, `CallLog`.
- **JWT auth** — bcrypt(12), timing-safe login, rate-limited auth routes, helmet + CORS allow-list; a global 401 signs out everywhere.
- **Onboarding state machine** — `PROFILE → PROMPT → VOICE_TEST → ACTIVE`, server-enforced prerequisites, revisitable steps; Step 3 is a real in-browser test call.
- **Transient assistants** — every inbound call composes a fresh Vapi assistant from the tenant's *current* settings (live prompt + open/closed context + transfer directory), so settings changes apply on the very next call. (Persistent push-sync also supported for assigned assistants.)
- **Call booking engine** — `checkAvailability` / `bookAppointment` voice tools; double-booking prevented by an atomic per-tenant Postgres advisory lock; timezone-aware business hours (incl. overnight windows).
- **Billing markup** — integer-cent costs; `billed = round(providerCost × (10000 + markupBps)/10000)`; provider cost/identifiers stripped from tenant DTOs.
- **Masked recordings** — audio served through short-lived signed media tokens (`/api/media/:token`) with HTTP Range passthrough; the provider is never named in the UI.
- **Webhook security & idempotency** — `x-vapi-secret` compared with `timingSafeEqual`; `end-of-call-report` upserts on the provider call id and always returns 200 (no retry loops).

### Platform-admin (operator) layer
- **Tiered platform staff** — `ADMIN` / `SUPPORT` operators; bootstrap admins via `PLATFORM_ADMIN_EMAILS`, plus DB-granted staff; role-aware middleware and nav.
- **Customer management** — add/list customers, block/unblock, delete, invite users; block enforced at login and on the inbound webhook.
- **Vapi assistant assignment** — assign + validate a Vapi assistant per customer, auto-fetch its phone number; customer settings changes push-sync to the assigned assistant.
- **Knowledge base** — per-tenant document upload → Vapi files + an inline `query` tool attached to the assistant.
- **Usage quotas** — per-tenant `monthlyMinuteLimit` (default 500) enforced in the assistant-request flow; surfaced on dashboard + admin.
- **Runtime config + audit** — `PlatformSetting` key/value store and an audit log for sensitive admin actions.

### Live sales demo (the marketing engine)
- **Lead capture + geo-gating** — `POST /api/demo/lead` creates an isolated per-visitor session; IP (ipapi.co) + phone-country detection decides whether an outbound call is offered.
- **In-browser voice demo** — talk to **Ava** (the sales agent); an **agent-driven on-screen stage** (intro → booking → double-book → summary → close) that *Ava herself* switches via a `set_demo_screen` tool, plus a live calendar she books into and a smart, call-specific summary she writes via `show_call_summary`.
- **Outbound "Get a call"** — Ava rings the prospect's phone with country-routed caller ID (US/CA), running the same demo by voice.
- **Industry-aware** — the sample calendar and Ava's script adapt to the prospect's industry (clinic vs. contractor).
- **Sales-agent persona & playbook** — a warm, human prompt that builds rapport, qualifies, demos, and books a planning call on the **founder's real calendar** (`checkFounderAvailability` / `bookPlanningCall`) — which the booking engine prevents from double-booking.
- **Demo call capture** — transcript, summary, and recording of every demo call captured for founder review.

### Public booking & invite-gated signup *(latest)*
- **Self-service "Book a call"** — a calendar/form section on the landing page books straight into the founder's real calendar via `GET /api/booking/slots` + `POST /api/booking` (rate-limited, atomic double-booking guard). Captures name, business type, phone, optional email/notes, and a "needs a custom system" flag; appears instantly in the founder's admin calendar.
- **Invite-only signups** — registration is gated behind one-time `AccessCode`s. Admins generate/revoke codes (admin → **Access codes**); the code is consumed atomically inside the signup transaction (reuse/race-proof). Platform admins are exempt.

### World-class landing page & design system *(latest)*
- **"How every call works" console** — a self-driving, cinematic walkthrough: streaming transcript, a live calendar showing busy/booked/callback states (and *no double-booking*), and a call summary that resolves to an explicit **outcome** (booked / callback / answered) across three scenarios (new caller, returning customer, quick question).
- **Live-demo restyle** — the in-browser call console reskinned to the same premium light card; the transcript is a fixed-height scrolling box (no more growing card).
- **Apple-grade UX pass** — an ambient aurora sound-wave backdrop, softer layered shadows, pill buttons app-wide, tighter display typography, smooth anchor scrolling, consistent focus rings, a mobile nav menu, and the logo linking home everywhere.

---

## Quick start (local)

Requirements: **Node ≥ 18.18**, **Docker** (for Postgres), npm 9+.

### Windows (PowerShell) — one command
```powershell
.\scripts\setup-local.ps1          # bootstrap (keeps existing DB data)
.\scripts\setup-local.ps1 -Reset   # full wipe: drops the DB volume first
npm run dev                        # api :4000, web :3000
```

### macOS / Linux
```bash
docker compose up -d --wait        # PostgreSQL (host port 5433)
npm install                        # both workspaces
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
npm run db:setup                   # prisma db push + seed
npm run dev                        # api :4000, web :3000
```

> **Ports:** Postgres is published on host **5433** (not 5432) because Windows often runs a native PostgreSQL on 5432 — a classic source of "impossible" auth errors. Never wrap `DATABASE_URL` in quotes (Prisma P1012). Schema changes use `prisma db push` — never `migrate dev`/`reset` (it wipes the DB).

**Demo tenant login** (seeded, fully onboarded): `demo@voicefront.dev` / `demo1234!`, or register a fresh tenant at `/register`.

---

## Deployment (Railway)

Production runs three services on one Railway project: **web**, **api**, and **Postgres**.

> **Two-repo gotcha:** Railway auto-deploys from GitHub **`helmitshu/voicefront-web`** branch `main` — **not** `helmitshu/voicefront` (where `origin` points). Locally there's a `web` remote → `voicefront-web`. Deploy by overlaying the local tree onto `web/main` and pushing there. Make deploy fixes in this repo (never only on `voicefront-web`) or they get clobbered on the next push.

- **API start:** `prisma db push --skip-generate && node dist/index.js` (schema auto-applies on deploy).
- **Key env:** API needs `DATABASE_URL`, `CORS_ORIGIN` (= the web domain, exactly), `JWT_SECRET`, `VAPI_*`. Web needs `NEXT_PUBLIC_API_URL` (baked at build time). `PUBLIC_API_URL` auto-derives from `RAILWAY_PUBLIC_DOMAIN` when unset, so demo + assistant webhooks serve from the cloud (no tunnel).

Full deployment walkthrough and env reference: [`docs/CLAUDE.md` §5](docs/CLAUDE.md).

---

## Security & deliberate tradeoffs

- **Provider masking** — costs/identifiers stripped server-side, recordings proxied; the provider is never named to tenants. (The in-browser *test* call necessarily talks to provider endpoints — phone callers and all dashboard data stay masked.)
- **Webhook auth** is constant-time; media tokens are scoped to a single call + tenant and expire (~5 min).
- **Access codes** are consumed atomically inside the signup transaction (no reuse, no races).
- **HIPAA / consent** — this is a foundation, not a compliance kit: PHI needs a BAA with the voice/LLM vendors, and some states require recording-consent disclosure in the greeting.

---

## Where to go next

- **Architecture & handoff (use as Claude Project knowledge):** [`docs/CLAUDE.md`](docs/CLAUDE.md)
- **API contract:** [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md)
- **Database schema:** [`docs/DATABASE_SCHEMA.md`](docs/DATABASE_SCHEMA.md)
