// Projects — studio creates, both list (filtered by role)
import { Hono } from 'hono';
import type { AppVariables, Env, Project, User, KanbanColumn } from './types.js';
import { requireAuth, requireRole } from './middleware.js';
import { uuid } from './crypto.js';

export const projectRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

projectRoutes.use('*', requireAuth);

const DEFAULT_COLUMNS = [
  { name: 'A Fazer',  pos: 1024 },
  { name: 'Em Curso', pos: 2048 },
  { name: 'Concluído', pos: 3072 },
];

// GET /api/projects — list projects visible to the user
projectRoutes.get('/', async (c) => {
  const u = c.get('user') as User;
  const sql = u.role === 'studio'
    ? `SELECT p.*, c.name AS client_name, c.email AS client_email
       FROM projects p JOIN users c ON c.id = p.client_id
       ORDER BY p.updated_at DESC LIMIT 200`
    : `SELECT p.*, c.name AS client_name, c.email AS client_email
       FROM projects p JOIN users c ON c.id = p.client_id
       WHERE p.client_id = ?
       ORDER BY p.updated_at DESC LIMIT 200`;
  const stmt = c.env.DB.prepare(sql);
  const rows = u.role === 'studio' ? await stmt.all<Project & { client_name: string; client_email: string }>()
                                     : await stmt.bind(u.id).all<Project & { client_name: string; client_email: string }>();
  return c.json({ projects: rows.results });
});

// GET /api/projects/:id — single project (with columns) — ownership-checked
projectRoutes.get('/:id', async (c) => {
  const u = c.get('user') as User;
  const id = c.req.param('id');
  const proj = await c.env.DB
    .prepare(`SELECT p.*, c.name AS client_name, c.email AS client_email
              FROM projects p JOIN users c ON c.id = p.client_id
              WHERE p.id = ?`)
    .bind(id)
    .first<Project & { client_name: string; client_email: string }>();
  if (!proj) return c.json({ error: 'projeto não encontrado' }, 404);
  if (u.role === 'client' && proj.client_id !== u.id) return c.json({ error: 'forbidden' }, 403);
  const cols = await c.env.DB
    .prepare('SELECT id, project_id, name, position FROM columns WHERE project_id = ? ORDER BY position')
    .bind(id)
    .all<KanbanColumn>();
  return c.json({ project: proj, columns: cols.results });
});

// POST /api/projects — create (studio only)
projectRoutes.post('/', requireRole('studio'), async (c) => {
  const me = c.get('user') as User;
  const body = await c.req.json().catch(() => null) as { client_id?: string; name?: string; description?: string } | null;
  if (!body?.client_id || !body?.name) return c.json({ error: 'cliente e nome são obrigatórios' }, 400);
  const client = await c.env.DB.prepare('SELECT id, role FROM users WHERE id = ?').bind(body.client_id).first<{ id: string; role: string }>();
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

// GET /api/clients — list clients (studio only) for the project-create dropdown
export const clientsList = async (c: { env: Env; json: (data: unknown, status?: number) => Response }): Promise<Response> => {
  const rows = await c.env.DB
    .prepare(`SELECT id, email, name, created_at FROM users WHERE role = 'client' ORDER BY name`)
    .all<User>();
  return c.json({ clients: rows.results });
};
