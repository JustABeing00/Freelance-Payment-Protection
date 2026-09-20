-- Session 07: client-portal access columns.
-- 0001 created portal_links with id/workspace/project/token_hash only.
-- The Prisma schema (PortalLink) requires expiry + revocation, so add them
-- here. Existing rows (if any) get a 7-day expiry from migration time.
ALTER TABLE "portal_links"
  ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMPTZ(6) NOT NULL DEFAULT (now() + interval '7 days'),
  ADD COLUMN IF NOT EXISTS "revoked_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS "portal_links_expires_idx" ON "portal_links"("expires_at");
