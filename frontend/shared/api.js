// shared/api.js — fetch wrapper for the Diernus Portal
// Configures the API base URL and handles JSON, auth, errors.

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

  // Invites
  invite: (email, name, role) => request('/api/invites', { method: 'POST', body: { email, name, role } }),
  invites: () => request('/api/invites'),

  // Projects
  projects: () => request('/api/projects'),
  project:  (id) => request('/api/projects/' + encodeURIComponent(id)),
  createProject: (client_id, name, description) =>
    request('/api/projects', { method: 'POST', body: { client_id, name, description } }),

  // Clients (studio)
  clients: () => request('/api/clients'),
};

// tiny dom helper
export function $(sel, root = document) { return root.querySelector(sel); }
export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    if (k === 'class') e.className = attrs[k];
    else if (k === 'html') e.innerHTML = attrs[k];
    else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  for (const c of children) {
    if (c == null) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

export function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return d.toLocaleDateString('pt-PT', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtDateTime(s) {
  if (!s) return '';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return d.toLocaleString('pt-PT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
