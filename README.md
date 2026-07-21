# Diernus · Portal do cliente

Plataforma de acompanhamento de projetos para o estúdio **Diernus**.
Clientes autenticam-se, seguem os seus projetos num **kanban** (A Fazer / Em Curso / Concluído), comentam nos cartões e fazem download de ficheiros. O estúdio cria e gere tudo.

## Stack

- **Frontend** — Cloudflare Pages (vanilla HTML/CSS/JS, sem build)
- **API** — Cloudflare Worker (TypeScript) com [Hono](https://hono.dev)
- **Base de dados** — Cloudflare D1 (SQLite)
- **Ficheiros** — Cloudflare R2 (PDF, imagens, dwg…)
- **Sessões/cache** — Cloudflare KV
- **E-mail de convites** — [Resend](https://resend.com)

URL de produção (a configurar): `https://portal.diernus.com`

## Layout

```
worker/                 # API (Cloudflare Worker, TypeScript)
  src/
    index.ts           # Hono router + entry
    auth.ts            # login / me / logout / aceitar convite
    projects.ts        # CRUD de projetos
    cards.ts           # CRUD de cartões (kanban) + mover entre colunas
    comments.ts        # comentários em cartões
    files.ts           # upload + download via R2
    invites.ts         # convites (cliente ou equipa)
    db.ts              # helpers de D1
    crypto.ts          # JWT (jose) + bcrypt (bcryptjs)
    resend.ts          # envio de email via Resend
    middleware.ts      # auth guard, role guard
  schema.sql
  wrangler.toml
  package.json
  tsconfig.json

frontend/              # Cloudflare Pages (HTML/CSS/JS)
  index.html           # redireciona para /login ou /portal
  login.html           # formulário de login
  aceitar.html         # aceitar convite (cliente ou equipa)
  portal/              # área do cliente
    index.html
  admin/               # área do estúdio
    index.html
  shared/
    api.js             # wrapper de fetch
    style.css
```

## Papéis

| Papel | Vê | Cria | Edita | Comenta |
|---|---|---|---|---|
| `studio` (estúdio) | tudo | tudo | tudo | sim |
| `client` (cliente) | só os seus projetos | nada | nada | sim |

Todas as queries D1 verificam `client_id = jwt.userId` quando o chamador é `client`.

## Convenção Kanban

Cada projeto novo é criado com 3 colunas pré-populadas:

1. **A Fazer**
2. **Em Curso**
3. **Concluído**

Posições são inteiros com gaps de 1024 para permitir reordenação sem reescrever tudo.

## Setup local

```bash
make install       # npm install no worker/
make dev           # (2 terminais) make dev-worker + make dev-frontend
```

Antes do primeiro deploy, definir os secrets:

```bash
cd worker
npx wrangler secret put JWT_SECRET
npx wrangler secret put RESEND_KEY
npx wrangler secret put EMAIL_FROM
npx wrangler secret put PUBLIC_URL
```

## Deploy

```bash
make deploy        # worker + frontend, ~30s
```

Push para `main` no GitHub não deploya automaticamente (a integração Git-Pages não está ligada). Usa `make deploy`.

## Comandos úteis

```bash
make status        # listar deploys
make logs          # tail de logs do worker
make schema        # aplicar schema.sql ao D1 local + remoto
```

## Ficheiros

- Tipos permitidos: PDF, PNG, JPG, JPEG, SVG, DWG, DXF, RVT, ZIP
- Limite: 50 MB por ficheiro
- Anexos a um cartão (opcional) ou a um projeto
