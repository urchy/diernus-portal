// shared/board.js — Kanban board component
// Renders the board (columns + cards), handles drag-drop, and shows a
// card-detail side panel with comments.

import { api } from './api.js';
import { $, fmtDate, fmtDateTime, timeAgo, escapeHtml, initials } from './layout.js';

const PRIORITY_LABEL = { low: 'baixa', medium: 'média', high: 'alta' };
const PRIORITY_COLOR = {
  low:    { bg: 'rgba(35,33,28,.08)',  fg: 'var(--graphite-60)' },
  medium: { bg: 'rgba(44,73,199,.12)',  fg: 'var(--cobalt)' },
  high:   { bg: 'rgba(179,35,46,.12)',  fg: 'var(--stamp)' },
};

/**
 * Mount a Kanban board into `mountEl`.
 * @param mountEl  HTMLElement to render into
 * @param projectId  string
 * @param access  'studio' | 'client'
 */
export async function mountBoard(mountEl, projectId, access) {
  const { project, columns, cards } = await api.board(projectId);
  const canEdit = access === 'studio';

  // header
  const header = document.createElement('div');
  header.className = 'board-head';
  header.innerHTML = `
    <div>
      <h1>${escapeHtml(project.name)}</h1>
      <p class="lede">${escapeHtml(project.client_name)} · ${escapeHtml(project.client_email)}</p>
    </div>
    <div class="board-meta">
      ${project.hourly_rate != null
        ? `<span class="meta-pill"><span class="meta-label">€/hora</span><span class="meta-value">${Number(project.hourly_rate).toFixed(0)} €</span></span>` : ''}
      ${project.budget_hours != null
        ? `<span class="meta-pill"><span class="meta-label">orçamento</span><span class="meta-value">${formatHours(project.budget_hours)} h</span></span>` : ''}
      <span class="meta-pill"><span class="meta-label">cartões</span><span class="meta-value">${cards.length}</span></span>
      ${canEdit ? '<button class="btn sm ghost" id="editMeta">Editar preço/orçamento</button>' : ''}
    </div>
  `;
  mountEl.appendChild(header);

  // load SortableJS from CDN (only once)
  await loadSortable();

  // build the board
  const board = document.createElement('div');
  board.className = 'kanban';
  // group cards by column
  const byCol = new Map();
  for (const c of columns) byCol.set(c.id, []);
  for (const card of cards) {
    if (byCol.has(card.column_id)) byCol.get(card.column_id).push(card);
  }
  for (const c of columns) {
    const col = document.createElement('div');
    col.className = 'kcol';
    col.dataset.colId = c.id;
    const colCards = (byCol.get(c.id) || []).sort((a, b) => a.position - b.position);
    col.innerHTML = `
      <div class="kcol-head">
        <span class="kcol-name">${escapeHtml(c.name)}</span>
        <span class="kcol-count">${colCards.length}</span>
      </div>
      <div class="kcol-cards" data-col-id="${c.id}"></div>
      ${canEdit ? `<button class="kcol-add" data-col-id="${c.id}">+ Cartão</button>` : ''}
    `;
    const list = col.querySelector('.kcol-cards');
    for (const card of colCards) list.appendChild(renderCard(card, canEdit));
    board.appendChild(col);
  }
  mountEl.appendChild(board);

  // drag-and-drop (only if studio)
  if (canEdit && window.Sortable) {
    for (const list of board.querySelectorAll('.kcol-cards')) {
      window.Sortable.create(list, {
        group: 'kanban',
        animation: 150,
        ghostClass: 'kcard-ghost',
        chosenClass: 'kcard-chosen',
        dragClass: 'kcard-drag',
        forceFallback: true,
        onEnd: async (ev) => {
          const cardId = ev.item.dataset.cardId;
          const newColId = ev.to.dataset.colId;
          // reorder positions in the destination column
          const ids = Array.from(ev.to.querySelectorAll('.kcard')).map(el => el.dataset.cardId);
          const newPos = ids.indexOf(cardId);
          try {
            await api.moveCard(cardId, newColId, (newPos + 1) * 1024);
          } catch (e) {
            console.error('move failed', e);
          }
          // update column counts
          refreshColumnCounts(board);
        },
      });
    }
  }

  // "+ Cartão" button
  if (canEdit) {
    board.addEventListener('click', e => {
      const addBtn = e.target.closest('.kcol-add');
      if (addBtn) openNewCardModal(projectId, addBtn.dataset.colId, () => refresh(board, mountEl, projectId, access));
    });
  }

  // card click → detail panel
  board.addEventListener('click', e => {
    const cardEl = e.target.closest('.kcard');
    if (!cardEl) return;
    e.preventDefault();
    openCardDetail(cardEl.dataset.cardId, canEdit, () => refresh(board, mountEl, projectId, access));
  });

  // "Editar preço/orçamento" button
  const editMeta = header.querySelector('#editMeta');
  if (editMeta) editMeta.addEventListener('click', () => openEditMetaModal(project, () => location.reload()));
}

