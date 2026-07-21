// Auth routes — login, me, logout, accept-invite
import { Hono } from 'hono';
import type { AppVariables, Env, User, Invitation } from './types.js';
import { hashPassword, verifyPassword, signJwt, uuid } from './crypto.js';
import { setSessionCookie, clearSessionCookie, requireAuth } from './middleware.js';

export const authRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// POST /api/auth/login
authRoutes.post('/login', async (c) => {
  const body = await c.req.json().catch(() => null) as { email?: string; password?: string } | null;
  if (!body?.email || !body?.password) return c.json({ error: 'email e palavra-passe obrigatórios' }, 400);

  const user = await c.env.DB
    .prepare('SELECT id, email, password_hash, name, role, status, created_at, last_seen_at FROM users WHERE email = ?')
    .bind(body.email.toLowerCase().trim())
    .first<User & { password_hash: string }>();
  if (!user) return c.json({ error: 'credenciais inválidas' }, 401);
  if (user.status !== 'active') return c.json({ error: 'conta pendente de ativação — verifique o seu email para definir a palavra-passe' }, 403);
  const ok = await verifyPassword(body.password, user.password_hash);
  if (!ok) return c.json({ error: 'credenciais inválidas' }, 401);

  const token = await signJwt({ sub: user.id, role: user.role }, c.env.JWT_SECRET);
  setSessionCookie(c.res.headers, token, c.env.ENVIRONMENT === 'production');
  return c.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role, status: user.status, created_at: user.created_at, last_seen_at: user.last_seen_at },
  });
});

// POST /api/auth/logout
authRoutes.post('/logout', async (c) => {
  clearSessionCookie(c.res.headers, c.env.ENVIRONMENT === 'production');
  return c.json({ ok: true });
});

// GET /api/auth/me
authRoutes.get('/me', requireAuth, async (c) => {
  const u = c.get('user');
  return c.json({ user: u });
});

// GET /api/auth/invite/:token — lookup an invitation (public, doesn't reveal the token hash)
authRoutes.get('/invite/:token', async (c) => {
  const inv = await c.env.DB
    .prepare('SELECT email, name, role, expires_at, accepted_at FROM invitations WHERE token = ?')
    .bind(c.req.param('token'))
    .first<Pick<Invitation, 'email' | 'name' | 'role' | 'expires_at' | 'accepted_at'>>();
  if (!inv) return c.json({ error: 'convite não encontrado' }, 404);
  if (inv.accepted_at) return c.json({ error: 'convite já utilizado' }, 410);
  if (new Date(inv.expires_at) < new Date()) return c.json({ error: 'convite expirado' }, 410);
  return c.json({ invitation: inv });
});

// POST /api/auth/accept-invite — set password, consume invitation
// Two flows:
//   (a) the user does NOT exist yet (was created via POST /api/invites for a new person):
//       create the user with status='active' + set password.
//   (b) the user already exists with status='pending' (was created via POST /api/clients):
//       set the password + flip status to 'active'.
authRoutes.post('/accept-invite', async (c) => {
  const body = await c.req.json().catch(() => null) as { token?: string; password?: string; name?: string } | null;
  if (!body?.token || !body?.password) return c.json({ error: 'token e palavra-passe obrigatórios' }, 400);
  if (body.password.length < 8) return c.json({ error: 'a palavra-passe tem de ter pelo menos 8 caracteres' }, 400);

  const inv = await c.env.DB
    .prepare('SELECT id, email, name, role, expires_at, accepted_at FROM invitations WHERE token = ?')
    .bind(body.token)
    .first<Invitation>();
  if (!inv) return c.json({ error: 'convite não encontrado' }, 404);
  if (inv.accepted_at) return c.json({ error: 'convite já utilizado' }, 410);
  if (new Date(inv.expires_at) < new Date()) return c.json({ error: 'convite expirado' }, 410);

  const hash = await hashPassword(body.password);
  const email = inv.email.toLowerCase();
  const name = (body.name || inv.name).trim();
  const existing = await c.env.DB
    .prepare('SELECT id, status, password_hash FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string; status: string; password_hash: string }>();

  let userId: string;
  if (existing) {
    if (existing.status === 'active') return c.json({ error: 'esta conta já está ativa' }, 409);
    // Replace the unguessable placeholder with the real hash; flip status to 'active'.
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE users SET password_hash = ?, name = ?, status = 'active' WHERE id = ?")
        .bind(hash, name, existing.id),
      c.env.DB.prepare('UPDATE invitations SET accepted_at = datetime("now") WHERE id = ?').bind(inv.id),
    ]);
    userId = existing.id;
  } else {
    userId = uuid();
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO users (id, email, password_hash, name, role, status) VALUES (?, ?, ?, ?, ?, 'active')")
        .bind(userId, email, hash, name, inv.role),
      c.env.DB.prepare('UPDATE invitations SET accepted_at = datetime("now") WHERE id = ?').bind(inv.id),
    ]);
  }

  const token = await signJwt({ sub: userId, role: inv.role }, c.env.JWT_SECRET);
  setSessionCookie(c.res.headers, token, c.env.ENVIRONMENT === 'production');
  return c.json({ user: { id: userId, email, name, role: inv.role, status: 'active' } });
});
