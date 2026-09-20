-- Session 02 foundation migration: core entities + append-only guards.
-- Postgres-first. Amounts integer minor units; timestamps UTC timestamptz; UUID PKs.
-- Append-only tables (events, payments, approvals, agreements) are protected by
-- triggers that reject UPDATE/DELETE from ANY role, including future app roles.
-- Corrections happen via new reversing rows, never edits (domain-model §1).

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
  "display_name" TEXT NOT NULL,
  "password_hash" JSONB,
  "oauth_subject" TEXT,
  "mfa_secret" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_login_at" TIMESTAMPTZ(6)
);

CREATE TABLE IF NOT EXISTS "workspaces" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "owner_user_id" UUID NOT NULL REFERENCES "users"("id"),
  "default_currency" TEXT NOT NULL DEFAULT 'USD',
  "reminder_defaults" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "workspace_members" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL REFERENCES "users"("id"),
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "role" "WorkspaceRole" NOT NULL DEFAULT 'owner',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  UNIQUE ("user_id", "workspace_id")
);

CREATE TABLE IF NOT EXISTS "clients" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "company" TEXT,
  "phone" TEXT,
  "trust_tier" "TrustTier" NOT NULL DEFAULT 'low',
  "notes" TEXT,
  "archived_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  UNIQUE ("workspace_id", "email")
);
CREATE INDEX IF NOT EXISTS "clients_workspace_idx" ON "clients"("workspace_id");

CREATE TABLE IF NOT EXISTS "projects" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "client_id" UUID NOT NULL REFERENCES "clients"("id"),
  "title" TEXT NOT NULL,
  "description" TEXT,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "total_value_cents" INTEGER NOT NULL CHECK ("total_value_cents" >= 0),
  "trust_tier_override" "TrustTier",
  "pause_state" "PauseState" NOT NULL DEFAULT 'active',
  "pause_reason" TEXT,
  "agreement_version_id" UUID,
  "archived_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "projects_workspace_idx" ON "projects"("workspace_id");
CREATE INDEX IF NOT EXISTS "projects_workspace_client_idx" ON "projects"("workspace_id","client_id");

CREATE TABLE IF NOT EXISTS "milestones" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "project_id" UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "order_index" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "amount_cents" INTEGER NOT NULL CHECK ("amount_cents" >= 0),
  "due_date" TIMESTAMPTZ(6) NOT NULL,
  "work_state" TEXT NOT NULL DEFAULT 'draft',
  "payment_state" TEXT NOT NULL DEFAULT 'unpaid',
  "release_gate" "ReleaseCondition" NOT NULL DEFAULT 'current_milestone_paid',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "milestones_ws_project_idx" ON "milestones"("workspace_id","project_id");

CREATE TABLE IF NOT EXISTS "agreements" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "project_id" UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "version" INTEGER NOT NULL,
  "is_current" BOOLEAN NOT NULL DEFAULT TRUE,
  "terms_text" TEXT NOT NULL,
  "payment_due_days" INTEGER NOT NULL DEFAULT 7,
  "grace_days" INTEGER NOT NULL DEFAULT 3,
  "pause_after_overdue_days" INTEGER NOT NULL DEFAULT 7,
  "release_condition" "ReleaseCondition" NOT NULL DEFAULT 'current_milestone_paid',
  "reminder_policy" JSONB NOT NULL DEFAULT '{}',
  "late_fee_policy" TEXT,
  "hash" TEXT NOT NULL,
  "supersedes_id" UUID,
  "accepted_at" TIMESTAMPTZ(6),
  "accepted_by" TEXT,
  "accept_ip_hash" TEXT,
  "accept_ua_hash" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  UNIQUE ("project_id","version")
);
CREATE INDEX IF NOT EXISTS "agreements_ws_project_idx" ON "agreements"("workspace_id","project_id");

CREATE TABLE IF NOT EXISTS "payments" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "project_id" UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "milestone_id" UUID REFERENCES "milestones"("id"),
  "provider" TEXT NOT NULL DEFAULT 'stripe',
  "provider_payment_id" TEXT NOT NULL,
  "amount_cents" INTEGER NOT NULL CHECK ("amount_cents" >= 0),
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "state" "PaymentState" NOT NULL DEFAULT 'pending',
  "reverses_id" UUID,
  "idempotency_key" TEXT NOT NULL UNIQUE,
  "raw_webhook_ref" TEXT,
  "received_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  UNIQUE ("provider","provider_payment_id")
);
CREATE INDEX IF NOT EXISTS "payments_ws_project_idx" ON "payments"("workspace_id","project_id");
CREATE INDEX IF NOT EXISTS "payments_ws_milestone_idx" ON "payments"("workspace_id","milestone_id");

