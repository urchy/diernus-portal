// Cards — CRUD + move
// Studio: full CRUD on any card in any of their projects
// Client:  read-only on cards in their own projects; comments are handled separately
// Studio-side mutations (create / move) also notify the project's client
// so the client's bell lights up. Moving a card to the "Revisão" column
// ALSO sends an email to the project owner (the client) so they can
// review — this is the quality-gate handoff.
import { Hono } from 'hono';
import type { AppVariables, Env, User, Card, CardPriority } from './types.js';
import { requireAuth, requireStudio } from './middleware.js';
import { isStudio, isClient } from './types.js';
import { uuid } from './crypto.js';
import { notifyClient } from './notifications.js';
import { sendEmail, cardReviewEmail, projectCompletedEmail } from './resend.js';

// ----------------------------------------------------------------------------
// Card history helper
// Every meaningful card mutation calls this once. The user_name is cached at
// insert time so the frontend doesn't need a join to render the timeline.
// ----------------------------------------------------------------------------
async function logCardHistory(
  env: Env,
  args: {
    cardId: string;
    projectId: string;
    user: User;
    action: 'created' | 'moved' | 'assigned' | 'unassigned' | 'priority_changed' | 'renamed' | 'description_changed' | 'due_date_set' | 'due_date_cleared' | 'estimated_hours_changed' | 'deleted';
    fromValue?: string | null;
    toValue?: string | null;
  }
): Promise<void> {
  try {
    await env.DB
      .prepare(`INSERT INTO card_history (id, card_id, project_id, user_id, user_name, action, from_value, to_value)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        uuid(),
        args.cardId,
        args.projectId,
        args.user.id,
        args.user.name || args.user.email,
        args.action,
        args.fromValue ?? null,
        args.toValue ?? null,
      )
      .run();
  } catch (e) {
    // History is best-effort — never block the actual operation
    console.error('[cards.ts] history insert failed:', (e as Error).message);
  }
}

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
  if (isStudio(u.role)) return 'studio';
  if (isClient(u.role) && p.client_id === u.id) return 'client';
  return null;
}

// GET /api/board — admin/team-only multi-project Jira-style board
// Returns projects + columns + cards in one shot. The frontend groups columns
// by name to render a unified 3-column board, and filters by project when the
// admin focuses on a single client.
//
// Default behaviour: only ACTIVE projects (backwards-compat with the original
// auto-complete-on-last-card semantics — completed/archived projects are not on
// the unified board unless explicitly asked for).
//
// Opt-in flags (?include_status=active,completed,archived comma list) override
// the default. This lets the Quadro Geral surface a "Arquivados" filter chip
// without breaking the existing call sites.
//
// Examples:
//   GET /api/board                       → active only
//   GET /api/board?include_status=archived  → only archived
//   GET /api/board?include_status=all       → everything
//   GET /api/board?include_status=active,completed  → active + completed
cardRoutes.get('/board', requireStudio, async (c) => {
  // Parse the include_status query param. Default = ['active'].
  // Unknown values are silently dropped (avoids 400 for typos).
  const VALID = new Set(['active', 'completed', 'archived']);
  const includeParam = c.req.query('include_status');
  const requested = includeParam
    ? includeParam.split(',').map(s => s.trim()).filter(s => VALID.has(s))
    : ['active'];
  const statuses = requested.length ? requested : ['active'];  // safety: never empty
  const ph = statuses.map(() => '?').join(',');

  const projects = await c.env.DB
    .prepare(`SELECT p.*, c.name AS client_name, c.email AS client_email
              FROM projects p JOIN users c ON c.id = p.client_id
              WHERE p.status IN (${ph})
              ORDER BY p.status = 'active' DESC, p.updated_at DESC`)
    .bind(...statuses)
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

  // ---- Summary block (computed from cards + project meta) ----
  //   total / done / in_progress / todo          — counts
  //   total_estimated_hours / total_actual_hours — sums
  //   progress_pct                              — done / total × 100
  //   budget_consumed_pct                       — actual / budget × 100
  //   overdue_count                             — due_date < today AND not in Concluído
  //   next_due_card                             — soonest due_date (any open card)
  const total = cards.results.length;
  let done = 0, inProgress = 0, todo = 0;
  let totalEst = 0, totalAct = 0;
  let overdue = 0;
  let nextDue: any = null;
  const todayIso = new Date().toISOString().slice(0, 10);
  for (const card of cards.results) {
    const col = cols.results.find((k: any) => k.id === card.column_id);
    const cname = (col?.name || '').toLowerCase();
    if (cname === 'concluído' || cname === 'concluido') done++;
    else if (cname === 'em curso') inProgress++;
    else todo++;
    totalEst += Number(card.estimated_hours) || 0;
    totalAct += Number(card.actual_hours) || 0;
    if (card.due_date && card.due_date < todayIso && cname !== 'concluído' && cname !== 'concluido') overdue++;
    if (card.due_date && cname !== 'concluído' && cname !== 'concluido') {
      if (!nextDue || card.due_date < nextDue.due_date) {
        nextDue = { id: card.id, title: card.title, due_date: card.due_date, priority: card.priority, column_id: card.column_id };
      }
    }
  }
  const summary = {
    total,
    done,
    in_progress: inProgress,
    todo,
    total_estimated_hours: Math.round(totalEst * 10) / 10,
    total_actual_hours:   Math.round(totalAct * 10) / 10,
    progress_pct: total > 0 ? Math.round((done / total) * 100) : 0,
    budget_consumed_pct: project.budget_hours > 0 ? Math.round((totalAct / project.budget_hours) * 100) : null,
    overdue_count: overdue,
    next_due_card: nextDue,
  };

  return c.json({ project, columns: cols.results, cards: cards.results, summary, access });
});

// POST /api/projects/:id/cards — create a card (studio only)
cardRoutes.post('/projects/:id/cards', requireStudio, async (c) => {
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
  // history: 'created' event
  await logCardHistory(c.env, {
    cardId: id, projectId: c.req.param('id'), user: me,
    action: 'created', toValue: card!.title,
  });
  // notify the client — a new card appeared on their project
  await notifyClient(c.env, {
    projectId: c.req.param('id'),
    type: 'card_created',
    refKind: 'card',
    refId: id,
    actor: me,
    message: `“${card!.title}”${card!.due_date ? ` — prazo ${card!.due_date}` : ''}`,
    link: `/portal/projeto.html?id=${c.req.param('id')}&card=${id}`,
  });
  return c.json({ card }, 201);
});

// PATCH /api/cards/:id — update card (studio only)
cardRoutes.patch('/cards/:id', requireStudio, async (c) => {
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

  // History: one row per changed field. Keep it simple — record the
  // from/to of each interesting field if the body touched it.
  const me = c.get('user') as User;
  if (body.title !== undefined && body.title !== existing.title) {
    await logCardHistory(c.env, {
      cardId: existing.id, projectId: existing.project_id, user: me,
      action: 'renamed', fromValue: existing.title, toValue: body.title,
    });
  }
  if (body.description !== undefined && (body.description || '') !== (existing.description || '')) {
    await logCardHistory(c.env, {
      cardId: existing.id, projectId: existing.project_id, user: me,
      action: 'description_changed', fromValue: existing.description || '(vazio)', toValue: body.description || '(vazio)',
    });
  }
  if (body.priority !== undefined && body.priority !== existing.priority) {
    await logCardHistory(c.env, {
      cardId: existing.id, projectId: existing.project_id, user: me,
      action: 'priority_changed', fromValue: existing.priority, toValue: body.priority,
    });
  }
  if (body.due_date !== undefined && body.due_date !== existing.due_date) {
    const wasCleared = existing.due_date && !body.due_date;
    await logCardHistory(c.env, {
      cardId: existing.id, projectId: existing.project_id, user: me,
      action: wasCleared ? 'due_date_cleared' : 'due_date_set',
      fromValue: existing.due_date, toValue: body.due_date || null,
    });
  }
  if (body.estimated_hours !== undefined && body.estimated_hours !== existing.estimated_hours) {
    await logCardHistory(c.env, {
      cardId: existing.id, projectId: existing.project_id, user: me,
      action: 'estimated_hours_changed',
      fromValue: existing.estimated_hours != null ? `${existing.estimated_hours}h` : null,
      toValue: body.estimated_hours != null ? `${body.estimated_hours}h` : null,
    });
  }
  if (body.assignee_id !== undefined && body.assignee_id !== existing.assignee_id) {
    const isUnassigned = !body.assignee_id;
    // Look up the new assignee's name for the "to" value
    let toName: string | null = null;
    if (body.assignee_id) {
      const a = await c.env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(body.assignee_id).first<{ name: string }>();
      toName = a?.name || '(desconhecido)';
    }
    let fromName: string | null = null;
    if (existing.assignee_id) {
      const a = await c.env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(existing.assignee_id).first<{ name: string }>();
      fromName = a?.name || '(desconhecido)';
    }
    await logCardHistory(c.env, {
      cardId: existing.id, projectId: existing.project_id, user: me,
      action: isUnassigned ? 'unassigned' : 'assigned',
      fromValue: fromName, toValue: toName,
    });
  }
  return c.json({ card });
});

// POST /api/cards/:id/move — move card to a different column + position
// body: { column_id, position? }   (position optional, defaults to end of column)
cardRoutes.post('/cards/:id/move', requireStudio, async (c) => {
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

  // notify the client — the card moved (use the destination column name)
  // but only if the column actually changed (otherwise it'd be a no-op move
  // and the bell would be noisy)
  const moved = existing.column_id !== body.column_id;
  if (moved) {
    const me = c.get('user') as User;
    // history: 'moved' event with from/to column names (looks up source column name)
    const srcCol = await c.env.DB
      .prepare('SELECT name FROM columns WHERE id = ?')
      .bind(existing.column_id)
      .first<{ name: string }>();
    await logCardHistory(c.env, {
      cardId: existing.id, projectId: existing.project_id, user: me,
      action: 'moved',
      fromValue: srcCol?.name || '(desconhecida)',
      toValue: targetCol.name,
    });
    await notifyClient(c.env, {
      projectId: existing.project_id,
      type: 'card_moved',
      refKind: 'card',
      refId: c.req.param('id'),
      actor: me,
      message: `“${existing.title}” → ${targetCol.name}`,
      link: `/portal/projeto.html?id=${existing.project_id}&card=${c.req.param('id')}`,
    });

    // Email the client if the card just landed in the "Revisão" column.
    // This is the quality-gate handoff — the studio is asking the client
    // to review. Sent via waitUntil so the API response doesn't wait for
    // Resend. The destination column name match is case-insensitive and
    // accent-insensitive (covers "Revisão", "revisao", "REVISÃO", etc).
    const targetName = (targetCol.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (targetName === 'revisao') {
      const ctx = await c.env.DB
        .prepare(`SELECT p.name AS project_name, p.id AS project_id, p.due_date,
                  c.name AS client_name, c.email AS client_email
                  FROM projects p JOIN users c ON c.id = p.client_id
                  WHERE p.id = ?`)
        .bind(existing.project_id)
        .first<{ project_name: string; project_id: string; due_date: string | null; client_name: string; client_email: string }>();
      if (ctx) {
        const reviewUrl = `${c.env.PUBLIC_URL}/portal/projeto.html?id=${ctx.project_id}&card=${c.req.param('id')}`;
        const tpl = cardReviewEmail({
          clientName: ctx.client_name,
          projectName: ctx.project_name,
          cardTitle: existing.title,
          cardId: c.req.param('id'),
          projectId: existing.project_id,
          publicUrl: c.env.PUBLIC_URL,
          dueDate: existing.due_date || ctx.due_date,
          studioName: me.name,
          reviewUrl,
        });
        // Fire-and-forget: don't block the move response on Resend
        c.executionCtx.waitUntil(
          sendEmail(c.env, { to: ctx.client_email, ...tpl })
            .catch(err => console.error('[cards.ts] review email failed:', err.message))
        );
      }
    }
  }

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
        // tell the client their project is done (bell)
        const me = c.get('user') as User;
        const projRow = await c.env.DB
          .prepare('SELECT name FROM projects WHERE id = ?')
          .bind(existing.project_id)
          .first<{ name: string }>();
        await notifyClient(c.env, {
          projectId: existing.project_id,
          type: 'project_completed',
          refKind: 'project',
          refId: existing.project_id,
          actor: me,
          message: `“${projRow?.name || 'o projeto'}” está concluído.`,
          link: `/portal/projeto.html?id=${existing.project_id}`,
        });
        // Email the client + every studio member
        const finalCardTitle = existing.title;
        const projectName = projRow?.name || 'o projeto';
        const recipients = await c.env.DB
          .prepare(`SELECT u.id, u.name, u.email, u.role,
                    CASE WHEN u.id = p.client_id THEN 1 ELSE 0 END AS is_client
                    FROM users u JOIN projects p ON p.id = ?
                    WHERE u.status = 'active' AND (u.id = p.client_id OR u.role IN ('admin', 'team'))`)
          .bind(existing.project_id)
          .all<{ id: string; name: string; email: string; role: string; is_client: number }>();
        for (const r of recipients.results) {
          const isClient = r.is_client === 1;
          const portalPath = isClient
            ? `/portal/projeto.html?id=${existing.project_id}`
            : `/admin/projeto.html?id=${existing.project_id}`;
          const projectUrl = `${c.env.PUBLIC_URL}${portalPath}`;
          const tpl = projectCompletedEmail({
            recipientName: r.name,
            projectName,
            finalCardTitle,
            projectUrl,
            forClient: isClient,
          });
          c.executionCtx.waitUntil(
            sendEmail(c.env, { to: r.email, ...tpl })
              .catch(err => console.error(`[cards.ts] project-completed email to ${r.email} failed:`, err.message))
          );
        }
      }
    }
  }

  return c.json({ ok: true, project_completed });
});

// DELETE /api/cards/:id (studio only)
cardRoutes.delete('/cards/:id', requireStudio, async (c) => {
  const existing = await c.env.DB
    .prepare('SELECT * FROM cards WHERE id = ?')
    .bind(c.req.param('id'))
    .first<Card>();
  if (!existing) return c.json({ error: 'cartão não encontrado' }, 404);
  const access = await assertProjectAccess(c, existing.project_id);
  if (!access) return c.json({ error: 'forbidden' }, 403);
  // History: record the deletion BEFORE the row is gone (history table
  // has a CASCADE FK on card_id, so a record-after-delete would also work,
  // but doing it first is cleaner and more reliable).
  const me = c.get('user') as User;
  await logCardHistory(c.env, {
    cardId: existing.id, projectId: existing.project_id, user: me,
    action: 'deleted', fromValue: existing.title, toValue: null,
  });
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

// GET /api/cards/:id/history — full audit trail for one card
// Reverse-chronological (newest first). Capped at 200 rows to keep the
// response small. Both studio and client can read.
cardRoutes.get('/cards/:id/history', async (c) => {
  const card = await c.env.DB
    .prepare('SELECT id, project_id FROM cards WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ id: string; project_id: string }>();
  if (!card) return c.json({ error: 'cartão não encontrado' }, 404);
  const access = await assertProjectAccess(c, card.project_id);
  if (!access) return c.json({ error: 'forbidden' }, 403);
  const rows = await c.env.DB
    .prepare(`SELECT id, user_id, user_name, action, from_value, to_value, created_at
              FROM card_history
              WHERE card_id = ?
              ORDER BY created_at DESC
              LIMIT 200`)
    .bind(c.req.param('id'))
    .all<{ id: string; user_id: string | null; user_name: string; action: string; from_value: string | null; to_value: string | null; created_at: string }>();
  return c.json({ history: rows.results });
});
