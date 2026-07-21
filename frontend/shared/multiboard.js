// shared/multiboard.js — Jira-style multi-project Kanban (admin only)
//
// Renders a single board that shows cards from every (non-archived) project,
// grouped by status (A Fazer / Em Curso / Concluído). Each card is colored
// with its project so the studio can scan all their work in one place.
//
// - "Todos os projetos" mode → read-only bird's-eye view, drag disabled
// - Click a project chip → focuses that project. Drag-drop is enabled
//   (the real columns are now in play, so the existing move endpoint works),
//   "+ Cartão" buttons become active, and an "Abrir projeto" link goes to
//   the full editor for that project.

import { api } from './api.js';
import { $, escapeHtml, initials, timeAgo } from './layout.js';
import { openCardDetail, openNewCardModal } from './board.js';

const PRIORITY_LABEL = { low: 'baixa', medium: 'média', high: 'alta' };
const PRIORITY_COLOR = {
  low:    { bg: 'rgba(35,33,28,.08)',  fg: 'var(--graphite-60)' },
  medium: { bg: 'rgba(44,73,199,.12)',  fg: 'var(--cobalt)' },
  high:   { bg: 'rgba(179,35,46,.12)',  fg: 'var(--stamp)' },
};

// Default column names every project ships with. We use them to bucket
// cards into the unified 3-column view, regardless of the project's
// actual column IDs.
const STATUS_BUCKETS = ['A Fazer', 'Em Curso', 'Concluído'];

/**
 * Mount a multi-project Kanban board.
 * @param mountEl  HTMLElement to render into
 */
