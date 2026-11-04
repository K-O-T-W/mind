// Behavior: tree edits, selection, inline editing, undo, autosave.
// Mouse/file/search wiring lives in interact.js.

const MOD_LABEL = (window.MIND_PLATFORM && window.MIND_PLATFORM.mod) || 'Ctrl';

let toastTimer = 0;
let skipClickUntil = 0;
let blankClickOk = false;

// ---------------------------------------------------------------- status

function updateStatus() {
  if (!mind) return;
  const total = totalNodes();
  const tops = mind.root ? mind.root.children.length : 0;
  if (mind.review) {
    const left = mind.review.ops.filter(o => o.state === 'pending').length;
    ui.statCount.textContent = `审批中 · ${left} 项待定`;
  } else {
    ui.statCount.textContent = `${total} 个节点` + (tops > 1 ? ` · ${tops} 簇` : '');
  }
  document.title = (mind.name || '未命名') + ' — 产品定义';

  if (!mind.src) {
    ui.statSave.textContent = mind.dirty ? '未保存 · 仅在浏览器' : '仅在浏览器';
    ui.statSave.className = 'save-state' + (mind.dirty ? ' dirty' : '');
    ui.statSave.title = '这个文档还没写成文件，按 ' + MOD_LABEL + '+S 选个位置';
  } else if (mind.dirty) {
    ui.statSave.textContent = '未保存';
    ui.statSave.className = 'save-state dirty';
    ui.statSave.title = MOD_LABEL + '+S 写回 ' + mind.src.name;
  } else if (mind.savedAt) {
    const t = new Date(mind.savedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    ui.statSave.textContent = '已保存 ' + t;
    ui.statSave.className = 'save-state saved';
    ui.statSave.title = mind.src.name;
  } else {
    ui.statSave.textContent = '已保存';
    ui.statSave.className = 'save-state';
    ui.statSave.title = mind.src.name;
  }

  ui.emptyHint.hidden = !(total === 0 && !mind.editingId);
  updateUndoButtons();
  paintTabs();
  if (typeof syncHandoff === 'function') syncHandoff();
}

function updateUndoButtons() {
  const undoBtn = document.querySelector('[data-act="undo"]');
  const redoBtn = document.querySelector('[data-act="redo"]');
  if (undoBtn) undoBtn.disabled = mind.undo.length === 0;
  if (redoBtn) redoBtn.disabled = mind.redo.length === 0;
}

function toast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 1900);
}

function markDirty() {
  mind.dirty = true;
  updateStatus();
  scheduleAutosave();
}

// ---------------------------------------------------------------- selection

function selectedNode() {
  return nodes.get(mind.selectedId) || null;
}

function clearSelection() {
  mind.selectedId = null;
  mind.selection = new Set();
  mind.selectedCommentId = null;
  renderComments();                 // 注释框的选中状态也要跟着放下
  paintSelection();
  drawLinks();
  if (typeof syncNotePanel === 'function') syncNotePanel();
  updateStatus();
}

function stepSelection(delta) {
  if (!order.length) return;
  const i = order.findIndex(n => n.id === mind.selectedId);
  const next = order[clamp(i < 0 ? 0 : i + delta, 0, order.length - 1)];
  if (next) select(next.id);
}

function goLeft() {
  const node = selectedNode();
  if (!node) return;
  if (node.children.length && !node.collapsed) {
    node.collapsed = true;
    reindex();
    render();
    select(node.id);
    scheduleAutosave();
  } else {
    const parent = parents.get(node.id);
    if (parent) select(parent.id);
  }
}

function goRight() {
  const node = selectedNode();
  if (!node || !node.children.length) return;
  if (node.collapsed) {
    node.collapsed = false;
    reindex();
    render();
    select(node.id);
    scheduleAutosave();
  } else {
    select(node.children[0].id);
  }
}

// Collapsing is a view-only change, but it rides along in the file so a
// folded branch stays folded next time.
function toggleCollapse(node) {
  if (!node || !node.children.length || mind.review) return;
  node.collapsed = !node.collapsed;
  reindex();
  render({ animate: true, dur: 190 });
  select(node.id);
  if (!node.collapsed) ensureVisible(nodes.get(node.id));
  scheduleAutosave();
}

// ---------------------------------------------------------------- structure

