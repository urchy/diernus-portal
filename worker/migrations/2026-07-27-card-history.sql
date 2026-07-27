-- Migration: card history (audit trail)
-- Run on remote:
--   cd worker && npx wrangler d1 execute diernus-portal-db --file=./migrations/2026-07-27-card-history.sql --remote
--
-- What this does:
--   Creates a `card_history` table that records every meaningful change to
--   a card: who did it, when, what changed. Read by the card detail panel
--   so clients can see "what's been happening on this card" and Andre
--   can audit who moved what when.
--
-- The application code (cards.ts) inserts rows on every mutating action.
-- This script is just the table.

CREATE TABLE IF NOT EXISTS card_history (
  id          TEXT PRIMARY KEY,
  card_id     TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  user_id     TEXT,                              -- nullable: a deletion actor can be soft-nulled
  user_name   TEXT NOT NULL DEFAULT '',          -- cached at insert time for display
  action      TEXT NOT NULL,                     -- 'created' | 'moved' | 'assigned' | 'unassigned' | 'priority_changed' | 'renamed' | 'description_changed' | 'due_date_set' | 'due_date_cleared' | 'estimated_hours_changed' | 'deleted'
  from_value  TEXT,                              -- textual representation of the old state
  to_value    TEXT,                              -- textual representation of the new state
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (card_id)    REFERENCES cards(id)    ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_card_history_card    ON card_history(card_id, created_at);
CREATE INDEX IF NOT EXISTS idx_card_history_project ON card_history(project_id, created_at);
