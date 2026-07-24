# Email notifications — roadmap & how to add a new one

## Where it lives

All email is sent via Resend (`worker/src/resend.ts`). One low-level
`sendEmail(env, args)` plus a per-type `xxxEmail(args)` function that returns
`{ subject, html, text }`. To add a new email type:

1. Add `xxxEmail(args)` to `worker/src/resend.ts`. Wrap the body in the
   shared `shell({...})` so the brand is consistent in the inbox.
2. Add a section to this doc under "Roadmap".
3. Call `sendEmail()` from the right place in the API, wrapped in
   `c.executionCtx.waitUntil(...)` so the API response doesn't wait for
   Resend. On failure, log to console — never throw into the user's flow.

The email is **always fire-and-forget**. The in-app bell (`notifyClient()`
/ `notifyStudio()` in `worker/src/notifications.ts`) is the synchronous
fallback that doesn't depend on Resend. The bell should fire regardless of
whether the email send succeeds — they're independent.

## Architecture decisions

- **One sender (`sendEmail`) + N templates.** Each template owns its own
  subject, body copy, and CTA. Add a template, register it in the roadmap
  below, wire it where the trigger happens.
- **Env abstraction.** `sendEmail` reads `RESEND_KEY`, `EMAIL_FROM`,
  `PUBLIC_URL` from the worker's env. No env vars in the templates.
- **`shell()` is shared.** Every email renders with the same monospace
  eyebrow + cream background + max 520px + primary CTA button. Brand
  consistency in the inbox.
- **Locale is PT-PT.** Diernus is a Portuguese studio. Email copy is
  Portuguese (Portugal). No i18n yet — if we add it, `shell()` will need
  a `locale` argument.
- **No email queue.** Today we send synchronously inside `waitUntil`. If
  we ever need retries or rate limiting, add a `notifications_outbox` D1
  table and a cron that drains it. Not needed yet.

## Roadmap

| # | Type | Trigger | Recipient | Status |
|---|------|---------|-----------|--------|
| 1 | `invitation` | `POST /api/clients/:id/invite` and team invites | the invitee | **DONE** |
| 2 | `card_review` | Card moved to "Revisão" column | project owner (client) | **DONE** |
| 3 | `comment` | New comment on a card (studio + client, both directions) | the opposite side | **DONE** |
| 4 | `file` | New file upload (studio + client, both directions) | the opposite side | **DONE** |
| 5 | `project_completed` | Auto-complete: last card → Concluído | client + every studio member | **DONE** |
| 6 | `card_overdue` | Cron: card.due_date < today AND not Concluído | studio members | NEXT |
| 7 | `project_overdue` | Cron: project.due_date < today AND not completed | studio members + client | NEXT |
| 8 | `client_invited` | Send the invite link when a client is first created (today we just return `accept_url` in the response) | the new client | BACKLOG |
| 9 | `weekly_summary` | Cron: Monday 9am | studio (per-member breakdown of the previous week) | BACKLOG |
| 10 | `payment_due` | Hook from a future invoicing module | client | LATER — no payment system yet |

## How to add a new type (worked example: `project_completed`)

```ts
// 1. Add the template to resend.ts
export function projectCompletedEmail(args: {
  clientName: string;
  projectName: string;
  publicUrl: string;
  projectUrl: string;
}): { subject: string; html: string; text: string } {
  const subject = `Projeto concluído: ${args.projectName}`;
  const body = `O projeto <b>${escapeHtml(args.projectName)}</b> está concluído. Pode rever o resultado final e descarregar os ficheiros partilhados.`;
  const text = `Olá ${args.clientName},\n\no projeto "${args.projectName}" está concluído...\n\n${args.projectUrl}\n\n— Diernus`;
  const html = shell({
    eyebrow: 'DIERNUS · PROJETO',
    heading: `Concluído, ${escapeHtml(args.clientName)}`,
    bodyHtml: body,
    ctaText: 'VER PROJETO',
    ctaUrl: args.projectUrl,
    footer: 'Enviado porque o último cartão do projeto foi marcado como concluído.',
  });
  return { subject, html, text };
}

// 2. Wire it from cards.ts (or wherever the trigger is)
const tpl = projectCompletedEmail({...});
c.executionCtx.waitUntil(
  sendEmail(c.env, { to: ctx.client_email, ...tpl })
    .catch(err => console.error('[cards.ts] project-completed email failed:', err.message))
);
```

## Failure modes

- **Resend 401** — bad API key. Fix in `wrangler secret put RESEND_KEY`.
- **Resend 422** — invalid `to` address. The client email is from the
  `users` table, so this is data corruption (or a typo in the address
  during onboarding). Log and move on.
- **Resend 429** — rate limit. Resend's free tier is 100/day, 50/hour.
  The studio is unlikely to hit this but if it does, the
  `waitUntil` promise will reject, the in-app notification already fired,
  and we lose the email. The fix is the outbox table mentioned above.
- **Network error** — the `waitUntil` promise rejects, we log it, the
  in-app notification still fired. No data loss.

## Anti-patterns to avoid

- **Don't** add email to a hot path (anywhere in the request response
  cycle, without `waitUntil`). The user is waiting on the response.
- **Don't** retry the same email on failure (yet). One log line, move on.
  When we have the outbox, retries become the queue's job.
- **Don't** put secrets in the template. The env is passed at call time.
- **Don't** skip the in-app notification because the email exists. Bell
  is the always-on channel. Email is the loud one.
