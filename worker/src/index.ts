// Diernus Portal — Cloudflare Worker entry
// Mounts: /api/auth/* /api/projects/* /api/invites/* /api/clients
// (Cards / Comments / Files come in Phase 2+.)
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppVariables, Env } from './types.js';
import { authRoutes } from './auth.js';
import { projectRoutes, clientRoutes } from './projects.js';
import { inviteRoutes } from './invites.js';
import { cardRoutes } from './cards.js';
import { commentRoutes } from './comments.js';
import { fileRoutes } from './files.js';
import { teamRoutes } from './team.js';
import { timeRoutes } from './time.js';
import { financeRoutes } from './finance.js';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// CORS — allow the Pages frontend to call the Worker.
// In production the frontend lives on portal.diernus.com and we don't
// actually need CORS (same origin). During dev (Pages on .pages.dev,
// worker on .workers.dev) we allow the Pages origin.
app.use('*', async (c, next) => {
  const allowed =
    c.env.ENVIRONMENT === 'production'
      ? [c.env.PUBLIC_URL, 'https://diernus-portal.pages.dev', 'https://diernus.pages.dev']
      : ['*'];
  const corsMiddleware = cors({
    origin: (origin) => allowed.includes('*') || allowed.includes(origin) ? origin : allowed[0],
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['content-type'],
    exposeHeaders: ['content-type'],
    maxAge: 86400,
  });
  return corsMiddleware(c, next);
});

app.get('/api/health', (c) => c.json({ ok: true, env: c.env.ENVIRONMENT, ts: new Date().toISOString() }));

app.route('/api/auth', authRoutes);
app.route('/api/projects', projectRoutes);
app.route('/api/invites', inviteRoutes);
app.route('/api/team', teamRoutes);
app.route('/api/clients', clientRoutes);
app.route('/api/finance', financeRoutes);
app.route('/api', cardRoutes);       // /api/projects/:id/board, /api/cards/:id, etc.
app.route('/api', commentRoutes);    // /api/cards/:cardId/comments
app.route('/api', fileRoutes);       // /api/projects/:id/files, /api/files/:id
app.route('/api', timeRoutes);       // /api/cards/:id/time-entries, /api/time-entries/:id

app.notFound((c) => c.json({ error: 'not found', path: c.req.path }, 404));
app.onError((err, c) => {
  console.error('Worker error:', err);
  return c.json({ error: 'internal error', message: (err as Error).message }, 500);
});

export default app;
