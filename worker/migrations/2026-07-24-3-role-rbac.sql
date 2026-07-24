-- Migration: 3-role RBAC (admin / team / client)
-- Run on remote:  cd worker && npx wrangler d1 execute diernus-portal-db --file=./migrations/2026-07-24-3-role-rbac.sql --remote
--
-- What this does:
--   1. Rebuilds `users` and `invitations` tables with an EXPANDED role CHECK
--      that accepts the new values (admin/team/client) AND the legacy 'studio'
--      value (so the row-copy doesn't violate the CHECK).
--   2. Renames every existing 'studio' role value to 'admin'.
--   3. We could tighten the CHECK further in a follow-up migration to drop
--      'studio' from the allowed list. For now, leaving it lets us rerun
--      this script safely and provides a graceful rollback path.
--
-- CRITICAL: the new `users` table MUST list columns in the SAME order as
-- the live table (status was ALTER-ed in as the last column, not in the
-- CREATE TABLE position). Otherwise `SELECT *` will map columns wrong
-- during the row copy.
--
-- Idempotent: safe to re-run (UPDATEs match 0 rows after the first run).

PRAGMA foreign_keys=OFF;

-- ===== USERS — rebuild with EXPANDED role CHECK =====
-- Column order matches the live table: id, email, password_hash, name,
-- role, created_at, last_seen_at, status. (status was ALTERed in last.)
CREATE TABLE users_new (
  id              TEXT PRIMARY KEY,
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('admin', 'team', 'client', 'studio')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at    TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'suspended'))
);
INSERT INTO users_new (id, email, password_hash, name, role, created_at, last_seen_at, status)
  SELECT id, email, password_hash, name, role, created_at, last_seen_at, status FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
CREATE INDEX IF NOT EXISTS idx_users_role   ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- ===== INVITATIONS — rebuild with EXPANDED role CHECK =====
-- Column order matches the live table (verified via PRAGMA table_info).
CREATE TABLE invitations_new (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('admin', 'team', 'client', 'studio')),
  token           TEXT UNIQUE NOT NULL,
  invited_by      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  accepted_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE CASCADE
);
INSERT INTO invitations_new (id, email, name, role, token, invited_by, expires_at, accepted_at, created_at)
  SELECT id, email, name, role, token, invited_by, expires_at, accepted_at, created_at FROM invitations;
DROP TABLE invitations;
ALTER TABLE invitations_new RENAME TO invitations;
CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email);

-- ===== DATA MIGRATION (now safe — the new CHECK accepts 'admin') =====
UPDATE users        SET role = 'admin' WHERE role = 'studio';
UPDATE invitations  SET role = 'admin' WHERE role = 'studio';

PRAGMA foreign_keys=ON;
