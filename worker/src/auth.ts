// Auth routes — login, me, logout, accept-invite, Google OAuth
import { Hono } from 'hono';
import type { AppVariables, Env, User, Invitation } from './types.js';
import { hashPassword, verifyPassword, signJwt, uuid, randomToken } from './crypto.js';
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

// =========================================================================
// Google OAuth (SSO)
// =========================================================================
//
// Flow:
//   1. User clicks "Continuar com Google" on /login.html
//   2. Browser navigates to /api/auth/google/start?returnTo=...
//      → we generate a CSRF state token, store {returnTo} in KV keyed by it
//        (5min TTL), and 302 to Google's authorization endpoint.
//   3. Google handles consent, then 302s to /api/auth/google/callback?code=...&state=...
//   4. We verify the state against KV, exchange the code for tokens at
//      https://oauth2.googleapis.com/token, then fetch the user profile at
//      https://www.googleapis.com/oauth2/v3/userinfo.
//   5. Upsert the user by email:
//        - existing 'active' user → log them in (role unchanged)
//        - existing 'pending' user (invited but never accepted) → activate
//        - new email             → create as 'client' (admins can only be
//                                  created via the invite flow, not via signup)
//   6. Issue our JWT session cookie and redirect to returnTo, or the role-
//      appropriate landing page.
//
// Both routes are public (no requireAuth). The state token in KV is the
// only thing preventing CSRF; we never trust a callback that doesn't
// present a valid state we issued.
//
// To enable: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET via
// `wrangler secret put`. Without them, the routes return a clear 500 error.

// GET /api/auth/google/start
authRoutes.get('/google/start', async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID) {
    return c.text('Google SSO não está configurado — falta GOOGLE_CLIENT_ID', 500);
  }
  const state = randomToken(24);
  const returnTo = c.req.query('returnTo') || '';
  // 5-minute TTL is plenty — the round-trip is seconds, not minutes.
  await c.env.SESSIONS.put(
    `google_oauth:${state}`,
    JSON.stringify({ returnTo: returnTo.slice(0, 500) }), // cap length, no abuse
    { expirationTtl: 600 }
  );
  // The redirect_uri MUST match exactly what's registered in Google Cloud.
  // We derive it from the request's own origin (the Worker), not from
  // PUBLIC_URL — because PUBLIC_URL points to the Pages frontend for
  // emails/CORS, while the API lives on the Worker subdomain.
  const redirectUri = new URL(c.req.url).origin + '/api/auth/google/callback';
  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    // 'online' = we get an access_token but no refresh_token. Fine for SSO
    // (we only need the profile once at sign-in).
    access_type: 'online',
    // 'select_account' = always show the account picker, even if the user
    // is already signed in to Google. This is what most production apps do
    // — never silently sign in as a stale account.
    prompt: 'select_account',
  });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

// GET /api/auth/google/callback
authRoutes.get('/google/callback', async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return c.text('Google SSO não está configurado — falta GOOGLE_CLIENT_ID ou GOOGLE_CLIENT_SECRET', 500);
  }
  const code  = c.req.query('code');
  const state = c.req.query('state');
  const err   = c.req.query('error');
  if (err) return c.text(`Google recusou o pedido: ${err}`, 400);
  if (!code || !state) return c.text('faltam parâmetros code/state', 400);

  // ---- 1. Verify state (CSRF) ----
  const stateData = await c.env.SESSIONS.get(`google_oauth:${state}`);
  if (!stateData) return c.text('estado inválido ou expirado — reinicie o início de sessão', 400);
  // Consume the state immediately so it can't be replayed.
  await c.env.SESSIONS.delete(`google_oauth:${state}`);
  let returnTo = '';
  try { returnTo = (JSON.parse(stateData) as { returnTo?: string }).returnTo || ''; } catch {}

  // ---- 2. Exchange code for tokens ----
  // Same redirect_uri as the start — MUST match exactly.
  const redirectUri = new URL(c.req.url).origin + '/api/auth/google/callback';
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    console.error('Google token exchange failed:', tokenRes.status, body);
    return c.text('falha ao trocar o código por tokens — verifique o Client Secret', 500);
  }
  const tokens = await tokenRes.json() as { access_token?: string; id_token?: string };
  if (!tokens.access_token) return c.text('Google não devolveu access_token', 500);

  // ---- 3. Fetch user profile ----
  const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!profileRes.ok) return c.text('falha ao obter perfil do Google', 500);
  const profile = await profileRes.json() as {
    sub: string;
    email: string;
    email_verified?: boolean | string; // Google sometimes returns "true" as a string
    name?: string;
    picture?: string;
  };
  if (!profile.email) return c.text('Google não devolveu email', 400);
  if (profile.email_verified === false || profile.email_verified === 'false') {
    return c.text('o email do Google não está verificado', 403);
  }

  const email = profile.email.toLowerCase().trim();
  const name  = (profile.name || email.split('@')[0]).slice(0, 200);

  // ---- 4. Upsert user by email ----
  const existing = await c.env.DB
    .prepare('SELECT id, email, name, role, status FROM users WHERE email = ?')
    .bind(email)
    .first<User & { status: string }>();

  let userId: string;
  let userRole: 'admin' | 'team' | 'client';

  if (existing) {
    if (existing.status === 'suspended') {
      return c.text('esta conta está suspensa — contacte o estúdio', 403);
    }
    userId = existing.id;
    userRole = existing.role as 'admin' | 'team' | 'client';
    // If they were 'pending' (invited but never set a password), activate
    // them now. The studio already approved them by sending the invite.
    if (existing.status === 'pending') {
      await c.env.DB
        .prepare("UPDATE users SET status = 'active' WHERE id = ?")
        .bind(userId)
        .run();
    }
  } else {
    // New email — create as 'client' (admins must be invited, not self-signup).
    // password_hash stays as a random unguessable placeholder; the user can
    // log in via Google from now on. If they ever need a password, the
    // studio can set one via D1 (out of band).
    userId = uuid();
    const placeholder = '!google-' + randomToken(48);
    await c.env.DB
      .prepare("INSERT INTO users (id, email, password_hash, name, role, status) VALUES (?, ?, ?, ?, 'client', 'active')")
      .bind(userId, email, placeholder, name)
      .run();
    userRole = 'client';
  }

  // ---- 5. Issue session cookie + redirect ----
  const jwt = await signJwt({ sub: userId, role: userRole }, c.env.JWT_SECRET);
  setSessionCookie(c.res.headers, jwt, c.env.ENVIRONMENT === 'production');

  // The OAuth callback runs on the Worker, not on the Pages frontend.
  // So a relative redirect like "/portal/" would 404 on the Worker.
  // We MUST build an absolute URL pointing to the frontend (PUBLIC_URL).
  //
  // returnTo validation: only accept paths starting with a single slash
  // (defense against open-redirect to other domains).
  const frontend = c.env.PUBLIC_URL.replace(/\/$/, ''); // strip trailing /
  let dest = '';
  if (returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//')) {
    dest = frontend + returnTo;
  }
  if (!dest) {
    dest = frontend + (userRole === 'client' ? '/portal/' : '/admin/');
  }
  return c.redirect(dest);
});
