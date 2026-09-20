-- Session 07: client-portal access columns.
-- Ensures portal_links carries expiry + revocation + created marker
-- (IF NOT EXISTS: no-op when 0001 already created them).
ALTER TABLE "portal_links"
  ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMPTZ(6) NOT NULL DEFAULT (now() + interval '7 days'),
  ADD COLUMN IF NOT EXISTS "revokedAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS "portal_links_expires_idx" ON "portal_links"("expiresAt");
