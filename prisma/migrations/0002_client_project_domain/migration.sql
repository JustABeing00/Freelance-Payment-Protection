-- Session 04: client + project domain expansion.
-- Adds contact/billing/timezone/country/status to clients and
-- scheduling/terms/status to projects. All new columns are nullable
-- (or defaulted) so the migration is backward compatible with 0001 data.

ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "billingEmail" TEXT;
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "billingAddress" TEXT;
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "timezone" TEXT;
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "country" TEXT;
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "startDate" TIMESTAMPTZ(6);
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "expectedCompletion" TIMESTAMPTZ(6);
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "paymentTerms" TEXT;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

-- Keep status vocabularies documented at the app layer (CHECKs stay permissive
-- so future statuses do not require a DDL change; validation lives in Zod).
-- Guard: expected completion should not precede start date when both are set.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_dates_chk') THEN
    ALTER TABLE "projects"
      ADD CONSTRAINT "projects_dates_chk"
      CHECK ("expectedCompletion" IS NULL OR "startDate" IS NULL OR "expectedCompletion" >= "startDate");
  END IF;
END $$;