export async function mountMultiBoard(mountEl) {
  const { projects, columns, cards } = await api.boardAll();

  if (projects.length === 0) {
    mountEl.innerHTML = `
      <div class="page-head">
        <div>
          <span class="eyebrow">Quadro geral</span>
          <h1>Sem projetos ainda</h1>
          <p class="lede">Crie um cliente em <a href="/admin/clientes.html">Clientes</a> e depois um projeto em <a href="/admin/projetos.html">Projetos</a> — eles aparecem aqui automaticamente.</p>
        </div>
      </div>`;
    return;
  }

  // deterministic per-project color (so the same project always gets the same hue)
  const projectColor = new Map();
  for (const p of projects) projectColor.set(p.id, colorForId(p.id));

  // session state: which project is focused, or null = "Todos"
  let focused = null; // project.id | null

  // build the header (chips + actions)
  const header = document.createElement('div');
  header.className = 'board-head';
  header.innerHTML = `
    <div>
      <span class="eyebrow">Quadro geral</span>
      <h1>Todos os projetos</h1>
      <p class="lede">${projects.length} ${projects.length === 1 ? 'projeto' : 'projetos'} · ${cards.length} ${cards.length === 1 ? 'cartão' : 'cartões'}</p>
    </div>
    <div class="board-meta" id="boardActions"></div>
  `;
  mountEl.appendChild(header);

  // project filter chips
  const chips = document.createElement('div');
  chips.className = 'board-filter';
  const allChip = chipEl('all', null, projects.length, null, `Todos (${projects.length})`);
  allChip.classList.add('is-active');
  chips.appendChild(allChip);
  for (const p of projects) {
    const count = cards.filter(c => c.project_id === p.id).length;
    const chip = chipEl(p.id, p.name, count, projectColor.get(p.id), p.name);
    chips.appendChild(chip);
  }
  mountEl.appendChild(chips);

  // the kanban itself (we re-render this on focus change)
  const boardHost = document.createElement('div');
  mountEl.appendChild(boardHost);

  // chip click → focus change
  chips.addEventListener('click', e => {
    const chip = e.target.closest('.board-filter-chip');
    if (!chip) return;
    focused = chip.dataset.project === 'all' ? null : chip.dataset.project;
    // re-render chips + board
    for (const c of chips.querySelectorAll('.board-filter-chip')) c.classList.remove('is-active');
    chip.classList.add('is-active');
    updateHeader();
    renderBoard();
  });

  function updateHeader() {
    const proj = focused ? projects.find(p => p.id === focused) : null;
    const meta = header.querySelector('#boardActions');
    if (proj) {
      header.querySelector('h1').textContent = proj.name;
      header.querySelector('.lede').textContent =
        `${proj.client_name} · ${cards.filter(c => c.project_id === proj.id).length} cartões`;
      meta.innerHTML = `
        <span class="meta-pill"><span class="meta-label">€/hora</span><span class="meta-value">${proj.hourly_rate != null ? Number(proj.hourly_rate).toFixed(0) + ' €' : '—'}</span></span>
        <span class="meta-pill"><span class="meta-label">orçamento</span><span class="meta-value">${proj.budget_hours != null ? proj.budget_hours + ' h' : '—'}</span></span>
        <a class="btn sm ghost" href="/admin/projeto.html?id=${encodeURIComponent(proj.id)}">Abrir projeto ›</a>
      `;
    } else {
      header.querySelector('h1').textContent = 'Todos os projetos';
      header.querySelector('.lede').textContent =
        `${projects.length} projetos · ${cards.length} cartões`;
      meta.innerHTML = '';
    }
  }

  async function renderBoard() {
    await loadSortable();
    boardHost.innerHTML = '';
    const board = document.createElement('div');
    board.className = 'kanban';

    // decide which cards to show + how to group them
    const visibleCards = focused ? cards.filter(c => c.project_id === focused) : cards;
    const projectColumns = focused
      ? columns.filter(c => c.project_id === focused)   // real columns, for drag-drop
      : columns;                                         // grouped by name in each bucket

    // build a map column_id → { project_id, name, position }
    const colIndex = new Map();
    for (const c of columns) colIndex.set(c.id, c);

    // for "Todos" mode, virtual columns don't have IDs. We still need a Sortable
    // target per status bucket, so we synthesize one. In "focused" mode, the
    // real column IDs go straight into Sortable and the move endpoint works.
    const buckets = STATUS_BUCKETS.map((name, i) => ({
      name,
      key: 'bucket:' + name,
      // in focused mode, find the project's column matching this status name
      realColumnId: focused ? (projectColumns.find(c => c.name === name)?.id || null) : null,
      // for unified mode we show cards from any project whose column name matches
    }));

    for (const b of buckets) {
      const inBucket = visibleCards.filter(card => {
        const col = colIndex.get(card.column_id);
        return col && col.name === b.name;
      });
      const col = document.createElement('div');
      col.className = 'kcol';
      col.dataset.bucket = b.name;
      col.innerHTML = `
        <div class="kcol-head">
          <span class="kcol-name">${escapeHtml(b.name)}</span>
          <span class="kcol-count">${inBucket.length}</span>
        </div>
        <div class="kcol-cards" data-bucket="${b.name}"></div>
        ${focused ? `<button class="kcol-add" data-real-col="${b.realColumnId || ''}">+ Cartão</button>` : ''}
      `;
      const list = col.querySelector('.kcol-cards');
      for (const card of inBucket) list.appendChild(renderCard(card, projects, projectColor, focused));
      board.appendChild(col);
    }
    boardHost.appendChild(board);

    // drag-drop: only in focused mode
    if (focused && window.Sortable) {
      for (const list of board.querySelectorAll('.kcol-cards')) {
        window.Sortable.create(list, {
          group: 'multiboard-' + focused,
          animation: 150,
          ghostClass: 'kcard-ghost',
          chosenClass: 'kcard-chosen',
          dragClass: 'kcard-drag',
          forceFallback: true,
          onEnd: async (ev) => {
            const cardId = ev.item.dataset.cardId;
            const newBucket = ev.to.dataset.bucket;
            const realCol = STATUS_BUCKETS.includes(newBucket)
              ? (projectColumns.find(c => c.name === newBucket)?.id)
              : null;
            if (!realCol) { console.error('no real column for', newBucket); renderBoard(); return; }
            const ids = Array.from(ev.to.querySelectorAll('.kcard')).map(el => el.dataset.cardId);
            const newPos = ids.indexOf(cardId);
            try {
              await api.moveCard(cardId, realCol, (newPos + 1) * 1024);
            } catch (e) {
              console.error('move failed', e);
            }
            refreshCounts(board);
          },
        });
      }
    }

    // "+ Cartão" button (focused mode only)
    if (focused) {
      board.addEventListener('click', e => {
        const addBtn = e.target.closest('.kcol-add');
        if (addBtn) {
          const colId = addBtn.dataset.realCol;
          if (!colId) return;
          openNewCardModal(focused, colId, () => refreshAfterMutation());
        }
      });
    }

    // card click → detail panel
    board.addEventListener('click', e => {
      const cardEl = e.target.closest('.kcard');
      if (!cardEl) return;
      e.preventDefault();
      const cardId = cardEl.dataset.cardId;
      // editable only when focused on the project that owns the card
      const card = cards.find(c => c.id === cardId);
      const canEdit = focused != null && card && card.project_id === focused;
      openCardDetail(cardId, canEdit, () => refreshAfterMutation());
    });
  }

  async function refreshAfterMutation() {
    // simplest: re-fetch everything and re-render
    const fresh = await api.boardAll();
    // mutate the captured state in place
    projects.length = 0; projects.push(...fresh.projects);
    columns.length = 0; columns.push(...fresh.columns);
    cards.length = 0;   cards.push(...fresh.cards);
    renderBoard();
    updateHeader();
    // refresh chip counts
    for (const c of chips.querySelectorAll('.board-filter-chip')) {
      const pid = c.dataset.project;
      const n = pid === 'all' ? cards.length : cards.filter(x => x.project_id === pid).length;
      const countEl = c.querySelector('.chip-count');
      if (countEl) countEl.textContent = String(n);
    }
  }

  function refreshCounts(board) {
    for (const col of board.querySelectorAll('.kcol')) {
      const count = col.querySelectorAll('.kcard').length;
      const badge = col.querySelector('.kcol-count');
      if (badge) badge.textContent = count;
    }
  }

  // first render
  renderBoard();
}

