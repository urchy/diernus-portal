-- Diernus Portal — schema (D1 / SQLite)
-- Idempotent: safe to re-run.

PRAGMA foreign_keys = ON;

-- =========================================================================
-- users — studio team + clients
-- =========================================================================
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT,                                       -- nullable: pending clients have no password yet
  name            TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('admin', 'team', 'client')),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_role   ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- =========================================================================
-- invitations — both clients and studio team members
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
  FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email);

-- =========================================================================
-- projects — one per client engagement (client can have many)
-- =========================================================================
CREATE TABLE IF NOT EXISTS projects (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
  hourly_rate     REAL,                                        -- €/hour agreed with the client
  budget_hours    REAL,                                        -- optional total hours budget
  due_date        TEXT,                                        -- project-level deadline (date only, ISO yyyy-mm-dd)
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (client_id)  REFERENCES users(id)    ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)    ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

-- migrations for existing DBs (CREATE TABLE doesn't add columns retroactively)
-- Idempotent: SQLite will fail these if already applied; the schema script
-- ignores those errors when run with `wrangler d1 execute` --command.
ALTER TABLE projects ADD COLUMN due_date TEXT;

-- =========================================================================
-- columns — kanban columns per project (default 3 seeded on project create)
-- =========================================================================
CREATE TABLE IF NOT EXISTS columns (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  name            TEXT NOT NULL,
  position        INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_columns_project ON columns(project_id, position);

-- One-time migration: add "Revisão" column to every existing project that
-- doesn't have it. Idempotent (skips if the project already has a Revisão
-- column, e.g. because it was created after this migration ran).
-- Position 2560 sits between Em Curso (2048) and Concluído (3072).
-- UUID v4-ish: 4-char-2-char-4-2-6-char random hex, matches our uuid() helper.
INSERT INTO columns (id, project_id, name, position)
  SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6))),
         p.id,
         'Revisão',
         2560
  FROM projects p
  WHERE NOT EXISTS (
    SELECT 1 FROM columns k
    WHERE k.project_id = p.id AND LOWER(k.name) IN ('revisão', 'revisao')
  );

-- =========================================================================
-- cards — kanban cards
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
  estimated_hours REAL,                                        -- how many hours the studio estimates for this card
  actual_hours    REAL NOT NULL DEFAULT 0,                     -- how many hours were actually spent (incremented by the studio)
  assignee_id     TEXT,                                        -- studio member assigned to this card (optional)
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
-- comments — on cards (studio + client both can post)
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
-- time_entries — hours logged against a card (studio only)
-- Each row is an "I spent X hours on this card" entry; cards.actual_hours
-- is the cached sum of all entries for that card.
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
-- notifications — in-app bell for the studio
-- Populated when a client posts a comment or uploads a file, so the
-- studio can react. One row per recipient (so a client action notifies
-- every active studio user). ref_kind + ref_id let the UI link straight
-- back to the card / project.
-- =========================================================================
CREATE TABLE IF NOT EXISTS notifications (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,                              -- studio recipient
  type            TEXT NOT NULL,                              -- 'client_comment' | 'client_file' (extensible)
  ref_kind        TEXT NOT NULL,                              -- 'card' | 'project'
  ref_id          TEXT NOT NULL,                              -- card_id or project_id
  actor_id        TEXT,                                       -- who triggered it (the client)
  actor_name      TEXT,                                       -- cached for fast list rendering
  message         TEXT NOT NULL,                              -- human-readable summary
  link            TEXT NOT NULL,                              -- relative path to jump to
  is_read         INTEGER NOT NULL DEFAULT 0,                 -- 0/1 (SQLite has no bool)
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id)   REFERENCES users(id)    ON DELETE CASCADE,
  FOREIGN KEY (actor_id)  REFERENCES users(id)    ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user   ON notifications(user_id, is_read, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, created_at) WHERE is_read = 0;

-- =========================================================================
-- files — uploaded documents (studio uploads, both download)
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
