-- Session 08: payment lifecycle (Stripe-backed, no escrow).
-- Expands PaymentState with the task-contract states (created/processing/paid/
-- cancelled) while keeping legacy verified aliases (received/partial) for rows
-- written before Session 08. Replaces the blanket append-only trigger on
-- payments with a lifecycle guard: money/provider linkage is write-once,
-- state/received_at/raw_webhook_ref may advance, rows may never be deleted.
-- Every transition is auditable via the events table (Payment* event types).

DO $$ BEGIN
  ALTER TYPE "PaymentState" ADD VALUE IF NOT EXISTS 'created';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "PaymentState" ADD VALUE IF NOT EXISTS 'processing';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "PaymentState" ADD VALUE IF NOT EXISTS 'paid';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "PaymentState" ADD VALUE IF NOT EXISTS 'cancelled';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Lifecycle guard: money + provider linkage immutable, lifecycle may advance.
DROP TRIGGER IF EXISTS "no_update_payments" ON "payments";

CREATE OR REPLACE FUNCTION "guard_payment_immutability"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'append-only table payments: DELETE not allowed (refund via new state, never delete)'
      USING ERRCODE = '25001';
    RETURN NULL;
  END IF;
  -- TG_OP = 'UPDATE': business-money columns are write-once.
  IF (
    OLD."workspaceId" IS DISTINCT FROM NEW."workspaceId"
    OR OLD."projectId" IS DISTINCT FROM NEW."projectId"
    OR OLD."milestoneId" IS DISTINCT FROM NEW."milestoneId"
    OR OLD."provider" IS DISTINCT FROM NEW."provider"
    OR OLD."providerPaymentId" IS DISTINCT FROM NEW."providerPaymentId"
    OR OLD."amountCents" IS DISTINCT FROM NEW."amountCents"
    OR OLD."currency" IS DISTINCT FROM NEW."currency"
    OR OLD."idempotencyKey" IS DISTINCT FROM NEW."idempotencyKey"
    OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
  ) THEN
    RAISE EXCEPTION 'payment money/provider linkage is immutable (payment %)', OLD."id"
      USING ERRCODE = '25001';
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "guard_payment_immutability" ON "payments";
CREATE TRIGGER "guard_payment_immutability" BEFORE UPDATE OR DELETE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION "guard_payment_immutability"();
