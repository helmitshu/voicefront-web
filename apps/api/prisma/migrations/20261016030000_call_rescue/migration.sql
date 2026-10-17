-- Reliability pack, safe landing + success-rate alarm:
--  - call_logs gains the rescue flag pair (rescue_needed, rescue_reason),
--    written once at end-of-call finalize time when a call provably broke
--    and produced no appointment, and cleared only by an owner/manager.
--  - reliability_alarms holds the success-rate alarm's dedupe state, one
--    row per scope, so a restart never re-alarms a reported wave.

-- AlterTable
ALTER TABLE "call_logs" ADD COLUMN "rescue_needed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "call_logs" ADD COLUMN "rescue_reason" TEXT;

-- CreateIndex
CREATE INDEX "call_logs_rescue_needed_ended_at_idx" ON "call_logs"("rescue_needed", "ended_at" DESC);

-- CreateTable
CREATE TABLE "reliability_alarms" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "last_alarmed_at" TIMESTAMP(3) NOT NULL,
    "last_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reliability_alarms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reliability_alarms_scope_key" ON "reliability_alarms"("scope");
