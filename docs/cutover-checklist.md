# diernus.com cutover checklist

The day the nameservers at ptservidor change to Cloudflare's and the
24-48h DNS propagation completes, this is the script. Go in order.
**Each step has a "verify before proceeding" line — don't skip.**

## 0. Pre-cutover (do these now, before flipping nameservers)

- [x] **Worker code is on the new 3-role system + Google SSO + email templates** (commit `3e7b9f6`, deployed)
- [x] **Resend API key set, EMAIL_FROM = `Diernus <onboarding@resend.dev>`** (sandbox, will switch to `ola@diernus.com` after step 6 below)
- [x] **Google OAuth client in Google Cloud has the production redirect URIs registered**:
  - `https://diernus-portal-api.diernus.com/api/auth/google/callback`
  - Plus the two staging URIs already there
- [ ] **Backup current DNS records at ptservidor** (Andre)
  - Go to ptservidor's DNS panel → export the zone file (BIND format) → save to `~/Documents/diernus-dns-backup-YYYY-MM-DD.txt`
  - Screenshot every record (A, CNAME, MX, TXT, NS) — some panels don't have a clean export
  - Confirm the backup has at least: A records for `diernus.com` and any `www`, MX records, any SPF/DKIM TXT records you currently use for email
- [ ] **Confirm you have the ptservidor login** (Andre) — you'll need to change nameservers there

## 1. Add diernus.com to Cloudflare (me, with your access)

Two options:

**Option A — I do it (you give me access)**: invite `silva.andre.daniel@gmail.com` to the Cloudflare account. I add the zone, paste in the backed-up DNS records, save.

**Option B — You do it (5 min)**:
1. Log in to https://dash.cloudflare.com
2. Click "+ Add a site" → enter `diernus.com` → Free plan
3. Cloudflare will scan for existing records. **Click "Add records manually" instead** so you can paste your backed-up zone file
4. After the zone is created, paste every A/CNAME/MX/TXT record from the ptservidor backup
5. Leave NS records alone — Cloudflare will tell you the new nameservers in step 2

Ping me when the zone is created. I take it from here.

## 2. Change nameservers at ptservidor (Andre, 2 min — the point of no return)

ptservidor → Domains → `diernus.com` → Nameservers → "Use custom nameservers"

Cloudflare gave you two nameservers that look like `xxx.ns.cloudflare.com` and `yyy.ns.cloudflare.com`. Paste them in, save.

> **This is the point of no return.** Once you save, DNS propagation starts. Typical: 4-12h, worst case 24-48h. There's no way to roll back faster than waiting it out.

## 3. Verify propagation (check every hour or so)

```bash
# Run this from any machine with dig (or use https://dnschecker.org)
dig NS diernus.com +short
# Should eventually return the two xxx.ns.cloudflare.com nameservers

dig A diernus.com +short
# Should eventually return Cloudflare's IPs (NOT ptservidor's)
```

When both queries return Cloudflare values everywhere (or even just at your location — TTL is per-resolver), Cloudflare is authoritative. **Tell me and I start step 4.**

## 4. Configure the 3 subdomains in Cloudflare (me, 5 min)

Once Cloudflare is authoritative, I:

| Subdomain | Type | Target | Purpose |
|---|---|---|---|
| `diernus.com` (apex) | CNAME | `diernus.pages.dev` | Marketing site (existing Pages project `diernus`) |
| `www.diernus.com` | CNAME | `diernus.pages.dev` | WWW → apex |
| `portal.diernus.com` | CNAME | `diernus-portal.pages.dev` | Client + admin portal |
| `diernus-portal-api.diernus.com` | — | (Worker route) | API endpoint |

**Apex setup** (`diernus.com` → Pages): Cloudflare's CNAME flattening means I just add a CNAME record pointing to `diernus.pages.dev` and Cloudflare flattens it to an A record automatically. Then in the Pages project `diernus` dashboard: Custom domains → add `diernus.com`.

