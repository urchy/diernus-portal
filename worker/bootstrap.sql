-- Diernus Portal — bootstrap (fresh D1, no migrations)
-- Idempotent: safe to re-run.
--
-- Use this when creating a NEW D1 database (e.g. a staging environment).
-- For existing production DBs, use schema.sql + migrations/*.sql instead.
-- schema.sql contains both CREATE TABLE and ALTER TABLE statements; the
-- ALTER TABLEs exist for databases that were created before the columns
-- were added, so they fail on a brand-new D1. bootstrap.sql omits them.

PRAGMA foreign_keys = ON;

-- =========================================================================
-- users
-- =========================================================================
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('admin', 'team', 'client')),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at    TEXT,
  password_changed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_role   ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- =========================================================================
-- invitations (with the new CASCADE FK on email)
-- =========================================================================
CREATE TABLE IF NOT EXISTS invitations (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('admin', 'team', 'client')),
  token           TEXT UNIQUE NOT NULL,
  invited_by      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  accepted_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (email)      REFERENCES users(email) ON DELETE CASCADE,
  FOREIGN KEY (invited_by) REFERENCES users(id)   ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email);

-- =========================================================================
-- projects
-- =========================================================================
CREATE TABLE IF NOT EXISTS projects (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
  hourly_rate     REAL,
  budget_hours    REAL,
  due_date        TEXT,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (client_id)  REFERENCES users(id)    ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)    ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

-- =========================================================================
-- columns (kanban per project; default 4 seeded on project create)
-- =========================================================================
CREATE TABLE IF NOT EXISTS columns (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  name            TEXT NOT NULL,
  position        INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_columns_project ON columns(project_id, position);

-- =========================================================================
-- cards
-- =========================================================================
CREATE TABLE IF NOT EXISTS cards (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  column_id       TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  position        INTEGER NOT NULL,
  priority        TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  due_date        TEXT,
  estimated_hours REAL,
  actual_hours    REAL NOT NULL DEFAULT 0,
  assignee_id     TEXT,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id)  REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (column_id)   REFERENCES columns(id)  ON DELETE CASCADE,
  FOREIGN KEY (assignee_id) REFERENCES users(id)    ON DELETE SET NULL,
  FOREIGN KEY (created_by)  REFERENCES users(id)    ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_cards_project  ON cards(project_id);
CREATE INDEX IF NOT EXISTS idx_cards_column   ON cards(column_id, position);
CREATE INDEX IF NOT EXISTS idx_cards_assignee ON cards(assignee_id);

-- =========================================================================
-- comments
-- =========================================================================
CREATE TABLE IF NOT EXISTS comments (
  id              TEXT PRIMARY KEY,
  card_id         TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  body            TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_comments_card ON comments(card_id, created_at);

-- =========================================================================
-- time_entries
-- =========================================================================
CREATE TABLE IF NOT EXISTS time_entries (
  id              TEXT PRIMARY KEY,
  card_id         TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  hours           REAL NOT NULL CHECK (hours > 0),
  note            TEXT,
  logged_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_time_entries_card  ON time_entries(card_id, logged_at);
CREATE INDEX IF NOT EXISTS idx_time_entries_user  ON time_entries(user_id, logged_at);
CREATE INDEX IF NOT EXISTS idx_time_entries_logged ON time_entries(logged_at);

-- =========================================================================
-- notifications
-- =========================================================================
CREATE TABLE IF NOT EXISTS notifications (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  type            TEXT NOT NULL,
  ref_kind        TEXT NOT NULL,
  ref_id          TEXT NOT NULL,
  actor_id        TEXT,
  actor_name      TEXT,
  message         TEXT NOT NULL,
  link            TEXT NOT NULL,
  is_read         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id)   REFERENCES users(id)    ON DELETE CASCADE,
  FOREIGN KEY (actor_id)  REFERENCES users(id)    ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user   ON notifications(user_id, is_read, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, created_at) WHERE is_read = 0;

-- =========================================================================
-- files
-- =========================================================================
CREATE TABLE IF NOT EXISTS files (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  card_id         TEXT,
  filename        TEXT NOT NULL,
  r2_key          TEXT NOT NULL UNIQUE,
  size            INTEGER NOT NULL,
  mime_type       TEXT NOT NULL,
  uploaded_by     TEXT NOT NULL,
  uploaded_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (card_id)    REFERENCES cards(id)    ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users(id)  ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id);
CREATE INDEX IF NOT EXISTS idx_files_card    ON files(card_id);

-- =========================================================================
-- card_history
-- =========================================================================
CREATE TABLE IF NOT EXISTS card_history (
  id          TEXT PRIMARY KEY,
  card_id     TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  user_id     TEXT,
  user_name   TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,
  from_value  TEXT,
  to_value    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (card_id)    REFERENCES cards(id)    ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_card_history_card    ON card_history(card_id, created_at);
CREATE INDEX IF NOT EXISTS idx_card_history_project ON card_history(project_id, created_at);

-- =========================================================================
-- email_changes (two-step email confirmation)
-- =========================================================================
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

-- =========================================================================
-- password_resets — one-time tokens for the "forgot password" flow
-- =========================================================================
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
