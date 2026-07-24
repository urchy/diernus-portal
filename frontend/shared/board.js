// shared/board.js — Kanban board component
// Renders the board (columns + cards), handles drag-drop, and shows a
// card-detail side panel with comments.

import { api } from './api.js';
import { $, fmtDate, fmtDateTime, timeAgo, escapeHtml, initials, showToast } from './layout.js';

const PRIORITY_LABEL = { low: 'baixa', medium: 'média', high: 'alta' };
const PRIORITY_COLOR = {
  low:    { bg: 'rgba(35,33,28,.08)',  fg: 'var(--graphite-60)' },
  medium: { bg: 'rgba(44,73,199,.12)',  fg: 'var(--cobalt)' },
  high:   { bg: 'rgba(179,35,46,.12)',  fg: 'var(--stamp)' },
};

// Tiny PT pluraliser — keeps the count phrase grammatically correct.
//   pluralise(1, 'cartão', 'cartões')           → "1 cartão"
//   pluralise(2, 'cartão', 'cartões')           → "2 cartões"
//   pluralise(1, 'atrasado', 'atrasados')       → "1 atrasado"
function pluralise(n, singular, plural) {
  if (n == null || n === 0) return `0 ${plural}`;
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * Mount a Kanban board into `mountEl`.
 * @param mountEl  HTMLElement to render into
 * @param projectId  string
 * @param access  'studio' | 'client'
 */
export async function mountBoard(mountEl, projectId, access) {
  const { project, columns, cards, summary } = await api.board(projectId);
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

  // summary block
  if (summary) mountEl.appendChild(buildSummaryHeader(project, summary, canEdit));

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
    openCardDetail(cardEl.dataset.cardId, canEdit, () => refresh(board, mountEl, projectId, access), projectId);
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
  // re-fetch the board and re-render (simpler than patching in place).
  // The project page appends its own content (e.g. project files) after
  // the kanban, so we only strip the elements owned by mountBoard —
  // the kanban, the page-head, and the summary block. Anything added by
  // the page (back-link, files section) stays put.
  mountEl.querySelectorAll('.kanban').forEach(n => n.remove());
  mountEl.querySelectorAll('.board-head').forEach(n => n.remove());
  mountEl.querySelectorAll('.summary').forEach(n => n.remove());
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

export async function openCardDetail(cardId, canEdit, onChange, projectId) {
  const overlay = document.createElement('div');
  overlay.className = 'card-detail-back on';
  const { card, comments } = await api.card(cardId);
  // fetch team members + files in parallel (both for studio; client still gets files)
  const [teamRes, filesRes, timeRes] = await Promise.all([
    canEdit ? api.teamMembers().catch(() => ({ members: [] })) : Promise.resolve({ members: [] }),
    api.cardFiles(projectId || card.project_id, cardId).catch(() => ({ files: [] })),
    canEdit ? api.timeEntries(cardId).catch(() => ({ entries: [] })) : Promise.resolve({ entries: [] }),
  ]);
  const team = teamRes.members || [];
  const files = filesRes.files || [];
  const timeEntries = timeRes.entries || [];
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
          <h3>Atribuído a</h3>
          <div class="cd-assignee">
            <select id="assigneeSel" class="cd-assignee-sel">
              <option value="">— ninguém —</option>
              ${team.map(m => `<option value="${escapeHtml(m.id)}" ${m.id === card.assignee_id ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}
            </select>
            ${card.assignee_name ? `<span class="cd-assignee-current" title="atribuído a">${initials(card.assignee_name)} ${escapeHtml(card.assignee_name)}</span>` : ''}
          </div>
        </section>
        <section class="cd-section">
          <h3>Estado</h3>
          <div class="row" style="display:flex;gap:.5rem;flex-wrap:wrap">
            <button class="btn sm ghost" data-act="priority" data-value="low">Baixa</button>
            <button class="btn sm ghost" data-act="priority" data-value="medium">Média</button>
            <button class="btn sm ghost" data-act="priority" data-value="high">Alta</button>
            <button class="btn sm ghost" data-act="delete" style="color:var(--stamp)">Apagar cartão</button>
          </div>
        </section>
        ${canEdit ? `
        <section class="cd-section">
          <h3>Horas gastas <span class="cd-section-aside">${formatHours(card.actual_hours)} h${card.estimated_hours ? ` / ${formatHours(card.estimated_hours)} h estimadas` : ''}</span></h3>
          <form id="timeForm" class="cd-time-form">
            <input type="number" name="hours" step="0.25" min="0.25" max="24" placeholder="0.5" required>
            <input type="text" name="note" placeholder="o que foi feito (opcional)" maxlength="500">
            <button type="submit" class="btn primary sm">+ Registar</button>
          </form>
          <div class="cd-time-entries" id="timeEntries">
            ${timeEntries.length === 0
              ? '<em style="color:var(--graphite-60);font-size:.85rem">Sem horas registadas.</em>'
              : timeEntries.map(e => `
                <div class="cd-time-row" data-entry-id="${escapeHtml(e.id)}">
                  <span class="cd-time-h">${formatHours(e.hours)}h</span>
                  <span class="cd-time-note">${escapeHtml(e.note || '')}</span>
                  <span class="cd-time-meta">${escapeHtml(e.user_name)} · ${timeAgo(e.logged_at)}</span>
                  <button class="cd-time-del" data-time-del="${escapeHtml(e.id)}" title="Apagar">✕</button>
                </div>
              `).join('')}
          </div>
        </section>` : card.actual_hours ? `
        <section class="cd-section">
          <h3>Horas gastas</h3>
          <div style="font-family:var(--mono);font-size:.85rem">${formatHours(card.actual_hours)} h${card.estimated_hours ? ` (estimado: ${formatHours(card.estimated_hours)} h)` : ''}</div>
        </section>` : ''}
        ` : `
        ${card.assignee_name ? `
        <section class="cd-section">
          <h3>Atribuído a</h3>
          <div class="cd-assignee"><span class="cd-assignee-current">${initials(card.assignee_name)} ${escapeHtml(card.assignee_name)}</span></div>
        </section>` : ''}`}
        <section class="cd-section">
          <h3>Ficheiros (${files.length})</h3>
          <div class="cd-files" id="cdFiles">
            ${files.length === 0
              ? '<em style="color:var(--graphite-60);font-size:.85rem">Sem ficheiros anexados.</em>'
              : files.map(f => renderFileRow(f, canEdit)).join('')}
          </div>
          <form id="fileForm" class="cd-file-form">
            <label class="cd-file-drop" id="fileDrop">
              <input type="file" id="fileInput" hidden>
              <span>📎 Escolher ficheiro ou largar aqui (máx. ${canEdit ? 50 : 25} MB)${canEdit ? '' : ' — o estúdio será notificado'}</span>
            </label>
            <div class="cd-file-status" id="fileStatus" style="display:none"></div>
          </form>
        </section>
        <section class="cd-section">
          <h3>Comentários (${comments.length})</h3>
          <div class="cd-comments">
            ${comments.length === 0
              ? '<em style="color:var(--graphite-60);font-size:.85rem">Sem comentários. Adicione o primeiro abaixo.</em>'
              : comments.map(c => `
                <div class="cd-comment">
                  <div class="cd-comment-head">
                    <span class="cd-author">${escapeHtml(c.author_name)}</span>
                    <span class="cd-role cd-role-${c.author_role === 'client' ? 'client' : 'studio'}">${c.author_role === 'client' ? 'cliente' : 'estúdio'}</span>
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

  // assignee change
  if (canEdit) {
    const sel = overlay.querySelector('#assigneeSel');
    if (sel) {
      sel.addEventListener('change', async () => {
        const newId = sel.value || null;
        const restoreSel = sel.value;
        const member = team.find(m => m.id === newId);
        try {
          await api.updateCard(cardId, { assignee_id: newId });
          // update local state
          card.assignee_id = newId;
          card.assignee_name = member ? member.name : null;
          // update the "X initials Name" pill next to the dropdown
          const cur = overlay.querySelector('.cd-assignee-current');
          if (cur) {
            if (member) {
              cur.textContent = member.name;
              cur.style.display = '';
            } else {
              cur.remove();
            }
          } else if (member) {
            // re-render the cd-assignee row to include the current pill
            const row = overlay.querySelector('.cd-assignee');
            if (row) {
              const span = document.createElement('span');
              span.className = 'cd-assignee-current';
              span.textContent = member.name;
              row.appendChild(span);
            }
          }
          showToast(newId ? `Atribuído a ${member.name}` : 'Atribuição removida');
          onChange();
        } catch (e) {
          alert('Não foi possível atribuir: ' + e.message);
          sel.value = restoreSel;  // revert
        }
      });
    }
  }

  // time entry form
  if (canEdit) {
    const timeForm = overlay.querySelector('#timeForm');
    if (timeForm) {
      timeForm.addEventListener('submit', async e => {
        e.preventDefault();
        const fd = new FormData(timeForm);
        const hours = Number(fd.get('hours'));
        const note = (fd.get('note') || '').toString();
        if (!Number.isFinite(hours) || hours <= 0) return;
        const submit = timeForm.querySelector('button[type=submit]');
        submit.disabled = true; submit.textContent = 'A registar…';
        try {
          const { entry } = await api.logHours(cardId, hours, note);
          // update the in-panel state without closing it
          const list = overlay.querySelector('#timeEntries');
          // remove the "Sem horas registadas." placeholder if present
          const placeholder = list.querySelector('em');
          if (placeholder) placeholder.remove();
          // prepend the new row
          const row = document.createElement('div');
          row.innerHTML = renderTimeEntryRow(entry);
          list.prepend(row.firstElementChild);
          // refresh the aside (e.g. "0.3 h / 1 h estimadas")
          const newActual = (card.actual_hours || 0) + entry.hours;
          card.actual_hours = newActual;
          updateHoursAside(overlay, card);
          updateCardHeaderPills(overlay, card);
          // reset the form, keep the panel open
          timeForm.reset();
          submit.disabled = false; submit.textContent = '+ Registar';
          timeForm.querySelector('input[name="hours"]')?.focus();
          showToast(`+${formatHours(entry.hours)}h registadas`);
          // background-refresh the board so the card on the board shows the new actual_hours
          onChange();
        } catch (err) {
          alert('Não foi possível registar: ' + err.message);
          submit.disabled = false; submit.textContent = '+ Registar';
        }
      });
    }
  }
  // time entry delete (event delegation)
  overlay.addEventListener('click', async e => {
    const delBtn = e.target.closest('button[data-time-del]');
    if (!delBtn) return;
    if (!confirm('Apagar este registo de horas? O total do cartão será atualizado.')) return;
    try {
      const row = delBtn.closest('.cd-time-row');
      const hours = Number(row?.dataset.hours || 0);
      await api.deleteTimeEntry(delBtn.dataset.timeDel);
      row.remove();
      card.actual_hours = Math.max(0, (card.actual_hours || 0) - hours);
      updateHoursAside(overlay, card);
      updateCardHeaderPills(overlay, card);
      // if no entries left, show the placeholder back
      const list = overlay.querySelector('#timeEntries');
      if (list && !list.children.length) {
        list.innerHTML = '<em style="color:var(--graphite-60);font-size:.85rem">Sem horas registadas.</em>';
      }
      showToast('Registo removido');
      onChange();
    } catch (err) { alert('Erro: ' + err.message); }
  });

  // file upload — both studio and client can upload
  {
    const fileInput = overlay.querySelector('#fileInput');
    const fileDrop = overlay.querySelector('#fileDrop');
    const fileStatus = overlay.querySelector('#fileStatus');
    const filesContainer = overlay.querySelector('#cdFiles');
    if (fileInput) {
      fileDrop.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => {
        if (fileInput.files?.[0]) uploadAndAppend(fileInput.files[0], projectId || card.project_id, cardId, filesContainer, fileStatus, onChange, overlay);
      });
      // drag-and-drop
      ['dragenter','dragover'].forEach(ev => fileDrop.addEventListener(ev, e => { e.preventDefault(); fileDrop.classList.add('on'); }));
      ['dragleave','drop'].forEach(ev => fileDrop.addEventListener(ev, e => { e.preventDefault(); fileDrop.classList.remove('on'); }));
      fileDrop.addEventListener('drop', e => {
        const f = e.dataTransfer?.files?.[0];
        if (f) uploadAndAppend(f, projectId || card.project_id, cardId, filesContainer, fileStatus, onChange, overlay);
      });
    }
  }
  // file delete — studio only (clients see download-only file rows; renderFileRow already hides the ✕)
  if (canEdit) {
    overlay.addEventListener('click', async e => {
      const delBtn = e.target.closest('button[data-file-del]');
      if (!delBtn) return;
      const id = delBtn.dataset.fileDel;
      if (!confirm('Apagar este ficheiro?')) return;
      try {
        await api.deleteFile(id);
        const row = delBtn.closest('.cd-file');
        row.remove();
        // update the section heading (Ficheiros (n))
        const list = overlay.querySelector('#cdFiles');
        if (list && !list.children.length) {
          list.innerHTML = '<em style="color:var(--graphite-60);font-size:.85rem">Sem ficheiros anexados.</em>';
        }
        updateFilesHeading(overlay, files.length);
        showToast('Ficheiro removido');
      } catch (err) {
        alert('Não foi possível remover: ' + err.message);
      }
    });
  }

  // priority buttons
  if (canEdit) {
    overlay.addEventListener('click', async e => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'priority') {
        try {
          await api.updateCard(cardId, { priority: btn.dataset.value });
          card.priority = btn.dataset.value;
          updateCardHeaderPills(overlay, card);
          showToast('Prioridade atualizada');
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
      const { comment } = await api.addComment(cardId, body);
      // update the in-panel state without closing it
      const list = overlay.querySelector('.cd-comments');
      if (list) {
        const placeholder = list.querySelector('em');
        if (placeholder) placeholder.remove();
        const row = document.createElement('div');
        row.innerHTML = renderCommentRow(comment);
        list.appendChild(row.firstElementChild);
      }
      // update the section header (Comentários (n))
      updateSectionHeading(overlay, 'Comentários', `Comentários (${list.querySelectorAll('.cd-comment').length})`);
      // reset the form, focus the textarea so the user can keep adding notes
      e.target.reset();
      submit.disabled = false; submit.textContent = canEdit ? 'Enviar comentário' : 'Comentar';
      const ta = e.target.querySelector('textarea');
      if (ta) ta.focus();
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
      <h2>Projeto · detalhes</h2>
      <div class="error" id="err" style="display:none"></div>
      <form id="form">
        <label class="field"><label>Preço por hora (€)</label><input type="number" name="hourly_rate" step="1" min="0" value="${project.hourly_rate ?? ''}"></label>
        <label class="field"><label>Orçamento total (horas)</label><input type="number" name="budget_hours" step="0.5" min="0" value="${project.budget_hours ?? ''}"></label>
        <label class="field"><label>Prazo do projeto</label><input type="date" name="due_date" value="${project.due_date ?? ''}"></label>
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
        due_date: data.get('due_date') || null,
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

// ---- Summary header (rendered between page-head and the kanban) ----
function buildSummaryHeader(project, summary, canEdit) {
  const wrap = document.createElement('section');
  wrap.className = 'summary';
  const pct = Math.max(0, Math.min(100, summary.progress_pct || 0));
  const dueClass = (() => {
    if (!project.due_date) return '';
    const d = new Date(project.due_date);
    const today = new Date(); today.setHours(0,0,0,0);
    const days = Math.round((d - today) / 86400000);
    if (days < 0) return 'summary-due summary-due-overdue';
    if (days <= 7) return 'summary-due summary-due-soon';
    return 'summary-due';
  })();
  const dueLabel = (() => {
    if (!project.due_date) return 'sem prazo';
    const d = new Date(project.due_date);
    const today = new Date(); today.setHours(0,0,0,0);
    const days = Math.round((d - today) / 86400000);
    if (days < 0) return `atrasado ${Math.abs(days)}d`;
    if (days === 0) return 'vence hoje';
    if (days === 1) return 'vence amanhã';
    if (days <= 30) return `em ${days}d`;
    return d.toLocaleDateString('pt-PT', { day: '2-digit', month: 'short', year: 'numeric' });
  })();
  const budgetPct = summary.budget_consumed_pct;
  const budgetTone = budgetPct == null ? '' : (budgetPct >= 100 ? 'summary-bill-over' : budgetPct >= 80 ? 'summary-bill-warn' : '');
  wrap.innerHTML = `
    <div class="summary-card">
      <div class="summary-label">Progresso</div>
      <div class="summary-value">${pct}<small>%</small></div>
      <div class="summary-bar"><div class="summary-bar-fill" style="width:${pct}%"></div></div>
      <div class="summary-sub">${summary.done} de ${summary.total} cartões concluídos</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Tarefas</div>
      <div class="summary-value">${summary.total}</div>
      <div class="summary-sub">${summary.todo} a fazer · ${summary.in_progress} em curso</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Horas</div>
      <div class="summary-value">${formatHours(summary.total_actual_hours)}<small>h</small></div>
      <div class="summary-sub">${formatHours(summary.total_estimated_hours)}h estimadas${project.budget_hours != null ? ' · ' + formatHours(project.budget_hours) + 'h orçamento' : ''}</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Orçamento</div>
      <div class="summary-value ${budgetTone}">${budgetPct == null ? '—' : budgetPct + '<small>%</small>'}</div>
      <div class="summary-sub">${budgetPct == null ? 'sem orçamento definido' : `${formatHours(summary.total_actual_hours)}h / ${formatHours(project.budget_hours)}h`}</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Prazo</div>
      <div class="summary-value ${dueClass}">${escapeHtml(dueLabel.split(' ')[0])}</div>
      <div class="summary-sub">${project.due_date ? new Date(project.due_date).toLocaleDateString('pt-PT', { day: '2-digit', month: 'short', year: 'numeric' }) : 'definir prazo'}${summary.overdue_count > 0 ? ' · ' + pluralise(summary.overdue_count, 'cartão atrasado', 'cartões atrasados') : ''}</div>
    </div>
    ${summary.next_due_card ? `
    <div class="summary-card summary-next">
      <div class="summary-label">Próximo a entregar</div>
      <div class="summary-value-sm">${escapeHtml(summary.next_due_card.title)}</div>
      <div class="summary-sub">${new Date(summary.next_due_card.due_date).toLocaleDateString('pt-PT', { day: '2-digit', month: 'short' })}</div>
    </div>` : ''}
  `;
  return wrap;
}

// ---- File row in the card detail ----
function renderFileRow(f, canEdit) {
  const sizeKB = f.size < 1024 * 1024
    ? Math.max(1, Math.round(f.size / 1024)) + ' KB'
    : (f.size / 1024 / 1024).toFixed(1) + ' MB';
  const ext = (f.filename.split('.').pop() || '?').toLowerCase();
  return `
    <div class="cd-file">
      <span class="cd-file-ext cd-file-ext-${escapeHtml(ext)}">${escapeHtml(ext.slice(0, 4))}</span>
      <a class="cd-file-name" href="${api.fileDownloadUrl(f.id)}" target="_blank" rel="noopener" download>${escapeHtml(f.filename)}</a>
      <span class="cd-file-meta">${sizeKB} · ${escapeHtml(f.uploader_name || '')}</span>
      ${canEdit ? `<button class="cd-file-del" data-file-del="${escapeHtml(f.id)}" title="Apagar">✕</button>` : ''}
    </div>`;
}

// ---- Per-card panel helpers (used by openCardDetail's in-place updates) ----
function renderTimeEntryRow(e) {
  return `
    <div class="cd-time-row" data-entry-id="${escapeHtml(e.id)}" data-hours="${escapeHtml(String(e.hours))}">
      <span class="cd-time-h">${formatHours(e.hours)}h</span>
      <span class="cd-time-note">${escapeHtml(e.note || '')}</span>
      <span class="cd-time-meta">${escapeHtml(e.user_name)} · ${timeAgo(e.logged_at)}</span>
      <button class="cd-time-del" data-time-del="${escapeHtml(e.id)}" title="Apagar">✕</button>
    </div>
  `;
}

function renderCommentRow(c) {
  return `
    <div class="cd-comment">
      <div class="cd-comment-head">
        <span class="cd-author">${escapeHtml(c.author_name)}</span>
        <span class="cd-role cd-role-${c.author_role === 'client' ? 'client' : 'studio'}">${c.author_role === 'client' ? 'cliente' : 'estúdio'}</span>
        <span class="cd-time">${timeAgo(c.created_at)}</span>
      </div>
      <div class="cd-comment-body">${escapeHtml(c.body).replace(/\n/g, '<br>')}</div>
    </div>
  `;
}

function updateHoursAside(overlay, card) {
  const aside = overlay.querySelector('.cd-section h3:has(.cd-section-aside)');
  if (!aside) return;
  // the aside lives in the "Horas gastas" heading — find it by content
  const headings = overlay.querySelectorAll('.cd-section h3');
  for (const h of headings) {
    if (h.textContent.toLowerCase().includes('horas gastas')) {
      h.innerHTML = `Horas gastas <span class="cd-section-aside">${formatHours(card.actual_hours)} h${card.estimated_hours ? ` / ${formatHours(card.estimated_hours)} h estimadas` : ''}</span>`;
      break;
    }
  }
}

function updateFilesHeading(overlay, count) {
  const headings = overlay.querySelectorAll('.cd-section h3');
  for (const h of headings) {
    if (h.textContent.toLowerCase().includes('ficheiros')) {
      h.textContent = `Ficheiros (${count})`;
      break;
    }
  }
}

function updateCardHeaderPills(overlay, card) {
  // The card-detail-head cd-meta row: priority badge + due + estimated + actual
  const meta = overlay.querySelector('.card-detail-head .cd-meta');
  if (!meta) return;
  meta.innerHTML =
    PRIORITY_BADGE(card.priority) +
    (card.due_date ? `<span class="cd-pill">${new Date(card.due_date).toLocaleDateString('pt-PT')}</span>` : '') +
    (card.estimated_hours ? `<span class="cd-pill">${formatHours(card.estimated_hours)} h estimadas</span>` : '') +
    (card.actual_hours ? `<span class="cd-pill">${formatHours(card.actual_hours)} h gastas</span>` : '');
}

function updateSectionHeading(overlay, match, html) {
  const headings = overlay.querySelectorAll('.cd-section h3');
  for (const h of headings) {
    if (h.textContent.toLowerCase().includes(match.toLowerCase())) {
      h.innerHTML = html;
      break;
    }
  }
}

// ---- Upload handler (called by file input change / drop) ----
async function uploadAndAppend(file, projectId, cardId, container, status, onChange, overlay) {
  if (status) {
    status.style.display = '';
    status.textContent = `A enviar ${file.name}…`;
  }
  try {
    const { file: uploaded } = await api.uploadFile(projectId, file, cardId);
    if (status) status.textContent = `Enviado: ${uploaded.filename}`;
    // clear the "no files" placeholder if present
    const placeholder = container.querySelector('em');
    if (placeholder) placeholder.remove();
    // prepend the new row
    const div = document.createElement('div');
    div.innerHTML = renderFileRow(uploaded, true);
    container.prepend(div.firstElementChild);
    // update the section heading count
    if (overlay) updateFilesHeading(overlay, container.querySelectorAll('.cd-file').length);
    if (onChange) onChange();
    setTimeout(() => { if (status) status.style.display = 'none'; }, 2500);
  } catch (err) {
    if (status) status.textContent = 'Erro: ' + err.message;
    setTimeout(() => { if (status) status.style.display = 'none'; }, 4000);
  }
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