function addSibling(node, snap) {
  const parent = node ? parents.get(node.id) : null;
  const fresh = newNode('');
  pushUndo(snap);

  if (!node) {
    fresh.pos = { x: 0, y: 0 };
    mind.root.children.push(fresh);
  } else if (parent) {
    const i = parent.children.indexOf(node);
    parent.children.splice(Math.max(0, i) + 1, 0, fresh);
    parent.collapsed = false;
  } else {
    // A sibling of a top-level node is a new cluster: drop it right under,
    // aligned with the one it grew out of.
    const i = mind.root.children.indexOf(node);
    fresh.pos = {
      x: node.pos ? node.pos.x : 0,
      y: (node.pos ? node.pos.y : 0) + (node.subH || node.h || 0) + 40,
    };
    mind.root.children.splice(Math.max(0, i) + 1, 0, fresh);
  }

  if (node) node.collapsed = false;
  mind.selectedId = fresh.id;
  markDirty();
  reindex();
  render({ animate: true, dur: 180 });
  select(fresh.id);
  markFresh(fresh.id);
  startEdit(fresh.id);
  saveAutosaveNow();
  return fresh;
}

function addChild(node, snap) {
  if (!node) node = mind.root.children[0] || null;
  if (!node) return addSibling(null, snap);
  pushUndo(snap);
  node.collapsed = false;
  const fresh = newNode('');
  node.children.push(fresh);
  mind.selectedId = fresh.id;
  markDirty();
  reindex();
  render({ animate: true, dur: 180 });
  select(fresh.id);
  markFresh(fresh.id);
  startEdit(fresh.id);
  saveAutosaveNow();
  return fresh;
}

// Drop a brand-new cluster where the pointer is (double-click on empty space).
function addTopLevelAt(worldX, worldY) {
  pushUndo();
  const fresh = newNode('');
  fresh.pos = { x: worldX, y: worldY };
  mind.root.children.push(fresh);
  mind.selectedId = fresh.id;
  mind.selection = new Set([fresh.id]);
  markDirty();
  reindex();
  render({ animate: true, dur: 160 });
  select(fresh.id);
  // Centre the box on the click now that its size is known.
  if (Number.isFinite(fresh.w)) {
    fresh.pos.x -= fresh.w / 2;
    fresh.pos.y -= fresh.h / 2;
    computeLayout();
    stick();
  }
  markFresh(fresh.id);
  startEdit(fresh.id);
  saveAutosaveNow();
  return fresh;
}

function indentNode(node, snap) {
  if (!node) return false;
  const parent = parentOf(node);
  if (!parent) return false;
  const i = parent.children.indexOf(node);
  if (i <= 0) return false;
  pushUndo(snap);
  parent.children.splice(i, 1);
  const prev = parent.children[i - 1];
  prev.children.push(node);
  prev.collapsed = false;
  node.collapsed = false;
  delete node.pos;                 // it is no longer a cluster of its own
  mind.selectedId = node.id;
  markDirty();
  reindex();
  render({ animate: true, dur: 200 });
  select(node.id);
  saveAutosaveNow();
  return true;
}

function outdentNode(node, snap) {
  if (!node) return false;
  const parent = parents.get(node.id);
  if (!parent) return false;       // already top level
  const grand = parentOf(parent);
  if (!grand) return false;
  pushUndo(snap);
  const i = parent.children.indexOf(node);
  parent.children.splice(i, 1);
  const pi = grand.children.indexOf(parent);
  grand.children.splice(pi + 1, 0, node);
  if (grand.virt) {
    // Lifted out of its cluster: it keeps the spot it was drawn in.
    node.pos = { x: settleX(node), y: settleY(node) };
  }
  grand.collapsed = false;
  node.collapsed = false;
  mind.selectedId = node.id;
  markDirty();
  reindex();
  render({ animate: true, dur: 200 });
  select(node.id);
  saveAutosaveNow();
  return true;
}

// Alt+点连线 = 剪断（虚幻引擎同款）：子节点带着整棵子树离开父节点，
// 停在原来画着的位置，独立成一块。撤销栈照常接管。
function cutLink(childId) {
  const child = nodes.get(childId);
  if (!child || mind.review) return false;      // 审批预览里不动真树
  const parent = parents.get(child.id) || locate(child);
  if (!parent || parent.virt) return false;
  const i = parent.children.indexOf(child);
  if (i < 0) return false;
  pushUndo();
  parent.children.splice(i, 1);
  child.pos = { x: settleX(child), y: settleY(child) };
  mind.root.children.push(child);
  mind.selectedId = child.id;
  markDirty();
  reindex();
  render({ animate: true, dur: 200 });
  select(child.id);
  saveAutosaveNow();
  toast('已剪断 ·「' + String(child.text || '未命名').slice(0, 24) + '」独立成块');
  return true;
}

