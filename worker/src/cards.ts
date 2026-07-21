// Cards — CRUD + move
// Studio: full CRUD on any card in any of their projects
// Client:  read-only on cards in their own projects; comments are handled separately
import { Hono } from 'hono';
import type { AppVariables, Env, User, Card, CardPriority } from './types.js';
import { requireAuth, requireRole } from './middleware.js';
import { uuid } from './crypto.js';

export const cardRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

cardRoutes.use('*', requireAuth);

const POS_STEP = 1024;

async function assertProjectAccess(c: { get: (k: string) => unknown; env: Env }, projectId: string): Promise<'studio' | 'client' | null> {
  const u = c.get('user') as User;
  const p = await c.env.DB
    .prepare('SELECT id, client_id FROM projects WHERE id = ?')
    .bind(projectId)
    .first<{ id: string; client_id: string }>();
  if (!p) return null;
  if (u.role === 'studio') return 'studio';
  if (u.role === 'client' && p.client_id === u.id) return 'client';
  return null;
}

// GET /api/board — admin-only multi-project Jira-style board
// Returns all projects (non-archived) + all columns + all cards in one shot.
// The frontend groups columns by name to render a unified 3-column board,
// and filters by project when the admin focuses on a single client.
cardRoutes.get('/board', requireRole('studio'), async (c) => {
  // Only active projects show on the multi-board. completed/archived projects
  // drop off automatically (auto-complete kicks in when all cards close).
  const projects = await c.env.DB
    .prepare(`SELECT p.*, c.name AS client_name, c.email AS client_email
              FROM projects p JOIN users c ON c.id = p.client_id
              WHERE p.status = 'active'
              ORDER BY p.updated_at DESC`)
    .all<any>();
  const projectIds = projects.results.map((p: any) => p.id);
  let columns: any[] = [];
  let cards: any[] = [];
  if (projectIds.length) {
    const ph = projectIds.map(() => '?').join(',');
    const cols = await c.env.DB
      .prepare(`SELECT id, project_id, name, position FROM columns
                WHERE project_id IN (${ph}) ORDER BY project_id, position`)
      .bind(...projectIds)
      .all<any>();
    columns = cols.results;
    const cr = await c.env.DB
      .prepare(`SELECT c.*, u.name AS assignee_name, cb.name AS creator_name
                FROM cards c
                LEFT JOIN users u ON u.id = c.assignee_id
                LEFT JOIN users cb ON cb.id = c.created_by
                WHERE c.project_id IN (${ph})
                ORDER BY c.column_id, c.position`)
      .bind(...projectIds)
      .all<any>();
    cards = cr.results;
    const cardIds = cards.map((x: any) => x.id);
    if (cardIds.length) {
      const ph2 = cardIds.map(() => '?').join(',');
      const comments = await c.env.DB
        .prepare(`SELECT card_id, COUNT(*) AS n FROM comments WHERE card_id IN (${ph2}) GROUP BY card_id`)
        .bind(...cardIds)
        .all<{ card_id: string; n: number }>();
      const m: Record<string, number> = {};
      for (const r of comments.results) m[r.card_id] = r.n;
      for (const card of cards) card.comment_count = m[card.id] || 0;
    }
  }
  return c.json({ projects: projects.results, columns, cards });
});

// GET /api/projects/:id/board — project + columns + cards in one shot
// (used by the Kanban UI for both admin and client)
cardRoutes.get('/projects/:id/board', async (c) => {
  const access = await assertProjectAccess(c, c.req.param('id'));
  if (!access) return c.json({ error: 'não encontrado' }, 404);
  const project = await c.env.DB
    .prepare(`SELECT p.*, c.name AS client_name, c.email AS client_email
              FROM projects p JOIN users c ON c.id = p.client_id WHERE p.id = ?`)
    .bind(c.req.param('id'))
    .first<any>();
  if (!project) return c.json({ error: 'não encontrado' }, 404);
  const cols = await c.env.DB
    .prepare('SELECT id, project_id, name, position FROM columns WHERE project_id = ? ORDER BY position')
    .bind(c.req.param('id'))
    .all<any>();
  const cards = await c.env.DB
    .prepare(`SELECT c.*, u.name AS assignee_name, cb.name AS creator_name
              FROM cards c
              LEFT JOIN users u ON u.id = c.assignee_id
              LEFT JOIN users cb ON cb.id = c.created_by
              WHERE c.project_id = ?
              ORDER BY c.column_id, c.position`)
    .bind(c.req.param('id'))
    .all<any>();
  // attach comment counts
  const ids = cards.results.map((c: any) => c.id);
  let commentsByCard: Record<string, number> = {};
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await c.env.DB
      .prepare(`SELECT card_id, COUNT(*) AS n FROM comments WHERE card_id IN (${placeholders}) GROUP BY card_id`)
      .bind(...ids)
      .all<{ card_id: string; n: number }>();
    for (const r of rows.results) commentsByCard[r.card_id] = r.n;
  }
  for (const card of cards.results) card.comment_count = commentsByCard[card.id] || 0;
  return c.json({ project, columns: cols.results, cards: cards.results, access });
});

