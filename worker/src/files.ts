// Files — uploaded to R2, attached to projects (and optionally to cards).
// Both studio and client can upload (studio up to 50 MB, clients up to
// 25 MB to keep the bucket tidy). Notifications flow BOTH directions:
//   client uploads  → notifyStudio() (the studio bell lights up)
//   studio uploads  → notifyClient() (the client bell lights up)
import { Hono } from 'hono';
import type { AppVariables, Env, FileRecord, User } from './types.js';
import { requireAuth } from './middleware.js';
import { isStudio, isClient } from './types.js';
import { uuid } from './crypto.js';
import { notifyStudio, notifyClient } from './notifications.js';

export const fileRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();
fileRoutes.use('*', requireAuth);

const MAX_UPLOAD_MB_STUDIO = 50;
const MAX_UPLOAD_MB_CLIENT = 25;
const ALLOWED_MIME = null; // null = allow anything within size limit

async function assertProjectAccess(c: { get: (k: string) => unknown; env: Env }, projectId: string): Promise<'studio' | 'client' | null> {
  const u = c.get('user') as User;
  const p = await c.env.DB
    .prepare('SELECT id, client_id FROM projects WHERE id = ?')
    .bind(projectId)
    .first<{ id: string; client_id: string }>();
  if (!p) return null;
  if (isStudio(u.role)) return 'studio';
  if (isClient(u.role) && p.client_id === u.id) return 'client';
  return null;
}

// GET /api/projects/:id/files — list files in a project (optionally ?card_id=)
fileRoutes.get('/projects/:id/files', async (c) => {
  const access = await assertProjectAccess(c, c.req.param('id'));
  if (!access) return c.json({ error: 'não encontrado' }, 404);
  const cardId = c.req.query('card_id');
  const sql = cardId
    ? `SELECT f.*, u.name AS uploader_name
       FROM files f JOIN users u ON u.id = f.uploaded_by
       WHERE f.project_id = ? AND f.card_id = ?
       ORDER BY f.uploaded_at DESC`
    : `SELECT f.*, u.name AS uploader_name
       FROM files f JOIN users u ON u.id = f.uploaded_by
       WHERE f.project_id = ?
       ORDER BY f.uploaded_at DESC`;
  const stmt = c.env.DB.prepare(sql);
  const rows = cardId
    ? await stmt.bind(c.req.param('id'), cardId).all<any>()
    : await stmt.bind(c.req.param('id')).all<any>();
  return c.json({ files: rows.results });
});

