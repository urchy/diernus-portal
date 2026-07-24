// Resend email integration
//
// One low-level sender (`sendEmail`) + one `renderEmail` factory for each
// type of email. To add a new email type, write a new `xxxEmail(args)`
// function that returns `{ subject, html, text }` and call `sendEmail()`
// with it. See docs/email-notifications.md for the roadmap.
//
// All email types render with the same shared shell (the Diernus
// monospace eyebrow + cream background) so the brand is consistent in
// the inbox.
import type { Role } from './types.js';

export interface EmailEnv {
  RESEND_KEY: string;
  EMAIL_FROM: string;
  PUBLIC_URL: string;
}

interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export async function sendEmail(env: EmailEnv, args: SendArgs): Promise<void> {
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
    // Log the failure so we can see it in `wrangler tail` — the call sites
    // catch and fall back to a manual accept_url, so without this log
    // we'd silently lose all email failures.
    console.error(`Resend send failed: ${res.status} from=${env.EMAIL_FROM} to=${args.to} subject="${args.subject}" body=${text}`);
    throw new Error(`Resend ${res.status}: ${text}`);
  }
}

// Shared shell — every email type wraps its body in this. Keeps the brand
// consistent in the inbox: monospace eyebrow, cream background, max 520px,
// primary CTA button.
function shell(args: { eyebrow: string; heading: string; bodyHtml: string; ctaText: string; ctaUrl: string; footer?: string }): string {
  return `<!doctype html>
<html><body style="font-family:system-ui,Inter,sans-serif;color:#23211C;background:#EDEAE3;padding:24px">
<div style="max-width:520px;margin:0 auto;background:#fff;padding:32px;border:1px solid rgba(35,33,28,.15)">
  <div style="font-family:monospace;letter-spacing:.18em;font-size:.7rem;color:#2C49C7;margin-bottom:8px">${escapeHtml(args.eyebrow)}</div>
  <h1 style="font-size:1.4rem;margin:0 0 12px 0;line-height:1.25">${args.heading}</h1>
  <div style="line-height:1.55">${args.bodyHtml}</div>
  <p style="margin:24px 0"><a href="${args.ctaUrl}" style="display:inline-block;background:#2C49C7;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-family:monospace;letter-spacing:.12em;font-size:.85rem">${escapeHtml(args.ctaText)} →</a></p>
  <p style="font-size:.85rem;color:rgba(35,33,28,.6);line-height:1.55">Ou copie este link:<br><a href="${args.ctaUrl}" style="color:#2C49C7;word-break:break-all">${args.ctaUrl}</a></p>
  ${args.footer ? `<p style="font-size:.8rem;color:rgba(35,33,28,.6);line-height:1.55;margin-top:32px;border-top:1px solid rgba(35,33,28,.1);padding-top:16px">${args.footer}</p>` : ''}
</div>
</body></html>`;
}

// --- Invitation email (existing) ---
export function invitationEmail(args: { name: string; email: string; role: Role; token: string; inviterName: string; publicUrl: string }): { subject: string; html: string; text: string } {
  const acceptUrl = `${args.publicUrl}/aceitar.html?token=${encodeURIComponent(args.token)}`;
  const isClient = args.role === 'client';
  const subject = isClient
    ? `Convite para acompanhar o seu projeto · Diernus`
    : `Bem-vindo à equipa Diernus · Portal interno`;
  const roleLabel = isClient ? 'cliente' : 'membro da equipa';
  const body = `${escapeHtml(args.inviterName)} convidou-o(a) para ${isClient ? 'acompanhar o seu projeto' : 'juntar-se à equipa'} no portal Diernus como <b>${roleLabel}</b>.<br><br>Para ativar a sua conta, defina a sua palavra-passe:`;
  const text =
`Olá ${args.name},

${args.inviterName} convidou-o(a) para ${isClient ? 'acompanhar o seu projeto' : 'juntar-se à equipa'} no portal Diernus.

Para ativar a sua conta, defina a sua palavra-passe aqui:
${acceptUrl}

Este convite expira em 7 dias.

— Diernus`;
  const html = shell({
    eyebrow: 'DIERNUS · PORTAL',
    heading: `Olá, ${escapeHtml(args.name)}`,
    bodyHtml: body,
    ctaText: 'ACEITAR CONVITE',
    ctaUrl: acceptUrl,
    footer: 'Este convite expira em 7 dias.',
  });
  return { subject, html, text };
}

