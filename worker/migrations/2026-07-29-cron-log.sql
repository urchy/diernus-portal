-- Cron idempotency log — one row per (cron_name, entity_type, entity_id, sent_date).
-- Used by the daily overdue checks (cards + projects) to avoid re-sending the
-- same email twice for the same overdue item on the same UTC day. If the user
-- pushes the due_date back and the item goes overdue again later, the next
-- day-slot is empty and the email sends again as expected.
CREATE TABLE IF NOT EXISTS cron_log (
  id          TEXT PRIMARY KEY,
  cron_name   TEXT NOT NULL,   -- 'card_overdue' | 'project_overdue' | 'weekly_summary' | ...
  entity_type TEXT NOT NULL,   -- 'card' | 'project' | 'user' | ...
  entity_id   TEXT NOT NULL,
  sent_date   TEXT NOT NULL,   -- 'YYYY-MM-DD' (UTC) — easy to dedupe per day
  sent_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(cron_name, entity_type, entity_id, sent_date)
);
CREATE INDEX IF NOT EXISTS idx_cron_log_lookup ON cron_log(cron_name, entity_type, sent_date);
