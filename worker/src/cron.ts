// Cron handler — runs on a schedule defined in wrangler.toml ([triggers] section).
//
// Today this houses the weekly summary email (Monday 9am). Future
// scheduled jobs (e.g. card_overdue, project_overdue) can be added here
// alongside — Hono doesn't have a "scheduled" handler directly, so we
// register a single `scheduled(event, env, ctx)` export in index.ts and
// dispatch by cron expression or scheduled time inside this file.
import type { Env } from './types.js';
import { sendEmail, weeklySummaryEmail } from './resend.js';

export async function handleScheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  // event.cron is the cron expression that fired (e.g. "0 9 * * 1").
  // We use it to route to the right handler. All times in cron are UTC —
  // we hardcode 0 8 * * 1 (≈ 9am Europe/Lisbon in summer, 8am in winter).
  console.log(`[cron] firing: cron="${event.cron}" scheduledTime=${new Date(event.scheduledTime).toISOString()}`);
  try {
    if (event.cron === '0 8 * * 1') {
      await runWeeklySummary(env, ctx);
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

function fmtDate(d: Date): string {
  // pt-PT: "13 de julho de 2026" — short enough to fit in subject + body
  return d.toLocaleDateString('pt-PT', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
