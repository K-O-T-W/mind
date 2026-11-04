// Notes: a node can carry a long free-form note, edited in a side panel.
// The panel follows the selection, so stepping through nodes steps through
// their notes. Text lives on node.note and is stored as a quote in the .md outline.

const notePanel = document.getElementById('notePanel');
const noteEdit = document.getElementById('noteEdit');
const noteHi = document.getElementById('noteHi');
const noteBody = document.getElementById('noteBody');
const noteOwner = document.getElementById('noteOwner');
const noteCount = document.getElementById('noteCount');
const noteClose = document.getElementById('noteClose');
const noteAddCode = document.getElementById('noteAddCode');
const noteLangMenu = document.getElementById('noteLangMenu');
const noteGrip = document.getElementById('noteGrip');
const noteMode = document.getElementById('noteMode');
const noteTip = document.getElementById('noteTip');

let noteOwnerId = null;
let noteOwnerNode = null;
let noteBefore = null;
let noteDirty = false;
let notePaintRaf = 0;
let noteDiffMark = null;   // 审批 diff：fn(lineIndex) -> 类名，null = 普通渲染

// ------------------------------------------------------------- read-only

// While a proposal is open the canvas renders a shadow tree. Editing there
// would write into a future nobody accepted yet, so the panel shows the note
// exactly as it sits in the document and refuses to take input.
function noteLocked() {
  return !!(mind && mind.review);
}

// 审批中的备注视图：文本框里放"生效后"的备注，高亮层把新增的行垫出来。
// 删掉的行不在这里铺（会错位，面板的逐行 diff 里有），保证逐行对齐不破功。
function buildNoteDiffMark(oldText, newText) {
  const rows = lineDiff(String(oldText || ''), String(newText || ''));
  const cls = [];
  let add = 0, del = 0, k = 0;
  for (const row of rows) {
    if (row.t === 'del') { del++; continue; }
    if (row.t === 'add') { cls[k] = 'nl-add'; add++; }
    k++;
  }
  if (!add && !del) return null;
  const mark = (i) => cls[i] || '';
  mark.tip = (add ? '+' + add : '') + (add && del ? ' ' : '') + (del ? '−' + del : '');
  return mark;
}

// Preview clone -> the node it was cloned from. Nodes the proposal adds have
// no original, so their own (proposed) note is all there is to show.
function noteSubject(node) {
  if (node && mind && mind.review && node.real) return node.real;
  return node;
}

function noteOpFor(node) {
  const r = mind && mind.review;
  if (!r || !node) return null;
  return r.ops.find((o) => o.kind === 'note' && o.targetReal === node && o.state !== 'rejected') || null;
}

function applyNoteMode(node) {
  const locked = noteLocked();
  const wasLocked = notePanel.classList.contains('locked');
  notePanel.classList.toggle('locked', locked);
  noteBody.readOnly = locked;
  noteBody.setAttribute('aria-readonly', locked ? 'true' : 'false');
  noteMode.hidden = !locked;
  noteAddCode.hidden = locked;
  if (locked && !wasLocked) {
    toggleLangMenu(false);
    // A panel dragged wide earlier must give the canvas its strip back.
    if (notePanel.offsetWidth > noteMaxWidth()) applyNoteWidth(noteMaxWidth());
  }

  if (!locked) {
    noteTip.textContent = 'Esc 收起';
    noteBody.placeholder = '写下这个节点的备注，长一点也没关系。';
    return;
  }
  noteBody.placeholder = '这个节点还没有备注。';
  if (noteDiffMark && noteDiffMark.tip) {
    noteTip.textContent = '审批中 · 备注变化 ' + noteDiffMark.tip + ' · 绿底是新增的行';
  } else {
    noteTip.textContent = noteOpFor(node) ? '审批中 · 提案要改这条' : '审批中 · 只看不改';
  }
}

// ---------------------------------------------------------------- width

const NOTE_W_MIN = 280;
const NOTE_W_MAX = 760;
let noteResizer = null;

function noteMaxWidth() {
  // Leave the canvas a usable strip even when the review panel is parked on
  // the other side.
  const rv = (mind && mind.review && ui.reviewPanel && !ui.reviewPanel.hidden)
    ? ui.reviewPanel.offsetWidth + 26
    : 0;
  return Math.max(NOTE_W_MIN, Math.min(NOTE_W_MAX, window.innerWidth - 240 - rv));
}

function applyNoteWidth(w) {
  if (noteResizer) return noteResizer.apply(w);
  const width = Math.min(Math.max(w, NOTE_W_MIN), noteMaxWidth());
  notePanel.style.width = width + 'px';
  return width;
}

// ---------------------------------------------------------------- painting