function renderCard(card, canEdit) {
  const div = document.createElement('div');
  div.className = 'kcard';
  div.dataset.cardId = card.id;
  const p = PRIORITY_COLOR[card.priority] || PRIORITY_COLOR.medium;
  const due = card.due_date ? new Date(card.due_date).toLocaleDateString('pt-PT', { day: '2-digit', month: 'short' }) : '';
  const comments = card.comment_count || 0;
  const isOverdue = card.due_date && new Date(card.due_date) < new Date() && card.priority !== 'low';
  div.innerHTML = `
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

function refreshColumnCounts(board) {
  for (const col of board.querySelectorAll('.kcol')) {
    const count = col.querySelectorAll('.kcard').length;
    const badge = col.querySelector('.kcol-count');
    if (badge) badge.textContent = count;
  }
}

async function refresh(board, mountEl, projectId, access) {
  // re-fetch the board and re-render cards (simpler than patching in place)
  mountEl.querySelectorAll('.kanban').forEach(n => n.remove());
  mountEl.querySelector('.board-head')?.remove();
  await mountBoard(mountEl, projectId, access);
  // re-mount handler
  // (handlers re-bind via the new mount; no need to re-attach)
}

export async function openNewCardModal(projectId, columnId, onCreated) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-back on';
  overlay.innerHTML = `
    <div class="modal">
      <h2>+ Cartão</h2>
      <div class="error" id="err" style="display:none"></div>
      <form id="form">
        <label class="field"><label>Título</label><input name="title" required autofocus></label>
        <label class="field"><label>Descrição (opcional)</label><textarea name="description" rows="3"></textarea></label>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:.7rem">
          <label class="field"><label>Prioridade</label><select name="priority"><option value="low">baixa</option><option value="medium" selected>média</option><option value="high">alta</option></select></label>
          <label class="field"><label>Prazo (opcional)</label><input type="date" name="due_date"></label>
          <label class="field"><label>Horas estimadas</label><input type="number" name="estimated_hours" step="0.5" min="0"></label>
        </div>
        <div class="row" style="display:flex;gap:.55rem">
          <button type="button" class="btn ghost" id="cancel" style="flex:1;justify-content:center;padding:.55rem">Cancelar</button>
          <button type="submit" class="btn primary" id="submit" style="flex:1;justify-content:center;padding:.55rem">Criar cartão</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#form').addEventListener('submit', async e => {
    e.preventDefault();
    const data = new FormData(e.target);
    const submit = overlay.querySelector('#submit');
    submit.disabled = true; submit.textContent = 'A criar…';
    try {
      const body = {
        column_id: columnId,
        title: data.get('title'),
        description: data.get('description') || undefined,
        priority: data.get('priority') || 'medium',
        due_date: data.get('due_date') || undefined,
        estimated_hours: data.get('estimated_hours') ? Number(data.get('estimated_hours')) : undefined,
      };
      await api.createCard(projectId, body);
      overlay.remove();
      onCreated();
    } catch (err) {
      const el = overlay.querySelector('#err');
      el.textContent = err.message;
      el.style.display = '';
      submit.disabled = false; submit.textContent = 'Criar cartão';
    }
  });
}

