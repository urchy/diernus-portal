// Notifications — in-app bell for the studio.
//   Populated by comments.ts and files.ts when a client acts.
//   Each row is per-recipient (so a client comment notifies every
//   active studio user). Studio users fetch the list via /api/notifications.
import { Hono } from 'hono';
import type { AppVariables, Env, User } from './types.js';
import { requireAuth } from './middleware.js';
import { uuid } from './crypto.js';

export const notificationRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();
notificationRoutes.use('*', requireAuth);

// Helper used by other modules: insert one row per active studio user.
// Exported so comments.ts / files.ts can call it without re-implementing.
export async function notifyStudio(
  env: Env,
  args: { type: string; refKind: 'card' | 'project'; refId: string; actor?: User | null; message: string; link: string },
): Promise<void> {
  const studioRows = await env.DB
    .prepare(`SELECT id FROM users WHERE role = 'studio' AND status = 'active'`)
    .all<{ id: string }>();
  if (studioRows.results.length === 0) return;
  const stmts = studioRows.results.map(r =>
    env.DB.prepare(`INSERT INTO notifications
       (id, user_id, type, ref_kind, ref_id, actor_id, actor_name, message, link)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(uuid(), r.id, args.type, args.refKind, args.refId,
            args.actor?.id || null, args.actor?.name || null,
            args.message, args.link)
  );
  await env.DB.batch(stmts);
}

// Title is derived from the notification type at serialize time. Keeps the
// schema lean (no extra column) and lets us tweak titles without a migration.
function titleFor(type: string): string {
  switch (type) {
    case 'client_comment': return 'Novo comentário';
    case 'client_file':    return 'Novo ficheiro';
    default: return 'Notificação';
  }
}

// GET /api/notifications — list for the current user, newest first
notificationRoutes.get('/', async (c) => {
  const me = c.get('user') as User;
  const limit = Math.min(Number(c.req.query('limit')) || 50, 200);
  const rows = await c.env.DB
    .prepare(`SELECT id, type, ref_kind, ref_id, actor_name, message, link, is_read, created_at
              FROM notifications
              WHERE user_id = ?
              ORDER BY created_at DESC LIMIT ?`)
    .bind(me.id, limit)
    .all<any>();
  const unread = await c.env.DB
    .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0')
    .bind(me.id)
    .first<{ n: number }>();
  return c.json({
    notifications: rows.results.map(r => ({
      ...r,
      is_read: !!r.is_read,
      title: titleFor(r.type),
    })),
    unread_count: unread?.n || 0,
  });
});

// GET /api/notifications/unread-count — lightweight poll endpoint
notificationRoutes.get('/unread-count', async (c) => {
  const me = c.get('user') as User;
  const row = await c.env.DB
    .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0')
    .bind(me.id)
    .first<{ n: number }>();
  return c.json({ unread_count: row?.n || 0 });
});

// POST /api/notifications/mark-read/:id — mark a single notification as read
notificationRoutes.post('/mark-read/:id', async (c) => {
  const me = c.get('user') as User;
  await c.env.DB
    .prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), me.id)
    .run();
  return c.json({ ok: true });
});

// POST /api/notifications/mark-all-read — flip every unread row to read
notificationRoutes.post('/mark-all-read', async (c) => {
  const me = c.get('user') as User;
  await c.env.DB
    .prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0')
    .bind(me.id)
    .run();
  return c.json({ ok: true });
});

// DELETE /api/notifications/:id — dismiss a single notification
notificationRoutes.delete('/:id', async (c) => {
  const me = c.get('user') as User;
  await c.env.DB
    .prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), me.id)
    .run();
  return c.json({ ok: true });
});