function paintNote() {
  noteHi.innerHTML = hlNote(noteBody.value, noteDiffMark);
  noteHi.scrollTop = noteBody.scrollTop;
  noteHi.scrollLeft = noteBody.scrollLeft;
}

function scheduleNotePaint() {
  if (notePaintRaf) return;
  notePaintRaf = requestAnimationFrame(() => {
    notePaintRaf = 0;
    paintNote();
  });
}

// The textarea owns the scrollbar; the highlight layer must line up with the
// text column it leaves, or long lines wrap at different places.
function syncNoteMetrics() {
  const sw = Math.max(0, noteBody.offsetWidth - noteBody.clientWidth);
  noteHi.style.paddingRight = (14 + sw) + 'px';
}

function noteText(node) {
  return String((node && node.note) || '');
}

// Space the note panel eats on the right — fit() and ensureVisible() use it.
function noteInset() {
  return mind.noteOpen ? (notePanel.offsetWidth || 0) + 26 : 0;
}

function updateNoteHead(node) {
  const label = String((node && node.text) || '').replace(/\s+/g, ' ').trim() || '未命名';
  noteOwner.textContent = label;
  noteOwner.title = label;
  updateNoteCount();
}

function updateNoteCount() {
  const n = noteBody.value.length;
  noteCount.textContent = n ? `${n} 字` : '空';
}

function refreshNoteHead() {
  if (!mind.noteOpen || !noteOwnerId) return;
  const node = noteOwnerNode;
  if (node) updateNoteHead(node);
}

function markHasNote(node, rec, value) {
  const on = !!String(value || '').trim();
  rec.wrap.classList.toggle('has-note', on);
  rec.wrap.setAttribute('aria-label', (node.text || '未命名') + (on ? '，有备注' : ''));
}

function onNoteInput() {
  if (noteLocked()) return;
  const node = noteOwnerNode;
  if (!node) return;
  node.note = noteBody.value.replace(/\r\n?/g, '\n');
  noteDirty = true;
  const rec = wraps.get(node.id);
  if (rec) markHasNote(node, rec, node.note);
  updateNoteCount();
  scheduleNotePaint();
  markDirty();
}

function onNoteKey(e) {
  if (e.key === 'Escape' && !noteLangMenu.hidden) {
    e.preventDefault();
    e.stopPropagation();
    toggleLangMenu(false);
    noteBody.focus({ preventScroll: true });
    return;
  }
  if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.key === 'Enter')) {
    e.preventDefault();
    e.stopPropagation();
    closeNote();
  }
}

// ---------------------------------------------------------------- code block

function toggleLangMenu(show) {
  const on = show == null ? noteLangMenu.hidden : !!show;
  noteLangMenu.hidden = !on;
  noteAddCode.setAttribute('aria-expanded', on ? 'true' : 'false');
}

function insertCodeBlock(lang) {
  toggleLangMenu(false);
  const ta = noteBody;
  const value = ta.value;
  const start = ta.selectionStart == null ? value.length : ta.selectionStart;
  const end = ta.selectionEnd == null ? start : ta.selectionEnd;

  const head = value.slice(0, start);
  const tail = value.slice(end);
  const lead = head && !head.endsWith('\n') ? '\n' : '';
  const open = '```' + lang;

  ta.value = head + lead + open + '\n\n```\n' + tail;
  const caret = head.length + lead.length + open.length + 1;
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(caret, caret);

  onNoteInput();
  paintNote();

  // keep the empty line where the code goes in sight
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 22;
  const line = (head + lead + open).split('\n').length - 1;
  ta.scrollTop = Math.max(0, line * lh - ta.clientHeight / 2);
  noteHi.scrollTop = ta.scrollTop;
}

function bindNoteUI() {
  noteClose.addEventListener('click', closeNote);
  noteBody.addEventListener('input', onNoteInput);
  noteBody.addEventListener('keydown', onNoteKey);
  noteBody.addEventListener('scroll', () => {
    noteHi.scrollTop = noteBody.scrollTop;
    noteHi.scrollLeft = noteBody.scrollLeft;
  });
  // IME composition draws text that the transparent textarea hides, so the
  // highlight layer steps aside until the syllable is committed.
  noteBody.addEventListener('compositionstart', () => noteEdit.classList.add('composing'));
  noteBody.addEventListener('compositionend', () => {
    noteEdit.classList.remove('composing');
    paintNote();
  });
  noteBody.addEventListener('blur', () => noteEdit.classList.remove('composing'));

  // mousedown is swallowed so the textarea keeps focus and its caret position
  noteAddCode.addEventListener('mousedown', (e) => e.preventDefault());
  noteAddCode.addEventListener('click', (e) => {
    e.preventDefault();
    toggleLangMenu();
  });
  noteLangMenu.addEventListener('mousedown', (e) => e.preventDefault());
  noteLangMenu.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-lang]');
    if (btn) insertCodeBlock(btn.dataset.lang);
  });
  document.addEventListener('pointerdown', (e) => {
    if (noteLangMenu.hidden) return;
    if (noteLangMenu.contains(e.target) || noteAddCode.contains(e.target)) return;
    toggleLangMenu(false);
  }, true);

  noteResizer = bindPanelResize(notePanel, noteGrip, {
    key: 'note.width.v1',
    min: NOTE_W_MIN,
    max: noteMaxWidth,
    dir: 'left',
    onResize: () => { syncNoteMetrics(); scheduleNotePaint(); },
    onEnd: () => { const n = selectedNode(); if (n) ensureVisible(n); },
  });

  notePanel.addEventListener('pointerdown', (e) => {
    if (e.target === notePanel) noteBody.focus({ preventScroll: true });
  });
}