// --- Card review email (NEW) ---
// Sent to the client when a studio card lands in the "Revisão" column.
// The client is the project owner — they need to know there's something
// to review.
export function cardReviewEmail(args: {
  clientName: string;
  projectName: string;
  cardTitle: string;
  cardId: string;
  projectId: string;
  publicUrl: string;
  dueDate?: string | null;
  studioName: string;
  reviewUrl: string;
}): { subject: string; html: string; text: string } {
  const dueLine = args.dueDate
    ? `Prazo: <b>${escapeHtml(args.dueDate)}</b>.`
    : 'Sem prazo definido.';
  const subject = `Pronto para revisão: ${args.cardTitle} · ${args.projectName}`;
  const body =
`O cartão <b>“${escapeHtml(args.cardTitle)}”</b> do projeto <b>${escapeHtml(args.projectName)}</b> está pronto para a sua revisão. ${dueLine}<br><br>
Abra o cartão no portal para comentar, aprovar ou pedir alterações. Quando concordar com o resultado, o estúdio avança o cartão para Concluído.`;
  const text =
`Olá ${args.clientName},

O cartão "${args.cardTitle}" do projeto "${args.projectName}" está pronto para a sua revisão.
${args.dueDate ? `Prazo: ${args.dueDate}.` : 'Sem prazo definido.'}

Abra o cartão no portal para comentar, aprovar ou pedir alterações:
${args.reviewUrl}

— Diernus`;
  const html = shell({
    eyebrow: 'DIERNUS · REVISÃO',
    heading: `Pronto para revisão, ${escapeHtml(args.clientName)}`,
    bodyHtml: body,
    ctaText: 'REVER CARTÃO',
    ctaUrl: args.reviewUrl,
    footer: 'Enviado porque o estúdio colocou este cartão na coluna Revisão.',
  });
  return { subject, html, text };
}

// --- Comment email (both directions) ---
// Used for client→studio AND studio→client comment notifications.
// The email goes to the OPPOSITE side of whoever posted. The wording
// uses the author's name explicitly so the recipient can tell who
// commented (not just "someone").
export function commentEmail(args: {
  recipientName: string;
  authorName: string;
  authorRole: 'studio' | 'client';
  projectName: string;
  cardTitle: string;
  commentSnippet: string; // already truncated to ~80 chars + ellipsis
  cardUrl: string;
}): { subject: string; html: string; text: string } {
  const verb = args.authorRole === 'studio' ? 'respondeu' : 'comentou';
  const subject = `${args.authorName} ${verb} no cartão “${args.cardTitle}” · ${args.projectName}`;
  const body =
`<b>${escapeHtml(args.authorName)}</b> ${verb} no cartão <b>“${escapeHtml(args.cardTitle)}”</b> do projeto <b>${escapeHtml(args.projectName)}</b>:<br><br>
<blockquote style="margin:0;padding:10px 14px;border-left:3px solid #2C49C7;background:rgba(44,73,199,.05);font-style:italic;color:#23211C">“${escapeHtml(args.commentSnippet)}”</blockquote><br>
Abra o cartão no portal para responder ou continuar a conversa.`;
  const text =
`Olá ${args.recipientName},

${args.authorName} ${verb} no cartão "${args.cardTitle}" do projeto "${args.projectName}":

"${args.commentSnippet}"

Abra o cartão no portal para responder:
${args.cardUrl}

— Diernus`;
  const html = shell({
    eyebrow: 'DIERNUS · COMENTÁRIO',
    heading: `Novo comentário, ${escapeHtml(args.recipientName)}`,
    bodyHtml: body,
    ctaText: 'VER CARTÃO',
    ctaUrl: args.cardUrl,
    footer: 'Enviado porque alguém comentou num cartão do seu projeto.',
  });
  return { subject, html, text };
}

