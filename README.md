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
| `admin` (estúdio, owner) | tudo (incluindo Finanças) | tudo | tudo | sim |
| `team` (estúdio, membro) | tudo **exceto** Finanças | tudo exceto convidar admins / ver finanças | tudo | sim |
| `client` (cliente) | só os seus projetos | nada | nada | sim |

O `admin` pode promover um `team` a `admin` directamente na BD (não há UI para isso por agora — o estúdio é pequeno). Todas as queries D1 verificam `client_id = jwt.userId` quando o chamador é `client`. O middleware `requireStudio` aceita `admin` e `team`; `requireAdmin` só aceita `admin`.

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
npx wrangler secret put GOOGLE_CLIENT_ID        # opcional, para SSO Google
npx wrangler secret put GOOGLE_CLIENT_SECRET    # opcional, para SSO Google
```

## Autenticação

Duas opções, ambas funcionam em paralelo:

1. **Email + palavra-passe** — fluxo clássico. O admin cria o utilizador (cliente ou equipa), envia o convite, e a pessoa aceita em `/aceitar.html` definindo a sua palavra-passe.
2. **Google SSO** — o utilizador clica "Continuar com Google" no login. Se o email já existir na BD, faz login com a role existente; se não existir, é criado como `client` (admins só por convite). Utilizadores convidados com `status='pending'` são activados automaticamente no primeiro sign-in Google.

### Setup do Google OAuth (10 min, one-off)

1. Ir a [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials)
2. Criar um projeto (ou usar um existente) → **Configure consent screen**:
   - User type: **External**
   - App name: `Diernus Portal`
   - Support email: o teu email
   - Scopes: `openid`, `email`, `profile`
   - **Test users**: adicionar `andre@diernus.com` e `cliente.demo@diernus.com` (e qualquer outro que vá testar)
3. Voltar a **Credentials** → **Create credentials** → **OAuth 2.0 Client ID** → Web application:
   - Name: `Diernus Portal`
   - **Authorized JavaScript origins**:
     - `https://diernus-portal.pages.dev`               (staging)
     - `https://diernus-portal-api.silva-andre-daniel.workers.dev`  (staging API)
     - `https://portal.diernus.com`                     (produção, depois do cutover)
     - `https://diernus-portal-api.diernus.com`         (produção API, depois do cutover)
   - **Authorized redirect URIs**:
     - `https://diernus-portal-api.silva-andre-daniel.workers.dev/api/auth/google/callback`  (staging)
     - `https://diernus-portal-api.diernus.com/api/auth/google/callback`  (produção, depois do cutover)
4. Copiar o **Client ID** e o **Client Secret** e pôr como secrets:
   ```bash
   cd worker
   npx wrangler secret put GOOGLE_CLIENT_ID        # colar o Client ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET    # colar o Client Secret
   ```
5. Testar: abrir `https://diernus-portal.pages.dev/login.html`, clicar "Continuar com Google", escolher a conta, e deves voltar ao `/admin/` ou `/portal/`.

**Nota sobre domínio de produção:** até o `diernus.com` estar na Cloudflare, o fluxo só funciona no URL de staging. Quando o domínio migrar, basta adicionar os 2 novos URIs ao mesmo OAuth client no Google Cloud — não é preciso criar um novo client.

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
