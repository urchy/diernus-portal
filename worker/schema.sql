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
  role            TEXT NOT NULL CHECK (role IN ('studio', 'client')),
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
  role            TEXT NOT NULL CHECK (role IN ('studio', 'client')),
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
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (client_id)  REFERENCES users(id)    ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)    ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

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
