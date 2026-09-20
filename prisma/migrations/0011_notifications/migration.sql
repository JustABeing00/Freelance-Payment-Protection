-- Session 18: production-grade notifications.
-- Extends `notifications` with transactional kind/category + in-app read
-- marker, and adds per-user preferences + client opt-outs (unsubscribe path
-- required for transactional mail).
-- Backward compatible: new columns defaulted/nullable; absent preference
-- rows mean "enabled"; absent opt-out rows mean "subscribed".

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'reminder',
  ADD COLUMN IF NOT EXISTS "category" TEXT NOT NULL DEFAULT 'reminders',
  ADD COLUMN IF NOT EXISTS "readAt" TIMESTAMPTZ(6);

CREATE INDEX IF NOT EXISTS "notifications_ws_channel_state_idx"
  ON "notifications" ("workspaceId", "channel", "state");

CREATE TABLE IF NOT EXISTS "notification_preferences" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "userId" UUID NOT NULL,
  "category" TEXT NOT NULL,
  "channel" "NotificationChannel" NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT notification_preferences_unique
    UNIQUE ("workspaceId", "userId", "category", "channel")
);
CREATE INDEX IF NOT EXISTS "notification_preferences_ws_user_idx"
  ON "notification_preferences" ("workspaceId", "userId");

CREATE TABLE IF NOT EXISTS "notification_opt_outs" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "email" TEXT NOT NULL,
  "category" TEXT NOT NULL DEFAULT 'all',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT notification_opt_outs_unique
    UNIQUE ("workspaceId", "email", "category")
);
CREATE INDEX IF NOT EXISTS "notification_opt_outs_ws_email_idx"
  ON "notification_opt_outs" ("workspaceId", "email");
