// Team — active studio members (the assignee picker source of truth)
// + the role-change endpoint (admin-only, with last-admin guard).
import { Hono } from 'hono';
import type { AppVariables, Env, User } from './types.js';
import { requireAuth, requireAdmin, requireStudio } from './middleware.js';

export const teamRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();
// Apply requireAuth to ALL routes (must run before any role check that reads c.get('user'))
teamRoutes.use('*', requireAuth);

// GET /api/team/members — assignable (any studio member)
teamRoutes.get('/members', requireStudio, async (c) => {
  const rows = await c.env.DB
    .prepare(`SELECT id, email, name, role, last_seen_at
              FROM users
              WHERE role IN ('admin', 'team') AND status = 'active'
              ORDER BY name`)
    .all<{ id: string; email: string; name: string; role: 'admin' | 'team'; last_seen_at: string | null }>();
  return c.json({ members: rows.results });
});

// PATCH /api/team/members/:id/role — change a team member's role (admin only)
// Body: { role: 'admin' | 'team' }
//
// Last-admin guard: refuses to demote the last remaining admin with
// a 409 + a clear PT error message. This is the only "I locked myself
// out of the studio" trap in the system.
teamRoutes.patch('/members/:id/role', requireAdmin, async (c) => {
  const me = c.get('user') as User;
  const targetId = c.req.param('id');
  const body = await c.req.json().catch(() => null) as { role?: 'admin' | 'team' } | null;
  if (!body?.role || (body.role !== 'admin' && body.role !== 'team')) {
    return c.json({ error: 'papel inválido (use "admin" ou "team")' }, 400);
  }

  // Refuse to change your own role (prevents accidental self-lockout via the UI)
  if (targetId === me.id) {
    return c.json({ error: 'não pode alterar o seu próprio papel — peça a outro admin' }, 403);
  }

  // Load the target
  const target = await c.env.DB
    .prepare('SELECT id, role, status FROM users WHERE id = ?')
    .bind(targetId)
    .first<{ id: string; role: 'admin' | 'team' | 'client'; status: string }>();
  if (!target) return c.json({ error: 'utilizador não encontrado' }, 404);
  if (target.role === 'client') {
    return c.json({ error: 'este utilizador é um cliente, não um membro da equipa' }, 400);
  }
  if (target.status !== 'active') {
    return c.json({ error: 'só é possível alterar o papel de membros ativos' }, 400);
  }
  if (target.role === body.role) {
    return c.json({ error: `já é ${body.role}, nada a fazer` }, 400);
  }

  // LAST-ADMIN GUARD: refusing to demote the only remaining admin
  if (target.role === 'admin' && body.role === 'team') {
    const adminCount = await c.env.DB
      .prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'`)
      .first<{ n: number }>();
    if (adminCount && adminCount.n <= 1) {
      return c.json({
        error: 'não é possível despromover o último admin — promova outro membro a admin primeiro',
      }, 409);
    }
  }

  await c.env.DB
    .prepare(`UPDATE users SET role = ? WHERE id = ?`)
    .bind(body.role, targetId)
    .run();
  const updated = await c.env.DB
    .prepare('SELECT id, email, name, role, status FROM users WHERE id = ?')
    .bind(targetId)
    .first<{ id: string; email: string; name: string; role: 'admin' | 'team'; status: string }>();
  return c.json({ member: updated });
});
