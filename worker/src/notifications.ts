// Notifications — in-app bell, bidirectional.
//   Studio gets notified when a client acts (comment, file upload).
//   Client gets notified when the studio acts on their project
//   (comment, file, card move, project status change).
//   Each row is per-recipient — a single client comment creates one
//   notification per active studio user; a studio action creates one
//   notification for the project owner.
import { Hono } from 'hono';
import type { AppVariables, Env, User } from './types.js';
import { requireAuth } from './middleware.js';
import { uuid } from './crypto.js';

export const notificationRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();
notificationRoutes.use('*', requireAuth);

// Insert a single notification row. Internal — used by both fan-out
// helpers below. Quietly no-ops if recipientIds is empty.
async function insertRows(
  env: Env,
  recipientIds: string[],
  args: { type: string; refKind: 'card' | 'project'; refId: string; actor?: User | null; message: string; link: string },
): Promise<void> {
  if (recipientIds.length === 0) return;
  const stmts = recipientIds.map(rid =>
    env.DB.prepare(`INSERT INTO notifications
       (id, user_id, type, ref_kind, ref_id, actor_id, actor_name, message, link)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(uuid(), rid, args.type, args.refKind, args.refId,
            args.actor?.id || null, args.actor?.name || null,
            args.message, args.link)
  );
  await env.DB.batch(stmts);
}

// Fan out to every active studio user. Use when a CLIENT acts.
export async function notifyStudio(
  env: Env,
  args: { type: string; refKind: 'card' | 'project'; refId: string; actor?: User | null; message: string; link: string },
): Promise<void> {
  const rows = await env.DB
    .prepare(`SELECT id FROM users WHERE role = 'studio' AND status = 'active'`)
    .all<{ id: string }>();
  await insertRows(env, rows.results.map(r => r.id), args);
}

// Fan out to the client that owns the project. Use when a STUDIO user
// acts on a client project. Looks up the project's client_id and inserts
// one notification for that client (if they exist and are active).
export async function notifyClient(
  env: Env,
  args: { projectId: string; type: string; refKind: 'card' | 'project'; refId: string; actor?: User | null; message: string; link: string },
): Promise<void> {
  const proj = await env.DB
    .prepare('SELECT client_id FROM projects WHERE id = ?')
    .bind(args.projectId)
    .first<{ client_id: string }>();
  if (!proj) return;
  const client = await env.DB
    .prepare('SELECT id, status FROM users WHERE id = ? AND role = \'client\'')
    .bind(proj.client_id)
    .first<{ id: string; status: string }>();
  if (!client || client.status !== 'active') return;
  await insertRows(env, [client.id], args);
}

// Title is derived from the notification type at serialize time. Keeps the
// schema lean (no extra column) and lets us tweak titles without a migration.
function titleFor(type: string): string {
  switch (type) {
    case 'client_comment':     return 'Novo comentário';
    case 'client_file':        return 'Novo ficheiro';
    case 'studio_comment':     return 'Resposta do estúdio';
    case 'studio_file':        return 'Novo ficheiro do estúdio';
    case 'card_moved':         return 'Cartão atualizado';
    case 'card_created':       return 'Novo cartão';
    case 'project_status':     return 'Estado do projeto';
    case 'project_completed':  return 'Projeto concluído';
    default:                   return 'Notificação';
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
