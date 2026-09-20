-- Session 12: reminder + escalation engine audit columns.
-- Extends the foundation `notifications` table (created in 0001) so every
-- automation is auditable: scheduledFor / sentAt / delivery status /
-- recipient / template+version / rendered snapshot / result-error /
-- attempt count / next scheduled action / cancel marker / idempotency key.
-- Also adds a per-project reminder-policy override (`{}` = inherit workspace
-- defaults, validated by domain/reminders.ts).
-- Backward compatible: all new columns nullable or defaulted.

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS "templateVersion" TEXT NOT NULL DEFAULT 'v1',
  ADD COLUMN IF NOT EXISTS "subject" TEXT,
  ADD COLUMN IF NOT EXISTS "bodySnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "recipientName" TEXT,
  ADD COLUMN IF NOT EXISTS "deliveredAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "canceledAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lastError" TEXT,
  ADD COLUMN IF NOT EXISTS "nextActionAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "nextActionLabel" TEXT,
  ADD COLUMN IF NOT EXISTS "trigger" TEXT NOT NULL DEFAULT 'schedule',
  ADD COLUMN IF NOT EXISTS "policyStep" TEXT,
  ADD COLUMN IF NOT EXISTS "policyVersion" INTEGER,
  ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS notifications_idempotency_uniq
    ON notifications ("idempotencyKey");
END $$;

CREATE INDEX IF NOT EXISTS notifications_project_idx
  ON notifications ("workspaceId", "projectId");

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS "reminderPolicy" JSONB NOT NULL DEFAULT '{}';
