-- Session 02 foundation migration: core entities + append-only guards.
-- Postgres-first. Amounts integer minor units; timestamps UTC timestamptz; UUID PKs.
-- Append-only tables (events, payments, approvals, agreements) are protected by
-- triggers that reject UPDATE/DELETE from ANY role, including future app roles.
-- Corrections happen via new reversing rows, never edits (domain-model §1).
--
-- Naming: quoted camelCase columns, exactly matching prisma/schema.prisma
-- field names (the schema carries no field-level @map, so the column name IS
-- the field name). Table names stay snake_case via @@map. Quoted identifiers
-- are case-sensitive in Postgres, so every migration must use the camelCase
-- spelling from the schema. Do not introduce snake_case columns here.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Enums
DO $$ BEGIN CREATE TYPE "TrustTier" AS ENUM ('low','standard','high'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "WorkspaceRole" AS ENUM ('owner','member','accountant_readonly'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "PauseState" AS ENUM ('active','paused'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "ReleaseCondition" AS ENUM ('current_milestone_paid','all_milestones_paid','manual_release'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "PaymentState" AS ENUM ('pending','received','partial','refunded','disputed','failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "NotificationChannel" AS ENUM ('email','sms','inapp'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "NotificationState" AS ENUM ('queued','sent','delivered','failed','bounced'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "PlanState" AS ENUM ('offered','accepted','active','completed','defaulted'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Tables
CREATE TABLE IF NOT EXISTS "users" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" TEXT NOT NULL UNIQUE,
  "displayName" TEXT NOT NULL,
  "passwordHash" JSONB,
  "oauthSubject" TEXT,
  "mfaSecret" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "lastLoginAt" TIMESTAMPTZ(6)
);

CREATE TABLE IF NOT EXISTS "workspaces" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "ownerUserId" UUID NOT NULL REFERENCES "users"("id"),
  "defaultCurrency" TEXT NOT NULL DEFAULT 'USD',
  "reminderDefaults" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "workspace_members" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL REFERENCES "users"("id"),
  "workspaceId" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "role" "WorkspaceRole" NOT NULL DEFAULT 'owner',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  UNIQUE ("userId", "workspaceId")
);

CREATE TABLE IF NOT EXISTS "clients" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "company" TEXT,
  "phone" TEXT,
  "trustTier" "TrustTier" NOT NULL DEFAULT 'low',
  "notes" TEXT,
  "archivedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  UNIQUE ("workspaceId", "email")
);
CREATE INDEX IF NOT EXISTS "clients_workspace_idx" ON "clients"("workspaceId");

CREATE TABLE IF NOT EXISTS "projects" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "clientId" UUID NOT NULL REFERENCES "clients"("id"),
  "title" TEXT NOT NULL,
  "description" TEXT,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "totalValueCents" INTEGER NOT NULL CHECK ("totalValueCents" >= 0),
  "trustTierOverride" "TrustTier",
  "pauseState" "PauseState" NOT NULL DEFAULT 'active',
  "pauseReason" TEXT,
  "agreementVersionId" UUID,
  "archivedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "projects_workspace_idx" ON "projects"("workspaceId");
CREATE INDEX IF NOT EXISTS "projects_workspace_client_idx" ON "projects"("workspaceId","clientId");

CREATE TABLE IF NOT EXISTS "milestones" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "projectId" UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "orderIndex" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "amountCents" INTEGER NOT NULL CHECK ("amountCents" >= 0),
  "dueDate" TIMESTAMPTZ(6) NOT NULL,
  "workState" TEXT NOT NULL DEFAULT 'draft',
  "paymentState" TEXT NOT NULL DEFAULT 'unpaid',
  "releaseGate" "ReleaseCondition" NOT NULL DEFAULT 'current_milestone_paid',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "milestones_ws_project_idx" ON "milestones"("workspaceId","projectId");

CREATE TABLE IF NOT EXISTS "agreements" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "projectId" UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "version" INTEGER NOT NULL,
  "isCurrent" BOOLEAN NOT NULL DEFAULT TRUE,
  "termsText" TEXT NOT NULL,
  "paymentDueDays" INTEGER NOT NULL DEFAULT 7,
  "graceDays" INTEGER NOT NULL DEFAULT 3,
  "pauseAfterOverdueDays" INTEGER NOT NULL DEFAULT 7,
  "releaseCondition" "ReleaseCondition" NOT NULL DEFAULT 'current_milestone_paid',
  "reminderPolicy" JSONB NOT NULL DEFAULT '{}',
  "lateFeePolicy" TEXT,
  "hash" TEXT NOT NULL,
  "supersedesId" UUID,
  "acceptedAt" TIMESTAMPTZ(6),
  "acceptedBy" TEXT,
  "acceptIpHash" TEXT,
  "acceptUaHash" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  UNIQUE ("projectId","version")
);
CREATE INDEX IF NOT EXISTS "agreements_ws_project_idx" ON "agreements"("workspaceId","projectId");

CREATE TABLE IF NOT EXISTS "payments" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "projectId" UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "milestoneId" UUID REFERENCES "milestones"("id"),
  "provider" TEXT NOT NULL DEFAULT 'stripe',
  "providerPaymentId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL CHECK ("amountCents" >= 0),
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "state" "PaymentState" NOT NULL DEFAULT 'pending',
  "reversesId" UUID,
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "rawWebhookRef" TEXT,
  "receivedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  UNIQUE ("provider","providerPaymentId")
);
CREATE INDEX IF NOT EXISTS "payments_ws_project_idx" ON "payments"("workspaceId","projectId");
CREATE INDEX IF NOT EXISTS "payments_ws_milestone_idx" ON "payments"("workspaceId","milestoneId");

