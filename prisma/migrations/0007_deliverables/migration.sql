-- Session 10: controlled-delivery columns on deliverables + versions.
-- Backward compatible: existing rows (if any) default to draft/locked/none.

ALTER TABLE deliverables
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS "stagingUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "stagingTransferState" TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS "currentVersionNo" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "approvedVersionNo" INTEGER,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'deliverables_status_chk'
  ) THEN
    ALTER TABLE deliverables ADD CONSTRAINT deliverables_status_chk CHECK (
      status IN ('draft','submitted','preview_available','client_review','approved','payment_pending','paid','released')
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'deliverables_staging_chk'
  ) THEN
    ALTER TABLE deliverables ADD CONSTRAINT deliverables_staging_chk CHECK (
      "stagingTransferState" IN ('none','staging_live','transfer_pending','transferred')
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS deliverables_workspace_project_idx
  ON deliverables ("workspaceId", "projectId");

ALTER TABLE deliverable_versions
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS files JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS links TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "previewText" TEXT,
  ADD COLUMN IF NOT EXISTS "stagingUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "previewContentType" TEXT,
  ADD COLUMN IF NOT EXISTS "previewSizeBytes" INTEGER,
  ADD COLUMN IF NOT EXISTS "finalContentType" TEXT,
  ADD COLUMN IF NOT EXISTS "finalSizeBytes" INTEGER;

-- preview/final refs become optional: a version may be links + description only.
DO $$ BEGIN
  ALTER TABLE deliverable_versions ALTER COLUMN "previewArtifactRef" DROP NOT NULL;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE deliverable_versions ALTER COLUMN "finalArtifactRef" DROP NOT NULL;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
