-- Session 05: milestone engine expansion.
-- Adds the explicit multi-dimension state columns (no booleans), currency,
-- audit history, idempotency tracking, and a DB-level sequence guard.
-- All new columns are nullable or defaulted so the migration is backward
-- compatible with 0001/0002 data. dueDate becomes nullable (milestones may
-- be unscheduled at draft time; validation lives in Zod + domain).

ALTER TABLE "milestones" ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE "milestones" ADD COLUMN IF NOT EXISTS "approvalState" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "milestones" ADD COLUMN IF NOT EXISTS "deliverableState" TEXT NOT NULL DEFAULT 'locked';
ALTER TABLE "milestones" ADD COLUMN IF NOT EXISTS "unlockState" TEXT NOT NULL DEFAULT 'locked';
ALTER TABLE "milestones" ADD COLUMN IF NOT EXISTS "appliedPaymentIds" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "milestones" ADD COLUMN IF NOT EXISTS "amountHistory" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "milestones" ADD COLUMN IF NOT EXISTS "approvedVersionId" TEXT;
ALTER TABLE "milestones" ADD COLUMN IF NOT EXISTS "currentVersionId" TEXT;
ALTER TABLE "milestones" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

-- Allow draft milestones without a scheduled date.
ALTER TABLE "milestones" ALTER COLUMN "dueDate" DROP NOT NULL;

-- First milestone of each project is available; the rest start locked.
-- (New rows default to 'locked'; the API sets orderIndex 0 → 'available'.)

-- Sequence guard: one row per position, no gaps-by-duplication, no silent
-- reordering. Named so future migrations can reference it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'milestones_project_order_uniq') THEN
    ALTER TABLE "milestones"
      ADD CONSTRAINT "milestones_project_order_uniq" UNIQUE ("projectId", "orderIndex");
  END IF;
END $$;

-- Money guard: amounts stay non-negative (corrections via audited changes).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'milestones_amount_chk') THEN
    ALTER TABLE "milestones"
      ADD CONSTRAINT "milestones_amount_chk" CHECK ("amountCents" > 0);
  END IF;
END $$;
