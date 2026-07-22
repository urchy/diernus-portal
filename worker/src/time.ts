// Time entries — hours logged against a card (studio only).
//   - cards.actual_hours is kept in sync as a cached sum
//   - listing is per-card and (on the finance endpoint) per-user/period
import { Hono } from 'hono';
import type { AppVariables, Env, User } from './types.js';
import { requireAuth, requireRole } from './middleware.js';
import { uuid } from './crypto.js';

export const timeRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();
timeRoutes.use('*', requireAuth, requireRole('studio'));

// helper: assert the studio can access the card's project
async function assertProjectAccess(c: { get: (k: string) => unknown; env: Env }, projectId: string) {
  // studio role always has access; this is just a safety check
  const u = c.get('user') as User;
  if (u.role !== 'studio') return false;
  const p = await c.env.DB.prepare('SELECT id FROM projects WHERE id = ?').bind(projectId).first<{ id: string }>();
  return !!p;
}

// GET /api/cards/:id/time-entries — list all entries for a card
timeRoutes.get('/cards/:id/time-entries', async (c) => {
  const card = await c.env.DB
    .prepare('SELECT project_id FROM cards WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ project_id: string }>();
  if (!card) return c.json({ error: 'cartão não encontrado' }, 404);
  if (!await assertProjectAccess(c, card.project_id)) return c.json({ error: 'forbidden' }, 403);
  const rows = await c.env.DB
    .prepare(`SELECT t.*, u.name AS user_name
              FROM time_entries t JOIN users u ON u.id = t.user_id
              WHERE t.card_id = ?
              ORDER BY t.logged_at DESC LIMIT 200`)
    .bind(c.req.param('id'))
    .all<any>();
  return c.json({ entries: rows.results });
});

// POST /api/cards/:id/time-entries — log hours against a card
//   body: { hours: number, note?: string, logged_at?: ISO string }
timeRoutes.post('/cards/:id/time-entries', async (c) => {
  const me = c.get('user') as User;
  const card = await c.env.DB
    .prepare('SELECT project_id FROM cards WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ project_id: string }>();
  if (!card) return c.json({ error: 'cartão não encontrado' }, 404);
  if (!await assertProjectAccess(c, card.project_id)) return c.json({ error: 'forbidden' }, 403);
  const body = await c.req.json().catch(() => null) as { hours?: number; note?: string; logged_at?: string } | null;
  const hours = Number(body?.hours);
  if (!body || !Number.isFinite(hours) || hours <= 0 || hours > 24) {
    return c.json({ error: 'horas inválidas (0 < h ≤ 24)' }, 400);
  }
  const id = uuid();
  const note = (body?.note || '').toString().trim().slice(0, 500) || null;
  // logged_at: if provided, parse as ISO; otherwise now
  let loggedAt: string;
  if (body?.logged_at) {
    const d = new Date(body.logged_at);
    if (isNaN(d.getTime())) return c.json({ error: 'logged_at inválido' }, 400);
    loggedAt = d.toISOString().replace('T', ' ').slice(0, 19);
  } else {
    loggedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
  }
  // insert + bump cards.actual_hours in a batch
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO time_entries (id, card_id, user_id, hours, note, logged_at)
                      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(id, c.req.param('id'), me.id, hours, note, loggedAt),
    c.env.DB.prepare(`UPDATE cards SET actual_hours = COALESCE(actual_hours, 0) + ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(hours, c.req.param('id')),
  ]);
  const entry = await c.env.DB
    .prepare(`SELECT t.*, u.name AS user_name
              FROM time_entries t JOIN users u ON u.id = t.user_id
              WHERE t.id = ?`)
    .bind(id)
    .first<any>();
  return c.json({ entry }, 201);
});

// DELETE /api/time-entries/:id — remove a time entry (and decrement the card's actual_hours)
timeRoutes.delete('/time-entries/:id', async (c) => {
  const entry = await c.env.DB
    .prepare('SELECT * FROM time_entries WHERE id = ?')
    .bind(c.req.param('id'))
    .first<any>();
  if (!entry) return c.json({ error: 'registo não encontrado' }, 404);
  const card = await c.env.DB
    .prepare('SELECT project_id FROM cards WHERE id = ?')
    .bind(entry.card_id)
    .first<{ project_id: string }>();
  if (!card || !await assertProjectAccess(c, card.project_id)) return c.json({ error: 'forbidden' }, 403);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM time_entries WHERE id = ?').bind(c.req.param('id')),
    c.env.DB.prepare(`UPDATE cards SET actual_hours = MAX(0, COALESCE(actual_hours, 0) - ?), updated_at = datetime('now') WHERE id = ?`)
      .bind(entry.hours, entry.card_id),
  ]);
  return c.json({ ok: true });
});
