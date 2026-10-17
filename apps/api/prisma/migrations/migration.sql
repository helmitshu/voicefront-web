-- Instant demo calls ("Call me now") capture a lead with a phone number
-- only: the visitor types one field, the sales agent calls within seconds,
-- and the name and email are collected on the call itself. Name and email
-- therefore become nullable on demo leads. Existing rows are untouched
-- (they all carry both values); only new instant leads store NULLs.

-- AlterTable
ALTER TABLE "demo_leads" ALTER COLUMN "name" DROP NOT NULL;
ALTER TABLE "demo_leads" ALTER COLUMN "email" DROP NOT NULL;
