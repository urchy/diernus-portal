// Invoices — stub module that ships the `payment_due` email integration
// point. There is no real invoicing module yet (see docs/email-notifications.md
// item #10: "LATER — no payment system yet"), so for now this route just
// exposes:
//   - POST /api/invoices/test  (admin-only) — fire a sample payment_due
//     email to verify the template looks right end-to-end. Useful for
//     design QA and the upcoming CI visual-diff pipeline.
//   - GET  /api/invoices/preview  (admin-only) — return the rendered
//     {subject, html, text} for a given (project, amount, dueDate) so
//     we can preview without sending.
//
// When the real invoicing module lands, replace POST /api/invoices/test
// with the real "create an invoice" handler — and call
// `sendPaymentDueEmail()` whenever a new invoice becomes payable.
import { Hono } from 'hono';
import type { AppVariables, Env, User } from './types.js';
import { requireAuth, requireAdmin } from './middleware.js';
import { sendEmail, paymentDueEmail } from './resend.js';

export const invoiceRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();
invoiceRoutes.use('*', requireAuth, requireAdmin);

// POST /api/invoices/test — fire a sample payment_due email.
// Body: { projectId, amount (e.g. "€ 1.250,00"), dueDate (e.g. "2026-08-15") }
// Looks up the project's client (must be active) and sends the email to
// the client's address. Returns the render so the UI can preview.
invoiceRoutes.post('/test', async (c) => {
  const me = c.get('user') as User;
  const body = await c.req.json().catch(() => null) as {
    projectId?: string;
    amount?: string;
    dueDate?: string;
  } | null;
  if (!body?.projectId || !body.amount || !body.dueDate) {
    return c.json({ error: 'projectId, amount e dueDate são obrigatórios' }, 400);
  }

  const project = await c.env.DB
    .prepare(`SELECT p.id, p.name, p.client_id, u.name AS client_name, u.email AS client_email
              FROM projects p JOIN users u ON u.id = p.client_id
              WHERE p.id = ?`)
    .bind(body.projectId)
    .first<{ id: string; name: string; client_id: string; client_name: string; client_email: string }>();
  if (!project) return c.json({ error: 'projeto não encontrado' }, 404);

  const invoiceNumber = `INV-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${project.id.slice(0, 4).toUpperCase()}`;
  const payUrl = `${c.env.PUBLIC_URL.replace(/\/$/, '')}/portal/projeto.html?id=${project.id}&pay=1`;

  const tpl = paymentDueEmail({
    clientName: project.client_name,
    projectName: project.name,
    invoiceNumber,
    amount: body.amount,
    dueDate: body.dueDate,
    payUrl,
  });

  // Fire-and-forget (never block the response on Resend).
  c.executionCtx.waitUntil(
    sendEmail(c.env, { to: project.client_email, subject: tpl.subject, html: tpl.html, text: tpl.text })
      .catch(err => console.error(`[invoices.ts] test payment_due to ${project.client_email} failed:`, err.message))
  );

  return c.json({
    sent_to: project.client_email,
    sent_by: me.email,
    render: tpl,
  });
});

// GET /api/invoices/preview — return the rendered template without sending.
// Useful for design review / CI visual-diff. Query params: projectId,
// amount, dueDate.
invoiceRoutes.get('/preview', async (c) => {
  const projectId = c.req.query('projectId');
  const amount    = c.req.query('amount');
  const dueDate   = c.req.query('dueDate');
  if (!projectId || !amount || !dueDate) {
    return c.json({ error: 'projectId, amount e dueDate são obrigatórios' }, 400);
  }
  const project = await c.env.DB
    .prepare(`SELECT p.name, u.name AS client_name FROM projects p JOIN users u ON u.id = p.client_id WHERE p.id = ?`)
    .bind(projectId)
    .first<{ name: string; client_name: string }>();
  if (!project) return c.json({ error: 'projeto não encontrado' }, 404);

  const invoiceNumber = `INV-PREVIEW`;
  const payUrl = `${c.env.PUBLIC_URL.replace(/\/$/, '')}/portal/projeto.html?id=${projectId}&pay=1`;
  const tpl = paymentDueEmail({
    clientName: project.client_name,
    projectName: project.name,
    invoiceNumber, amount, dueDate, payUrl,
  });
  return c.json({ render: tpl });
});
