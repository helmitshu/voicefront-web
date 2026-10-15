-- Build 2 billing: the Stripe subscription mirror, the webhook
-- idempotency ledger, and the tenant billing exemption.
--
-- Tenant.subscriptionStatus stays the app-wide billing status; the new
-- subscriptions table holds the Stripe detail behind it (one row per
-- tenant). stripe_events is keyed on the Stripe event id itself, so a
-- redelivered webhook collides on insert and is skipped.
--
-- Grandfathering: billing_exempt defaults to false for every tenant
-- created after this migration, but every workspace that already exists
-- at deploy time (founder workspaces, test clinics) is exempt forever,
-- so the new activation gate can never lock out a pre-Stripe tenant.

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "billing_exempt" BOOLEAN NOT NULL DEFAULT false;

-- Grandfather every pre-launch tenant.
UPDATE "tenants" SET "billing_exempt" = true;

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "stripe_customer_id" TEXT NOT NULL,
    "stripe_subscription_id" TEXT,
    "tier" TEXT NOT NULL,
    "pricing_region" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "trial_start" TIMESTAMP(3),
    "trial_end" TIMESTAMP(3),
    "current_period_end" TIMESTAMP(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_tenant_id_key" ON "subscriptions"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_stripe_customer_id_key" ON "subscriptions"("stripe_customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_stripe_subscription_id_key" ON "subscriptions"("stripe_subscription_id");

-- CreateTable
CREATE TABLE "stripe_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
