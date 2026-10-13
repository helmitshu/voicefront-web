-- CreateTable
CREATE TABLE "demo_holds" (
    "id" TEXT NOT NULL,
    "demo_session_id" TEXT NOT NULL,
    "external_call_id" TEXT NOT NULL,
    "service" TEXT,
    "date" TEXT,
    "time" TEXT,
    "patient_name" TEXT,
    "callback_number" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "demo_holds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "demo_holds_demo_session_id_idx" ON "demo_holds"("demo_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "demo_holds_external_call_id_key" ON "demo_holds"("external_call_id");
