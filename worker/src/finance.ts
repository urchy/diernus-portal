// Finance summary — aggregates hours, money, and counts by project / client / team / month
//   Query params:
//     year=2026               (default: current year)
//     month=7                  (optional, 1-12 — restrict monthly bucket to a single month)
//     include_archived=false    (include completed/archived projects in the totals)
//
//   The "billed" amount per project is computed as: actual_hours * hourly_rate.
//   When hourly_rate is null, billed is null (project not yet priced).
import { Hono } from 'hono';
import type { AppVariables, Env } from './types.js';
import { requireAuth, requireRole } from './middleware.js';

export const financeRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();
financeRoutes.use('*', requireAuth, requireRole('studio'));

financeRoutes.get('/summary', async (c) => {
  const now = new Date();
  const year = Number(c.req.query('year')) || now.getUTCFullYear();
  const monthQ = c.req.query('month');
  const monthNum = monthQ ? Number(monthQ) : null;
  if (monthNum != null && (monthNum < 1 || monthNum > 12)) {
    return c.json({ error: 'mês inválido' }, 400);
  }
  // start/end of the requested period
  const start = monthNum
    ? new Date(Date.UTC(year, monthNum - 1, 1)).toISOString().slice(0, 19).replace('T', ' ')
    : new Date(Date.UTC(year, 0, 1)).toISOString().slice(0, 19).replace('T', ' ');
  const end = monthNum
    ? new Date(Date.UTC(year, monthNum, 1)).toISOString().slice(0, 19).replace('T', ' ')
    : new Date(Date.UTC(year + 1, 0, 1)).toISOString().slice(0, 19).replace('T', ' ');

  // -------- PER PROJECT (all projects, regardless of time filter) --------
  // We want both: project-level all-time stats (actual_hours, hourly_rate, billed)
  // AND time-filtered hours for the period (so the monthly view can show
  // "this month: X hours billed").
  const projectsRows = await c.env.DB
    .prepare(`SELECT p.id, p.name, p.status, p.hourly_rate, p.budget_hours, p.due_date,
              p.client_id, c.name AS client_name, c.email AS client_email,
              COALESCE((SELECT SUM(actual_hours) FROM cards WHERE project_id = p.id), 0) AS actual_hours,
              COALESCE((SELECT SUM(estimated_hours) FROM cards WHERE project_id = p.id), 0) AS estimated_hours,
              (SELECT COUNT(*) FROM cards WHERE project_id = p.id) AS card_count,
              (SELECT COUNT(*) FROM cards k WHERE k.project_id = p.id
                 AND k.column_id IN (SELECT id FROM columns WHERE project_id = p.id AND LOWER(name) IN ('concluído','concluido'))) AS done_cards
              FROM projects p JOIN users c ON c.id = p.client_id
              ORDER BY p.updated_at DESC`)
    .all<any>();
  // period hours per project (from time_entries joined to cards of that project)
  const periodRows = await c.env.DB
    .prepare(`SELECT p.id AS project_id,
              COALESCE(SUM(t.hours), 0) AS period_hours,
              COUNT(t.id) AS period_entries
              FROM projects p
              LEFT JOIN cards k ON k.project_id = p.id
              LEFT JOIN time_entries t ON t.card_id = k.id AND t.logged_at >= ? AND t.logged_at < ?
              GROUP BY p.id`)
    .bind(start, end)
    .all<any>();
  const periodMap = new Map(periodRows.results.map(r => [r.project_id, r]));

  const projects = projectsRows.results.map(p => {
    const period = periodMap.get(p.id) || { period_hours: 0, period_entries: 0 };
    const actual = Number(p.actual_hours) || 0;
    const periodH = Number(period.period_hours) || 0;
    const rate = p.hourly_rate != null ? Number(p.hourly_rate) : null;
    const billedTotal = rate != null ? round1(actual * rate) : null;
    const billedPeriod = rate != null ? round1(periodH * rate) : null;
    const budget = p.budget_hours != null ? Number(p.budget_hours) : null;
    const budgetRemaining = budget != null ? round1(Math.max(0, budget - actual)) : null;
    const budgetUsedPct = budget != null && budget > 0 ? Math.round((actual / budget) * 100) : null;
    return {
      id: p.id,
      name: p.name,
      status: p.status,
      client_id: p.client_id,
      client_name: p.client_name,
      client_email: p.client_email,
      due_date: p.due_date,
      hourly_rate: rate,
      budget_hours: budget,
      budget_remaining: budgetRemaining,
      budget_used_pct: budgetUsedPct,
      estimated_hours: Number(p.estimated_hours) || 0,
      actual_hours: actual,
      billed_total: billedTotal,
      card_count: Number(p.card_count) || 0,
      done_cards: Number(p.done_cards) || 0,
      period_hours: periodH,
      period_entries: Number(period.period_entries) || 0,
      period_billed: billedPeriod,
    };
  });

  // -------- PER CLIENT (aggregated from projects) --------
  const clientMap = new Map<string, any>();
  for (const p of projects) {
    const c = clientMap.get(p.client_id) || {
      id: p.client_id,
      name: p.client_name,
      email: p.client_email,
      project_count: 0,
      actual_hours: 0,
      period_hours: 0,
      billed_total: 0,
      period_billed: 0,
    };
    c.project_count += 1;
    c.actual_hours += p.actual_hours;
    c.period_hours += p.period_hours;
    c.billed_total += p.billed_total || 0;
    c.period_billed += p.period_billed || 0;
    clientMap.set(p.client_id, c);
  }
  const clients = Array.from(clientMap.values()).map(c => ({
    ...c,
    actual_hours: round1(c.actual_hours),
    period_hours: round1(c.period_hours),
    billed_total: round1(c.billed_total),
    period_billed: round1(c.period_billed),
  })).sort((a, b) => b.billed_total - a.billed_total);

  // -------- PER TEAM MEMBER (hours they logged) --------
  // Studio users who logged time in the period
  const teamRows = await c.env.DB
    .prepare(`SELECT u.id, u.name, u.email,
              COALESCE(SUM(t.hours), 0) AS period_hours,
              COUNT(t.id) AS entry_count
              FROM time_entries t
              JOIN users u ON u.id = t.user_id
              WHERE t.logged_at >= ? AND t.logged_at < ?
              GROUP BY u.id
              ORDER BY period_hours DESC`)
    .bind(start, end)
    .all<any>();
  // also pull all-time hours per member (separate query for context)
  const teamAllTime = await c.env.DB
    .prepare(`SELECT user_id, COALESCE(SUM(hours), 0) AS hours FROM time_entries GROUP BY user_id`)
    .all<any>();
  const teamAllMap = new Map(teamAllTime.results.map(r => [r.user_id, Number(r.hours) || 0]));
  const team = teamRows.results.map(m => ({
    id: m.id,
    name: m.name,
    email: m.email,
    period_hours: round1(Number(m.period_hours) || 0),
    entry_count: Number(m.entry_count) || 0,
    all_time_hours: round1(teamAllMap.get(m.id) || 0),
  }));

  // -------- MONTHLY BUCKETS (only when no specific month was asked) --------
  // Build 12 buckets for the year, fill them with period hours + billed.
  // Billed is computed per project (rate × hours for that project in
  // that month), not the average rate across all projects. The "Per
  // project" table above uses per-project rates; the chart should match
  // so the user isn't confused by two different totals.
  let monthly: any[] = [];
  if (monthNum == null) {
    // One row per (project, month) with hours, joined to the project's rate
    const monthlyRows = await c.env.DB
      .prepare(`SELECT p.id AS project_id, p.hourly_rate,
                strftime('%m', t.logged_at) AS month,
                COALESCE(SUM(t.hours), 0) AS hours,
                COUNT(t.id) AS entries
                FROM projects p
                JOIN cards k ON k.project_id = p.id
                JOIN time_entries t ON t.card_id = k.id
                WHERE t.logged_at >= ? AND t.logged_at < ?
                GROUP BY p.id, month`)
      .bind(start, end)
      .all<{ project_id: string; hourly_rate: number | null; month: string; hours: number; entries: number }>();
    // Aggregate by month: total hours + billed (sum of project-specific billed).
    // Important: compute billed on the RAW hours value, not the rounded
    // display value — round1(2.75) becomes 2.8 due to floating point, and
    // 2.8 × rate gives a different total than 2.75 × rate. The display
    // is rounded; the math is not.
    const byMonth = new Map<number, { hours: number; billed: number; entries: number }>();
    for (const r of monthlyRows.results) {
      const m = Number(r.month);
      const bucket = byMonth.get(m) || { hours: 0, billed: 0, entries: 0 };
      const rawHours = Number(r.hours) || 0;
      bucket.hours += rawHours;
      bucket.entries += Number(r.entries) || 0;
      if (r.hourly_rate != null) bucket.billed += rawHours * Number(r.hourly_rate);
      byMonth.set(m, bucket);
    }
    const monthNames = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    monthly = monthNames.map((name, i) => {
      const m = i + 1;
      const data = byMonth.get(m) || { hours: 0, billed: 0, entries: 0 };
      return {
        month: m, name,
        hours: round1(data.hours),
        billed: round1(data.billed),
        entries: data.entries,
      };
    });
  }

  // -------- TOTALS --------
  const totals = {
    projects: projects.length,
    active_projects: projects.filter(p => p.status === 'active').length,
    completed_projects: projects.filter(p => p.status === 'completed').length,
    clients: clients.length,
    period_hours: round1(projects.reduce((s, p) => s + p.period_hours, 0)),
    all_time_hours: round1(projects.reduce((s, p) => s + p.actual_hours, 0)),
    period_billed: round1(projects.reduce((s, p) => s + (p.period_billed || 0), 0)),
    all_time_billed: round1(projects.reduce((s, p) => s + (p.billed_total || 0), 0)),
  };

  return c.json({
    period: { year, month: monthNum },
    totals,
    projects,
    clients,
    team,
    monthly,
  });
});

function round1(n: number) { return Math.round(n * 10) / 10; }
