// Cron handler — runs on a schedule defined in wrangler.toml ([triggers] section).
//
// Houses three jobs:
//   - weekly summary   (Mon 08:00 UTC)
//   - card_overdue     (daily 09:00 UTC)
//   - project_overdue  (daily 09:00 UTC)
//
// Hono doesn't have a "scheduled" handler directly, so we register a single
// `scheduled(event, env, ctx)` export in index.ts and dispatch by cron
// expression. All crons in wrangler.toml are UTC; we tolerate the 1-hour
// DST drift against Europe/Lisbon.
import type { Env } from './types.js';
import { sendEmail, weeklySummaryEmail, cardOverdueEmail, projectOverdueEmail } from './resend.js';
import { notifyStudio } from './notifications.js';
import { uuid } from './crypto.js';

export async function handleScheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  console.log(`[cron] firing: cron="${event.cron}" scheduledTime=${new Date(event.scheduledTime).toISOString()}`);
  try {
    if (event.cron === '0 8 * * 1') {
      await runWeeklySummary(env, ctx);
      return;
    }
    if (event.cron === '0 9 * * *') {
      // Run both overdue checks sequentially. They share the cron_log table
      // for idempotency, so a single UTC-day dedupe key per entity.
      await runCardOverdueCheck(env, ctx);
      await runProjectOverdueCheck(env, ctx);
      return;
    }
    console.log(`[cron] no handler for cron="${event.cron}" — skipping`);
  } catch (err) {
    // Catch ALL errors so one failing job doesn't poison the rest of
    // the schedule. Cloudflare will retry the next scheduled run.
    console.error(`[cron] unhandled error:`, (err as Error).message, (err as Error).stack);
  }
}

// ---- Weekly summary ----
// Per-member breakdown of hours logged in the previous week (Mon→Sun).
// Sent individually to every active studio member (admin + team).
async function runWeeklySummary(env: Env, ctx: ExecutionContext): Promise<void> {
  // "Previous week" = last completed Mon..Sun.
  // We compute it from today (UTC, since D1's datetime('now') is UTC).
  const now = new Date();
  const day = now.getUTCDay();                  // 0=Sun, 1=Mon, ..., 6=Sat
  // We want Mon=0, Sun=6
  const offsetToThisMonday = ((day + 6) % 7);  // days back to this week's Monday
  const thisMonday = new Date(now);
  thisMonday.setUTCDate(thisMonday.getUTCDate() - offsetToThisMonday);
  // lastMonday = thisMonday - 7  (the Monday of the week we want to summarise)
  const lastMonday = new Date(thisMonday);
  lastMonday.setUTCDate(lastMonday.getUTCDate() - 7);
  const lastSunday = new Date(thisMonday);
  lastSunday.setUTCDate(lastSunday.getUTCDate() - 1);
  // 7-day window: [lastMonday 00:00, thisMonday 00:00)
  const startISO = lastMonday.toISOString().slice(0, 19).replace('T', ' ');
  // D1's datetime('now', ...) understands relative offsets. We use the
  // ISO string above for explicitness + to avoid off-by-ones from
  // crossing a month boundary.

  console.log(`[cron] weekly summary window: ${startISO} → ${lastMonday.toISOString()}`);

  // Per-member totals for the week
  const memberRows = await env.DB
    .prepare(`
      SELECT u.id, u.name, u.email,
             COALESCE(SUM(t.hours), 0) AS total_hours,
             COUNT(t.id) AS total_entries,
             COUNT(DISTINCT p.id) AS projects_touched
      FROM users u
      LEFT JOIN time_entries t ON t.user_id = u.id AND t.logged_at >= ?
      LEFT JOIN cards c        ON c.id = t.card_id
      LEFT JOIN projects p     ON p.id = c.project_id
      WHERE u.role IN ('admin', 'team') AND u.status = 'active'
      GROUP BY u.id
      HAVING total_hours > 0   -- skip members with zero hours (avoid noise)
      ORDER BY total_hours DESC
    `)
    .bind(startISO)
    .all<{ id: string; name: string; email: string; total_hours: number; total_entries: number; projects_touched: number }>();

  if (memberRows.results.length === 0) {
    console.log(`[cron] no studio hours logged in the last week — skipping weekly summary`);
    return;
  }

  // Per-member, top 3 projects by hours in the same window
  const portalBase = env.PUBLIC_URL.replace(/\/$/, '');

  for (const m of memberRows.results) {
    const perProject = await env.DB
      .prepare(`
        SELECT p.name AS name, COALESCE(SUM(t.hours), 0) AS hours
        FROM time_entries t
        JOIN cards c ON c.id = t.card_id
        JOIN projects p ON p.id = c.project_id
        WHERE t.user_id = ? AND t.logged_at >= ?
        GROUP BY p.id
        ORDER BY hours DESC
        LIMIT 3
      `)
      .bind(m.id, startISO)
      .all<{ name: string; hours: number }>();

    const tpl = weeklySummaryEmail({
      recipientName: m.name,
      weekStart: fmtDate(lastMonday),
      weekEnd:   fmtDate(lastSunday),
      totalHours: m.total_hours,
      totalEntries: m.total_entries,
      projectsTouched: m.projects_touched,
      perProject: perProject.results,
      portalUrl: `${portalBase}/admin/`,
    });

    ctx.waitUntil(
      sendEmail(env, { to: m.email, subject: tpl.subject, html: tpl.html, text: tpl.text })
        .catch(err => console.error(`[cron] weekly summary to ${m.email} failed:`, err.message))
    );
  }
  console.log(`[cron] weekly summary queued for ${memberRows.results.length} member(s)`);
}

