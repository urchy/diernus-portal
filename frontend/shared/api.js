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
};
