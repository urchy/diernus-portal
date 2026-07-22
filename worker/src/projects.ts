// Clients — studio creates pending clients, sends invites, lists them
// Projects — studio creates, both list (filtered by role)
import { Hono } from 'hono';
import type { AppVariables, Env, Project, User } from './types.js';
import { requireAuth, requireRole } from './middleware.js';
import { uuid } from './crypto.js';
import { createInvitation } from './invites.js';

export const projectRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();
export const clientRoutes  = new Hono<{ Bindings: Env; Variables: AppVariables }>();

projectRoutes.use('*', requireAuth);
clientRoutes.use('*',  requireAuth, requireRole('studio'));

const DEFAULT_COLUMNS = [
  { name: 'A Fazer',   pos: 1024 },
  { name: 'Em Curso',  pos: 2048 },
  { name: 'Concluído', pos: 3072 },
];

// =========================================================================
// projects
// =========================================================================

// GET /api/projects — list projects visible to the user
projectRoutes.get('/', async (c) => {
  const u = c.get('user') as User;
  const sql = u.role === 'studio'
    ? `SELECT p.*, c.name AS client_name, c.email AS client_email, c.status AS client_status
       FROM projects p JOIN users c ON c.id = p.client_id
       ORDER BY p.updated_at DESC LIMIT 200`
    : `SELECT p.*, c.name AS client_name, c.email AS client_email, c.status AS client_status
       FROM projects p JOIN users c ON c.id = p.client_id
       WHERE p.client_id = ?
       ORDER BY p.updated_at DESC LIMIT 200`;
  const stmt = c.env.DB.prepare(sql);
  const rows = u.role === 'studio' ? await stmt.all<Project & { client_name: string; client_email: string; client_status: string }>()
                                     : await stmt.bind(u.id).all<Project & { client_name: string; client_email: string; client_status: string }>();
  return c.json({ projects: rows.results });
});

// GET /api/projects/:id — single project (with columns) — ownership-checked
projectRoutes.get('/:id', async (c) => {
  const u = c.get('user') as User;
  const id = c.req.param('id');
  const proj = await c.env.DB
    .prepare(`SELECT p.*, c.name AS client_name, c.email AS client_email, c.status AS client_status
              FROM projects p JOIN users c ON c.id = p.client_id
              WHERE p.id = ?`)
    .bind(id)
    .first<Project & { client_name: string; client_email: string; client_status: string }>();
  if (!proj) return c.json({ error: 'projeto não encontrado' }, 404);
  if (u.role === 'client' && proj.client_id !== u.id) return c.json({ error: 'forbidden' }, 403);
  const cols = await c.env.DB
    .prepare('SELECT id, project_id, name, position FROM columns WHERE project_id = ? ORDER BY position')
    .bind(id)
    .all<{ id: string; project_id: string; name: string; position: number }>();
  return c.json({ project: proj, columns: cols.results });
});

