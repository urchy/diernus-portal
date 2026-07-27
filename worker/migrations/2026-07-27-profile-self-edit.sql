-- Migration: profile self-edit
-- Run on remote:
--   cd worker && npx wrangler d1 execute diernus-portal-db --file=./migrations/2026-07-27-profile-self-edit.sql --remote
--
-- What this does:
--   1. Adds `users.password_changed_at` so the JWT middleware can invalidate
--      any session issued before the user's last password change (a clean
--      way to "log out other devices" without server-side session storage).
--   2. Creates `email_changes` for two-step email confirmation. The user
--      enters a new email, we send a confirmation link to the NEW address,
--      and the old email stays active until they click the link. One row
--      per pending change per user; the most recent one wins.

ALTER TABLE users ADD COLUMN password_changed_at TEXT;

CREATE TABLE IF NOT EXISTS email_changes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  new_email   TEXT NOT NULL,
  token       TEXT UNIQUE NOT NULL,
  expires_at  TEXT NOT NULL,
  accepted_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_email_changes_token ON email_changes(token);
CREATE INDEX IF NOT EXISTS idx_email_changes_user  ON email_changes(user_id, accepted_at);
