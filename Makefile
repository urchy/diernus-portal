# Diernus Portal — deploy & dev helpers
# Cloudflare-native: Worker (API) + Pages (frontend) + D1 + R2 + KV
#
# Layout:
#   worker/     — Cloudflare Worker (TypeScript), wrangler, schema
#   frontend/   — Cloudflare Pages (vanilla HTML/CSS/JS)

PAGES_PROJECT := diernus-portal
D1_NAME       := diernus-portal-db
R2_BUCKET     := diernus-portal-files
KV_NAMESPACE  := diernus-portal-sessions

.PHONY: help install dev dev-worker dev-frontend deploy-worker deploy-frontend deploy logs status schema seed secret-whoami

help:
	@echo "Diernus Portal — Makefile"
	@echo ""
	@echo "  make install         install Worker deps"
	@echo "  make dev             run worker + frontend together"
	@echo "  make dev-worker      run the API worker locally (wrangler dev)"
	@echo "  make dev-frontend    serve the frontend on :8123"
	@echo "  make schema          apply D1 schema to local + remote"
	@echo "  make seed            seed the first studio admin"
	@echo "  make deploy-worker   deploy the API worker"
	@echo "  make deploy-frontend deploy the static frontend"
	@echo "  make deploy          deploy both"
	@echo "  make logs            tail worker logs"
	@echo "  make status          show deploys + project state"

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

# --- deploy ---

deploy-worker:
	cd worker && npx wrangler deploy

deploy-frontend:
	wrangler pages deploy frontend --project-name=$(PAGES_PROJECT)

deploy: deploy-worker deploy-frontend
	@echo "✓ both deployed"

logs:
	cd worker && npx wrangler tail

status:
	@echo "--- Pages ---"
	wrangler pages deployment list --project-name=$(PAGES_PROJECT) 2>&1 | head -10
	@echo ""
	@echo "--- Worker ---"
	cd worker && npx wrangler deployments list 2>&1 | head -10
