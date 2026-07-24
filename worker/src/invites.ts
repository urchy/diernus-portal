// Invites — studio can invite both:
//   (a) NEW people (not in the system yet) — POST /api/invites
//       Used for inviting new team members; the system creates the user
//       when they accept the invite (status=active).
//   (b) EXISTING clients (created via POST /api/clients) — POST /api/clients/:id/invite
//       Used for re-sending an invite; the system activates the existing
//       pending user when they accept.
import { Hono } from 'hono';
import type { AppVariables, Env, User, Invitation } from './types.js';
import { requireAuth, requireStudio } from './middleware.js';
import { randomToken, uuid } from './crypto.js';
import { sendEmail, invitationEmail } from './resend.js';

export const inviteRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// All invite routes are studio-only (admin + team)
inviteRoutes.use('*', requireAuth, requireStudio);

// GET /api/invites — list recent invitations
inviteRoutes.get('/', async (c) => {
  const rows = await c.env.DB
    .prepare(`SELECT id, email, name, role, invited_by, expires_at, accepted_at, created_at
              FROM invitations ORDER BY created_at DESC LIMIT 100`)
    .all<Invitation>();
  return c.json({ invitations: rows.results });
});

// POST /api/invites — invite a NEW person (not yet in the system)
// For existing clients, use POST /api/clients/:id/invite instead.
inviteRoutes.post('/', async (c) => {
  const body = await c.req.json().catch(() => null) as { email?: string; name?: string; role?: 'admin' | 'team' | 'client' } | null;
  if (!body?.email || !body?.name || !body?.role) {
    return c.json({ error: 'email, nome e papel são obrigatórios' }, 400);
  }
  if (body.role !== 'admin' && body.role !== 'team' && body.role !== 'client') {
    return c.json({ error: 'papel inválido' }, 400);
  }
  const email = body.email.toLowerCase().trim();
  const me = c.get('user') as User;

  // Only admins can create other admins. Team members can only invite
  // other team members (or clients, but clients come through /api/clients).
  if (body.role === 'admin' && me.role !== 'admin') {
    return c.json({ error: 'só um admin pode convidar outro admin' }, 403);
  }

  // Refuse if user already exists
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>();
  if (existing) return c.json({ error: 'já existe uma conta com este email — para reenviar o convite, abra o cliente e use "Reenviar convite"' }, 409);

  // Refuse if there's a pending unexpired invite for the same email
  const pending = await c.env.DB
    .prepare(`SELECT id FROM invitations WHERE email = ? AND accepted_at IS NULL AND expires_at > datetime('now')`)
    .bind(email)
    .first<{ id: string }>();
  if (pending) return c.json({ error: 'já existe um convite pendente para este email' }, 409);

  const inv = await createInvitation(c.env, { email, name: body.name.trim(), role: body.role, invitedBy: me.id });

  return c.json({ invitation: inv.invitation }, 201);
});

// Helper: create an invitation row + send the email. Returns the invitation payload
// (with accept_url embedded if email failed).
export async function createInvitation(
  env: Env,
  args: { email: string; name: string; role: 'admin' | 'team' | 'client'; invitedBy: string },
): Promise<{ invitation: { id: string; email: string; name: string; role: 'admin' | 'team' | 'client'; expires_at: string; accept_url?: string }; warning?: string }> {
  const id = uuid();
  const token = randomToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  await env.DB
    .prepare(`INSERT INTO invitations (id, email, name, role, token, invited_by, expires_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, args.email, args.name, args.role, token, args.invitedBy, expiresAt)
    .run();

  // Look up inviter name (we don't have it in args; pass it through differently)
  const inviter = await env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(args.invitedBy).first<{ name: string }>();

  const tpl = invitationEmail({
    name: args.name,
    email: args.email,
    role: args.role,
    token,
    inviterName: inviter?.name || 'Diernus',
    publicUrl: env.PUBLIC_URL,
  });
  try {
    await sendEmail(env, { to: args.email, subject: tpl.subject, html: tpl.html, text: tpl.text });
    return { invitation: { id, email: args.email, name: args.name, role: args.role, expires_at: expiresAt } };
  } catch (e) {
    return {
      invitation: { id, email: args.email, name: args.name, role: args.role, expires_at: expiresAt, accept_url: `${env.PUBLIC_URL}/aceitar.html?token=${token}` },
      warning: `email falhou: ${(e as Error).message}`,
    };
  }
}
