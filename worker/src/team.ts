// Team — active studio members (the assignee picker source of truth)
import { Hono } from 'hono';
import type { AppVariables, Env } from './types.js';
import { requireAuth, requireRole } from './middleware.js';

export const teamRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();
teamRoutes.use('*', requireAuth, requireRole('studio'));

// GET /api/team/members — list active studio members (assignable)
teamRoutes.get('/members', async (c) => {
  const rows = await c.env.DB
    .prepare(`SELECT id, email, name, last_seen_at
              FROM users
              WHERE role = 'studio' AND status = 'active'
              ORDER BY name`)
    .all<{ id: string; email: string; name: string; last_seen_at: string | null }>();
  return c.json({ members: rows.results });
});
