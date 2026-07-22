// shared/layout.js — sidebar + topbar, role-aware nav, page rendering
// Each page calls `renderLayout({ active, crumbs, body })` once.

import { api } from './api.js';

const ICON = {
  overview: '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>',
  projects: '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="10" rx="1"/><line x1="2" y1="6" x2="14" y2="6"/></svg>',
  board:    '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="3" height="12" rx=".5"/><rect x="6.5" y="2" width="3" height="8" rx=".5"/><rect x="11" y="2" width="3" height="5" rx=".5"/></svg>',
  clients:  '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="6" r="2.5"/><path d="M3 14c0-2.8 2.2-5 5-5s5 2.2 5 5"/></svg>',
  team:     '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6" cy="6" r="2"/><circle cx="12" cy="6" r="2"/><path d="M2 14c0-2 1.6-3.5 4-3.5M14 14c0-2-1.6-3.5-4-3.5"/></svg>',
  finance:  '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 13h12M3 10l3-3 3 2 4-5M11 4h2v2"/></svg>',
  invites:  '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="12" height="9" rx="1"/><path d="M2 4l6 5 6-5"/></svg>',
  logout:   '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 3H3v10h3M10 5l3 3-3 3M13 8H6"/></svg>',
};

const NAV = {
  studio: [
    { group: 'GERAL',    items: [
      { key: 'overview', label: 'Visão geral', href: '/admin/' },
      { key: 'board',    label: 'Quadro geral', href: '/admin/board.html' },
    ]},
    { group: 'GESTÃO',   items: [
      { key: 'projects',  label: 'Projetos',    href: '/admin/projetos.html' },
      { key: 'clients',   label: 'Clientes',    href: '/admin/clientes.html' },
      { key: 'team',      label: 'Equipa',      href: '/admin/equipa.html' },
      { key: 'finance',   label: 'Finanças',    href: '/admin/financas.html' },
    ]},
    { group: 'COMUNICAÇÃO', items: [
      { key: 'invites',   label: 'Convites',    href: '/admin/convites.html' },
    ]},
  ],
  client: [
    { group: 'GERAL', items: [
      { key: 'overview', label: 'Visão geral', href: '/portal/' },
    ]},
    { group: 'PROJETOS', items: [
      { key: 'projects', label: 'Meus projetos', href: '/portal/' },
    ]},
  ],
};

export async function renderLayout({ active, crumbs = [] }) {
  let me;
  try { me = (await api.me()).user; }
  catch { location.replace('/login.html'); throw new Error('not logged in'); }

  // For client users, send to /portal/ if they hit an /admin/ page
  if (me.role !== 'studio' && location.pathname.startsWith('/admin/')) {
    location.replace('/portal/'); throw new Error('not a studio user');
  }
  if (me.role === 'studio' && location.pathname.startsWith('/portal/')) {
    location.replace('/admin/');  throw new Error('not a client');
  }

  const nav = NAV[me.role];
  const isStudio = me.role === 'studio';
  const base = isStudio ? '/admin' : '/portal';

  const initial = (me.name || me.email).trim().charAt(0).toUpperCase();

  // build sidebar
  const sidebar = document.createElement('aside');
  sidebar.className = 'sidebar';
  sidebar.innerHTML = `
    <a class="brand" href="${base}/">
      <b>D</b>
      <span>DIERNUS ${isStudio ? '· ADMIN' : '· PORTAL'}</span>
    </a>
    <nav>
      ${nav.map(g => `
        <div class="nav-group">
          <div class="nav-label">${g.group}</div>
          ${g.items.map(i => `
            <a class="nav-item ${i.key === active ? 'is-active' : ''}" href="${i.href}">
              ${ICON[i.key] || ''}
              <span>${i.label}</span>
            </a>
          `).join('')}
        </div>
      `).join('')}
    </nav>
    <div class="user-block">
      <div class="avatar">${escapeHtml(initial)}</div>
      <div class="user-meta">
        <div class="user-name">${escapeHtml(me.name)}</div>
        <div class="user-role">${isStudio ? 'estúdio' : 'cliente'}</div>
      </div>
      <button class="logout" id="logout" title="Sair">
        ${ICON.logout}
        <span>Sair</span>
      </button>
    </div>
  `;

  // build topbar
  const topbar = document.createElement('header');
  topbar.className = 'topbar';
  topbar.innerHTML = `
    <div class="crumbs">
      ${crumbs.map((c, i) => i < crumbs.length - 1
        ? `<span>${escapeHtml(c)}</span><span class="sep">›</span>`
        : `<span class="current">${escapeHtml(c)}</span>`).join('')}
    </div>
    <span class="spacer"></span>
    <span class="env-pill">${isStudio ? 'estúdio' : 'cliente'}</span>
    <span class="user-chip">${escapeHtml(me.name)}</span>
  `;

  // wrap the existing body without destroying the script element
  // (innerHTML='' would remove the running <script> tag and break the rest of the page)
  const oldContent = document.getElementById('app');
  const content = oldContent || document.createElement('main');
  content.className = 'content';

  // Remove any siblings of the script tag that came after the original <main id="app">.
  // Walk the body and keep only: <script> tags, our new sidebar, and our new main wrapper.
  const keep = new Set();
  keep.add(sidebar);
  // find the <main id="app"> and prepare to wrap it
  const main = document.createElement('div');
  main.className = 'main';
  main.appendChild(topbar);
  main.appendChild(content);
  keep.add(main);

  // remove every direct child of body that isn't a <script>, a modal, or something we want to keep
  const toRemove = [];
  for (const child of Array.from(document.body.children)) {
    if (child.tagName === 'SCRIPT') continue;
    if (child.classList && child.classList.contains('modal-back')) continue;  // keep modals in the body
    if (keep.has(child)) continue;
    toRemove.push(child);
  }
  toRemove.forEach(el => el.remove());

  document.body.classList.add('shell');
  // insert sidebar at the start of body, main after it
  document.body.insertBefore(sidebar, document.body.firstChild);
  // if main isn't already in body, append it
  if (!main.parentNode) document.body.appendChild(main);

  // wire logout
  const logoutBtn = document.getElementById('logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await api.logout();
      location.replace('/login.html');
    });
  }

  return { me, content };
}

export function $(sel, root = document) { return root.querySelector(sel); }
export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    if (k === 'class') e.className = attrs[k];
    else if (k === 'html') e.innerHTML = attrs[k];
    else if (k === 'on' && attrs[k]) for (const ev in attrs[k]) e.addEventListener(ev, attrs[k][ev]);
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
export function timeAgo(s) {
  if (!s) return '';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  const ms = Date.now() - d.getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'agora mesmo';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const d2 = Math.floor(h / 24);
  if (d2 < 30) return `há ${d2} d`;
  return fmtDate(s);
}
export function initials(name) {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map(p => p.charAt(0).toUpperCase()).join('');
}
export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// showToast — quick bottom-right notice (used by boards, modals, etc.)
export function showToast(msg) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  requestAnimationFrame(() => el.classList.add('on'));
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    el.classList.remove('on');
  }, 3200);
}
