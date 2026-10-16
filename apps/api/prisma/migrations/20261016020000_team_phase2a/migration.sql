-- AI team Phase 2a, the value core:
--  - Work items gain a real lifecycle (ASSIGNED and BLOCKED join
--    QUEUED, IN_PROGRESS, DONE), a link to the draft the coordinator
--    produced while working an item, and a last-nudge timestamp.
--  - Drafts gain the DAILY_DIGEST kind for the coordinator's digest.
--  - A runs ledger (team_runs) records every ability run, manual or
--    scheduled; the scheduled daily cap is counted from it and the
--    daily digest is composed from it.

-- AlterEnum
ALTER TYPE "WorkItemStatus" ADD VALUE IF NOT EXISTS 'ASSIGNED';
ALTER TYPE "WorkItemStatus" ADD VALUE IF NOT EXISTS 'BLOCKED';

-- AlterEnum
ALTER TYPE "TeamDraftKind" ADD VALUE IF NOT EXISTS 'DAILY_DIGEST';

-- AlterTable
ALTER TABLE "work_items" ADD COLUMN "draft_id" TEXT;
ALTER TABLE "work_items" ADD COLUMN "last_nudge_at" TIMESTAMP(3);

-- CreateEnum
CREATE TYPE "TeamRunTrigger" AS ENUM ('MANUAL', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "TeamRunStatus" AS ENUM ('RUNNING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "team_runs" (
    "id" TEXT NOT NULL,
    "ability" TEXT NOT NULL,
    "member_slug" TEXT,
    "trigger" "TeamRunTrigger" NOT NULL,
    "status" "TeamRunStatus" NOT NULL DEFAULT 'RUNNING',
    "summary" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "team_runs_trigger_started_at_idx" ON "team_runs"("trigger", "started_at" DESC);

-- CreateIndex
CREATE INDEX "team_runs_created_at_idx" ON "team_runs"("created_at" DESC);
