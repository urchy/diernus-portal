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
  bell:     '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3.5 12h9M5 12V8a3 3 0 016 0v4M8 4V3M5 5L4 4M11 5l1-1"/></svg>',
  logout:   '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 3H3v10h3M10 5l3 3-3 3M13 8H6"/></svg>',
};

// 3-role nav: admin and team share the same nav shape, except
// team does NOT see Finanças. The NAV table is built per-role below.
const NAV_BASE = {
  admin: [
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
  team: [
    { group: 'GERAL',    items: [
      { key: 'overview', label: 'Visão geral', href: '/admin/' },
      { key: 'board',    label: 'Quadro geral', href: '/admin/board.html' },
    ]},
    { group: 'GESTÃO',   items: [
      { key: 'projects',  label: 'Projetos',    href: '/admin/projetos.html' },
      { key: 'clients',   label: 'Clientes',    href: '/admin/clientes.html' },
      { key: 'team',      label: 'Equipa',      href: '/admin/equipa.html' },
      // finance is admin-only — omitted for team
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

// Role → display label, used in the sidebar user-block
const ROLE_LABEL = {
  admin: 'admin',
  team:  'equipa',
  client: 'cliente',
};

const NAV = NAV_BASE; // alias so existing `NAV[me.role]` access keeps working

export async function renderLayout({ active, crumbs = [] }) {
  let me;
  try { me = (await api.me()).user; }
  catch { location.replace('/login.html'); throw new Error('not logged in'); }

  // For client users, send to /portal/ if they hit an /admin/ page
  // admin and team both go to /admin/
  if (me.role === 'client' && location.pathname.startsWith('/admin/')) {
    location.replace('/portal/'); throw new Error('not a studio user');
  }
  if (me.role !== 'client' && location.pathname.startsWith('/portal/')) {
    location.replace('/admin/');  throw new Error('not a client');
  }

  // Fall back to empty nav if the role somehow doesn't match (defense in depth)
  const nav = NAV[me.role] || [];
  const isStudio = me.role === 'admin' || me.role === 'team';
  const base = isStudio ? '/admin' : '/portal';
  const roleLabel = ROLE_LABEL[me.role] || (isStudio ? 'estúdio' : 'cliente');

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
        <div class="user-role">${escapeHtml(roleLabel)}</div>
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
  // Both studio and client get the bell now — notifications are bidirectional
  // (client acts → studio bell; studio acts → client bell). The bell
  // renders below the topbar with a soft backdrop so the dropdown reads
  // as foreground, not the page as background.
  const showBell = true;
  topbar.innerHTML = `
    <div class="crumbs">
      ${crumbs.map((c, i) => i < crumbs.length - 1
        ? `<span>${escapeHtml(c)}</span><span class="sep">›</span>`
        : `<span class="current">${escapeHtml(c)}</span>`).join('')}
    </div>
    <span class="spacer"></span>
    <span class="env-pill">${isStudio ? 'estúdio' : 'cliente'}</span>
    ${showBell ? `
    <div class="topbar-bell" id="topbarBell">
      <button class="bell-btn" id="bellBtn" title="Notificações" aria-label="Notificações">
        ${ICON.bell}
        <span class="bell-badge" id="bellBadge" hidden>0</span>
      </button>
      <div class="bell-dropdown" id="bellDropdown" hidden>
        <div class="bell-head">
          <h3>Notificações</h3>
          <button class="btn sm ghost" id="bellMarkAll">Marcar tudo lido</button>
        </div>
        <div class="bell-list" id="bellList">
          <em style="color:var(--graphite-60);font-size:.85rem;padding:.7rem">A carregar…</em>
        </div>
      </div>
    </div>` : ''}
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

  // wire the notification bell (studio only — the markup is gated above)
  const bellBtn = document.getElementById('bellBtn');
  const bellDropdown = document.getElementById('bellDropdown');
  const bellBadge = document.getElementById('bellBadge');
  const bellList = document.getElementById('bellList');
  const bellMarkAll = document.getElementById('bellMarkAll');
  let bellPollHandle = null;
  let bellOpen = false;

  function setBadge(n) {
    if (!bellBadge) return;
    if (n > 0) {
      bellBadge.textContent = n > 99 ? '99+' : String(n);
      bellBadge.hidden = false;
    } else {
      bellBadge.hidden = true;
    }
  }

  function renderBellList(notifications) {
    if (!bellList) return;
    if (!notifications || notifications.length === 0) {
      bellList.innerHTML = '<em style="color:var(--graphite-60);font-size:.85rem;padding:.7rem;display:block;text-align:center">Sem notificações.</em>';
      return;
    }
    // Type → icon + short label + CSS hook. The pill shows the icon and a
    // short label so the user can scan a list of notifications by category.
    const META = {
      client_comment:    { icon: '💬', label: 'Comentário' },
      studio_comment:    { icon: '💬', label: 'Comentário' },
      client_file:       { icon: '📎', label: 'Ficheiro' },
      studio_file:       { icon: '📎', label: 'Ficheiro' },
      card_moved:        { icon: '↗', label: 'Cartão' },
      card_created:      { icon: '+', label: 'Cartão' },
      project_completed: { icon: '✓', label: 'Projeto' },
      project_status:    { icon: 'ⓘ', label: 'Projeto' },
    };
    bellList.innerHTML = notifications.map(n => {
      const m = META[n.type] || { icon: '•', label: 'Notificação' };
      return `
      <a class="bell-item ${n.is_read ? '' : 'unread'}" href="${escapeHtml(n.link)}" data-notif-id="${escapeHtml(n.id)}">
        <div class="bell-item-head">
          <span class="bell-item-type bell-type-${escapeHtml(n.type)}"><span class="bell-item-icon">${m.icon}</span> ${m.label}</span>
          <span class="bell-item-time">${timeAgo(n.created_at)}</span>
        </div>
        <div class="bell-item-title">${escapeHtml(n.title || 'Notificação')}</div>
        <div class="bell-item-msg">${escapeHtml(n.message)}</div>
        <button class="bell-item-dismiss" data-dismiss="${escapeHtml(n.id)}" title="Dispensar">✕</button>
      </a>
    `;}).join('');
    bellList.querySelectorAll('[data-dismiss]').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.preventDefault();
        e.stopPropagation();
        await api.dismissNotification(btn.dataset.dismiss);
        const row = btn.closest('.bell-item');
        if (row) row.remove();
        // refresh the badge count
        refreshUnread();
      });
    });
    bellList.querySelectorAll('.bell-item').forEach(a => {
      a.addEventListener('click', async () => {
        if (!a.classList.contains('unread')) return;
        await api.markRead(a.dataset.notifId);
        a.classList.remove('unread');
        refreshUnread();
      });
    });
  }

  async function refreshUnread() {
    try {
      const { unread_count } = await api.unreadCount();
      setBadge(unread_count);
    } catch (e) { /* silent */ }
  }

  async function refreshBellList() {
    if (!bellList) return;
    try {
      const { notifications } = await api.notifications();
      renderBellList(notifications);
    } catch (e) { /* silent */ }
  }

  if (bellBtn && bellDropdown) {
    // Backdrop: dims the rest of the page when the bell is open so the
    // dropdown clearly sits "above" the content (otherwise the action buttons
    // in the page head are partially covered and look broken).
    let bellBackdrop = null;
    function setBellOpen(open) {
      bellOpen = open;
      bellDropdown.hidden = !open;
      if (open) {
        if (!bellBackdrop) {
          bellBackdrop = document.createElement('div');
          bellBackdrop.className = 'bell-backdrop';
          bellBackdrop.addEventListener('click', () => setBellOpen(false));
          document.body.appendChild(bellBackdrop);
        }
        requestAnimationFrame(() => bellBackdrop.classList.add('on'));
      } else if (bellBackdrop) {
        bellBackdrop.classList.remove('on');
      }
    }

    bellBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      setBellOpen(!bellOpen);
      if (bellOpen) {
        await refreshBellList();
        // focus the first item for keyboard nav
        const first = bellList?.querySelector('.bell-item');
        if (first) first.focus();
      }
    });
    // click outside closes (backdrop click is handled above; this is for
    // clicking on the sidebar while the bell is open)
    document.addEventListener('click', e => {
      if (!bellOpen) return;
      if (e.target.closest('#topbarBell')) return;
      if (e.target.closest('.bell-backdrop')) return;
      setBellOpen(false);
    });
    // Esc closes
    document.addEventListener('keydown', e => {
      if (bellOpen && e.key === 'Escape') {
        setBellOpen(false);
        bellBtn.focus();
      }
    });
  }

  if (bellMarkAll) {
    bellMarkAll.addEventListener('click', async () => {
      await api.markAllRead();
      await refreshBellList();
      await refreshUnread();
    });
  }

  // initial badge + start polling every 30s (only if the bell exists)
  if (bellBadge) {
    refreshUnread();
    bellPollHandle = setInterval(refreshUnread, 30000);
    // pause polling when the tab is hidden, resume on focus
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        clearInterval(bellPollHandle);
        bellPollHandle = null;
      } else if (!bellPollHandle) {
        refreshUnread();
        bellPollHandle = setInterval(refreshUnread, 30000);
      }
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

/**
 * Run a page's main render inside a try/catch with a loading skeleton + an
 * error fallback. Use this instead of raw `await render()` at module top-level
 * so a single failed API call doesn't leave the user staring at a blank page.
 *
 *   const { content } = await renderLayout({ ... });
 *   const loading = pageLoading(content, 'A carregar projetos…');
 *   safeRender(content, loading, async () => {
 *     const { projects } = await api.projects();
 *     content.innerHTML = '...';
 *   });
 */
export function pageLoading(content, label = 'A carregar…') {
  const el = document.createElement('div');
  el.className = 'page-loading';
  el.innerHTML = `<div class="spinner"></div><span>${escapeHtml(label)}</span>`;
  content.appendChild(el);
  return el;
}
export function pageError(loadingEl, err, { backHref, backLabel = '‹ Voltar' } = {}) {
  const msg = (err && err.message) || String(err) || 'erro desconhecido';
  loadingEl.innerHTML = `
    <div class="error" style="max-width:520px;margin:2rem auto">
      <strong>Não foi possível carregar.</strong><br>${escapeHtml(msg)}
      ${backHref ? `<br><br><a class="btn ghost" href="${escapeHtml(backHref)}">${escapeHtml(backLabel)}</a>` : ''}
    </div>`;
}
export async function safeRender(loadingEl, fn) {
  try {
    await fn();
    loadingEl.remove();
  } catch (e) {
    console.error('[safeRender]', e);
    pageError(loadingEl, e);
  }
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
