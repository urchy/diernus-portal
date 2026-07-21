// Invites — studio can invite both clients and team members
import { Hono } from 'hono';
import type { AppVariables, Env, User, Invitation } from './types.js';
import { requireAuth, requireRole } from './middleware.js';
import { randomToken, uuid } from './crypto.js';
import { sendEmail, invitationEmail } from './resend.js';

export const inviteRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// All invite routes are studio-only
inviteRoutes.use('*', requireAuth, requireRole('studio'));

// GET /api/invites — list recent invitations
inviteRoutes.get('/', async (c) => {
  const rows = await c.env.DB
    .prepare(`SELECT id, email, name, role, invited_by, expires_at, accepted_at, created_at
              FROM invitations ORDER BY created_at DESC LIMIT 100`)
    .all<Invitation>();
  return c.json({ invitations: rows.results });
});

// POST /api/invites — create an invitation + email it
inviteRoutes.post('/', async (c) => {
  const body = await c.req.json().catch(() => null) as { email?: string; name?: string; role?: 'studio' | 'client' } | null;
  if (!body?.email || !body?.name || !body?.role) {
    return c.json({ error: 'email, nome e papel são obrigatórios' }, 400);
  }
  if (body.role !== 'studio' && body.role !== 'client') {
    return c.json({ error: 'papel inválido' }, 400);
  }
  const email = body.email.toLowerCase().trim();
  const me = c.get('user') as User;

  // Refuse if email already used
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>();
  if (existing) return c.json({ error: 'já existe uma conta com este email' }, 409);

  // Refuse if there's a pending unexpired invite for the same email
  const pending = await c.env.DB
    .prepare(`SELECT id FROM invitations WHERE email = ? AND accepted_at IS NULL AND expires_at > datetime('now')`)
    .bind(email)
    .first<{ id: string }>();
  if (pending) return c.json({ error: 'já existe um convite pendente para este email' }, 409);

  const id = uuid();
  const token = randomToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  await c.env.DB
    .prepare(`INSERT INTO invitations (id, email, name, role, token, invited_by, expires_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, email, body.name.trim(), body.role, token, me.id, expiresAt)
    .run();

  const tpl = invitationEmail({
    name: body.name.trim(),
    email,
    role: body.role,
    token,
    inviterName: me.name,
    publicUrl: c.env.PUBLIC_URL,
  });
  try {
    await sendEmail(c.env, { to: email, subject: tpl.subject, html: tpl.html, text: tpl.text });
  } catch (e) {
    return c.json({
      invitation: { id, email, name: body.name, role: body.role, expires_at: expiresAt, accept_url: `${c.env.PUBLIC_URL}/aceitar.html?token=${token}` },
      warning: `convite criado mas email falhou: ${(e as Error).message}`,
    }, 201);
  }
  return c.json({
    invitation: { id, email, name: body.name, role: body.role, expires_at: expiresAt },
  }, 201);
});