function renderCard(card, projects, projectColor, focused) {
  const div = document.createElement('div');
  div.className = 'kcard';
  div.dataset.cardId = card.id;
  const p = PRIORITY_COLOR[card.priority] || PRIORITY_COLOR.medium;
  const due = card.due_date ? new Date(card.due_date).toLocaleDateString('pt-PT', { day: '2-digit', month: 'short' }) : '';
  const comments = card.comment_count || 0;
  const isOverdue = card.due_date && new Date(card.due_date) < new Date() && card.priority !== 'low';
  const proj = projects.find(x => x.id === card.project_id);
  const projName = proj ? proj.name : '—';
  const projColor = projectColor.get(card.project_id) || 'rgba(0,0,0,.1)';
  const showProjectPill = focused == null; // hide it when focused (the header already names the project)
  div.innerHTML = `
    ${showProjectPill
      ? `<div class="kcard-project" style="background:${projColor}" title="${escapeHtml(projName)}">${escapeHtml(projName)}</div>`
      : ''}
    <div class="kcard-prio" style="background:${p.bg};color:${p.fg}">${PRIORITY_LABEL[card.priority] || card.priority}</div>
    <div class="kcard-title">${escapeHtml(card.title)}</div>
    <div class="kcard-meta">
      ${due ? `<span class="kcard-due ${isOverdue ? 'overdue' : ''}">${due}</span>` : ''}
      ${card.estimated_hours ? `<span class="kcard-hours">${formatHours(card.estimated_hours)}h</span>` : ''}
      ${comments ? `<span class="kcard-comments" title="${comments} comentário${comments>1?'s':''}">💬 ${comments}</span>` : ''}
      ${card.assignee_name ? `<span class="kcard-assignee" title="Atribuído a ${escapeHtml(card.assignee_name)}">${initials(card.assignee_name)}</span>` : ''}
    </div>
  `;
  return div;
}

function chipEl(id, name, count, color, label) {
  const el = document.createElement('button');
  el.className = 'board-filter-chip';
  el.dataset.project = id || 'all';
  el.innerHTML = `
    ${color ? `<span class="chip-dot" style="background:${color}"></span>` : '<span class="chip-dot chip-dot-all"></span>'}
    <span class="chip-label">${escapeHtml(label)}</span>
    <span class="chip-count">${count}</span>
  `;
  return el;
}

function colorForId(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  // pleasant pastel range
  const hue = h % 360;
  return `hsl(${hue}, 55%, 86%)`;
}

function formatHours(h) {
  if (h == null) return '';
  if (Number.isInteger(h)) return String(h);
  return h.toFixed(1).replace(/\.0$/, '');
}

let sortableLoaded = null;
function loadSortable() {
  if (window.Sortable) return Promise.resolve();
  if (sortableLoaded) return sortableLoaded;
  sortableLoaded = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js';
    s.onload = () => resolve();
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return sortableLoaded;
}
