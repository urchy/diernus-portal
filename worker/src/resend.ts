// Resend email integration
import type { Role } from './types.js';

interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export async function sendEmail(env: { RESEND_KEY: string; EMAIL_FROM: string; PUBLIC_URL: string }, args: SendArgs): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend ${res.status}: ${text}`);
  }
}

export function invitationEmail(args: { name: string; email: string; role: Role; token: string; inviterName: string; publicUrl: string }): { subject: string; html: string; text: string } {
  const acceptUrl = `${args.publicUrl}/aceitar.html?token=${encodeURIComponent(args.token)}`;
  const isClient = args.role === 'client';
  const subject = isClient
    ? `Convite para acompanhar o seu projeto · Diernus`
    : `Bem-vindo à equipa Diernus · Portal interno`;
  const roleLabel = isClient ? 'cliente' : 'membro da equipa';
  const text =
`Olá ${args.name},

${args.inviterName} convidou-o(a) para ${isClient ? 'acompanhar o seu projeto' : 'juntar-se à equipa'} no portal Diernus.

Para ativar a sua conta, defina a sua palavra-passe aqui:
${acceptUrl}

Este convite expira em 7 dias.

— Diernus`;
  const html =
`<!doctype html>
<html><body style="font-family:system-ui,Inter,sans-serif;color:#23211C;background:#EDEAE3;padding:24px">
<div style="max-width:520px;margin:0 auto;background:#fff;padding:32px;border:1px solid rgba(35,33,28,.15)">
  <div style="font-family:monospace;letter-spacing:.18em;font-size:.7rem;color:#2C49C7;margin-bottom:8px">DIERNUS · PORTAL</div>
  <h1 style="font-size:1.4rem;margin:0 0 12px 0">Olá, ${escapeHtml(args.name)}</h1>
  <p style="line-height:1.55">${escapeHtml(args.inviterName)} convidou-o(a) para ${isClient ? 'acompanhar o seu projeto' : 'juntar-se à equipa'} no portal Diernus como <b>${roleLabel}</b>.</p>
  <p style="line-height:1.55">Para ativar a sua conta, defina a sua palavra-passe:</p>
  <p style="margin:24px 0"><a href="${acceptUrl}" style="display:inline-block;background:#2C49C7;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-family:monospace;letter-spacing:.12em;font-size:.85rem">ACEITAR CONVITE →</a></p>
  <p style="font-size:.85rem;color:rgba(35,33,28,.6);line-height:1.55">Ou copie este link: <br><a href="${acceptUrl}" style="color:#2C49C7;word-break:break-all">${acceptUrl}</a></p>
  <p style="font-size:.8rem;color:rgba(35,33,28,.6);line-height:1.55;margin-top:32px;border-top:1px solid rgba(35,33,28,.1);padding-top:16px">Este convite expira em 7 dias.</p>
</div>
</body></html>`;
  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
