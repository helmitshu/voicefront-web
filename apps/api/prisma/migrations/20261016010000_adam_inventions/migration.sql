-- Adam's three inventions: simulated-patient call runs (Fix and Prove +
-- Patient Drills) and the weekly knowledge review (The Weekly Upgrade).
--
-- simulated_call_runs is the marker store for assistant-to-assistant test
-- calls: both call legs carry the run id in their assistant metadata, the
-- webhook captures results here, and no tenant CallLog is ever written —
-- so simulated calls cannot enter patient stats, usage minutes, or ROI
-- math. adam_weekly_reviews holds one row per tenant per ISO week; a
-- PENDING row is what surfaces the review in Adam's chat surface.

-- CreateTable
CREATE TABLE "simulated_call_runs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLACED',
    "scenario_title" TEXT NOT NULL,
    "scenario_prompt" TEXT NOT NULL,
    "source_call_log_id" TEXT,
    "diagnosis" TEXT,
    "fix_summary" TEXT,
    "origin_number" TEXT,
    "patient_call_id" TEXT,
    "receptionist_call_id" TEXT,
    "result_summary" TEXT,
    "result_transcript" TEXT,
    "result_recording_url" TEXT,
    "result_success_score" INTEGER,
    "result_outcome" TEXT,
    "result_duration_seconds" INTEGER NOT NULL DEFAULT 0,
    "patient_transcript" TEXT,
    "patient_recording_url" TEXT,
    "cleanup_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "simulated_call_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "simulated_call_runs_tenant_id_created_at_idx" ON "simulated_call_runs"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "simulated_call_runs_tenant_id_kind_created_at_idx" ON "simulated_call_runs"("tenant_id", "kind", "created_at" DESC);

-- CreateTable
CREATE TABLE "adam_weekly_reviews" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "week_key" TEXT NOT NULL,
    "gaps" JSONB NOT NULL,
    "gap_count" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "adam_weekly_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "adam_weekly_reviews_tenant_id_week_key_key" ON "adam_weekly_reviews"("tenant_id", "week_key");

-- CreateIndex
CREATE INDEX "adam_weekly_reviews_tenant_id_status_idx" ON "adam_weekly_reviews"("tenant_id", "status");

-- AddForeignKey
ALTER TABLE "simulated_call_runs" ADD CONSTRAINT "simulated_call_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adam_weekly_reviews" ADD CONSTRAINT "adam_weekly_reviews_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