// PATCH /api/projects/:id — update (studio only). Status, name, description, hourly_rate, budget_hours.
projectRoutes.patch('/:id', requireRole('studio'), async (c) => {
  const existing = await c.env.DB
    .prepare('SELECT id FROM projects WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ id: string }>();
  if (!existing) return c.json({ error: 'projeto não encontrado' }, 404);
  const body = await c.req.json().catch(() => null) as Partial<Project> | null;
  if (!body) return c.json({ error: 'payload vazio' }, 400);
  const allowed: (keyof Project)[] = ['name', 'description', 'status', 'hourly_rate', 'budget_hours', 'due_date'];
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
  await c.env.DB.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
  const project = await c.env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(c.req.param('id')).first<Project>();
  return c.json({ project });
});

// POST /api/projects — create (studio only)
projectRoutes.post('/', requireRole('studio'), async (c) => {
  const me = c.get('user') as User;
  const body = await c.req.json().catch(() => null) as { client_id?: string; name?: string; description?: string } | null;
  if (!body?.client_id || !body?.name) return c.json({ error: 'cliente e nome são obrigatórios' }, 400);
  const client = await c.env.DB.prepare('SELECT id, role, status FROM users WHERE id = ?').bind(body.client_id).first<{ id: string; role: string; status: string }>();
  if (!client) return c.json({ error: 'cliente não encontrado' }, 404);
  if (client.role !== 'client') return c.json({ error: 'o utilizador indicado não é um cliente' }, 400);

  const id = uuid();
  const colStmts = DEFAULT_COLUMNS.map(col =>
    c.env.DB.prepare('INSERT INTO columns (id, project_id, name, position) VALUES (?, ?, ?, ?)')
      .bind(uuid(), id, col.name, col.pos)
  );
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO projects (id, client_id, name, description, created_by) VALUES (?, ?, ?, ?, ?)')
      .bind(id, body.client_id, body.name.trim(), body.description?.trim() || null, me.id),
    ...colStmts,
  ]);
  const proj = await c.env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first<Project>();
  return c.json({ project: proj }, 201);
});

// =========================================================================
// clients  (studio only — guarded at the router level)
// =========================================================================

// GET /api/clients — list all clients (with status)
clientRoutes.get('/', async (c) => {
  const rows = await c.env.DB
    .prepare(`SELECT id, email, name, role, status, created_at, last_seen_at
              FROM users WHERE role = 'client'
              ORDER BY status = 'active' DESC, name`)
    .all<User>();
  // For each client email, return the *most recent* invitation with its
  // `accepted_at` + `expires_at`, plus the count of still-pending invites.
  // The frontend (admin/clientes.html) needs `accepted_at` to decide whether
  // the most recent invite was actually accepted — using MAX(expires_at) was
  // wrong because the latest expiry could belong to an invite that was
  // superseded by a newer (still pending) one.
  const invites = await c.env.DB
    .prepare(`SELECT i.email, i.created_at AS last_invite, i.expires_at, i.accepted_at,
              (SELECT COUNT(*) FROM invitations j
                 WHERE j.email = i.email
                   AND j.accepted_at IS NULL
                   AND j.expires_at > datetime('now')) AS pending_count
              FROM invitations i
              WHERE i.id = (SELECT id FROM invitations
                             WHERE email = i.email
                             ORDER BY created_at DESC LIMIT 1)`)
    .all<{ email: string; last_invite: string; expires_at: string; accepted_at: string | null; pending_count: number }>();
  const inviteMap = new Map(invites.results.map(i => [i.email, i]));
  const clients = rows.results.map(u => ({ ...u, invite: inviteMap.get(u.email) || null }));
  return c.json({ clients });
});

// GET /api/clients/:id — single client
clientRoutes.get('/:id', async (c) => {
  const u = await c.env.DB
    .prepare('SELECT id, email, name, role, status, created_at, last_seen_at FROM users WHERE id = ? AND role = \'client\'')
    .bind(c.req.param('id'))
    .first<User>();
  if (!u) return c.json({ error: 'cliente não encontrado' }, 404);
  const projects = await c.env.DB
    .prepare('SELECT id, name, status, updated_at FROM projects WHERE client_id = ? ORDER BY updated_at DESC')
    .bind(c.req.param('id'))
    .all<{ id: string; name: string; status: string; updated_at: string }>();
  const invites = await c.env.DB
    .prepare('SELECT id, expires_at, accepted_at, created_at FROM invitations WHERE email = ? ORDER BY created_at DESC LIMIT 10')
    .bind(u.email)
    .all<{ id: string; expires_at: string; accepted_at: string | null; created_at: string }>();
  return c.json({ client: u, projects: projects.results, invitations: invites.results });
});

