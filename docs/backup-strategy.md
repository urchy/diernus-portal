# D1 Backup Strategy

**Date:** 2026-07-28
**Status:** Production, runs nightly at 03:00 UTC.

D1 has no built-in point-in-time recovery and no automatic backups. Without this, a bad migration, a dropped table, or a Cloudflare-side incident would lose every `cards_history`, `comments`, `time_entries`, `notifications`, `files` row we have. So we run our own.

---

## What runs when

- **Schedule:** nightly at **03:00 UTC** (off-peak for both EU + US).
- **Trigger:** `.github/workflows/backup-d1.yml` (cron + `workflow_dispatch` for manual runs).
- **Action:** `wrangler d1 export diernus-portal-db --output=today.sql` → `wrangler r2 object put diernus-portal-files/backups/prod/YYYY-MM-DD.sql` → prune everything older than 30 days.
- **Retention:** 30 daily backups (≈ 30 × a few MB ≈ ~150 MB, which R2's free tier covers many times over).
- **What gets backed up:** everything in `diernus-portal-db` — `users`, `projects`, `columns`, `cards`, `comments`, `time_entries`, `files` (R2 holds the blobs, D1 holds the metadata), `notifications`, `card_history`, `invitations`, `email_changes`, `password_resets`. **The R2 file blobs themselves are NOT backed up here** — they're already in R2, which has its own 11-nines durability.

## Staging is not backed up

Staging is test data — `scripts/seed-staging.sh` regenerates it from scratch. Not worth the storage or the noise. If you want a one-off staging backup, `make backup-staging` does it manually.

---

## Where things live

| Thing | Location |
|---|---|
| Backup script | `scripts/backup-d1.sh` |
| GitHub Actions workflow | `.github/workflows/backup-d1.yml` |
| Local SQL output (after restore) | `./backups/db-YYYY-MM-DD.sql` |
| R2 path | `diernus-portal-files/backups/prod/YYYY-MM-DD.sql` |
| R2 object metadata (sha256) | stored by R2 (use `wrangler r2 object list` to see) |

---

## Required secrets (one-time setup)

Add to **GitHub → Settings → Secrets and variables → Actions → Repository secrets**:

| Secret | Value | Scopes needed on the token |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | A new API token | `D1:Read` (account) + `R2:Edit` (account) + account `15103fc0f7367d7fc72cab24473dc437` |
| `CLOUDFLARE_ACCOUNT_ID` | `15103fc0f7367d7fc72cab24473dc437` | — |

**Tip:** create the API token at https://dash.cloudflare.com/profile/api-tokens → "Create Token" → "Edit Cloudflare Workers" template, then add `D1:Read` + `R2:Edit` to the permissions. Restrict to the diernus account. Token name suggestion: `diernus-backup-d1-r2`.

For local ad-hoc runs (e.g. `make backup-prod`), export the same two vars in your shell before running.

---

## Restore procedure

Manual on purpose. You don't want a workflow auto-restoring — that could mask the very incident you're trying to investigate.

```bash
# 1. List what's there
make backup-list

# 2. Download the date you want (saves to ./backups/db-YYYY-MM-DD.sql)
make backup-restore DATE=2026-07-28

# 3. Eyeball it before applying
head -20 ./backups/db-2026-07-28.sql
wc -l ./backups/db-2026-07-28.sql

# 4. Dry-run against local D1 first
cd worker && wrangler d1 execute diernus-portal-db --local --file=../backups/db-2026-07-28.sql

# 5. Apply to production ONLY after the local dry-run looks right
cd worker && wrangler d1 execute diernus-portal-db --remote --file=../backups/db-2026-07-28.sql
```

The D1 export is a `wrangler d1 execute`-compatible SQL dump (one `INSERT INTO … VALUES …` per row), so step 4/5 work without any conversion.

---

## Verifying it works

After the workflow has run at least once:

```bash
# From your local terminal (needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID)
make backup-list
# should show today's + the last 29 days' SQL files
```

If `make backup-list` returns `(no backups yet)`, check the GitHub Actions tab — the workflow run is in the **Actions** sidebar, with logs showing each step.

---

## Failure modes & how to spot them

| Symptom | Cause | Fix |
|---|---|---|
| Action fails at "wrangler d1 export" with 401 | API token wrong / rotated | Re-add `CLOUDFLARE_API_TOKEN` in repo secrets |
| Action fails at "r2 object put" with 403 | Token missing R2:Edit scope | Re-create the token with both D1:Read + R2:Edit |
| `make backup-list` shows old dates only | Cron didn't fire (GH Actions outage, or schedule drift) | Trigger manually via **Actions → backup-d1 → Run workflow** |
| Backup file is suspiciously small (< 1 KB) | D1 is genuinely empty (after a wipe) or export failed silently | Open the file — if it's empty, re-run; if it has DDL only, the DB is empty |
| Restore doesn't match expectations | Wrong date picked | `make backup-list` and re-check the YYYY-MM-DD prefix |

The first scheduled run is **2026-07-29 03:00 UTC**. If you want a backup tonight, trigger the workflow manually now (Actions → backup-d1 → Run workflow).
