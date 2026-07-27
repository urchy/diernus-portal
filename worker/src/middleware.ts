// Auth middleware — verifies the JWT cookie and attaches the user to the context.
import type { MiddlewareHandler } from 'hono';
import type { AppVariables, Env, User } from './types.js';
import { isStudio, isAdmin } from './types.js';
import { verifyJwt } from './crypto.js';

const COOKIE_NAME = 'diernus_session';

export function setSessionCookie(headers: Headers, token: string, secure: boolean): void {
  // SameSite=None is required so the cookie is sent on cross-origin fetch
  // from the Pages frontend (diernus-portal.pages.dev) to this Worker
  // (diernus-portal-api.workers.dev). SameSite=None requires Secure=true.
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=None',
    'Max-Age=604800', // 7 days
  ];
  if (secure || parts.includes('SameSite=None')) parts.push('Secure');
  headers.append('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(headers: Headers, secure: boolean): void {
  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=None',
    'Max-Age=0',
  ];
  if (secure || parts.includes('SameSite=None')) parts.push('Secure');
  headers.append('Set-Cookie', parts.join('; '));
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie') || '';
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === name) return decodeURIComponent(v);
  }
  return null;
}

export const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> = async (c, next) => {
  const token = readCookie(c.req.raw, COOKIE_NAME);
  if (!token) return c.json({ error: 'unauthorized' }, 401);
  const payload = await verifyJwt(token, c.env.JWT_SECRET);
  if (!payload) return c.json({ error: 'unauthorized' }, 401);
  const user = await c.env.DB
    .prepare('SELECT id, email, name, role, status, created_at, last_seen_at, password_changed_at FROM users WHERE id = ?')
    .bind(payload.sub)
    .first<User>();
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  // Invalidate JWTs that were issued before the user's last password change.
  // This is our "log out other devices" mechanism — we don't have
  // server-side session storage, but we can compare the JWT's iat to the
  // password_changed_at column and reject if the token is older.
  if (user.password_changed_at) {
    // SQLite's datetime('now') returns 'YYYY-MM-DD HH:MM:SS' in UTC, no 'Z'.
    // Append Z + swap the space for T so Date.parse() reads it as UTC.
    const changedMs = Date.parse(user.password_changed_at.replace(' ', 'T') + 'Z');
    const iatMs = payload.iat * 1000;
    if (Number.isFinite(changedMs) && changedMs > iatMs) {
      return c.json({ error: 'sessão expirada — a sua palavra-passe foi alterada noutro dispositivo. Inicie sessão novamente.' }, 401);
    }
  }
  c.set('user', user);
  // touch last_seen_at (best-effort, no await)
  c.env.DB.prepare('UPDATE users SET last_seen_at = datetime("now") WHERE id = ?').bind(user.id).run().catch(() => {});
  return next();
};

// Role guards — the 3-role system:
//   requireAuth    — must be logged in
//   requireStudio  — admin OR team (replaces the old requireRole('studio'))
//   requireAdmin   — admin only (e.g. finance)
//   requireRole('client') — kept for client-only paths (rare; usually we do
//                          a per-resource ownership check instead)
export const requireRole = (role: 'client'): MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> =>
  async (c, next) => {
    const u = c.get('user');
    if (!u || u.role !== role) return c.json({ error: 'forbidden' }, 403);
    return next();
  };

export const requireStudio: MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> =
  async (c, next) => {
    const u = c.get('user');
    if (!u || !isStudio(u.role)) return c.json({ error: 'forbidden' }, 403);
    return next();
  };

export const requireAdmin: MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> =
  async (c, next) => {
    const u = c.get('user');
    if (!u || !isAdmin(u.role)) return c.json({ error: 'forbidden' }, 403);
    return next();
  };
