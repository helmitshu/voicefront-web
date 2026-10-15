-- Server-owned pricing region on the workspace: 'USD' for everyone by
-- default; 'CAD' is granted only by the Canadian-business verification
-- (the business website, or facts a demo lead already verified) or by a
-- platform admin override. Source + timestamp record how and when the
-- current value was granted. This column is the single source the
-- Stripe checkout will read once checkout exists.
ALTER TABLE "tenants" ADD COLUMN "pricing_region" TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE "tenants" ADD COLUMN "pricing_region_source" TEXT;
ALTER TABLE "tenants" ADD COLUMN "pricing_region_verified_at" TIMESTAMP(3);
