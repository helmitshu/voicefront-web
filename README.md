# VoiceFront

An AI voice receptionist for clinics, contractors, and service businesses. It answers every call, books appointments straight into the calendar, answers common questions, captures leads, and routes urgent calls to a human. Built as a white-label, multi-tenant SaaS platform.

## Status

In active development. The core platform is live and serving calls; the public site and onboarding flows are being refined.

## Who it's for

1. **Tenants (clinics, contractors, service businesses)**, a branded dashboard to manage their AI receptionist: onboarding, call-handling settings, voice and hours, knowledge-base documents, usage, and a searchable call history with transcripts and recordings.
2. **The platform operator**, an admin portal to manage customers, assign voice assistants, review demo calls, manage booking calendars, and issue signup invitations.
3. **Prospects**, a marketing site that demonstrates the product live: an on-screen workflow, an in-browser voice test, and self-booking for a setup call.

## Architecture

- **Web**, Next.js 14 (App Router) + Tailwind
- **API**, Express + TypeScript + Prisma
- **Database**, PostgreSQL
- **Voice**, Vapi (inbound and outbound calls, real-time voice)
- **Deploy**, Railway · Docker Compose for local development

```
voicefront-web/
├── apps/
│   ├── api/     Express + TypeScript + Prisma (PostgreSQL) backend
│   └── web/     Next.js 14 (App Router) + Tailwind frontend
├── docs/        Architecture reference, API reference, DB schema
├── scripts/     Local setup helpers
└── docker-compose.yml   Local PostgreSQL
```

> **Deep dive:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the full architecture reference (data model, every system, data-flow walkthroughs, deployment, design decisions). [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md) and [`docs/DATABASE_SCHEMA.md`](docs/DATABASE_SCHEMA.md) cover the contract and schema in detail.

## Core platform

- **Multi-tenant SaaS**, tenants (industry, white-label slug, subscription status, usage limits) with role-based users (owner, manager, agent) and per-tenant agent settings.
- **Auth**, JWT with bcrypt hashing, rate-limited auth routes, hardened headers, CORS allow-list.
- **Onboarding state machine**, profile, prompt, voice test, active. Server-enforced prerequisites, revisitable steps, and a real in-browser test call before going live.
- **Transient assistants**, every inbound call composes a voice assistant from the tenant's settings, knowledge base, and calendar, so each business gets its own receptionist without manual Vapi configuration.
- **Call intelligence**, transcripts, recordings, summaries, and structured outcomes on every call, searchable from the dashboard.
- **Calendar booking**, books straight into the business's calendar with conflict checking, so the agent never double-books.
- **Knowledge base**, tenants upload documents (pricing, policies, FAQs) and the receptionist answers from them.

## Local development

1. Copy the example env files: `apps/api/.env.example` → `apps/api/.env`, `apps/web/.env.example` → `apps/web/.env`, and fill in your own keys.
2. Start Postgres: `docker-compose up -d`
3. Install and run: `npm install`, then `npm run dev` from the repo root.

No secrets are committed to this repo. Everything sensitive lives in `.env` files, which are gitignored.