**Portal setup** (`portal.diernus.com` → Pages): same — CNAME record + add the custom domain to the `diernus-portal` Pages project.

**API setup** (`diernus-portal-api.diernus.com` → Worker): Worker route in Cloudflare → `diernus-portal-api.diernus.com/api/*` → Worker `diernus-portal-api`.

## 5. Update Worker secrets (me, 2 min)

```bash
cd worker
# These replace the staging values currently set:
npx wrangler secret put PUBLIC_URL
# paste: https://portal.diernus.com

# Login.html — one line to change:
#   In frontend/login.html, the <meta name="api-base"> tag:
#   content="https://diernus-portal-api.silva-andre-daniel.workers.dev"
#   becomes:
#   content="https://diernus-portal-api.diernus.com"
```

The login.html change is a one-liner (the meta tag), then `wrangler pages deploy frontend`.

**CORS is automatic** — the Worker already allows `c.env.PUBLIC_URL` in the allowed-origins list, so updating PUBLIC_URL to `portal.diernus.com` makes CORS work without code changes.

**Cookie works** — the cookie is `SameSite=None; Secure` with no `Domain` attribute. The browser sends it on cross-origin fetches to the Worker, so `portal.diernus.com` → `diernus-portal-api.diernus.com` works the same as the current staging setup.

## 6. Resend domain verification (me, 15 min)

This is what gets us FROM `onboarding@resend.dev` TO `ola@diernus.com` as the sender.

1. In Resend → Domains → Add domain → `diernus.com`
2. Resend gives you 3 DNS records: 2 DKIM CNAMEs + 1 SPF TXT
3. Add them to the `diernus.com` zone in Cloudflare (DNS → Records → Add)
4. Wait ~5 min for Resend to verify (it polls automatically)
5. Once verified:
   ```bash
   cd worker
   npx wrangler secret put EMAIL_FROM
   # paste: Diernus <ola@diernus.com>
   ```

**Order matters**: do step 6 BEFORE step 5's `EMAIL_FROM` update, otherwise Resend rejects the email with "domain not verified" again.

## 7. Verify end-to-end (both of us, 15 min)

1. **Apex**: https://diernus.com loads the marketing site (the CSS 3D chair viewer)
2. **Portal**: https://portal.diernus.com loads the login page with the Google button
3. **Sign in as andre** via Google → land on /admin/ → bell shows
4. **Sign in as cliente.demo** via Google → land on /portal/ → bell shows
5. **Email test**: invite a fresh email (e.g. `your-personal@gmail.com`) via Equipa → check the inbox. The "from" should be `Diernus <ola@diernus.com>` (not the sandbox)
6. **API health**: `curl https://diernus-portal-api.diernus.com/api/health` returns `{"ok":true,...}`

If all 6 pass, the cutover is complete.

## 8. Keep staging working (don't break it)

The staging URL `diernus-portal.pages.dev` continues to work. The Worker still allows both origins in CORS. Nothing on the existing `.pages.dev` deployment breaks.

The only change to staging is: the `PUBLIC_URL` secret now points to `portal.diernus.com` (used for email links and CORS), but the staging frontend still lives on `diernus-portal.pages.dev`. **The login.html `<meta name="api-base">` is set per-deployment**, so the staging deployment keeps the `.workers.dev` API_BASE and the production deployment uses `diernus.com`. Both work.

## 9. Cleanup (after a week of stable production)

- Delete the staging Pages deployments from Cloudflare (or keep them as a safety net)
- Delete the `Resend Test` users we created during WS3 testing
- Remove the test data (regression-temp-project, etc.) from D1
- Audit which secrets are still needed

---

## What to ping me about

- **"Nameservers changed"** → I'll start watching for propagation
- **"Cloudflare is authoritative"** (the dig commands return Cloudflare) → I'll execute step 4
- **"Resend says domain is verified"** → I'll update EMAIL_FROM
- **Anything weird in the verification step 7** → I'll fix