// ---- Card overdue (daily 09:00 UTC) ----
// Find every card whose due_date is in the past and which is still in an
// open column (not Concluído), in an active project, and hasn't been
// notified today. Email the assignee (or all studio admins if unassigned)
// and fan-out a single in-app notification. Dedupe per (card, UTC day).
async function runCardOverdueCheck(env: Env, ctx: ExecutionContext): Promise<void> {
  const portalBase = env.PUBLIC_URL.replace(/\/$/, '');
  const today = new Date().toISOString().slice(0, 10);  // 'YYYY-MM-DD' UTC

  // Pre-fetch all active admins once. Unassigned cards route to all of them.
  const admins = await env.DB
    .prepare(`SELECT id, name, email FROM users WHERE role = 'admin' AND status = 'active'`)
    .all<{ id: string; name: string; email: string }>();

  // Find every overdue, open card we haven't notified today.
  // Note: "open" = column name is NOT 'concluído' / 'concluido' (case-insensitive).
  // We mirror the same naming convention the auto-complete logic uses in cards.ts.
  const rows = await env.DB
    .prepare(`
      SELECT c.id           AS card_id,
             c.title        AS card_title,
             c.due_date     AS due_date,
             c.assignee_id  AS assignee_id,
             p.id           AS project_id,
             p.name         AS project_name
      FROM cards c
      JOIN columns  k ON k.id = c.column_id
      JOIN projects p ON p.id = c.project_id
      WHERE c.due_date IS NOT NULL
        AND c.due_date < date('now')
        AND p.status = 'active'
        AND LOWER(k.name) NOT IN ('concluído', 'concluido', 'concluida')
        AND NOT EXISTS (
          SELECT 1 FROM cron_log l
          WHERE l.cron_name = 'card_overdue'
            AND l.entity_type = 'card'
            AND l.entity_id = c.id
            AND l.sent_date = date('now')
        )
      ORDER BY c.due_date ASC
    `)
    .all<{ card_id: string; card_title: string; due_date: string; assignee_id: string | null; project_id: string; project_name: string }>();

  if (rows.results.length === 0) {
    console.log(`[cron] card_overdue: no overdue cards today — done`);
    return;
  }

  console.log(`[cron] card_overdue: ${rows.results.length} card(s) overdue on ${today}`);

  for (const r of rows.results) {
    // 1) Mark as sent BEFORE we send (prevents duplicate sends if Resend retries).
    // If the email fails, we'll send again tomorrow — acceptable for v1.
    await env.DB
      .prepare(`INSERT OR IGNORE INTO cron_log (id, cron_name, entity_type, entity_id, sent_date)
                VALUES (?, 'card_overdue', 'card', ?, ?)`)
      .bind(uuid(), r.card_id, today)
      .run();

    // 2) Resolve recipient(s) — assignee, or all active admins if unassigned.
    const recipients: { id: string; name: string; email: string }[] = [];
    if (r.assignee_id) {
      const a = await env.DB
        .prepare(`SELECT id, name, email FROM users WHERE id = ? AND status = 'active'`)
        .bind(r.assignee_id)
        .first<{ id: string; name: string; email: string }>();
      if (a) recipients.push(a);
    }
    if (recipients.length === 0) {
      recipients.push(...admins.results);
    }
    if (recipients.length === 0) {
      console.warn(`[cron] card_overdue: card ${r.card_id} has no recipients — skipped email`);
      continue;
    }

    const daysOverdue = daysBetween(r.due_date, today);
    const cardUrl = `${portalBase}/admin/projeto.html?id=${r.project_id}&card=${r.card_id}`;

    for (const u of recipients) {
      const tpl = cardOverdueEmail({
        recipientName: u.name,
        projectName: r.project_name,
        cardTitle: r.card_title,
        dueDate: fmtDate(new Date(r.due_date + 'T00:00:00Z')),
        daysOverdue,
        cardUrl,
      });
      ctx.waitUntil(
        sendEmail(env, { to: u.email, subject: tpl.subject, html: tpl.html, text: tpl.text })
          .catch(err => console.error(`[cron] card_overdue to ${u.email} failed:`, err.message))
      );
    }

    // 3) In-app bell — one fan-out row per studio user (recipients may
    // overlap with the studio list, so use notifyStudio for the bell and
    // accept the slight duplication for now). Idempotency on the email
    // side comes from cron_log; the bell row is harmless if the user
    // has already seen it.
    await notifyStudio(env, {
      type: 'card_overdue',
      refKind: 'card',
      refId: r.card_id,
      message: `“${r.card_title}” está em atraso no projeto ${r.project_name}.`,
      link: `/admin/projeto.html?id=${r.project_id}&card=${r.card_id}`,
    }).catch(err => console.error(`[cron] card_overdue notifyStudio failed:`, err.message));
  }
  console.log(`[cron] card_overdue: queued emails + bells for ${rows.results.length} card(s)`);
}

