// shared/api.js — fetch wrapper for the Diernus Portal
// Points at the deployed Worker (cross-origin Pages → Workers).

const API_BASE = 'https://diernus-portal-api.silva-andre-daniel.workers.dev';

async function request(path, options = {}) {
  const opts = {
    method: options.method || 'GET',
    credentials: 'include',
    headers: { 'Accept': 'application/json', ...(options.headers || {}) },
  };
  if (options.body && typeof options.body !== 'string' && !(options.body instanceof FormData)) {
    opts.body = JSON.stringify(options.body);
    opts.headers['Content-Type'] = 'application/json';
  } else if (options.body) {
    opts.body = options.body;
  }
  const res = await fetch(API_BASE + path, opts);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  base: API_BASE,

  // Auth
  me:    () => request('/api/auth/me'),
  login: (email, password) => request('/api/auth/login', { method: 'POST', body: { email, password } }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),

  // Clients (studio)
  clients:    () => request('/api/clients'),
  client:     (id) => request('/api/clients/' + encodeURIComponent(id)),
  createClient: (email, name) => request('/api/clients', { method: 'POST', body: { email, name } }),
  inviteClient: (id) => request('/api/clients/' + encodeURIComponent(id) + '/invite', { method: 'POST' }),
  deleteClient: (id) => request('/api/clients/' + encodeURIComponent(id), { method: 'DELETE' }),

  // Team (studio)
  team:     () => request('/api/invites'),
  inviteTeam: (email, name) => request('/api/invites', { method: 'POST', body: { email, name, role: 'studio' } }),
  reInvite: (email, name, role) => request('/api/invites', { method: 'POST', body: { email, name, role } }),

  // Projects
  projects: () => request('/api/projects'),
  project:  (id) => request('/api/projects/' + encodeURIComponent(id)),
  createProject: (client_id, name, description) =>
    request('/api/projects', { method: 'POST', body: { client_id, name, description } }),
  updateProject: (id, patch) =>
    request('/api/projects/' + encodeURIComponent(id), { method: 'PATCH', body: patch }),

  // Board
  board: (projectId) => request('/api/projects/' + encodeURIComponent(projectId) + '/board'),
  boardAll: () => request('/api/board'),
  createCard: (projectId, body) =>
    request('/api/projects/' + encodeURIComponent(projectId) + '/cards', { method: 'POST', body }),
  updateCard: (id, patch) =>
    request('/api/cards/' + encodeURIComponent(id), { method: 'PATCH', body: patch }),
  moveCard:   (id, column_id, position) =>
    request('/api/cards/' + encodeURIComponent(id) + '/move', { method: 'POST', body: { column_id, position } }),
  deleteCard: (id) => request('/api/cards/' + encodeURIComponent(id), { method: 'DELETE' }),
  card:       (id) => request('/api/cards/' + encodeURIComponent(id)),

  // Comments
  comments: (cardId) => request('/api/cards/' + encodeURIComponent(cardId) + '/comments'),
  addComment: (cardId, body) =>
    request('/api/cards/' + encodeURIComponent(cardId) + '/comments', { method: 'POST', body: { body } }),

  // Team (assignable studio members)
  teamMembers: () => request('/api/team/members'),

  // Time entries (log hours against a card; studio only)
  timeEntries: (cardId) =>
    request('/api/cards/' + encodeURIComponent(cardId) + '/time-entries'),
  logHours: (cardId, hours, note) =>
    request('/api/cards/' + encodeURIComponent(cardId) + '/time-entries', {
      method: 'POST', body: { hours, note: note || undefined },
    }),
  deleteTimeEntry: (id) =>
    request('/api/time-entries/' + encodeURIComponent(id), { method: 'DELETE' }),

  // Finance summary (studio only)
  financeSummary: (year, month) => {
    const q = new URLSearchParams();
    if (year) q.set('year', String(year));
    if (month) q.set('month', String(month));
    const qs = q.toString();
    return request('/api/finance/summary' + (qs ? '?' + qs : ''));
  },

  // Notifications (in-app bell)
  notifications: () => request('/api/notifications'),
  unreadCount: () => request('/api/notifications/unread-count'),
  markAllRead: () => request('/api/notifications/mark-all-read', { method: 'POST' }),
  markRead: (id) => request('/api/notifications/mark-read/' + encodeURIComponent(id), { method: 'POST' }),
  dismissNotification: (id) => request('/api/notifications/' + encodeURIComponent(id), { method: 'DELETE' }),

  // Files
  projectFiles: (projectId) =>
    request('/api/projects/' + encodeURIComponent(projectId) + '/files'),
  cardFiles: (projectId, cardId) =>
    request('/api/projects/' + encodeURIComponent(projectId) + '/files?card_id=' + encodeURIComponent(cardId)),
  uploadFile: async (projectId, file, cardId) => {
    const fd = new FormData();
    fd.append('file', file);
    if (cardId) fd.append('card_id', cardId);
    const res = await fetch(API_BASE + '/api/projects/' + encodeURIComponent(projectId) + '/files', {
      method: 'POST',
      body: fd,
      credentials: 'include',
    });
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json().catch(() => null) : await res.text();
    if (!res.ok) {
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  },
  deleteFile: (fileId) =>
    request('/api/files/' + encodeURIComponent(fileId), { method: 'DELETE' }),
  fileDownloadUrl: (fileId) => API_BASE + '/api/files/' + encodeURIComponent(fileId),
};
