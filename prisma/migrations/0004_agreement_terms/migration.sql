-- Session 06: payment-terms / agreement layer.
-- Adds structured business-term columns (each maps to a numbered section in
-- domain/agreement.ts) plus an explicit lifecycle status. Content columns are
-- write-once: the guard trigger below rejects UPDATEs that touch business
-- content and rejects DELETEs entirely, while still allowing the lifecycle
-- transitions the API needs (send → accept → supersede, void, isCurrent flips
-- and acceptance metadata). Corrections are always a NEW version row, never
-- an edit — this is what keeps historical accepted terms reconstructable for
-- the evidence system.

ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "total_amount_cents" INTEGER;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "deposit_amount_cents" INTEGER;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "milestone_schedule" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "payment_methods" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "late_payment_policy" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "work_pause_description" TEXT;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "final_delivery_description" TEXT;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "ownership_mode" TEXT;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "ownership_description" TEXT;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "max_revisions_per_milestone" INTEGER;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "extra_revision_policy" TEXT;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "cancellation_notice_days" INTEGER;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "cancellation_kill_fee_cents" INTEGER;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "cancellation_policy" TEXT;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "custom_clauses" TEXT;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "disclaimer_version" TEXT NOT NULL DEFAULT 'v1';
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "sent_at" TIMESTAMPTZ(6);
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "voided_at" TIMESTAMPTZ(6);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agreements_version_chk') THEN
    ALTER TABLE "agreements"
      ADD CONSTRAINT "agreements_version_chk" CHECK ("version" > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agreements_status_chk') THEN
    ALTER TABLE "agreements"
      ADD CONSTRAINT "agreements_status_chk"
      CHECK ("status" IN ('draft','pending_acceptance','accepted','superseded','voided'));
  END IF;
END $$;

-- Replace the blanket append-only trigger on agreements with a
-- content-immutability guard: lifecycle columns may advance, business content
-- may never change, rows may never be deleted.
DROP TRIGGER IF EXISTS "no_update_agreements" ON "agreements";

CREATE OR REPLACE FUNCTION "guard_agreement_immutability"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'append-only table agreements: DELETE not allowed (void via new status, never delete)'
      USING ERRCODE = '25001';
    RETURN NULL;
  END IF;
  -- TG_OP = 'UPDATE': business-content columns are write-once.
  IF (
    OLD."project_id" IS DISTINCT FROM NEW."project_id"
    OR OLD."workspace_id" IS DISTINCT FROM NEW."workspace_id"
    OR OLD."version" IS DISTINCT FROM NEW."version"
    OR OLD."terms_text" IS DISTINCT FROM NEW."terms_text"
    OR OLD."hash" IS DISTINCT FROM NEW."hash"
    OR OLD."payment_due_days" IS DISTINCT FROM NEW."payment_due_days"
    OR OLD."grace_days" IS DISTINCT FROM NEW."grace_days"
    OR OLD."pause_after_overdue_days" IS DISTINCT FROM NEW."pause_after_overdue_days"
    OR OLD."release_condition" IS DISTINCT FROM NEW."release_condition"
    OR OLD."reminder_policy" IS DISTINCT FROM NEW."reminder_policy"
    OR OLD."late_fee_policy" IS DISTINCT FROM NEW."late_fee_policy"
    OR OLD."total_amount_cents" IS DISTINCT FROM NEW."total_amount_cents"
    OR OLD."currency" IS DISTINCT FROM NEW."currency"
    OR OLD."deposit_amount_cents" IS DISTINCT FROM NEW."deposit_amount_cents"
    OR OLD."milestone_schedule" IS DISTINCT FROM NEW."milestone_schedule"
    OR OLD."payment_methods" IS DISTINCT FROM NEW."payment_methods"
    OR OLD."late_payment_policy" IS DISTINCT FROM NEW."late_payment_policy"
    OR OLD."work_pause_description" IS DISTINCT FROM NEW."work_pause_description"
    OR OLD."final_delivery_description" IS DISTINCT FROM NEW."final_delivery_description"
    OR OLD."ownership_mode" IS DISTINCT FROM NEW."ownership_mode"
    OR OLD."ownership_description" IS DISTINCT FROM NEW."ownership_description"
    OR OLD."max_revisions_per_milestone" IS DISTINCT FROM NEW."max_revisions_per_milestone"
    OR OLD."extra_revision_policy" IS DISTINCT FROM NEW."extra_revision_policy"
    OR OLD."cancellation_notice_days" IS DISTINCT FROM NEW."cancellation_notice_days"
    OR OLD."cancellation_kill_fee_cents" IS DISTINCT FROM NEW."cancellation_kill_fee_cents"
    OR OLD."cancellation_policy" IS DISTINCT FROM NEW."cancellation_policy"
    OR OLD."custom_clauses" IS DISTINCT FROM NEW."custom_clauses"
    OR OLD."disclaimer_version" IS DISTINCT FROM NEW."disclaimer_version"
    OR OLD."supersedes_id" IS DISTINCT FROM NEW."supersedes_id"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
  ) THEN
    RAISE EXCEPTION 'accepted agreement content is immutable: create a new version instead of editing version %', OLD."version"
      USING ERRCODE = '25001';
    RETURN NULL;
  END IF;
  -- Accepted-at/by/ip/ua are write-once once set: acceptance cannot be rewritten.
  IF (OLD."accepted_at" IS NOT NULL AND (
    OLD."accepted_at" IS DISTINCT FROM NEW."accepted_at"
    OR OLD."accepted_by" IS DISTINCT FROM NEW."accepted_by"
    OR OLD."accept_ip_hash" IS DISTINCT FROM NEW."accept_ip_hash"
    OR OLD."accept_ua_hash" IS DISTINCT FROM NEW."accept_ua_hash"
  )) THEN
    RAISE EXCEPTION 'agreement acceptance record is immutable (version %)', OLD."version"
      USING ERRCODE = '25001';
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "guard_agreement_immutability" ON "agreements";
CREATE TRIGGER "guard_agreement_immutability" BEFORE UPDATE OR DELETE ON "agreements"
  FOR EACH ROW EXECUTE FUNCTION "guard_agreement_immutability"();
