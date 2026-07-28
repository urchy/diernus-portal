# Diernus Portal — deploy & dev helpers
# Cloudflare-native: Worker (API) + Pages (frontend) + D1 + R2 + KV
#
# Layout:
#   worker/     — Cloudflare Worker (TypeScript), wrangler, schema
#   frontend/   — Cloudflare Pages (vanilla HTML/CSS/JS)

PAGES_PROJECT   := diernus-portal
PAGES_STAGING   := diernus-portal-staging
D1_NAME         := diernus-portal-db
D1_STAGING      := diernus-portal-db-staging
R2_BUCKET       := diernus-portal-files
KV_NAMESPACE    := diernus-portal-sessions

# URLs (overridable from the environment)
PROD_API   ?= https://diernus-portal-api.diernus.com/api
PROD_WEB   ?= https://portal.diernus.com
STG_API    ?= https://diernus-portal-api-staging.silva-andre-daniel.workers.dev/api
STG_WEB    ?= https://diernus-portal-staging.pages.dev

.PHONY: help install dev dev-worker dev-frontend deploy-worker deploy-frontend deploy deploy-staging logs status schema seed secret-whoami setup-staging-secrets seed-staging seed-staging-fresh add-staging-domain test test-prod test-staging backup-prod backup-staging backup-list backup-restore

help:
	@echo "Diernus Portal — Makefile"
	@echo ""
	@echo "  make install             install Worker deps"
	@echo "  make dev                 run worker + frontend together"
	@echo "  make dev-worker          run the API worker locally (wrangler dev)"
	@echo "  make dev-frontend        serve the frontend on :8123"
	@echo "  make schema              apply D1 schema to local + remote"
	@echo "  make seed                seed the first studio admin"
	@echo ""
	@echo "  make deploy-worker       deploy the API worker (production)"
	@echo "  make deploy-frontend     deploy the static frontend (production)"
	@echo "  make deploy              deploy both (production)"
	@echo "  make deploy-staging      deploy the worker + frontend to staging"
	@echo ""
	@echo "  make setup-staging-secrets   prompt for + set RESEND_KEY, GOOGLE_*, etc on staging"
	@echo "  make add-staging-domain   attach staging.diernus.com to the staging Pages project (needs CLOUDFLARE_API_TOKEN)"
	@echo "  make seed-staging        create staging fixtures via the API (writes tests/.staging-fixtures.json)"
	@echo "  make seed-staging-fresh  same, but --clean (deletes any prior staging projects first)"
	@echo ""
	@echo "  make test                run the full regression against both prod + staging"
	@echo "  make test-prod           run the regression against production only"
	@echo "  make test-staging        run the regression against staging only (uses seeded IDs)"
	@echo ""
	@echo "  make backup-prod         export prod D1 to R2 (today's SQL + prune old)"
	@echo "  make backup-staging      same for staging (test data — manual only)"
	@echo "  make backup-list         list existing backups in R2"
	@echo "  make backup-restore DATE=YYYY-MM-DD  download a backup to ./backups/"
	@echo ""
	@echo "  make logs                tail worker logs"
	@echo "  make status              show deploys + project state"

install:
	cd worker && npm install

# --- dev ---

dev-worker:
	cd worker && npx wrangler dev

dev-frontend:
	cd frontend && python3 -m http.server 8123

# dev together would need two terminals. Run `make dev-worker` and `make dev-frontend` side by side.

# --- schema ---

schema:
	cd worker && npx wrangler d1 execute $(D1_NAME) --file=./schema.sql --local
	cd worker && npx wrangler d1 execute $(D1_NAME) --file=./schema.sql --remote

# --- seed first studio admin (run once) ---
# Usage: make seed EMAIL=andre@diernus.com NAME=Andre PASSWORD=...
seed:
	cd worker && npx wrangler d1 execute $(D1_NAME) --remote --command "INSERT INTO users (id, email, password_hash, name, role) VALUES ('usr_admin_seed', '$(EMAIL)', '$(PASSWORD)', '$(NAME)', 'studio')"

# --- secrets (run once per environment) ---
# Usage: make secret-whoami  (lists the secrets that need to be set)
secret-whoami:
	@echo "Secrets to set with 'cd worker && npx wrangler secret put <NAME>':"
	@echo "  JWT_SECRET   — random 32+ char string for signing JWTs"
	@echo "  RESEND_KEY   — Resend API key (https://resend.com/api-keys)"
	@echo "  EMAIL_FROM   — verified sender on Resend, e.g. 'Diernus <ola@diernus.com>'"
	@echo "  PUBLIC_URL   — base URL, e.g. 'https://portal.diernus.com'"

# --- staging wiring (one-time) ---
setup-staging-secrets:
	bash scripts/setup-staging-secrets.sh

# Attach staging.diernus.com to the staging Pages project. Needs
# CLOUDFLARE_API_TOKEN in your env (with Pages:Edit + DNS:Edit on
# the diernus.com zone). See scripts/add-staging-domain.sh for details.
add-staging-domain:
	bash scripts/add-staging-domain.sh

seed-staging:
	bash scripts/seed-staging.sh

seed-staging-fresh:
	bash scripts/seed-staging.sh --clean

# --- deploy ---

deploy-worker:
	cd worker && npx wrangler deploy

deploy-frontend:
	wrangler pages deploy frontend --project-name=$(PAGES_PROJECT)

deploy: deploy-worker deploy-frontend
	@echo "✓ both deployed (production)"

# Deploy to staging. The frontend deploy script copies the code, swaps
# the api-base meta tag to the staging worker URL, and pushes to the
# staging Pages project.
deploy-staging:
	cd worker && npx wrangler deploy --env staging
	bash scripts/deploy-staging.sh
	@echo "✓ staging deployed"

logs:
	cd worker && npx wrangler tail

status:
	@echo "--- Pages (production) ---"
	wrangler pages deployment list --project-name=$(PAGES_PROJECT) 2>&1 | head -10
	@echo ""
	@echo "--- Pages (staging) ---"
	wrangler pages deployment list --project-name=$(PAGES_STAGING) 2>&1 | head -10
	@echo ""
	@echo "--- Worker (production) ---"
	cd worker && npx wrangler deployments list 2>&1 | head -10
	@echo ""
	@echo "--- Worker (staging) ---"
	cd worker && npx wrangler deployments list --env staging 2>&1 | head -10

# --- regression tests ---

test-prod:
	API=$(PROD_API) WEB=$(PROD_WEB) bash tests/regression.sh

test-staging:
	API=$(STG_API) WEB=$(STG_WEB) bash tests/regression.sh

test: test-prod test-staging
	@echo "✓ all regressions complete"

# --- D1 backups (prod runs nightly via GitHub Actions; these are for ad-hoc use) ---
# Required env: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (same as for the workflow).
# The script picks the right D1 based on the target name.

backup-prod:
	ENV_NAME=prod bash scripts/backup-d1.sh

backup-staging:
	ENV_NAME=staging bash scripts/backup-d1.sh

backup-list:
	bash scripts/backup-d1.sh --list

backup-restore:
	@[ -n "$(DATE)" ] || (echo "usage: make backup-restore DATE=YYYY-MM-DD" >&2; exit 1)
	bash scripts/backup-d1.sh --restore=$(DATE)