// ---------------------------------------------------------------- open / close

function bindNote(node, live) {
  noteOwnerId = node.id;
  noteOwnerNode = node;
  noteBefore = snapshot();
  noteDirty = false;
  noteDiffMark = null;
  let value = noteText(node);
  let head = node;
  if (noteLocked() && live && live !== node && live.real) {
    // 审批中：文本框给"生效后"的备注，变化的地方由高亮层标出来。
    const mark = buildNoteDiffMark(node.note, live.note);
    if (mark) { value = String(live.note || ''); noteDiffMark = mark; }
    head = live;   // 标题也用生效后的名字（改名的提案能直接看到新名）
  }
  noteBody.value = value;
  updateNoteHead(head);
  applyNoteMode(node);
  paintNote();
  syncNoteMetrics();
}

function openNote(id) {
  const live = id ? nodes.get(id) : selectedNode();
  if (!live) return;
  const node = noteSubject(live);
  if (mind.editingId) commitEdit();

  if (!mind.noteOpen) {
    mind.noteOpen = true;
    notePanel.hidden = false;
    // The other panel may be sitting wide; it has to give back the room.
    if (typeof clampReviewWidth === 'function') clampReviewWidth();
  }
  if (noteOwnerId !== node.id) {
    flushNote();
    bindNote(node, live);
  } else {
    applyNoteMode(node);
  }

  // Read-only: keep the caret off the text so ↑↓ still step through the
  // proposal while the note stays in view.
  if (!noteLocked()) {
    noteBody.focus({ preventScroll: true });
    const end = noteBody.value.length;
    noteBody.setSelectionRange(end, end);
  }
  ensureVisible(live);
}

function flushNote() {
  // Nothing typed here can reach the tree while a proposal is on screen.
  if (noteLocked()) {
    noteDirty = false;
    noteBefore = null;
    return;
  }
  const node = noteOwnerNode;
  if (!node) {
    noteOwnerId = null;
    noteBefore = null;
    noteDirty = false;
    return;
  }
  if (!noteDirty) return;

  // node.note was already written live on every keystroke, so the edit is
  // measured against the snapshot taken when the panel bound to this node.
  const value = noteBody.value.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  node.note = value;
  noteDirty = false;

  const rec = wraps.get(node.id);
  if (rec) markHasNote(node, rec, value);
  updateNoteCount();

  const before = noteBefore;
  noteBefore = null;
  if (before && before !== snapshot()) {
    markDirty();
    pushUndo(before);
    saveAutosaveNow();
  }
}

function closeNote() {
  toggleLangMenu(false);
  flushNote();
  noteOwnerId = null;
  noteOwnerNode = null;
  noteBefore = null;
  noteDirty = false;
  noteDiffMark = null;
  if (mind.noteOpen) {
    mind.noteOpen = false;
    notePanel.hidden = true;
  }
  focusStage();
}

// Drop the panel without touching the tree — used when the document is replaced.
function resetNote() {
  toggleLangMenu(false);
  noteOwnerId = null;
  noteOwnerNode = null;
  noteBefore = null;
  noteDirty = false;
  noteDiffMark = null;
  noteBody.value = '';
  noteHi.innerHTML = '';
  updateNoteCount();
  if (mind.noteOpen) {
    mind.noteOpen = false;
    notePanel.hidden = true;
  }
}

// Called from select(); force re-reads the node after undo/redo rebuilt it.
function syncNotePanel(force) {
  if (!mind.noteOpen) return;
  const live = selectedNode();
  if (!live) { closeNote(); return; }
  const node = noteSubject(live);
  if (node.id === noteOwnerId && !force) { applyNoteMode(node); return; }
  flushNote();
  bindNote(node, live);
}

function toggleNote() {
  if (mind.noteOpen) closeNote();
  else openNote();
}
