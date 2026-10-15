-- Human pacing for the AI team room: a member reply is stored with the
-- moment it becomes visible and stays hidden from thread reads until
-- then, so replies land at a human rhythm instead of instantly. Null
-- (owner, CEO and SYSTEM messages) means visible immediately.

-- AlterTable
ALTER TABLE "team_messages" ADD COLUMN "visible_at" TIMESTAMP(3);