// POST /api/clients — create a pending client (NO email sent)
// Admin creates the record; they can send the invite later via POST /api/clients/:id/invite
clientRoutes.post('/', async (c) => {
  const body = await c.req.json().catch(() => null) as { email?: string; name?: string } | null;
  if (!body?.email || !body?.name) return c.json({ error: 'email e nome são obrigatórios' }, 400);
  const email = body.email.toLowerCase().trim();
  const name = body.name.trim();
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>();
  if (existing) return c.json({ error: 'já existe uma conta com este email' }, 409);

  const id = uuid();
  // password_hash is NOT NULL in the schema, so for pending users we store a
  // random 64-char placeholder. It's unguessable + status='pending' blocks login
  // anyway, so this is defense in depth.
  const placeholder = randomPlaceholder();
  await c.env.DB
    .prepare(`INSERT INTO users (id, email, password_hash, name, role, status) VALUES (?, ?, ?, ?, 'client', 'pending')`)
    .bind(id, email, placeholder, name)
    .run();
  const u = await c.env.DB.prepare('SELECT id, email, name, role, status, created_at FROM users WHERE id = ?').bind(id).first<User>();
  return c.json({ client: u }, 201);
});

function randomPlaceholder(): string {
  const arr = new Uint8Array(48);
  crypto.getRandomValues(arr);
  return '!' + Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

// POST /api/clients/:id/invite — send (or re-send) an invitation to an existing client
// Creates an invitation row and emails them. The client becomes 'active'
// when they accept the invite via /aceitar.html and set a password.
clientRoutes.post('/:id/invite', async (c) => {
  const me = c.get('user') as User;
  const client = await c.env.DB
    .prepare('SELECT id, email, name, role, status FROM users WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ id: string; email: string; name: string; role: string; status: string }>();
  if (!client) return c.json({ error: 'cliente não encontrado' }, 404);
  if (client.role !== 'client') return c.json({ error: 'o utilizador indicado não é um cliente' }, 400);
  if (client.status === 'active') return c.json({ error: 'este cliente já está ativo — não precisa de convite' }, 409);

  // refuse if there's already a pending unexpired invite
  const pending = await c.env.DB
    .prepare(`SELECT id, expires_at FROM invitations WHERE email = ? AND accepted_at IS NULL AND expires_at > datetime('now')`)
    .bind(client.email)
    .first<{ id: string; expires_at: string }>();
  if (pending) {
    const remainingHours = Math.max(0, Math.round((new Date(pending.expires_at).getTime() - Date.now()) / 3600000));
    return c.json({
      error: `já existe um convite pendente (expira em ~${remainingHours}h). Use "Reenviar" para o substituir.`,
      existing_invitation_id: pending.id,
    }, 409);
  }

  const res = await createInvitation(c.env, { email: client.email, name: client.name, role: 'client', invitedBy: me.id });
  const body: { invitation: typeof res.invitation; warning?: string } = { invitation: res.invitation };
  if (res.warning) body.warning = res.warning;
  return c.json(body, 201);
});

// DELETE /api/clients/:id — delete a pending client (only if they haven't accepted an invite and have no projects)
clientRoutes.delete('/:id', async (c) => {
  const client = await c.env.DB
    .prepare('SELECT id, role, status FROM users WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ id: string; role: string; status: string }>();
  if (!client) return c.json({ error: 'cliente não encontrado' }, 404);
  if (client.role !== 'client') return c.json({ error: 'o utilizador indicado não é um cliente' }, 400);
  if (client.status === 'active') return c.json({ error: 'não é possível eliminar um cliente ativo — arquive primeiro os projetos' }, 409);
  const projects = await c.env.DB.prepare('SELECT id FROM projects WHERE client_id = ?').bind(c.req.param('id')).first<{ id: string }>();
  if (projects) return c.json({ error: 'este cliente tem projetos — apague os projetos primeiro' }, 409);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM invitations WHERE email = (SELECT email FROM users WHERE id = ?)').bind(c.req.param('id')),
    c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(c.req.param('id')),
  ]);
  return c.json({ ok: true });
});
