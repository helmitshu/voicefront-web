# Database migrations

VoiceFront uses **Prisma Migrate** for all schema changes. Migrations are
committed to git (in `apps/api/prisma/migrations/`), reviewed in PRs, and applied
forward-only in production via `prisma migrate deploy`.

> Before June 2026 the project used `prisma db push`, which diffs and force-
> applies the schema with no history, review, or rollback (and can silently drop
> data). We've moved off it. `db:push` still exists for throwaway local
> prototyping, but **never** use it against staging or production.

## One-time baseline (run ONCE against the existing production database)

Production was built with `db push`, so it has all the tables but no Prisma
migration history. Before the first deploy that runs `migrate deploy`, mark the
baseline migration as already applied — this writes a history row, it does **not**
create or alter anything:

```bash
# From apps/api, with DATABASE_URL pointing at PRODUCTION:
DATABASE_URL="<prod-database-url>" npx prisma migrate resolve --applied 0_init
# Verify:
DATABASE_URL="<prod-database-url>" npx prisma migrate status   # should say "Database schema is up to date!"
```

On Railway this is easiest from the service shell (where `DATABASE_URL` is already
set): `npx prisma migrate resolve --applied 0_init`.

**Do this before merging the deploy-script change**, or the deploy will try to
re-create existing tables and fail. Do the same one-time baseline on any other
long-lived environment (staging) that predates migrations.

## Everyday workflow

- **Make a schema change:** edit `prisma/schema.prisma`, then
  `npm run db:migrate -w apps/api` (Prisma generates a migration + applies it to
  your local DB). Commit the new folder under `prisma/migrations/`.
- **Production deploy:** the `start` script runs `prisma migrate deploy` before
  booting — it applies any new, unapplied migrations forward-only.
- **CI:** the integration job runs `migrate deploy` against a clean Postgres, so
  a migration that doesn't build a valid schema fails CI before it ships.

## Notes

- `prisma migrate reset` **wipes the database** — never run it against anything
  but a local throwaway DB.
- Keep migrations small and reviewable. For risky changes (drops, type changes,
  large backfills) prefer an expand/contract sequence over a single destructive
  migration.