function moveSibling(node, dir) {
  if (!node) return;
  const parent = parentOf(node);
  if (!parent) return;
  const i = parent.children.indexOf(node);
  const j = i + dir;
  if (j < 0 || j >= parent.children.length) return;
  pushUndo();
  parent.children.splice(i, 1);
  parent.children.splice(j, 0, node);
  mind.selectedId = node.id;
  markDirty();
  reindex();
  render({ animate: true, dur: 160 });
  select(node.id, { ensure: false });
  ensureVisible(node);
  saveAutosaveNow();
}

// Removing a node hands its children back to the parent instead of taking
// them down with it. A deleted cluster's children therefore stay where they
// were drawn, as independent top-level nodes.
function unlinkNode(node) {
  const parent = locate(node);
  if (!parent) return null;
  const i = parent.children.indexOf(node);
  if (i < 0) return null;
  parent.children.splice(i, 1);
  const kids = node.children.splice(0);
  if (kids.length) {
    if (parent.virt) {
      for (const k of kids) k.pos = { x: settleX(k), y: settleY(k) };
    }
    parent.children.splice(i, 0, ...kids);
  }
  return kids[0] || parent.children[i] || parent.children[i - 1] || null;
}

function locate(node) {
  if (!node) return null;
  const walk = (parent) => {
    for (const child of parent.children) {
      if (child === node) return parent;
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  return walk(mind.root);
}

function deleteNode(node, snap) {
  if (!node || !locate(node)) return;
  pushUndo(snap);
  const next = unlinkNode(node);
  mind.selectedId = next && next.id ? next.id : null;
  mind.selection = mind.selectedId ? new Set([mind.selectedId]) : new Set();
  mind.dirty = true;
  reindex();
  render({ animate: true, dur: 170 });
  if (mind.selectedId) select(mind.selectedId);
  updateStatus();
  scheduleAutosave();
}

// Box-select then delete: everything picked goes, everything under it that
// was not picked survives one level up.
function deleteSelection() {
  const picked = selectedNodes();
  if (!picked.length) return false;
  pushUndo();
  picked.sort((a, b) => b.depth - a.depth);
  let next = null;
  for (const node of picked) {
    if (!locate(node)) continue;
    const after = unlinkNode(node);
    if (after) next = after;
  }
  mind.selectedId = next && next.id ? next.id : (mind.root.children[0] || {}).id || null;
  mind.selection = mind.selectedId ? new Set([mind.selectedId]) : new Set();
  mind.dirty = true;
  reindex();
  render({ animate: true, dur: 170 });
  if (mind.selectedId) select(mind.selectedId);
  updateStatus();
  scheduleAutosave();
  return true;
}

function reparentNode(node, target) {
  if (!node || !target || mind.review) return false;
  if (target === node || isDescendant(target, node)) return false;
  const parent = parents.get(node.id);
  if (!parent) {
    // A cluster cannot become a child of its own descendant; anything else is
    // a normal attach, and it loses its stored position on the way in.
    if (isDescendant(target, node)) return false;
  }
  pushUndo();
  if (parent) {
    const i = parent.children.indexOf(node);
    if (i >= 0) parent.children.splice(i, 1);
  } else {
    const i = mind.root.children.indexOf(node);
    if (i >= 0) mind.root.children.splice(i, 1);
  }
  target.children.push(node);
  delete node.pos;
  target.collapsed = false;
  node.collapsed = false;
  mind.selectedId = node.id;
  mind.selection = new Set([node.id]);
  markDirty();
  reindex();
  render({ animate: true, dur: 220 });
  select(node.id);
  saveAutosaveNow();
  return true;
}

// ---------------------------------------------------------------- undo

function revealSelection() {
  if (!mind.selectedId || !nodes.has(mind.selectedId)) {
    const first = mind.root && mind.root.children[0];
    mind.selectedId = first ? first.id : null;
  }
  if (!mind.selection || !mind.selection.size) mind.selection = new Set();
  for (const id of [...mind.selection]) if (!nodes.has(id)) mind.selection.delete(id);
  if (mind.selectedId && !mind.selection.size) mind.selection.add(mind.selectedId);

  let p = parents.get(mind.selectedId);
  let changed = false;
  while (p) {
    if (p.collapsed) { p.collapsed = false; changed = true; }
    p = parents.get(p.id);
  }
  if (changed) reindex();
}

function undo() {
  commitEdit();
  if (mind.review) return;
  if (!mind.undo.length) return;
  mind.redo.push(snapshot());
  const target = mind.undo.pop();
  if (!restoreSnapshot(target)) { toast('这一步撤销不了'); return; }
  revealSelection();
  mind.dirty = true;
  render({ animate: false });
  if (mind.selectedId) select(mind.selectedId);
  if (typeof syncNotePanel === 'function') syncNotePanel(true);
  updateStatus();
  scheduleAutosave();
}

function redo() {
  commitEdit();
  if (mind.review) return;
  if (!mind.redo.length) return;
  mind.undo.push(snapshot());
  const target = mind.redo.pop();
  if (!restoreSnapshot(target)) { toast('这一步重做不了'); return; }
  revealSelection();
  mind.dirty = true;
  render({ animate: false });
  if (mind.selectedId) select(mind.selectedId);
  if (typeof syncNotePanel === 'function') syncNotePanel(true);
  updateStatus();
  scheduleAutosave();
}

// ---------------------------------------------------------------- editing

function focusStage() {
  try { stage.focus({ preventScroll: true }); } catch { /* ignore */ }
}

function startEdit(id, opts = {}) {
  if (mind.review) return;
  if (mind.editingId === id) return;
  if (mind.editingId) commitEdit();
  const node = nodes.get(id);
  const rec = wraps.get(id);
  if (!node || !rec) return;

  mind.editingId = id;
  mind.editBefore = snapshot();
  rec.wrap.classList.add('editing');

  const ta = document.createElement('textarea');
  ta.className = 'editor';
  ta.value = opts.text != null ? opts.text : node.text;
  ta.spellcheck = false;
  ta.setAttribute('aria-label', '编辑节点');
  ta.addEventListener('input', onEditorInput);
  ta.addEventListener('keydown', onEditorKey);
  ta.addEventListener('blur', onEditorBlur);
  rec.box.appendChild(ta);
  rec.ta = ta;

  if (opts.fresh) node.text = ta.value;
  ta.focus({ preventScroll: true });
  const end = ta.value.length;
  if (opts.selectAll) ta.setSelectionRange(0, end);
  else ta.setSelectionRange(end, end);
  ensureVisible(node);
  updateStatus();
}

function onEditorInput() {
  const id = mind.editingId;
  if (!id) return;
  const rec = wraps.get(id);
  const node = nodes.get(id);
  if (!rec || !rec.ta || !node) return;

  let value = rec.ta.value.replace(/[\r\n]+/g, ' ');
  if (value !== rec.ta.value) {
    const caret = Math.min(rec.ta.selectionStart, value.length);
    rec.ta.value = value;
    rec.ta.setSelectionRange(caret, caret);
  }
  node.text = value;
  rec.text.textContent = value;
  if (typeof refreshNoteHead === 'function') refreshNoteHead();

  measureNodes();
  computeLayout();
  animateLayout(true, 90);
  ensureVisible(node);
  if (!mind.dirty) mind.dirty = true;
  updateStatus();
  scheduleAutosave();
}

function onEditorKey(e) {
  if (e.isComposing || e.keyCode === 229) return;
  const id = mind.editingId;
  const node = id ? nodes.get(id) : null;
  const rec = id ? wraps.get(id) : null;
  if (!node) return;

  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) commitEdit((snap) => addChild(node, snap));
    else commitEdit((snap) => addSibling(node, snap));
  } else if (e.key === 'Tab') {
    e.preventDefault();
    if (e.shiftKey) {
      commitEdit((snap) => { if (outdentNode(node, snap)) startEdit(node.id); });
    } else {
      commitEdit((snap) => addChild(node, snap));
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    commitEdit();
  } else if (e.key === 'Backspace' && rec && rec.ta && rec.ta.value === '') {
    e.preventDefault();
    commitEdit((snap) => deleteNode(node, snap));
  }
}

function onEditorBlur() {
  if (!mind.editingId) return;
  commitEdit();
}

function commitEdit(then) {
  const id = mind.editingId;
  if (!id) { if (then) then(undefined); return; }
  const rec = wraps.get(id);
  const ta = rec ? rec.ta : null;
  if (!rec || !ta) { mind.editingId = null; if (then) then(undefined); return; }

  const node = nodes.get(id);
  const before = mind.editBefore;
  let value = ta.value.replace(/[\r\n]+/g, ' ').trim();

  mind.editingId = null;
  mind.editBefore = null;
  rec.wrap.classList.remove('editing');
  ta.remove();
  rec.ta = null;
  rec.text.hidden = false;

  if (!value) {
    if (!then && node && node.children.length === 0) {
      deleteNode(node, before);
      if (!mind.editingId) focusStage();
      return;
    }
    value = '未命名';
  }

  const changed = value !== node.text;
  node.text = value;
  rec.text.textContent = value;

  if (!then && changed) pushUndo(before);
  if (changed) { mind.dirty = true; scheduleAutosave(); }

  measureNodes();
  computeLayout();
  animateLayout(true, 160);
  updateStatus();

  if (then) then(changed ? before : undefined);
  if (!mind.editingId) focusStage();
}

// ---------------------------------------------------------------- keys

function onKeyDown(e) {
  if (e.defaultPrevented) return;

  if (mind.helpOpen) {
    if (e.key === 'Escape') { e.preventDefault(); closeHelp(); }
    return;
  }

  const mod = e.ctrlKey || e.metaKey;
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

  // Reviewing a proposal: the canvas is read-only until it is decided.
  if (mind.review && !typing) {
    if (typeof reviewKey === 'function' && reviewKey(e, mod)) return;
    if (mod) return;
    if (e.key === '?' ) { e.preventDefault(); openHelp(); }
    return;
  }

  // These stay available even with the inline editor focused.
  if (mod) {
    const k = e.key.toLowerCase();
    if (k === 's') { e.preventDefault(); e.shiftKey ? saveDoc(true) : saveDoc(false); return; }
    if (k === 'o') { e.preventDefault(); openDoc(); return; }
    if (k === 'n') { e.preventDefault(); newDoc(); return; }
    if (k === 'f' && !e.shiftKey) { e.preventDefault(); openSearch(); return; }
  }

  if (typing) return;

  // Tabs. Ctrl+Tab / Ctrl+PageUp belong to the browser, so the app claims
  // Alt+digit and Ctrl+Alt+arrows instead — neither is reserved anywhere.
  if (e.altKey && !mod) {
    // macOS 的 Option+字母会打出特殊字符（Option+N 是 ˜），e.key 不再是 n。
    // 所以字母和数字都同时认 e.code，换键盘布局也不会失灵。
    let k = (e.key || '').toLowerCase();
    if (!/^[a-z]$/.test(k)) {
      const m = /^Key([A-Z])$/.exec(e.code || '');
      k = m ? m[1].toLowerCase() : '';
    }
    if (k === 'n' && !e.shiftKey) { e.preventDefault(); newDoc(); return; }
    if (k === 'o' && !e.shiftKey) { e.preventDefault(); openDoc(); return; }
    if (k === 'a' && !e.shiftKey) {
      e.preventDefault();
      if (typeof focusHandoff === 'function') focusHandoff();
      return;
    }
    let n = /^[1-9]$/.test(e.key) ? Number(e.key) : 0;
    if (!n) {
      const m = /^Digit([1-9])$/.exec(e.code || '');
      n = m ? Number(m[1]) : 0;
    }
    if (n) {
      e.preventDefault();
      if (docs[n - 1]) activateDoc(docs[n - 1]);
      return;
    }
  }
  if (mod && e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
    e.preventDefault();
    cycleDoc(e.key === 'ArrowRight' ? 1 : -1);
    return;
  }

  // Tab is a tree command unless focus is on an actual control
  // (toolbar, menu, search field). There it keeps normal focus navigation.
  if (e.key === 'Tab' && t && t.closest('button, a, input, textarea, select, [contenteditable], [role="button"]')) return;

  if (e.key === 'Escape') {
    let closed = false;
    if (mind.searchOpen) { closeSearch(); closed = true; }
    if (!ui.exportMenu.hidden) { closeExportMenu(); closed = true; }
    if (mind.noteOpen) { closeNote(); closed = true; }
    if (closed) { e.preventDefault(); return; }
  }

  if (e.key === '?' && !mod) {
    e.preventDefault();
    openHelp();
    return;
  }

  if (mod) {
    const k = e.key.toLowerCase();
    if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (k === 'y') { e.preventDefault(); redo(); return; }
    if (k === 'enter') { e.preventDefault(); addChild(selectedNode()); return; }
    if (k === ']' || k === '}') { e.preventDefault(); if (!e.repeat) indentNode(selectedNode()); return; }
    if (k === '[' || k === '{') { e.preventDefault(); if (!e.repeat) outdentNode(selectedNode()); return; }
    if (k === '=' || k === '+') { e.preventDefault(); zoomBy(1.2); return; }
    if (k === '-') { e.preventDefault(); zoomBy(1 / 1.2); return; }
    if (k === '0') { e.preventDefault(); zoomBy(1 / mind.view.s); return; }
    return;
  }

  // 蓝图注释框：C 是全局命令——选中节点就框住它们，没选中就在鼠标处新建。
  // 必须放在下面“没有选中节点就返回”之前，否则空地上的 C 会一声不响地消失。
  if ((e.key === 'c' || e.key === 'C') && !e.altKey) {
    e.preventDefault();
    if (!e.repeat) createCommentFromSelection();
    return;
  }

  // 选中的是蓝图注释框：Delete 删框（节点全留）、F2 改标题、Esc 放下。
  if (mind.selectedCommentId && mind.selection.size === 0) {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (!e.repeat) deleteSelectedComment();
      return;
    }
    if (e.key === 'F2') { e.preventDefault(); editCommentTitle(mind.selectedCommentId); return; }
    if (e.key === 'Escape') {
      e.preventDefault();
      mind.selectedCommentId = null;
      renderComments();
      return;
    }
    return;
  }

  const node = selectedNode();
  if (!node) {
    if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      const first = mind.root.children[0];
      if (first) { select(first.id); return; }
      const r = stage.getBoundingClientRect();
      const p = toWorld(r.left + r.width / 2, r.top + r.height / 2);
      addTopLevelAt(p.x, p.y);
      return;
    }
    if (e.key === 'ArrowDown' && order.length) { e.preventDefault(); select(order[0].id); }
    return;
  }

  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    moveSibling(node, e.key === 'ArrowUp' ? -1 : 1);
    return;
  }

  switch (e.key) {
    case 'ArrowUp': e.preventDefault(); stepSelection(-1); return;
    case 'ArrowDown': e.preventDefault(); stepSelection(1); return;
    case 'ArrowLeft': e.preventDefault(); goLeft(); return;
    case 'ArrowRight': e.preventDefault(); goRight(); return;
    case 'Home': e.preventDefault(); if (order[0]) select(order[0].id); return;
    case 'End': e.preventDefault(); if (order.length) select(order[order.length - 1].id); return;
    case 'Enter':
      e.preventDefault();
      if (!e.repeat) addSibling(node);
      return;
    case 'Tab':
      e.preventDefault();
      if (e.repeat) return;
      if (e.shiftKey) outdentNode(node);
      else addChild(node);
      return;
    case ' ':
      e.preventDefault();
      if (!e.repeat) toggleCollapse(node);
      return;
    case 'Delete':
    case 'Backspace':
      e.preventDefault();
      if (e.repeat) return;
      if (mind.selection.size > 1) deleteSelection();
      else deleteNode(node);
      return;
    case 'F2':
      e.preventDefault();
      startEdit(node.id);
      return;
    case 'n':
    case 'N':
      e.preventDefault();
      if (!e.repeat) toggleNote();
      return;
    case 'f':
    case 'F':
      e.preventDefault();
      fit();
      return;
    case 'Escape':
      e.preventDefault();
      if (mind.selection.size > 1) clearSelection();
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------- 蓝图注释框

// UE 同款：选中节点按 C，框起来成一个注释框，标题直接进入编辑。
// 空地按 C 也得有效——在鼠标当前位置长一个空框，这才是虚幻引擎的手感。
function createCommentFromSelection() {
  if (!mind || mind.review) return;
  const sel = selectedNodes().filter((n) => n.vis);
  const snap = snapshot();
  let c;
  if (sel.length) {
    const pad = 30, head = 26;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const n of sel) {
      const x = settleX(n), y = settleY(n);
      x1 = Math.min(x1, x);
      y1 = Math.min(y1, y);
      x2 = Math.max(x2, x + (n.w || 120));
      y2 = Math.max(y2, y + (n.h || 34));
    }
    c = {
      id: newCommentId(),
      x: Math.round(x1 - pad),
      y: Math.round(y1 - pad - head),
      w: Math.round(Math.max(160, x2 - x1 + pad * 2)),
      h: Math.round(Math.max(90, y2 - y1 + pad * 2 + head)),
      color: '#7aa2f7',
      text: '注释',
    };
  } else {
    // 空地按 C：在鼠标处生一个空框，标题栏压在光标下面，立刻能拖。
    // 只夹住标题栏，不让框整块跑到屏幕外——不然看起来就像“什么都没发生”。
    const m = mouseWorldForNewComment();
    const r = stage.getBoundingClientRect();
    const tl = toWorld(r.left, r.top);
    const br = toWorld(r.right, r.bottom);
    const w = 260, h = 150;
    let x = m.x - 8, y = m.y - 13;
    if (br.x - tl.x > 120) x = Math.min(x, br.x - 80);
    if (br.y - tl.y > 80) y = Math.min(y, br.y - 46);
    x = Math.max(x, tl.x + 8);
    y = Math.max(y, tl.y + 8);
    c = {
      id: newCommentId(),
      x: Math.round(x),
      y: Math.round(y),
      w,
      h,
      color: '#7aa2f7',
      text: '注释',
    };
  }
  docComments().push(c);
  pushUndo(snap);
  markDirty();
  mind.selectedCommentId = c.id;
  mind.selection = new Set();
  mind.selectedId = null;
  paintSelection();
  if (typeof syncNotePanel === 'function') syncNotePanel();
  render();
  editCommentTitle(c.id);
  saveAutosaveNow();
}