// POST /api/projects/:id/cards — create a card (studio only)
cardRoutes.post('/projects/:id/cards', requireRole('studio'), async (c) => {
  const access = await assertProjectAccess(c, c.req.param('id'));
  if (!access) return c.json({ error: 'não encontrado' }, 404);
  const me = c.get('user') as User;
  const body = await c.req.json().catch(() => null) as Partial<Card> | null;
  if (!body?.title || !body?.column_id) return c.json({ error: 'título e coluna são obrigatórios' }, 400);

  // find max position in the target column
  const max = await c.env.DB
    .prepare('SELECT COALESCE(MAX(position), 0) AS m FROM cards WHERE column_id = ?')
    .bind(body.column_id)
    .first<{ m: number }>();
  const nextPos = (max?.m || 0) + POS_STEP;

  const id = uuid();
  await c.env.DB
    .prepare(`INSERT INTO cards (id, project_id, column_id, title, description, position, priority, due_date, estimated_hours, assignee_id, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      id, c.req.param('id'), body.column_id, body.title.trim(),
      body.description?.trim() || null,
      nextPos,
      (body.priority as CardPriority) || 'medium',
      body.due_date || null,
      body.estimated_hours ?? null,
      body.assignee_id || null,
      me.id,
    )
    .run();
  const card = await c.env.DB.prepare('SELECT * FROM cards WHERE id = ?').bind(id).first<Card>();
  return c.json({ card }, 201);
});

// PATCH /api/cards/:id — update card (studio only)
cardRoutes.patch('/cards/:id', requireRole('studio'), async (c) => {
  const existing = await c.env.DB
    .prepare('SELECT * FROM cards WHERE id = ?')
    .bind(c.req.param('id'))
    .first<Card>();
  if (!existing) return c.json({ error: 'cartão não encontrado' }, 404);
  const access = await assertProjectAccess(c, existing.project_id);
  if (!access) return c.json({ error: 'forbidden' }, 403);

  const body = await c.req.json().catch(() => null) as Partial<Card> | null;
  if (!body) return c.json({ error: 'payload vazio' }, 400);

  // Build SET clause from allowed fields
  const allowed: (keyof Card)[] = ['title', 'description', 'priority', 'due_date', 'estimated_hours', 'actual_hours', 'assignee_id', 'column_id', 'position'];
  const sets: string[] = [];
  const args: any[] = [];
  for (const k of allowed) {
    if ((body as any)[k] !== undefined) {
      sets.push(`${k} = ?`);
      args.push((body as any)[k] === '' ? null : (body as any)[k]);
    }
  }
  if (sets.length === 0) return c.json({ error: 'nada para atualizar' }, 400);
  sets.push('updated_at = datetime(\'now\')');
  args.push(c.req.param('id'));
  await c.env.DB.prepare(`UPDATE cards SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
  const card = await c.env.DB.prepare('SELECT * FROM cards WHERE id = ?').bind(c.req.param('id')).first<Card>();
  return c.json({ card });
});

// POST /api/cards/:id/move — move card to a different column + position
// body: { column_id, position? }   (position optional, defaults to end of column)
cardRoutes.post('/cards/:id/move', requireRole('studio'), async (c) => {
  const existing = await c.env.DB
    .prepare('SELECT * FROM cards WHERE id = ?')
    .bind(c.req.param('id'))
    .first<Card>();
  if (!existing) return c.json({ error: 'cartão não encontrado' }, 404);
  const access = await assertProjectAccess(c, existing.project_id);
  if (!access) return c.json({ error: 'forbidden' }, 403);

  const body = await c.req.json().catch(() => null) as { column_id?: string; position?: number } | null;
  if (!body?.column_id) return c.json({ error: 'column_id obrigatório' }, 400);

  // cross-project move protection: a card can only move to a column that
  // belongs to the same project. Otherwise you'd accidentally drop a
  // client's card into another client's project on the unified board.
  const targetCol = await c.env.DB
    .prepare('SELECT id, project_id, name FROM columns WHERE id = ?')
    .bind(body.column_id)
    .first<{ id: string; project_id: string; name: string }>();
  if (!targetCol) return c.json({ error: 'coluna de destino não existe' }, 404);
  if (targetCol.project_id !== existing.project_id) {
    return c.json({ error: 'o cartão não pode mudar de projeto' }, 400);
  }

  let pos = body.position;
  if (pos == null) {
    const max = await c.env.DB
      .prepare('SELECT COALESCE(MAX(position), 0) AS m FROM cards WHERE column_id = ? AND id != ?')
      .bind(body.column_id, c.req.param('id'))
      .first<{ m: number }>();
    pos = (max?.m || 0) + POS_STEP;
  }

  await c.env.DB
    .prepare('UPDATE cards SET column_id = ?, position = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .bind(body.column_id, pos, c.req.param('id'))
    .run();

  // Auto-complete: if this card just landed in a "Concluído" column and every
  // other card in the project is also in a "Concluído" column, mark the
  // project as completed so it falls off the multi-project board.
  let project_completed = false;
  if (targetCol.name.toLowerCase() === 'concluído' || targetCol.name.toLowerCase() === 'concluido') {
    const remaining = await c.env.DB
      .prepare(`SELECT COUNT(*) AS n
                FROM cards c JOIN columns k ON k.id = c.column_id
                WHERE c.project_id = ?
                  AND (LOWER(k.name) NOT IN ('concluído', 'concluido'))`)
      .bind(existing.project_id)
      .first<{ n: number }>();
    if (remaining && remaining.n === 0) {
      const proj = await c.env.DB
        .prepare('SELECT status FROM projects WHERE id = ?')
        .bind(existing.project_id)
        .first<{ status: string }>();
      if (proj && proj.status === 'active') {
        await c.env.DB
          .prepare(`UPDATE projects SET status = 'completed', updated_at = datetime('now') WHERE id = ?`)
          .bind(existing.project_id)
          .run();
        project_completed = true;
      }
    }
  }

  return c.json({ ok: true, project_completed });
});

// DELETE /api/cards/:id (studio only)
cardRoutes.delete('/cards/:id', requireRole('studio'), async (c) => {
  const existing = await c.env.DB
    .prepare('SELECT * FROM cards WHERE id = ?')
    .bind(c.req.param('id'))
    .first<Card>();
  if (!existing) return c.json({ error: 'cartão não encontrado' }, 404);
  const access = await assertProjectAccess(c, existing.project_id);
  if (!access) return c.json({ error: 'forbidden' }, 403);
  await c.env.DB.prepare('DELETE FROM cards WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

// GET /api/cards/:id — single card with comments + metadata
// Both studio and client can read (with ownership check via the project)
cardRoutes.get('/cards/:id', async (c) => {
  const card = await c.env.DB
    .prepare(`SELECT c.*, u.name AS assignee_name, cb.name AS creator_name
              FROM cards c
              LEFT JOIN users u ON u.id = c.assignee_id
              LEFT JOIN users cb ON cb.id = c.created_by
              WHERE c.id = ?`)
    .bind(c.req.param('id'))
    .first<any>();
  if (!card) return c.json({ error: 'cartão não encontrado' }, 404);
  const access = await assertProjectAccess(c, card.project_id);
  if (!access) return c.json({ error: 'forbidden' }, 403);
  const comments = await c.env.DB
    .prepare(`SELECT cm.*, u.name AS author_name, u.role AS author_role
              FROM comments cm JOIN users u ON u.id = cm.user_id
              WHERE cm.card_id = ? ORDER BY cm.created_at ASC`)
    .bind(c.req.param('id'))
    .all<any>();
  return c.json({ card, comments: comments.results, access });
});