// --- File upload email (both directions) ---
// Sent when a file lands in a project. Tells the recipient the filename,
// the project it landed in, and gives them a download link. We don't
// attach the file — the recipient clicks the portal link to download.
export function fileEmail(args: {
  recipientName: string;
  authorName: string;
  authorRole: 'studio' | 'client';
  projectName: string;
  fileName: string;
  fileSize: string;  // pre-formatted (e.g. "2.4 MB")
  where: string;     // "(no cartão)" or "" depending on whether card_id was provided
  portalUrl: string;
}): { subject: string; html: string; text: string } {
  const verb = args.authorRole === 'studio' ? 'partilhou' : 'enviou';
  const subject = `${args.authorName} ${verb} ${args.fileName} · ${args.projectName}`;
  const body =
`<b>${escapeHtml(args.authorName)}</b> ${verb} um novo ficheiro no projeto <b>${escapeHtml(args.projectName)}</b>${args.where ? ' ' + args.where : ''}:<br><br>
<div style="display:inline-block;padding:10px 14px;border:1px solid rgba(35,33,28,.15);border-radius:6px;background:#fff;font-family:monospace">
  📎 <b>${escapeHtml(args.fileName)}</b> <span style="color:rgba(35,33,28,.55);font-size:.85em">(${escapeHtml(args.fileSize)})</span>
</div><br><br>
Abra o portal para visualizar ou descarregar o ficheiro.`;
  const text =
`Olá ${args.recipientName},

${args.authorName} ${verb} um novo ficheiro no projeto "${args.projectName}"${args.where ? ' ' + args.where : ''}:

  ${args.fileName} (${args.fileSize})

Abra o portal para visualizar ou descarregar:
${args.portalUrl}

— Diernus`;
  const html = shell({
    eyebrow: 'DIERNUS · FICHEIRO',
    heading: `Novo ficheiro, ${escapeHtml(args.recipientName)}`,
    bodyHtml: body,
    ctaText: 'ABRIR PROJETO',
    ctaUrl: args.portalUrl,
    footer: 'Enviado porque um novo ficheiro foi adicionado ao projeto.',
  });
  return { subject, html, text };
}

// --- Project completed email ---
// Sent to BOTH the client (their project is done) and the studio members
// (so they know the auto-complete fired). The studio copy uses slightly
// different copy via the `forClient` flag.
export function projectCompletedEmail(args: {
  recipientName: string;
  projectName: string;
  finalCardTitle: string;
  projectUrl: string;
  forClient: boolean; // true = client-facing copy, false = studio-facing
}): { subject: string; html: string; text: string } {
  const subject = args.forClient
    ? `“${args.projectName}” está concluído · Diernus`
    : `Projeto concluído: ${args.projectName}`;
  const heading = args.forClient
    ? `O seu projeto está concluído, ${args.recipientName}`
    : `Projeto concluído: ${args.projectName}`;
  const body = args.forClient
    ? `O último cartão <b>“${escapeHtml(args.finalCardTitle)}”</b> foi movido para <b>Concluído</b>. Isto significa que todos os cartões do projeto <b>${escapeHtml(args.projectName)}</b> estão fechados.<br><br>O estúdio arquivou o projeto. Pode rever o resultado final no portal a qualquer momento.`
    : `O último cartão <b>“${escapeHtml(args.finalCardTitle)}”</b> do projeto <b>${escapeHtml(args.projectName)}</b> foi movido para Concluído. O projeto foi arquivado automaticamente.`;
  const text = args.forClient
    ? `Olá ${args.recipientName},

O último cartão "${args.finalCardTitle}" foi movido para Concluído. Isto significa que todos os cartões do projeto "${args.projectName}" estão fechados.

O estúdio arquivou o projeto. Pode rever o resultado final no portal:
${args.projectUrl}

— Diernus`
    : `Projeto concluído: ${args.projectName}

Último cartão: "${args.finalCardTitle}"

O projeto foi arquivado automaticamente.
${args.projectUrl}

— Diernus`;
  const html = shell({
    eyebrow: args.forClient ? 'DIERNUS · PROJETO' : 'DIERNUS · AUTO-COMPLETE',
    heading,
    bodyHtml: body,
    ctaText: 'VER PROJETO',
    ctaUrl: args.projectUrl,
    footer: args.forClient
      ? 'O projeto foi arquivado automaticamente quando o último cartão chegou a Concluído.'
      : 'Notificação automática — o último cartão chegou a Concluído.',
  });
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