function viewportCenterWorld() {
  const r = stage.getBoundingClientRect();
  return toWorld(r.left + r.width / 2, r.top + r.height / 2);
}

// 鼠标最后停在画布上的位置，按现在的视口换算成世界坐标。
// 不存 world 坐标：平移/缩放之后再按 C，旧坐标会落到视野外，看起来就像没建出来。
function mouseWorldForNewComment() {
  const p = mind.lastMouseClient;
  const r = stage.getBoundingClientRect();
  const onCanvas = p && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom
    && document.elementFromPoint(p.x, p.y)?.closest('#stage');
  return onCanvas ? toWorld(p.x, p.y) : viewportCenterWorld();
}

function newCommentId() {
  let m = 0;
  for (const c of docComments()) {
    const n = parseInt(String(c.id).slice(1), 10);
    if (Number.isFinite(n) && n > m) m = n;
  }
  return 'c' + (m + 1);
}

// 删框不删节点——框里的东西原地不动。
function deleteSelectedComment() {
  if (!mind || !mind.selectedCommentId) return false;
  return deleteCommentById(mind.selectedCommentId);
}

function deleteCommentById(id) {
  const list = docComments();
  const i = list.findIndex((c) => c.id === id);
  if (i < 0) return false;
  const snap = snapshot();
  list.splice(i, 1);
  if (mind.selectedCommentId === id) mind.selectedCommentId = null;
  pushUndo(snap);
  markDirty();
  render();
  saveAutosaveNow();
  return true;
}

