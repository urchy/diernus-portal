// Auth middleware — verifies the JWT cookie and attaches the user to the context.
import type { MiddlewareHandler } from 'hono';
import type { AppVariables, Env, User } from './types.js';
import { verifyJwt } from './crypto.js';

const COOKIE_NAME = 'diernus_session';

export function setSessionCookie(headers: Headers, token: string, secure: boolean): void {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=604800', // 7 days
  ];
  if (secure) parts.push('Secure');
  headers.append('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(headers: Headers, secure: boolean): void {
  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
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
    .prepare('SELECT id, email, name, role, created_at, last_seen_at FROM users WHERE id = ?')
    .bind(payload.sub)
    .first<User>();
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  c.set('user', user);
  // touch last_seen_at (best-effort, no await)
  c.env.DB.prepare('UPDATE users SET last_seen_at = datetime("now") WHERE id = ?').bind(user.id).run().catch(() => {});
  return next();
};

export const requireRole = (role: 'studio' | 'client'): MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> =>
  async (c, next) => {
    const u = c.get('user');
    if (!u || u.role !== role) return c.json({ error: 'forbidden' }, 403);
    return next();
  };