CREATE TABLE IF NOT EXISTS "deliverables" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "project_id" UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "milestone_id" UUID NOT NULL REFERENCES "milestones"("id") ON DELETE CASCADE,
  "title" TEXT NOT NULL,
  "delivery_state" TEXT NOT NULL DEFAULT 'locked',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "deliverables_ws_milestone_idx" ON "deliverables"("workspace_id","milestone_id");

CREATE TABLE IF NOT EXISTS "deliverable_versions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "deliverable_id" UUID NOT NULL REFERENCES "deliverables"("id") ON DELETE CASCADE,
  "version_no" INTEGER NOT NULL,
  "preview_artifact_ref" TEXT NOT NULL,
  "final_artifact_ref" TEXT NOT NULL,
  "sha256_preview" TEXT,
  "sha256_final" TEXT,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "supersedes_id" UUID,
  UNIQUE ("deliverable_id","version_no")
);

CREATE TABLE IF NOT EXISTS "approvals" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "project_id" UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "milestone_id" UUID NOT NULL REFERENCES "milestones"("id") ON DELETE CASCADE,
  "deliverable_version_id" UUID NOT NULL REFERENCES "deliverable_versions"("id"),
  "approver_ref" TEXT NOT NULL,
  "note" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "events" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "seq" BIGSERIAL NOT NULL,
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "project_id" UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "milestone_id" UUID REFERENCES "milestones"("id"),
  "deliverable_id" UUID REFERENCES "deliverables"("id"),
  "actor_type" TEXT NOT NULL,
  "actor_id" TEXT,
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "ip_hash" TEXT,
  "ua_hash" TEXT,
  "idempotency_key" TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS "events_ws_project_seq_idx" ON "events"("workspace_id","project_id","seq");
CREATE INDEX IF NOT EXISTS "events_ws_project_time_idx" ON "events"("workspace_id","project_id","occurred_at");
CREATE INDEX IF NOT EXISTS "events_type_idx" ON "events"("type");

CREATE TABLE IF NOT EXISTS "notifications" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "project_id" UUID REFERENCES "projects"("id") ON DELETE CASCADE,
  "milestone_id" UUID,
  "channel" "NotificationChannel" NOT NULL DEFAULT 'email',
  "template" TEXT NOT NULL,
  "to_ref" TEXT NOT NULL,
  "state" "NotificationState" NOT NULL DEFAULT 'queued',
  "provider_msg_id" TEXT,
  "scheduled_for" TIMESTAMPTZ(6) NOT NULL,
  "sent_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "notifications_sched_idx" ON "notifications"("workspace_id","state","scheduled_for");

CREATE TABLE IF NOT EXISTS "evidence_packs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "project_id" UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "generated_by" TEXT NOT NULL,
  "agreement_version_hashes" TEXT[] NOT NULL DEFAULT '{}',
  "event_seq_from" BIGINT NOT NULL,
  "event_seq_to" BIGINT NOT NULL,
  "artifact_ref" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "disclaimer_version" TEXT NOT NULL DEFAULT 'v1'
);
CREATE INDEX IF NOT EXISTS "evidence_ws_project_idx" ON "evidence_packs"("workspace_id","project_id");

CREATE TABLE IF NOT EXISTS "payment_plans" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "project_id" UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "milestone_id" UUID NOT NULL REFERENCES "milestones"("id") ON DELETE CASCADE,
  "original_amount_cents" INTEGER NOT NULL CHECK ("original_amount_cents" >= 0),
  "installments" JSONB NOT NULL DEFAULT '[]',
  "state" "PlanState" NOT NULL DEFAULT 'offered',
  "offered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "accepted_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "plans_ws_milestone_idx" ON "payment_plans"("workspace_id","milestone_id");

CREATE TABLE IF NOT EXISTS "portal_links" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "project_id" UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "token_hash" TEXT NOT NULL UNIQUE,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "revoked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "portal_ws_project_idx" ON "portal_links"("workspace_id","project_id");

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
