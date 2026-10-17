-- Visitor map: demo leads gain the approximate, IP-derived location fields
-- (city / region / latitude / longitude) from the geolocation lookup the
-- demo flow already runs. Derived fields only, purely additive: the raw IP
-- address is never stored, and existing rows simply stay NULL (the map
-- falls back to a country-level pin for them).

-- AlterTable
ALTER TABLE "demo_leads" ADD COLUMN "ip_city" TEXT;
ALTER TABLE "demo_leads" ADD COLUMN "ip_region" TEXT;
ALTER TABLE "demo_leads" ADD COLUMN "ip_lat" DOUBLE PRECISION;
ALTER TABLE "demo_leads" ADD COLUMN "ip_lng" DOUBLE PRECISION;
