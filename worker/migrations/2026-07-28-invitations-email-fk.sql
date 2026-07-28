-- Migration: add ON DELETE CASCADE FK from invitations.email → users.email
-- Run on remote:
--   cd worker && npx wrangler d1 execute diernus-portal-db --file=./migrations/2026-07-28-invitations-email-fk.sql --remote
--
-- Why: previously deleting a user left their invitations as orphans (the
-- schema only had invited_by → users(id) CASCADE; nothing on email).
-- Adding this FK makes user deletion properly clean up.
--
-- SQLite can't ALTER TABLE to add a FK, so we use the standard
-- recreate-table pattern: rename old, create new with FK, copy data,
-- drop old. Cloudflare D1 applies the whole multi-statement file as a
-- single atomic batch, so the intermediate state is never visible.
--
-- Note: PRAGMA foreign_keys = OFF inside the file doesn't take effect
-- under D1 (the server controls it), so we don't include it. The
-- intermediate state (with both old + new tables briefly co-existing)
-- is fine because no one is querying the DB while the migration runs.

-- 0. Delete orphan invitations first (rows whose email no longer exists in
--    users). These were left behind by manual data cleanups before this FK
--    existed. Without this step the new FK constraint would fail to add.
DELETE FROM invitations WHERE email NOT IN (SELECT email FROM users);

-- 1. Rename old, create new with the FK
ALTER TABLE invitations RENAME TO invitations_old;

CREATE TABLE invitations (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('admin', 'team', 'client')),
  token           TEXT UNIQUE NOT NULL,
  invited_by      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  accepted_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  -- ON DELETE CASCADE so deleting the user wipes their invitations
  FOREIGN KEY (email)      REFERENCES users(email) ON DELETE CASCADE,
  FOREIGN KEY (invited_by) REFERENCES users(id)   ON DELETE CASCADE
);

-- 2. Copy the surviving data
INSERT INTO invitations (id, email, name, role, token, invited_by, expires_at, accepted_at, created_at)
  SELECT id, email, name, role, token, invited_by, expires_at, accepted_at, created_at
  FROM invitations_old;

-- 3. Drop the old table
DROP TABLE invitations_old;

-- 4. Recreate the indexes that the old table had
CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email);


