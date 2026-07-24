// Team — active studio members (the assignee picker source of truth)
import { Hono } from 'hono';
import type { AppVariables, Env } from './types.js';
import { requireAuth, requireStudio } from './middleware.js';

export const teamRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();
teamRoutes.use('*', requireAuth, requireStudio);

// GET /api/team/members — list active studio members (assignable)
// Studio members are admin + team (both have assignable work).
teamRoutes.get('/members', async (c) => {
  const rows = await c.env.DB
    .prepare(`SELECT id, email, name, role, last_seen_at
              FROM users
              WHERE role IN ('admin', 'team') AND status = 'active'
              ORDER BY name`)
    .all<{ id: string; email: string; name: string; role: 'admin' | 'team'; last_seen_at: string | null }>();
  return c.json({ members: rows.results });
});
