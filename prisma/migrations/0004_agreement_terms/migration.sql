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
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "totalAmountCents" INTEGER;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "depositAmountCents" INTEGER;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "milestoneSchedule" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "paymentMethods" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "latePaymentPolicy" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "workPauseDescription" TEXT;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "finalDeliveryDescription" TEXT;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "ownershipMode" TEXT;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "ownershipDescription" TEXT;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "maxRevisionsPerMilestone" INTEGER;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "extraRevisionPolicy" TEXT;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "cancellationNoticeDays" INTEGER;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "cancellationKillFeeCents" INTEGER;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "cancellationPolicy" TEXT;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "customClauses" TEXT;
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "disclaimerVersion" TEXT NOT NULL DEFAULT 'v1';
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "sentAt" TIMESTAMPTZ(6);
ALTER TABLE "agreements" ADD COLUMN IF NOT EXISTS "voidedAt" TIMESTAMPTZ(6);

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
    OLD."projectId" IS DISTINCT FROM NEW."projectId"
    OR OLD."workspaceId" IS DISTINCT FROM NEW."workspaceId"
    OR OLD."version" IS DISTINCT FROM NEW."version"
    OR OLD."termsText" IS DISTINCT FROM NEW."termsText"
    OR OLD."hash" IS DISTINCT FROM NEW."hash"
    OR OLD."paymentDueDays" IS DISTINCT FROM NEW."paymentDueDays"
    OR OLD."graceDays" IS DISTINCT FROM NEW."graceDays"
    OR OLD."pauseAfterOverdueDays" IS DISTINCT FROM NEW."pauseAfterOverdueDays"
    OR OLD."releaseCondition" IS DISTINCT FROM NEW."releaseCondition"
    OR OLD."reminderPolicy" IS DISTINCT FROM NEW."reminderPolicy"
    OR OLD."lateFeePolicy" IS DISTINCT FROM NEW."lateFeePolicy"
    OR OLD."totalAmountCents" IS DISTINCT FROM NEW."totalAmountCents"
    OR OLD."currency" IS DISTINCT FROM NEW."currency"
    OR OLD."depositAmountCents" IS DISTINCT FROM NEW."depositAmountCents"
    OR OLD."milestoneSchedule" IS DISTINCT FROM NEW."milestoneSchedule"
    OR OLD."paymentMethods" IS DISTINCT FROM NEW."paymentMethods"
    OR OLD."latePaymentPolicy" IS DISTINCT FROM NEW."latePaymentPolicy"
    OR OLD."workPauseDescription" IS DISTINCT FROM NEW."workPauseDescription"
    OR OLD."finalDeliveryDescription" IS DISTINCT FROM NEW."finalDeliveryDescription"
    OR OLD."ownershipMode" IS DISTINCT FROM NEW."ownershipMode"
    OR OLD."ownershipDescription" IS DISTINCT FROM NEW."ownershipDescription"
    OR OLD."maxRevisionsPerMilestone" IS DISTINCT FROM NEW."maxRevisionsPerMilestone"
    OR OLD."extraRevisionPolicy" IS DISTINCT FROM NEW."extraRevisionPolicy"
    OR OLD."cancellationNoticeDays" IS DISTINCT FROM NEW."cancellationNoticeDays"
    OR OLD."cancellationKillFeeCents" IS DISTINCT FROM NEW."cancellationKillFeeCents"
    OR OLD."cancellationPolicy" IS DISTINCT FROM NEW."cancellationPolicy"
    OR OLD."customClauses" IS DISTINCT FROM NEW."customClauses"
    OR OLD."disclaimerVersion" IS DISTINCT FROM NEW."disclaimerVersion"
    OR OLD."supersedesId" IS DISTINCT FROM NEW."supersedesId"
    OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
  ) THEN
    RAISE EXCEPTION 'accepted agreement content is immutable: create a new version instead of editing version %', OLD."version"
      USING ERRCODE = '25001';
    RETURN NULL;
  END IF;
  -- Accepted-at/by/ip/ua are write-once once set: acceptance cannot be rewritten.
  IF (OLD."acceptedAt" IS NOT NULL AND (
    OLD."acceptedAt" IS DISTINCT FROM NEW."acceptedAt"
    OR OLD."acceptedBy" IS DISTINCT FROM NEW."acceptedBy"
    OR OLD."acceptIpHash" IS DISTINCT FROM NEW."acceptIpHash"
    OR OLD."acceptUaHash" IS DISTINCT FROM NEW."acceptUaHash"
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
