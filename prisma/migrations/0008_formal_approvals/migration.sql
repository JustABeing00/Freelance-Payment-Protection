-- Session 11: formal client approval — append-only decision events.
-- An approval pins ONE version (versionNo for deliverables, versionRef for
-- milestone-only approvals). Old rows stay historically true; only the latest
-- row pinning the CURRENT version authorizes release. Raw IPs/user-agents are
-- never stored — only sha256 hashes (ipHash/uaHash), where appropriate.
-- Backward compatible: existing rows (if any) default to decision 'approved'.

ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS "deliverableId" UUID REFERENCES deliverables("id") ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS "versionNo" INTEGER,
  ADD COLUMN IF NOT EXISTS "versionRef" TEXT,
  ADD COLUMN IF NOT EXISTS "decision" TEXT NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS "actorType" TEXT NOT NULL DEFAULT 'client',
  ADD COLUMN IF NOT EXISTS "actorId" TEXT,
  ADD COLUMN IF NOT EXISTS "ipHash" TEXT,
  ADD COLUMN IF NOT EXISTS "uaHash" TEXT;

-- Existing installs required a deliverable version FK; milestone-only
-- approvals (portal milestone approve without a deliverable row) need it
-- nullable. Rows already written keep their FK.
DO $$ BEGIN
  ALTER TABLE approvals ALTER COLUMN "deliverableVersionId" DROP NOT NULL;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Every approval must pin exactly one version.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'approvals_version_pin_chk'
  ) THEN
    ALTER TABLE approvals ADD CONSTRAINT approvals_version_pin_chk CHECK (
      ("versionNo" IS NOT NULL AND "versionNo" >= 1)
      OR ("versionRef" IS NOT NULL AND char_length("versionRef") > 0)
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'approvals_decision_chk'
  ) THEN
    ALTER TABLE approvals ADD CONSTRAINT approvals_decision_chk CHECK (
      decision IN ('approved','revision_requested','rejected','disputed')
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS approvals_project_milestone_idx
  ON approvals ("projectId", "milestoneId");
CREATE INDEX IF NOT EXISTS approvals_deliverable_idx
  ON approvals ("deliverableId");

-- Append-only guard stays: approvals are immutable (see 0001
-- no_update_approvals trigger on prevent_history_mutation). No change needed.
