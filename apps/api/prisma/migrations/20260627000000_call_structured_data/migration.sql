-- AlterTable
ALTER TABLE "call_logs" ADD COLUMN     "appointment_booked" BOOLEAN,
ADD COLUMN     "intent" TEXT,
ADD COLUMN     "lead_quality" TEXT,
ADD COLUMN     "outcome" TEXT,
ADD COLUMN     "structured_data" JSONB,
ADD COLUMN     "success_score" INTEGER,
ADD COLUMN     "urgency" TEXT;

