-- Migration: password_resets table
-- Run on remote:
--   cd worker && npx wrangler d1 execute diernus-portal-db --file=./migrations/2026-07-28-password-resets.sql --remote
--
-- Stores one-time tokens for the "forgot password" flow. The user
-- requests a reset at POST /api/auth/forgot-password; we create a row
-- here, email them the link, they click it, land on /reset-password.html,
-- POST the new password + token to /api/auth/reset-password; we mark
-- used_at and update the password hash.
--
-- Same pattern as email_changes (recent) and invitations (long-standing).

CREATE TABLE IF NOT EXISTS password_resets (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  token       TEXT UNIQUE NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token);
CREATE INDEX IF NOT EXISTS idx_password_resets_user  ON password_resets(user_id, used_at);