export async function openCardDetail(cardId, canEdit, onChange) {
  const overlay = document.createElement('div');
  overlay.className = 'card-detail-back on';
  const { card, comments } = await api.card(cardId);
  overlay.innerHTML = `
    <div class="card-detail">
      <header class="card-detail-head">
        <div>
          <div class="cd-meta">${PRIORITY_BADGE(card.priority)} ${card.due_date ? `<span class="cd-pill">${new Date(card.due_date).toLocaleDateString('pt-PT')}</span>` : ''} ${card.estimated_hours ? `<span class="cd-pill">${formatHours(card.estimated_hours)} h estimadas</span>` : ''} ${card.actual_hours ? `<span class="cd-pill">${formatHours(card.actual_hours)} h gastas</span>` : ''}</div>
          <h2>${escapeHtml(card.title)}</h2>
        </div>
        <button class="cd-close" id="cdClose" title="Fechar">✕</button>
      </header>
      <div class="cd-body">
        <section class="cd-section">
          <h3>Descrição</h3>
          <div class="cd-desc">${card.description ? escapeHtml(card.description).replace(/\n/g, '<br>') : '<em style="color:var(--graphite-60)">Sem descrição</em>'}</div>
        </section>
        ${canEdit ? `
        <section class="cd-section">
          <h3>Estado</h3>
          <div class="row" style="display:flex;gap:.5rem;flex-wrap:wrap">
            <button class="btn sm ghost" data-act="priority" data-value="low">Baixa</button>
            <button class="btn sm ghost" data-act="priority" data-value="medium">Média</button>
            <button class="btn sm ghost" data-act="priority" data-value="high">Alta</button>
            <button class="btn sm ghost" data-act="delete" style="color:var(--stamp)">Apagar cartão</button>
          </div>
        </section>` : ''}
        <section class="cd-section">
          <h3>Comentários (${comments.length})</h3>
          <div class="cd-comments">
            ${comments.length === 0
              ? '<em style="color:var(--graphite-60);font-size:.85rem">Sem comentários. Adicione o primeiro abaixo.</em>'
              : comments.map(c => `
                <div class="cd-comment">
                  <div class="cd-comment-head">
                    <span class="cd-author">${escapeHtml(c.author_name)}</span>
                    <span class="cd-role cd-role-${c.author_role}">${c.author_role === 'studio' ? 'estúdio' : 'cliente'}</span>
                    <span class="cd-time">${timeAgo(c.created_at)}</span>
                  </div>
                  <div class="cd-comment-body">${escapeHtml(c.body).replace(/\n/g, '<br>')}</div>
                </div>
              `).join('')}
          </div>
          <form id="cmtForm" class="cd-cmt-form">
            <textarea name="body" placeholder="${canEdit ? 'Adicionar nota interna ou atualizar o cliente…' : 'Adicionar comentário…'}" rows="3" required></textarea>
            <button class="btn primary" type="submit" id="cmtSubmit">${canEdit ? 'Enviar comentário' : 'Comentar'}</button>
          </form>
        </section>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#cdClose').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  // priority buttons
  if (canEdit) {
    overlay.addEventListener('click', async e => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'priority') {
        try {
          await api.updateCard(cardId, { priority: btn.dataset.value });
          overlay.remove();
          onChange();
        } catch (err) { alert(err.message); }
      } else if (btn.dataset.act === 'delete') {
        if (!confirm('Apagar este cartão?')) return;
        try {
          await api.deleteCard(cardId);
          overlay.remove();
          onChange();
        } catch (err) { alert(err.message); }
      }
    });
  }

  // comment form
  overlay.querySelector('#cmtForm').addEventListener('submit', async e => {
    e.preventDefault();
    const body = new FormData(e.target).get('body');
    const submit = overlay.querySelector('#cmtSubmit');
    submit.disabled = true; submit.textContent = 'A enviar…';
    try {
      await api.addComment(cardId, body);
      overlay.remove();
      onChange();
    } catch (err) {
      alert(err.message);
      submit.disabled = false; submit.textContent = canEdit ? 'Enviar comentário' : 'Comentar';
    }
  });
}

async function openEditMetaModal(project, onSaved) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-back on';
  overlay.innerHTML = `
    <div class="modal">
      <h2>Preço e orçamento</h2>
      <div class="error" id="err" style="display:none"></div>
      <form id="form">
        <label class="field"><label>Preço por hora (€)</label><input type="number" name="hourly_rate" step="1" min="0" value="${project.hourly_rate ?? ''}"></label>
        <label class="field"><label>Orçamento total (horas)</label><input type="number" name="budget_hours" step="0.5" min="0" value="${project.budget_hours ?? ''}"></label>
        <label class="field"><label>Estado</label>
          <select name="status">
            <option value="active"    ${project.status==='active'?'selected':''}>em curso</option>
            <option value="completed" ${project.status==='completed'?'selected':''}>concluído</option>
            <option value="archived"  ${project.status==='archived'?'selected':''}>arquivado</option>
          </select>
        </label>
        <div class="row" style="display:flex;gap:.55rem">
          <button type="button" class="btn ghost" id="cancel" style="flex:1;justify-content:center;padding:.55rem">Cancelar</button>
          <button type="submit" class="btn primary" id="submit" style="flex:1;justify-content:center;padding:.55rem">Guardar</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#form').addEventListener('submit', async e => {
    e.preventDefault();
    const data = new FormData(e.target);
    const submit = overlay.querySelector('#submit');
    submit.disabled = true; submit.textContent = 'A guardar…';
    try {
      await api.updateProject(project.id, {
        hourly_rate: data.get('hourly_rate') ? Number(data.get('hourly_rate')) : null,
        budget_hours: data.get('budget_hours') ? Number(data.get('budget_hours')) : null,
        status: data.get('status'),
      });
      overlay.remove();
      onSaved();
    } catch (err) {
      const el = overlay.querySelector('#err');
      el.textContent = err.message;
      el.style.display = '';
      submit.disabled = false; submit.textContent = 'Guardar';
    }
  });
}

function PRIORITY_BADGE(p) {
  const color = PRIORITY_COLOR[p] || PRIORITY_COLOR.medium;
  return `<span class="cd-pill" style="background:${color.bg};color:${color.fg}">${PRIORITY_LABEL[p] || p}</span>`;
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
