-- Session 13: payment-plan support (modified schedules as new versions).
-- Extends the foundation `payment_plans` table (created in 0001):
-- - `currency` (ISO code, default USD) so the plan carries its money unit.
-- - `version` (1-based within its milestone scope) + `supersedesId` (self
--   reference to the previous version): a modified schedule is a NEW row that
--   supersedes the old one. The old row + its events stay intact — the
--   original obligation is never silently rewritten.
-- - `note` (freelancer context, e.g. "client cash-flow accommodation").
-- - `updatedAt` lifecycle marker.
-- - `PlanState.superseded`: terminal state for replaced versions.
-- - Index on (workspaceId, projectId) for the plan-history views.
-- Backward compatible: all new columns nullable or defaulted.

DO $$ BEGIN
  ALTER TYPE "PlanState" ADD VALUE IF NOT EXISTS 'superseded';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE payment_plans
  ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "supersedesId" UUID REFERENCES "payment_plans"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "note" TEXT,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now();

ALTER TABLE payment_plans
  ADD CONSTRAINT payment_plans_original_positive_chk
  CHECK ("originalAmountCents" > 0) NOT VALID;

CREATE INDEX IF NOT EXISTS "plans_ws_project_idx"
  ON "payment_plans"("workspaceId","projectId");
