// Comments — both studio and client can post on cards in their projects
import { Hono } from 'hono';
import type { AppVariables, Env, User } from './types.js';
import { requireAuth } from './middleware.js';
import { uuid } from './crypto.js';

export const commentRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

commentRoutes.use('*', requireAuth);

async function assertCardAccess(c: { get: (k: string) => unknown; env: Env }, cardId: string): Promise<'studio' | 'client' | null> {
  const u = c.get('user') as User;
  const card = await c.env.DB.prepare('SELECT project_id FROM cards WHERE id = ?').bind(cardId).first<{ project_id: string }>();
  if (!card) return null;
  const p = await c.env.DB.prepare('SELECT client_id FROM projects WHERE id = ?').bind(card.project_id).first<{ client_id: string }>();
  if (!p) return null;
  if (u.role === 'studio') return 'studio';
  if (u.role === 'client' && p.client_id === u.id) return 'client';
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
  return c.json({ comment }, 201);
});