// POST /api/projects/:id/files — upload a file (multipart/form-data)
//   form fields: 'file' (required), 'card_id' (optional)
//   Both studio and client can upload; sizes are capped differently.
fileRoutes.post('/projects/:id/files', async (c) => {
  const access = await assertProjectAccess(c, c.req.param('id'));
  if (!access) return c.json({ error: 'não encontrado' }, 404);

  const me = c.get('user') as User;
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: 'formulário inválido' }, 400);
  const fileRaw = form.get('file');
  const file = fileRaw as File | null;
  if (!file || typeof file === 'object' && !('arrayBuffer' in file)) {
    return c.json({ error: 'campo "file" em falta' }, 400);
  }
  const cardIdRaw = form.get('card_id');
  const cardId = typeof cardIdRaw === 'string' && cardIdRaw.trim() ? cardIdRaw.trim() : null;

  // size cap (studio gets 50 MB, clients 25 MB)
  const maxMb = isStudio(me.role) ? MAX_UPLOAD_MB_STUDIO : MAX_UPLOAD_MB_CLIENT;
  const maxBytes = maxMb * 1024 * 1024;
  if (file.size > maxBytes) {
    return c.json({ error: `ficheiro demasiado grande (máx. ${maxMb} MB)` }, 400);
  }
  // optional mime guard
  if (ALLOWED_MIME && !ALLOWED_MIME.includes((file as any).type)) {
    return c.json({ error: `tipo não permitido: ${file.type}` }, 400);
  }
  // if a card_id was provided, make sure it belongs to this project
  if (cardId) {
    const card = await c.env.DB
      .prepare('SELECT id, project_id FROM cards WHERE id = ?')
      .bind(cardId)
      .first<{ id: string; project_id: string }>();
    if (!card || card.project_id !== c.req.param('id')) {
      return c.json({ error: 'cartão não pertence a este projeto' }, 400);
    }
  }

  const id = uuid();
  const safeName = file.name.replace(/[^\w.\- ]+/g, '_').slice(0, 200);
  const r2Key = `${c.req.param('id')}/${id}/${safeName}`;
  const buf = await file.arrayBuffer();
  await c.env.FILES.put(r2Key, buf, {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
    customMetadata: { originalName: safeName, uploadedBy: me.id },
  });
  await c.env.DB
    .prepare(`INSERT INTO files (id, project_id, card_id, filename, r2_key, size, mime_type, uploaded_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, c.req.param('id'), cardId, safeName, r2Key, file.size, file.type || 'application/octet-stream', me.id)
    .run();
  const record = await c.env.DB
    .prepare('SELECT * FROM files WHERE id = ?')
    .bind(id)
    .first<FileRecord>();

  // Notify the other side — client upload pings studio, studio upload pings client.
  const ctx = await c.env.DB
    .prepare(`SELECT name FROM projects WHERE id = ?`)
    .bind(c.req.param('id'))
    .first<{ name: string }>();
  const where = cardId ? ' (no cartão)' : '';
  if (isClient(me.role)) {
    await notifyStudio(c.env, {
      type: 'client_file',
      refKind: 'project',
      refId: c.req.param('id'),
      actor: me,
      message: `“${safeName}” em ${ctx?.name || 'o projeto'}${where}`,
      link: `/admin/projeto.html?id=${c.req.param('id')}${cardId ? `&card=${cardId}` : ''}`,
    });
  } else {
    await notifyClient(c.env, {
      projectId: c.req.param('id'),
      type: 'studio_file',
      refKind: 'project',
      refId: c.req.param('id'),
      actor: me,
      message: `“${safeName}” em ${ctx?.name || 'o projeto'}${where}`,
      link: `/portal/projeto.html?id=${c.req.param('id')}${cardId ? `&card=${cardId}` : ''}`,
    });
  }
  return c.json({ file: record }, 201);
});

// GET /api/files/:id — download a file (streams from R2)
fileRoutes.get('/files/:id', async (c) => {
  const file = await c.env.DB
    .prepare('SELECT * FROM files WHERE id = ?')
    .bind(c.req.param('id'))
    .first<FileRecord>();
  if (!file) return c.json({ error: 'ficheiro não encontrado' }, 404);
  const access = await assertProjectAccess(c, file.project_id);
  if (!access) return c.json({ error: 'forbidden' }, 403);

  const obj = await c.env.FILES.get(file.r2_key);
  if (!obj) return c.json({ error: 'ficheiro em falta no armazenamento' }, 404);
  // filename* (RFC 5987) for non-ASCII
  const ascii = file.filename.replace(/[^\x20-\x7E]/g, '_');
  const utf8 = encodeURIComponent(file.filename);
  const headers = new Headers();
  headers.set('Content-Type', file.mime_type || obj.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`);
  headers.set('Content-Length', String(file.size));
  return new Response(obj.body, { headers });
});

// DELETE /api/files/:id — delete a file (studio only)
fileRoutes.delete('/files/:id', async (c) => {
  const u = c.get('user') as User;
  if (!isStudio(u.role)) return c.json({ error: 'forbidden' }, 403);
  const file = await c.env.DB
    .prepare('SELECT * FROM files WHERE id = ?')
    .bind(c.req.param('id'))
    .first<FileRecord>();
  if (!file) return c.json({ error: 'ficheiro não encontrado' }, 404);
  await c.env.FILES.delete(file.r2_key).catch(() => null);  // best-effort
  await c.env.DB.prepare('DELETE FROM files WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});
