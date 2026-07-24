// Comments — both studio (admin/team) and client can post on cards in their projects.
// Notifications flow BOTH directions:
//   client comments  → notifyStudio() (the studio bell lights up)
//   studio comments  → notifyClient() (the client bell lights up)
// Emails flow in the OPPOSITE direction: whoever posted, the other side
// gets the email (with the comment snippet + deep link to the card).
import { Hono } from 'hono';
import type { AppVariables, Env, User } from './types.js';
import { requireAuth } from './middleware.js';
import { isStudio, isClient } from './types.js';
import { uuid } from './crypto.js';
import { notifyStudio, notifyClient } from './notifications.js';
import { sendEmail, commentEmail } from './resend.js';

export const commentRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

commentRoutes.use('*', requireAuth);

async function assertCardAccess(c: { get: (k: string) => unknown; env: Env }, cardId: string): Promise<'studio' | 'client' | null> {
  const u = c.get('user') as User;
  const card = await c.env.DB.prepare('SELECT project_id FROM cards WHERE id = ?').bind(cardId).first<{ project_id: string }>();
  if (!card) return null;
  const p = await c.env.DB.prepare('SELECT client_id FROM projects WHERE id = ?').bind(card.project_id).first<{ client_id: string }>();
  if (!p) return null;
  if (isStudio(u.role)) return 'studio';
  if (isClient(u.role) && p.client_id === u.id) return 'client';
  return null;
}

// GET /api/cards/:cardId/comments
commentRoutes.get('/cards/:cardId/comments', async (c) => {
  const access = await assertCardAccess(c, c.req.param('cardId'));
  if (!access) return c.json({ error: 'cartão não encontrado' }, 404);
  const rows = await c.env.DB
    .prepare(`SELECT cm.*, u.name AS author_name, u.role AS author_role
              FROM comments cm JOIN users u ON u.id = cm.user_id
              WHERE cm.card_id = ? ORDER BY cm.created_at ASC`)
    .bind(c.req.param('cardId'))
    .all<any>();
  return c.json({ comments: rows.results });
});

// POST /api/cards/:cardId/comments — anyone with access to the card can comment
commentRoutes.post('/cards/:cardId/comments', async (c) => {
  const access = await assertCardAccess(c, c.req.param('cardId'));
  if (!access) return c.json({ error: 'cartão não encontrado' }, 404);
  const me = c.get('user') as User;
  const body = await c.req.json().catch(() => null) as { body?: string } | null;
  if (!body?.body || !body.body.trim()) return c.json({ error: 'comentário vazio' }, 400);
  if (body.body.length > 5000) return c.json({ error: 'comentário demasiado longo (máx. 5000 caracteres)' }, 400);

  const id = uuid();
  await c.env.DB
    .prepare('INSERT INTO comments (id, card_id, user_id, body) VALUES (?, ?, ?, ?)')
    .bind(id, c.req.param('cardId'), me.id, body.body.trim())
    .run();
  // touch the card so updated_at moves
  await c.env.DB.prepare('UPDATE cards SET updated_at = datetime(\'now\') WHERE id = ?').bind(c.req.param('cardId')).run();
  const comment = await c.env.DB
    .prepare(`SELECT cm.*, u.name AS author_name, u.role AS author_role
              FROM comments cm JOIN users u ON u.id = cm.user_id WHERE cm.id = ?`)
    .bind(id)
    .first<any>();

  // Fire the right notification depending on who commented.
  const ctx = await c.env.DB
    .prepare(`SELECT c.title AS card_title, c.project_id, p.name AS project_name
              FROM cards c JOIN projects p ON p.id = c.project_id
              WHERE c.id = ?`)
    .bind(c.req.param('cardId'))
    .first<{ card_title: string; project_id: string; project_name: string }>();
  if (ctx) {
    const snippet = body.body.trim().length > 80
      ? body.body.trim().slice(0, 77) + '…'
      : body.body.trim();
    if (isClient(me.role)) {
      // client → studio: title "Novo comentário", body "em 'card' — 'snippet'"
      await notifyStudio(c.env, {
        type: 'client_comment',
        refKind: 'card',
        refId: c.req.param('cardId'),
        actor: me,
        message: `em “${ctx.card_title}” — “${snippet}”`,
        link: `/admin/projeto.html?id=${ctx.project_id}&card=${c.req.param('cardId')}`,
      });
      // Email each studio member (admin + team) — fan-out like the bell
      const recipients = await c.env.DB
        .prepare(`SELECT id, name, email FROM users WHERE role IN ('admin', 'team') AND status = 'active' AND id != ?`)
        .bind(me.id)
        .all<{ id: string; name: string; email: string }>();
      const cardUrl = `${c.env.PUBLIC_URL}/admin/projeto.html?id=${ctx.project_id}&card=${c.req.param('cardId')}`;
      for (const r of recipients.results) {
        const tpl = commentEmail({
          recipientName: r.name, authorName: me.name, authorRole: 'client',
          projectName: ctx.project_name, cardTitle: ctx.card_title,
          commentSnippet: snippet, cardUrl,
        });
        c.executionCtx.waitUntil(
          sendEmail(c.env, { to: r.email, ...tpl })
            .catch(err => console.error(`[comments.ts] client→studio email to ${r.email} failed:`, err.message))
        );
      }
    } else {
      // studio → client: title "Resposta do estúdio", body "em 'card' — 'snippet'"
      await notifyClient(c.env, {
        projectId: ctx.project_id,
        type: 'studio_comment',
        refKind: 'card',
        refId: c.req.param('cardId'),
        actor: me,
        message: `em “${ctx.card_title}” — “${snippet}”`,
        link: `/portal/projeto.html?id=${ctx.project_id}&card=${c.req.param('cardId')}`,
      });
      // Email the project owner (the client)
      const client = await c.env.DB
        .prepare(`SELECT c.name, c.email FROM users c JOIN projects p ON p.client_id = c.id WHERE p.id = ?`)
        .bind(ctx.project_id)
        .first<{ name: string; email: string }>();
      if (client) {
        const cardUrl = `${c.env.PUBLIC_URL}/portal/projeto.html?id=${ctx.project_id}&card=${c.req.param('cardId')}`;
        const tpl = commentEmail({
          recipientName: client.name, authorName: me.name, authorRole: 'studio',
          projectName: ctx.project_name, cardTitle: ctx.card_title,
          commentSnippet: snippet, cardUrl,
        });
        c.executionCtx.waitUntil(
          sendEmail(c.env, { to: client.email, ...tpl })
            .catch(err => console.error(`[comments.ts] studio→client email to ${client.email} failed:`, err.message))
        );
      }
    }
  }
  return c.json({ comment }, 201);
});