// 双击标题（或选中注释框按 F2）改名：和节点编辑同一种手感。
function editCommentTitle(id) {
  const el = commentEls.get(id);
  const c = docComments().find((x) => x.id === id);
  if (!el || !c || el.querySelector('.comment-edit')) return;
  const title = el.querySelector('.comment-title');
  const input = document.createElement('input');
  input.className = 'comment-edit';
  input.value = c.text || '';
  input.spellcheck = false;
  input.setAttribute('aria-label', '注释标题');
  title.hidden = true;
  title.after(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    input.remove();
    title.hidden = false;
    if (commit && value !== (c.text || '')) {
      const snap = snapshot();
      c.text = value;
      pushUndo(snap);
      markDirty();
      saveAutosaveNow();
    }
    renderComments();
    focusStage();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

// ---------------------------------------------------------------- boot

async function boot() {
  bindUI();
  try {
    await restoreWorkspace();
  } catch (err) {
    console.error(err);
    if (!docs.length) {
      const doc = makeDoc({ root: blankDoc() });
      docs.push(doc);
      activateDoc(doc, { force: true });
    }
  }
  if (!mind) {
    const doc = makeDoc({ root: blankDoc() });
    docs.push(doc);
    activateDoc(doc, { force: true });
  }
  renderTabs();
  renderFolderChip();
  updateStatus();
  updateUndoButtons();
  saveAutosaveNow();
  focusStage();
}