// ---- Project overdue (daily 09:00 UTC) ----
// Find every project whose due_date is in the past and which is still
// 'active' (not completed/archived), that hasn't been notified today.
// Email every active admin + drop a single fan-out in-app notification.
async function runProjectOverdueCheck(env: Env, ctx: ExecutionContext): Promise<void> {
  const portalBase = env.PUBLIC_URL.replace(/\/$/, '');
  const today = new Date().toISOString().slice(0, 10);

  const rows = await env.DB
    .prepare(`
      SELECT p.id          AS project_id,
             p.name        AS project_name,
             p.due_date    AS due_date,
             u.name        AS client_name
      FROM projects p
      LEFT JOIN users u ON u.id = p.client_id
      WHERE p.due_date IS NOT NULL
        AND p.due_date < date('now')
        AND p.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM cron_log l
          WHERE l.cron_name = 'project_overdue'
            AND l.entity_type = 'project'
            AND l.entity_id = p.id
            AND l.sent_date = date('now')
        )
      ORDER BY p.due_date ASC
    `)
    .all<{ project_id: string; project_name: string; due_date: string; client_name: string | null }>();

  if (rows.results.length === 0) {
    console.log(`[cron] project_overdue: no overdue projects today — done`);
    return;
  }

  const admins = await env.DB
    .prepare(`SELECT id, name, email FROM users WHERE role = 'admin' AND status = 'active'`)
    .all<{ id: string; name: string; email: string }>();
  if (admins.results.length === 0) {
    console.warn(`[cron] project_overdue: no active admins — skipped`);
    return;
  }

  console.log(`[cron] project_overdue: ${rows.results.length} project(s) overdue on ${today}`);

  for (const r of rows.results) {
    await env.DB
      .prepare(`INSERT OR IGNORE INTO cron_log (id, cron_name, entity_type, entity_id, sent_date)
                VALUES (?, 'project_overdue', 'project', ?, ?)`)
      .bind(uuid(), r.project_id, today)
      .run();

    const daysOverdue = daysBetween(r.due_date, today);
    const projectUrl = `${portalBase}/admin/projeto.html?id=${r.project_id}`;

    for (const u of admins.results) {
      const tpl = projectOverdueEmail({
        recipientName: u.name,
        projectName: r.project_name,
        clientName: r.client_name || '(cliente removido)',
        dueDate: fmtDate(new Date(r.due_date + 'T00:00:00Z')),
        daysOverdue,
        projectUrl,
      });
      ctx.waitUntil(
        sendEmail(env, { to: u.email, subject: tpl.subject, html: tpl.html, text: tpl.text })
          .catch(err => console.error(`[cron] project_overdue to ${u.email} failed:`, err.message))
      );
    }

    await notifyStudio(env, {
      type: 'project_overdue',
      refKind: 'project',
      refId: r.project_id,
      message: `“${r.project_name}” está em atraso.`,
      link: `/admin/projeto.html?id=${r.project_id}`,
    }).catch(err => console.error(`[cron] project_overdue notifyStudio failed:`, err.message));
  }
  console.log(`[cron] project_overdue: queued emails + bells for ${rows.results.length} project(s)`);
}

function fmtDate(d: Date): string {
  // pt-PT: "27 de julho de 2026" — short enough to fit in subject + body
  return d.toLocaleDateString('pt-PT', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// Whole-day diff between two 'YYYY-MM-DD' strings (UTC). Returns 0 if
// the two dates are the same day, 1 if one day apart, etc.
function daysBetween(fromDate: string, toDate: string): number {
  const a = Date.parse(fromDate + 'T00:00:00Z');
  const b = Date.parse(toDate   + 'T00:00:00Z');
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}
