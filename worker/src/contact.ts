// Contact form endpoint — receives submissions from diernus.com (the marketing
// site) and from any embedded form in the future. Sends a Resend email to the
// studio inbox + a confirmation email to the sender. CORS is handled at the
// index.ts level (we accept POST from https://diernus.com).
//
// Rate limit: 5 submissions per IP per hour. We use a simple in-memory sliding
// window — fine for the volume diernus.com gets. If the worker is ever
// scaled across regions, swap to KV or a Cloudflare Rate Limiting rule.
//
// Always returns 200 with a generic success body — no enumeration of whether
// an email is valid. Server-side validation errors also return 200 (we treat
// them as dropped submissions, since the alternative is letting spammers probe
// for validation rules).
import { Hono } from 'hono';
import type { AppVariables, Env } from './types.js';
import { sendEmail } from './resend.js';

export const contactRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// In-memory rate-limit store. Resets on worker cold start, which is fine —
// long-tail IP entries will time out within an hour anyway.
const RATE_WINDOW_MS = 60 * 60 * 1000;  // 1 hour
const RATE_MAX       = 5;              // per IP
const ipBuckets = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (ipBuckets.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) {
    ipBuckets.set(ip, arr);
    return true;
  }
  arr.push(now);
  ipBuckets.set(ip, arr);
  return false;
}

// Minimal RFC-5322-lite check: non-empty, has @, has a dot in the domain,
// no whitespace, max 254 chars (overall email length limit). The mail server
// does the real validation on delivery. This is just to catch obvious typos
// at the edge so the form can show a friendly error.
function looksLikeEmail(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const v = s.trim();
  if (!v || v.length > 254 || /\s/.test(v)) return false;
  const at = v.indexOf('@');
  if (at < 1 || at === v.length - 1) return false;
  const domain = v.slice(at + 1);
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return false;
  return true;
}

// Strip control chars + collapse whitespace. Cheap XSS guard for the parts
// we put into the email body.
function clean(s: string, max: number): string {
  // strip ASCII control chars (0x00-0x1F, 0x7F) except newline
  const noCtrl = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return noCtrl.trim().slice(0, max);
}

contactRoutes.post('/', async (c) => {
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'unknown';

  if (rateLimited(ip)) {
    // Silent drop — same response shape, no leak that we're rate-limiting.
    return c.json({ ok: true });
  }

  let body: any;
  try { body = await c.req.json(); } catch { body = null; }
  if (!body || typeof body !== 'object') {
    return c.json({ ok: true });  // no leak
  }

  // Validate. Drop silently on bad input (same 200 response).
  const email   = clean(String(body.email || ''), 254);
  const name    = clean(String(body.name  || ''), 100);
  const message = clean(String(body.message|| ''), 2000);
  const source  = clean(String(body.source || 'diernus.com'), 100);

  if (!looksLikeEmail(email)) {
    return c.json({ ok: true });
  }

  // Build the studio notification email
  const subject = `[Diernus] Novo contacto: ${name || email}`;
  const studioEmail = c.env.EMAIL_FROM?.includes('ola@') ? 'ola@diernus.com' : (c.env.EMAIL_FROM || 'ola@diernus.com');
  const text = [
    `Novo contacto via ${source}`,
    '',
    `De:    ${name || '(sem nome)'} <${email}>`,
    `IP:    ${ip}`,
    `Data:  ${new Date().toISOString()}`,
    '',
    'Mensagem:',
    message || '(sem mensagem)',
    '',
    '— Diernus Portal contact form',
  ].join('\n');

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:1.4rem;color:#23211C">
      <p style="font-size:.72rem;letter-spacing:.18em;text-transform:uppercase;color:#B5651D;margin:0 0 .8rem">Novo contacto via ${escapeHtml(source)}</p>
      <h2 style="font-size:1.4rem;margin:0 0 1rem;color:#1F1D17">${escapeHtml(name || email)} quer falar com vocês</h2>
      <table style="width:100%;border-collapse:collapse;margin:0 0 1.2rem">
        <tr><td style="padding:.4rem .6rem .4rem 0;font-size:.7rem;letter-spacing:.16em;text-transform:uppercase;color:#1F1D1760">Email</td>
            <td style="padding:.4rem 0"><a href="mailto:${escapeHtml(email)}" style="color:#2C49C7">${escapeHtml(email)}</a></td></tr>
        <tr><td style="padding:.4rem .6rem .4rem 0;font-size:.7rem;letter-spacing:.16em;text-transform:uppercase;color:#1F1D1760">IP</td>
            <td style="padding:.4rem 0;font-family:monospace;font-size:.85rem">${escapeHtml(ip)}</td></tr>
        <tr><td style="padding:.4rem .6rem .4rem 0;font-size:.7rem;letter-spacing:.16em;text-transform:uppercase;color:#1F1D1760">Data</td>
            <td style="padding:.4rem 0;font-family:monospace;font-size:.85rem">${escapeHtml(new Date().toISOString())}</td></tr>
      </table>
      <div style="background:#EDEAE3;border-left:3px solid #B5651D;padding:1rem 1.2rem;border-radius:4px;white-space:pre-wrap;font-size:.95rem;line-height:1.55">${escapeHtml(message || '(sem mensagem)')}</div>
      <p style="margin:1.2rem 0 0;font-size:.75rem;color:#1F1D1760">Responde directamente a este email — vai para o endereço do cliente.</p>
    </div>`;

  // Fire-and-forget the studio email. We don't want a slow Resend call to
  // delay the 200 response to the user (and we don't want them to know if
  // their email actually reached us).
  c.executionCtx.waitUntil(
    sendEmail(c.env, {
      to: studioEmail,
      subject,
      text,
      html,
      replyTo: email,  // so the studio can hit Reply and it goes to the sender
    }).catch(err => console.error('contact: studio email failed', err))
  );

  // Optional: send a brief confirmation to the sender. Kept short and warm.
  // Skip if their email looks like a no-reply / role address.
  const isRoleAddress = /^(no-?reply|postmaster|abuse|admin)@/i.test(email);
  if (!isRoleAddress) {
    c.executionCtx.waitUntil(
      sendEmail(c.env, {
        to: email,
        subject: 'Recebemos a sua mensagem · Diernus',
        text: `Olá${name ? ' ' + name.split(' ')[0] : ''},

Obrigado por escrever. Recebemos a sua mensagem e respondemos dentro de 24h úteis — normalmente antes.

Se entretanto precisar de enviar plantas, referências ou um caderno de encargos, pode responder diretamente a este email.

— Equipa Diernus
estúdio de desenho de mobiliário · Portugal`,
        html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:1.4rem;color:#23211C;line-height:1.55">
          <p style="font-size:.72rem;letter-spacing:.18em;text-transform:uppercase;color:#B5651D;margin:0 0 .8rem">Diernus</p>
          <h2 style="font-size:1.3rem;margin:0 0 1rem">Olá${name ? ', ' + escapeHtml(name.split(' ')[0]) : ''}.</h2>
          <p>Obrigado por escrever. Recebemos a sua mensagem e respondemos dentro de <b>24h úteis</b> — normalmente antes.</p>
          <p>Se entretanto precisar de enviar plantas, referências ou um caderno de encargos, pode responder directamente a este email.</p>
          <p style="margin-top:1.4rem">— Equipa Diernus<br><span style="color:#1F1D1760;font-size:.85rem">estúdio de desenho de mobiliário · Portugal</span></p>
        </div>`,
      }).catch(err => console.error('contact: confirmation email failed', err))
    );
  }

  return c.json({ ok: true });
});

// HTML escape for the email body. Cheap and good enough for our needs.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