CREATE TABLE IF NOT EXISTS "deliverables" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "projectId" UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "milestoneId" UUID NOT NULL REFERENCES "milestones"("id") ON DELETE CASCADE,
  "title" TEXT NOT NULL,
  "deliveryState" TEXT NOT NULL DEFAULT 'locked',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "deliverables_ws_milestone_idx" ON "deliverables"("workspaceId","milestoneId");

CREATE TABLE IF NOT EXISTS "deliverable_versions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "deliverableId" UUID NOT NULL REFERENCES "deliverables"("id") ON DELETE CASCADE,
  "versionNo" INTEGER NOT NULL,
  "previewArtifactRef" TEXT NOT NULL,
  "finalArtifactRef" TEXT NOT NULL,
  "sha256Preview" TEXT,
  "sha256Final" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "supersedesId" UUID,
  UNIQUE ("deliverableId","versionNo")
);

CREATE TABLE IF NOT EXISTS "approvals" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "projectId" UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "milestoneId" UUID NOT NULL REFERENCES "milestones"("id") ON DELETE CASCADE,
  "deliverableVersionId" UUID NOT NULL REFERENCES "deliverable_versions"("id"),
  "approverRef" TEXT NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "events" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "seq" BIGSERIAL NOT NULL,
  "workspaceId" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "projectId" UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "milestoneId" UUID REFERENCES "milestones"("id"),
  "deliverableId" UUID REFERENCES "deliverables"("id"),
  "actorType" TEXT NOT NULL,
  "actorId" TEXT,
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "occurredAt" TIMESTAMPTZ(6) NOT NULL,
  "recordedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "ipHash" TEXT,
  "uaHash" TEXT,
  "idempotencyKey" TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS "events_ws_project_seq_idx" ON "events"("workspaceId","projectId","seq");
CREATE INDEX IF NOT EXISTS "events_ws_project_time_idx" ON "events"("workspaceId","projectId","occurredAt");
CREATE INDEX IF NOT EXISTS "events_type_idx" ON "events"("type");

CREATE TABLE IF NOT EXISTS "notifications" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "projectId" UUID REFERENCES "projects"("id") ON DELETE CASCADE,
  "milestoneId" UUID,
  "channel" "NotificationChannel" NOT NULL DEFAULT 'email',
  "template" TEXT NOT NULL,
  "toRef" TEXT NOT NULL,
  "state" "NotificationState" NOT NULL DEFAULT 'queued',
  "providerMsgId" TEXT,
  "scheduledFor" TIMESTAMPTZ(6) NOT NULL,
  "sentAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "notifications_sched_idx" ON "notifications"("workspaceId","state","scheduledFor");

CREATE TABLE IF NOT EXISTS "evidence_packs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "projectId" UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "generatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "generatedBy" TEXT NOT NULL,
  "agreementVersionHashes" TEXT[] NOT NULL DEFAULT '{}',
  "eventSeqFrom" BIGINT NOT NULL,
  "eventSeqTo" BIGINT NOT NULL,
  "artifactRef" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "disclaimerVersion" TEXT NOT NULL DEFAULT 'v1'
);
CREATE INDEX IF NOT EXISTS "evidence_ws_project_idx" ON "evidence_packs"("workspaceId","projectId");

CREATE TABLE IF NOT EXISTS "payment_plans" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "projectId" UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "milestoneId" UUID NOT NULL REFERENCES "milestones"("id") ON DELETE CASCADE,
  "originalAmountCents" INTEGER NOT NULL CHECK ("originalAmountCents" >= 0),
  "installments" JSONB NOT NULL DEFAULT '[]',
  "state" "PlanState" NOT NULL DEFAULT 'offered',
  "offeredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "acceptedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "plans_ws_milestone_idx" ON "payment_plans"("workspaceId","milestoneId");

CREATE TABLE IF NOT EXISTS "portal_links" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "projectId" UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "tokenHash" TEXT NOT NULL UNIQUE,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "revokedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "portal_ws_project_idx" ON "portal_links"("workspaceId","projectId");

-- Append-only guards: REJECT any UPDATE or DELETE on evidence/financial tables.
CREATE OR REPLACE FUNCTION "prevent_history_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % not allowed (use reversing rows, never edits)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '25001';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "no_update_events" ON "events";
CREATE TRIGGER "no_update_events" BEFORE UPDATE OR DELETE ON "events"
  FOR EACH ROW EXECUTE FUNCTION "prevent_history_mutation"();

DROP TRIGGER IF EXISTS "no_update_payments" ON "payments";
CREATE TRIGGER "no_update_payments" BEFORE UPDATE OR DELETE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION "prevent_history_mutation"();

DROP TRIGGER IF EXISTS "no_update_approvals" ON "approvals";
CREATE TRIGGER "no_update_approvals" BEFORE UPDATE OR DELETE ON "approvals"
  FOR EACH ROW EXECUTE FUNCTION "prevent_history_mutation"();

DROP TRIGGER IF EXISTS "no_update_agreements" ON "agreements";
CREATE TRIGGER "no_update_agreements" BEFORE UPDATE OR DELETE ON "agreements"
  FOR EACH ROW EXECUTE FUNCTION "prevent_history_mutation"();

DROP TRIGGER IF EXISTS "no_update_evidence" ON "evidence_packs";
CREATE TRIGGER "no_update_evidence" BEFORE UPDATE OR DELETE ON "evidence_packs"
  FOR EACH ROW EXECUTE FUNCTION "prevent_history_mutation"();
