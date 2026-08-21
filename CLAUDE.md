# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CRM TopConta: turns a Google Sheets client base into a commercial-intelligence
source — imports/syncs client data, computes usage percentages/tiers, builds
segments, and runs WhatsApp (Cloud API) / SMS campaigns, with LGPD compliance
controls (CPF never stored in plaintext, opt-out enforcement, audit log,
tenant isolation).

Two independent npm packages, no workspace tooling tying them together:
`backend/` (Express + TypeScript + Prisma) and `frontend/` (React + TypeScript
+ Vite). Run npm commands from inside each directory.

## Commands

### Backend (`cd backend`)

```bash
docker compose up -d              # Postgres local (run from repo root)
npm install
npx prisma migrate dev --name x   # apply/create a migration
npm run prisma:generate           # regenerate Prisma client after schema changes
npm run prisma:seed               # tenant + demo users + demo clients
npm run dev                       # ts-node-dev, API on :4000
npm run build                     # tsc -p tsconfig.json
npm test                          # jest --runInBand, all *.test.ts under src/
npx jest src/services/usage.test.ts   # run a single test file
```

Demo users from seed: `admin@topconta.demo` / `operador@topconta.demo` /
`analista@topconta.demo`, password `mudar123`.

### Frontend (`cd frontend`)

```bash
npm install
npm run dev        # Vite dev server on :5173, proxies /api → :4000
npm run build       # tsc -b && vite build
```

## Architecture

### Request flow / entry points

`backend/src/app.ts` builds the Express app (middleware, all `/api/*` route
mounts) but does **not** call `app.listen()` or start the scheduler — it's
imported by two different entry points:

- `backend/src/index.ts` — local long-running server, also starts
  `services/scheduler.ts` (node-cron) if `ENABLE_SCHEDULER=true`.
- `backend/api/index.ts` — Vercel serverless handler; just re-exports `app`.
  No in-process scheduler here (see Cron section below).

### Tenant isolation & auth

Every table hangs off `Tenant`. `middleware/auth.ts` verifies the JWT and
attaches `req.user.tenantId`; every Prisma query in services/routes must
filter by that tenantId — there is no other isolation boundary. Roles are
`ADMIN | OPERATOR | ANALYST | VIEWER`, enforced via `requireRole(...)`.

Login can involve a two-step flow: password check issues either a normal JWT
or, if the user has 2FA enabled, a short-lived `pending2FA` token (5 min,
only valid against `POST /api/auth/2fa/verify`, rejected by `requireAuth`).

### Import pipeline

`services/googleSheets.ts` (Service Account) or `POST /api/imports/csv` feed
rows into `services/importService.ts`, which validates the PRD's required
fields, dedupes via `services/dedupe.ts` (CPF hash first, phone fallback),
and applies "last update wins" while preserving history via `Movement`
records. `services/cardAccountImport.ts` handles the real-world "Cartões e
contas" spreadsheet format (sourced from the `SaldoCartao` tab) as an
alternative input shape feeding the same pipeline. Usage percentage/tier
(`services/usage.ts`) uses safe division — a zero/missing `limite_total`
yields tier `INDEFINIDO`, never an error or false "no usage".

### LGPD / security primitives

- CPF: never persisted in plaintext — HMAC-SHA256 hash with a per-tenant salt
  (`Tenant.cpfSalt`) for dedupe, plus a masked display version
  (`services/masking.ts`).
- Channel credentials (`ChannelConfig.credentials`) are encrypted at rest via
  envelope encryption (`services/crypto.ts`, AES-256-GCM with an app-level
  master key standing in for a real KMS — swappable for AWS/GCP/Azure KMS
  without touching callers).
- Opt-out is sticky: once a client opts out, re-import never silently
  re-authorizes them.
- `services/retention.ts` runs a daily right-to-be-forgotten job anonymizing
  clients inactive past `Tenant.retentionDays`.
- Every sensitive action goes through `middleware/audit.ts` into `AuditLog`.

### Campaign send path

`services/campaignQueue.ts` enqueues the eligible audience as `MessageEvent`
rows with `status=FILA` (Postgres *is* the queue — no
RabbitMQ/Redis/Kafka), respecting the per-campaign dedupe window and the
tenant-wide `maxMsgsPerMinute` throttle. `POST /api/campaigns/:id/dispatch`
processes a batch. Channels are abstracted behind `ChannelAdapter`
(`services/channels/types.ts`), with real implementations for WhatsApp Cloud
API and SMS (Twilio as the reference provider, `ChannelConfig.priority`
enables multi-provider failover) plus mock adapters for credential-free dev.

### Automation engine

`services/automationEngine.ts` evaluates active `AutomationRule`s on a timer,
matching clients against the PRD's 5 triggers (new client, 30-day
reactivation, limit renewed — detected via a `Movement` created on import
when `limiteTotal` increases —, usage-tier nudges, opt-out/invalid-phone
block) and firing the configured action (launch campaign, notify, or block).
Repeat sends to the same client stay protected by the existing dedupe window.

### Cron jobs: local vs. Vercel

Locally, `services/scheduler.ts` runs everything via `node-cron` in-process.
In production (serverless, no long-running process), the same jobs are
exposed as HTTP endpoints under `/api/cron/*` (`routes/cron.ts`, protected by
`CRON_SECRET` bearer auth) and triggered by Vercel Cron Jobs
(`backend/vercel.json`).

**Vercel Hobby plan caps cron at once/day.** Jobs that run every 1-30 min
locally (campaign dispatch, automation engine, dynamic segment refresh) are
squashed to once/day at staggered times in `backend/vercel.json` on that
plan — the UI has manual "run now" buttons ("Disparar lote", "Atualizar
agora", "Sincronizar agora") to compensate. Upgrading to Pro removes the cap;
restore the original cadence by editing `backend/vercel.json`.

### Deployment topology

Two separate Vercel projects (root directories `backend` and `frontend`) plus
Supabase Postgres:

```
Browser → frontend (Vite static) → vercel.json rewrite /api/* → backend project
             backend: api/index.ts (serverless fn) → Prisma → Supabase Postgres
Vercel Cron Jobs → backend /api/cron/*
```

- `backend/vercel.json` uses explicit `builds`/`routes` (not framework
  auto-detect, which misidentifies this as a static-build Express app).
- `frontend/vercel.json` rewrites `/api/*` to the backend project's domain so
  the frontend always calls same-origin `/api/...` (no CORS, no hardcoded
  backend URL in frontend code).
- Prisma's `binaryTargets` includes `rhel-openssl-3.0.x` for Vercel's Lambda
  runtime, alongside `native` for local dev.
- Schema changes reach Supabase via
  `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`
  run directly against the Supabase project — not `prisma migrate deploy`
  (no network path from a normal dev/CI environment to the DB for that).
- `DATABASE_URL` must be the Supabase pooler connection (port 6543,
  Transaction mode) at runtime; `DIRECT_URL` (port 5432, direct) is only for
  `prisma migrate`/`db push`, never at request time.
- New/changed env vars on Vercel require a fresh deploy to take effect.

### Testing

Backend unit tests (`npx jest`) cover business rules that are easy to get
subtly wrong: usage tier boundaries (`usage.test.ts`), segment filter
combination logic (`segments.test.ts`), CPF/phone masking and hashing
(`masking.test.ts`), login rate-limiting/lockout (`authSecurity.test.ts`),
and the A/B significance z-test (`statistics.test.ts`). No frontend test
suite exists yet.
