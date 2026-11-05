// Documents: tabs, files on disk, and the workspace that survives a reload.
// `mind` is always one of `docs`; switching tabs rebinds it and rebuilds the
// canvas, so every other module keeps reading `mind` without knowing.

const WS_KEY = 'mind.workspace.v3';
const LEGACY_KEY = 'shape.mind.autosave.v1';
const FS_DB = 'mind.files.v1';
const FOLDER_ID = 'workspace-folder';

let folderHandle = null;     // FileSystemDirectoryHandle, when a workspace folder is bound
let folderName = '';
let folderWarn = false;      // handle survived a reload but lost its permission
let autosaveTimer = 0;
let tabEls = new Map();      // doc -> { el, dot, label, close }
let renameMode = null;
let lastPainted = null;

// ------------------------------------------------------------- handle store
// FileSystemHandles are structured-cloneable, so IndexedDB is the only place
// they can be parked between sessions. Every call is best-effort: without it
// the app still works, it just asks where to save again after a reload.

function idbOpen() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(FS_DB, 1); } catch (err) { reject(err); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexeddb'));
    req.onblocked = () => reject(new Error('indexeddb blocked'));
  });
}

async function idbRun(mode, run) {
  const db = await idbOpen();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('handles', mode);
      let out = null;
      const req = run(tx.objectStore('handles'));
      if (req) req.onsuccess = () => { out = req.result; };
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error || new Error('indexeddb tx'));
      tx.onabort = () => reject(tx.error || new Error('indexeddb abort'));
    });
  } finally {
    db.close();
  }
}

const idbGet = (key) => idbRun('readonly', (s) => s.get(key)).catch(() => null);
const idbPut = (key, value) => idbRun('readwrite', (s) => s.put(value, key)).then(() => true).catch(() => false);
const idbDel = (key) => idbRun('readwrite', (s) => s.delete(key)).then(() => true).catch(() => false);

// ----------------------------------------------------------------- documents

let docSeq = 0;

function makeDoc(init = {}) {
  docSeq++;
  return {
    key: 'd' + docSeq,
    name: init.name || '未命名',
    root: init.root || null,
    src: init.src || null,        // { kind: 'folder', name } | { kind: 'file', id, name }
    handle: null,                 // cached FileSystemFileHandle
    savedAt: init.savedAt || 0,
    dirty: false,
    viewed: !!init.view,
    view: init.view || { x: 0, y: 0, s: 1 },
    selectedId: init.selectedId || null,
    selection: new Set(init.selectedId ? [init.selectedId] : []),
    editingId: null,
    editBefore: null,
    undo: [],
    redo: [],
    hits: [],
    hitIndex: -1,
    searchOpen: false,
    helpOpen: false,
    noteOpen: !!init.noteOpen,
    noteOwnerId: init.noteOwnerId || null,
    noteScroll: 0,
    dragging: null,
    panning: null,
    marquee: null,
    menuAnchor: null,
    review: null,
  };
}

function docHasContent(doc) {
  if (!doc || !doc.root) return false;
  const kids = doc.root.children;
  if (!kids.length) return false;
  if (kids.length > 1) return true;
  const only = kids[0];
  if (only.children.length) return true;
  const text = String(only.text || '').trim();
  return !!text && text !== '中心主题';
}

function docTooltip(doc) {
  const where = doc.src
    ? (doc.src.kind === 'folder' ? '文件夹 · ' + doc.src.name : doc.src.name)
    : '还没写成文件';
  return `${doc.name || '未命名'}\n${where}${doc.dirty ? ' · 有改动未保存' : ''}\n双击改名`;
}

function uniqueDocName(base) {
  const taken = new Set(docs.map((d) => d.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(base + ' ' + n)) n++;
  return base + ' ' + n;
}

function cycleDoc(delta) {
  if (docs.length < 2) return;
  const i = docs.indexOf(mind);
  activateDoc(docs[(i + delta + docs.length) % docs.length]);
}

// ------------------------------------------------------------------ switching

function stashNote(doc) {
  // Read first: resetNote() clears the very flags we are about to keep.
  const open = !!mind.noteOpen;
  const owner = noteOwnerId;
  const scroll = noteBody.scrollTop;
  resetNote();
  doc.noteOpen = open;
  doc.noteOwnerId = owner;
  doc.noteScroll = scroll;
}

function restoreNotePanel(doc) {
  if (!doc.noteOpen) return;
  const node = (doc.noteOwnerId && nodes.get(doc.noteOwnerId))
    || (doc.selectedId && nodes.get(doc.selectedId))
    || null;
  if (!node) { doc.noteOpen = false; return; }
  mind.noteOpen = true;
  notePanel.hidden = false;
  bindNote(node);
  const top = doc.noteScroll || 0;
  requestAnimationFrame(() => {
    noteBody.scrollTop = top;
    noteHi.scrollTop = top;
  });
}

function activateDoc(doc, opts = {}) {
  if (!doc) return;
  if (doc === mind && !opts.force) return;

  if (mind) {
    const prev = mind;
    if (prev.editingId) commitEdit();
    if (prev.searchOpen) closeSearch();
    if (prev.helpOpen) closeHelp();
    if (ui.exportMenu && !ui.exportMenu.hidden) closeExportMenu();
    stashNote(prev);
  }

  mind = doc;
  dropTitleRoot(mind.root, (mind.src && mind.src.name) || mind.loose || mind.name);
  resetViewDom();
  reindex();
  if (typeof resetProposalState === 'function') resetProposalState();

  if (!mind.selectedId || !nodes.has(mind.selectedId)) {
    const first = mind.root && mind.root.children[0];
    mind.selectedId = first ? first.id : null;
  }
  if (!mind.selection || !mind.selection.size) {
    mind.selection = new Set(mind.selectedId ? [mind.selectedId] : []);
  }
  revealSelection();

  render({ animate: false });
  applyView();
  restoreNotePanel(doc);
  if (typeof syncReviewPanel === 'function') syncReviewPanel();
  if (!doc.viewed) { fit(76, 1.15); doc.viewed = true; }

  paintTabs();
  updateStatus();
  updateUndoButtons();
  scheduleAutosave();
  focusStage();
  if (typeof pollProposals === 'function') pollProposals(300);
}

// ---------------------------------------------------------------------- tabs

function renderTabs() {
  const box = ui.tabs;
  if (!box) return;
  const keepScroll = box.scrollLeft;
  box.textContent = '';
  tabEls = new Map();

  for (const doc of docs) {
    const el = document.createElement('div');
    el.className = 'tab';
    el.setAttribute('role', 'tab');
    el.dataset.key = doc.key;

    const dot = document.createElement('span');
    dot.className = 'tab-dot';
    dot.hidden = true;

    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = doc.name || '未命名';

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.type = 'button';
    close.tabIndex = -1;
    close.setAttribute('aria-label', '关闭标签');
    close.innerHTML = '<svg viewBox="0 0 8 8"><path d="M1.7 1.7l4.6 4.6M6.3 1.7L1.7 6.3"/></svg>';

    el.append(dot, label, close);
    box.append(el);
    tabEls.set(doc, { el, dot, label, close });

    el.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close')) return;
      activateDoc(doc);
    });
    el.addEventListener('pointerdown', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) { e.preventDefault(); closeDoc(doc); }
    });
    close.addEventListener('click', (e) => { e.stopPropagation(); closeDoc(doc); });
    label.addEventListener('dblclick', (e) => { e.stopPropagation(); beginRenameDoc(doc); });
  }

  box.scrollLeft = keepScroll;
  lastPainted = null;
  paintTabs();
}

function ensureTabVisible(doc) {
  const ref = tabEls.get(doc);
  if (!ref) return;
  const box = ui.tabs;
  const left = ref.el.offsetLeft;
  const right = left + ref.el.offsetWidth;
  if (left < box.scrollLeft + 2) box.scrollLeft = Math.max(0, left - 8);
  else if (right > box.scrollLeft + box.clientWidth - 2) box.scrollLeft = right - box.clientWidth + 8;
}

function paintTabs() {
  for (const [doc, ref] of tabEls) {
    const active = doc === mind;
    ref.el.classList.toggle('active', active);
    ref.el.setAttribute('aria-selected', active ? 'true' : 'false');
    ref.dot.hidden = !doc.dirty;
    if (!renameMode || renameMode.doc !== doc) {
      const label = doc.name || '未命名';
      if (ref.label.textContent !== label) ref.label.textContent = label;
    }
    ref.el.title = docTooltip(doc);
  }
  if (mind && lastPainted !== mind) ensureTabVisible(mind);
  lastPainted = mind;
}

function beginRenameDoc(doc) {
  const ref = tabEls.get(doc);
  if (!ref || renameMode) return;

  const input = document.createElement('input');
  input.className = 'tab-rename';
  input.value = doc.name || '';
  input.spellcheck = false;
  input.setAttribute('aria-label', '标签名');
  // Measure the label before hiding it — counting characters gets CJK wrong.
  const labelW = ref.label.getBoundingClientRect().width;
  input.style.width = Math.max(56, Math.min(172, labelW + 16)) + 'px';

  ref.label.hidden = true;
  ref.el.insertBefore(input, ref.label.nextSibling);
  input.focus();
  input.select();
  renameMode = { doc, input };

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    input.remove();
    ref.label.hidden = false;
    renameMode = null;

    if (commit && value && value !== doc.name) {
      doc.name = value;
      if (doc === mind) document.title = value + ' — 产品定义';
      await renameFileTo(doc, value);
      renderTabs();
      updateStatus();
      saveAutosaveNow();
    } else {
      renderTabs();
    }
    focusStage();
  };

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => { if (!done) finish(true); });
}

// Renaming the tab renames the file, because on disk the two are the same
// thing. When the browser cannot move a handle, a workspace-folder document
// is copied under the new name and the old one removed.
async function renameFileTo(doc, base) {
  if (!doc.src) return false;
  const want = safeName(base) + '.md';
  if (doc.src.name === want) return true;

  if (doc.src.kind === 'folder' && !folderHandle) {
    toast('文件夹没连上，磁盘上的文件名没改');
    return false;
  }

  const handle = await docHandle(doc);
  if (!handle) { toast('找不到原文件，磁盘上的文件名没改'); return false; }

  if (typeof handle.move === 'function') {
    try {
      await handle.move(want);
      doc.src.name = want;
      doc.handle = handle;
      return true;
    } catch { /* not allowed here — try the copy route below */ }
  }

  if (doc.src.kind === 'folder') {
    try {
      if (!(await ensurePerm(folderHandle, 'readwrite', true))) return false;
      const taken = await folderHandle.getFileHandle(want).then(() => true).catch(() => false);
      if (taken) { toast('文件夹里已经有「' + want + '」'); return false; }
      const fresh = await folderHandle.getFileHandle(want, { create: true });
      if (!(await writeHandle(fresh, toOutline(doc.root)))) {
        await folderHandle.removeEntry(want).catch(() => {});
        return false;
      }
      await folderHandle.removeEntry(doc.src.name).catch(() => {});
      doc.src.name = want;
      doc.handle = fresh;
      return true;
    } catch (err) {
      toast('改名失败：' + ((err && (err.message || err.name)) || '未知错误'));
      return false;
    }
  }

  toast('显示名改了，磁盘上的文件名没改');
  return false;
}

// --------------------------------------------------------------------- files

function safeName(name) {
  return String(name || '未命名').replace(/[\\/:*?"<>|]/g, '-').trim() || '未命名';
}

function fileBase(name) {
  return String(name || '').split(/[\\/]/).pop().replace(/\.(md|markdown|mind|txt)$/i, '') || '未命名';
}

async function ensurePerm(handle, mode, interactive) {
  try {
    if (!handle || !handle.queryPermission) return true;
    let state = await handle.queryPermission({ mode });
    if (state === 'granted') return true;
    if (!interactive || !handle.requestPermission) return false;
    state = await handle.requestPermission({ mode });
    return state === 'granted';
  } catch {
    return false;
  }
}

async function docHandle(doc) {
  if (!doc || !doc.src) return null;
  if (doc.src.kind === 'folder') {
    if (!folderHandle) return null;
    return folderHandle.getFileHandle(doc.src.name).catch(() => null);
  }
  if (doc.handle && (!doc.handle.name || doc.handle.name === doc.src.name)) return doc.handle;
  const handle = await idbGet(doc.src.id);
  if (handle) doc.handle = handle;
  return handle || null;
}

async function resolveHandle(doc, interactive) {
  const handle = await docHandle(doc);
  if (!handle) return null;
  return (await ensurePerm(handle, 'readwrite', interactive)) ? handle : null;
}

async function writeHandle(handle, text) {
  try {
    if (!(await ensurePerm(handle, 'readwrite', true))) { toast('没有写入权限'); return false; }
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    return true;
  } catch (err) {
    toast('保存失败：' + ((err && (err.message || err.name)) || '未知错误'));
    return false;
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function downloadText(text, filename, mime) {
  downloadBlob(new Blob([text], { type: mime || 'text/plain;charset=utf-8' }), filename);
}

// ------------------------------------------------------------- workspace folder

function renderFolderChip() {
  if (!ui.folderChip) return;
  if (folderName) {
    ui.folderChip.classList.add('bound');
    ui.folderName.textContent = folderName;
    ui.folderChip.classList.toggle('warn', folderWarn);
    ui.folderChip.title = folderWarn
      ? `${folderName} · 点击重新授权`
      : `工作文件夹：${folderName}\n新建的文档会直接写进这里`;
  } else {
    ui.folderChip.classList.remove('bound', 'warn');
    ui.folderName.textContent = '选择文件夹';
    ui.folderChip.title = '选一个文件夹当工作区：之后新建的文档直接落盘';
  }
}

async function refreshFolderAccess() {
  folderWarn = false;
  if (folderHandle) folderWarn = !(await ensurePerm(folderHandle, 'readwrite', false));
  renderFolderChip();
}

async function onFolderChip() {
  if (!folderName) { await bindFolder(); return; }
  if (folderWarn) await reGrantFolder();
  toggleFolderMenu();
}

function toggleFolderMenu() {
  if (!ui.folderMenu.hidden) { closeFolderMenu(); return; }
  ui.folderMenu.hidden = false;
  ui.folderChip.setAttribute('aria-expanded', 'true');
  const r = ui.folderChip.getBoundingClientRect();
  const w = ui.folderMenu.offsetWidth;
  ui.folderMenu.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px';
  ui.folderMenu.style.top = (r.bottom + 6) + 'px';
}

function closeFolderMenu() {
  if (!ui.folderMenu) return;
  ui.folderMenu.hidden = true;
  ui.folderChip.setAttribute('aria-expanded', 'false');
}

async function bindFolder() {
  if (!('showDirectoryPicker' in window)) {
    toast('这个浏览器不支持选文件夹（macOS 上用 Chrome / Edge 可以），保存时会单个问位置');
    return false;
  }
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: 'mind-workspace', mode: 'readwrite' });
  } catch (err) {
    if (err && err.name !== 'AbortError') toast('选文件夹失败：' + (err.message || err.name));
    return false;
  }
  if (!(await ensurePerm(dir, 'readwrite', true))) { toast('没有这个文件夹的写入权限'); return false; }

  // Documents that live in the old folder must not silently re-resolve their
  // names inside the new one — pin them to their own file handles first.
  if (folderHandle && folderHandle !== dir) await detachFolderDocs();

  folderHandle = dir;
  folderName = dir.name || '文件夹';
  folderWarn = false;
  await idbPut(FOLDER_ID, dir);
  renderFolderChip();
  await materializeScratch();
  saveAutosaveNow();
  return true;
}

// Turn "name inside the workspace folder" into "this exact file", so the
// document keeps saving after the folder is switched off or replaced.
async function detachFolderDocs() {
  for (const doc of docs) {
    if (!doc.src || doc.src.kind !== 'folder') continue;
    const handle = await docHandle(doc);
    if (!handle) continue;
    const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    // Without a place to park the handle, leave the document alone rather than
    // breaking the only link it has to its file.
    if (!(await idbPut(id, handle))) continue;
    doc.src = { kind: 'file', id, name: doc.src.name };
    doc.handle = handle;
  }
}

async function reGrantFolder() {
  if (!folderHandle) { await bindFolder(); return; }
  if (await ensurePerm(folderHandle, 'readwrite', true)) {
    folderWarn = false;
    renderFolderChip();
    toast('文件夹已就绪');
  } else {
    toast('还是没拿到权限，试试重新选一次');
  }
}

async function unbindFolder() {
  await detachFolderDocs();
  folderHandle = null;
  folderName = '';
  folderWarn = false;
  await idbDel(FOLDER_ID);
  closeFolderMenu();
  renderFolderChip();
  renderTabs();
  saveAutosaveNow();
  toast('已解除绑定，文件都还在原来的位置');
}

async function uniqueFileName(base, doc) {
  const stem = safeName(base || '未命名');
  for (let i = 1; i < 500; i++) {
    const name = i === 1 ? stem + '.md' : `${stem} ${i}.md`;
    const claimed = docs.some((d) => d !== doc && d.src && d.src.kind === 'folder' && d.src.name === name);
    if (claimed) continue;
    if (!folderHandle) return name;
    const exists = await folderHandle.getFileHandle(name).then(() => true).catch(() => false);
    if (!exists) return name;
  }
  return stem + '-' + Date.now() + '.md';
}

async function createFileInFolder(doc) {
  if (!folderHandle) return null;
  if (!(await ensurePerm(folderHandle, 'readwrite', true))) {
    toast('没有这个文件夹的写入权限');
    return null;
  }
  const name = await uniqueFileName(doc.name, doc);
  try {
    const handle = await folderHandle.getFileHandle(name, { create: true });
    doc.src = { kind: 'folder', name };
    doc.handle = handle;
    return handle;
  } catch (err) {
    toast('建不了文件：' + ((err && (err.message || err.name)) || '未知错误'));
    return null;
  }
}

// Every document that still lives only in the browser gets a real file.
async function materializeScratch() {
  if (!folderHandle) { toast('先选一个文件夹'); return; }
  let n = 0;
  for (const doc of docs.slice()) {
    if (doc.src || !docHasContent(doc)) continue;
    const handle = await createFileInFolder(doc);
    if (!handle) continue;
    if (await writeHandle(handle, toOutline(doc.root))) {
      doc.dirty = false;
      doc.savedAt = Date.now();
      n++;
    }
  }
  renderTabs();
  updateStatus();
  saveAutosaveNow();
  if (n) toast(`已把 ${n} 个文档写进 ${folderName}`);
}

// ------------------------------------------------------------------ new / open

async function newDoc() {
  commitEdit();
  const doc = makeDoc({ root: blankDoc(), name: uniqueDocName('未命名') });
  docs.push(doc);
  activateDoc(doc, { force: true });
  renderTabs();

  if (folderHandle) {
    const handle = await createFileInFolder(doc);
    if (handle) {
      if (await writeHandle(handle, toOutline(doc.root))) {
        doc.dirty = false;
        doc.savedAt = Date.now();
      } else {
        doc.dirty = true;
      }
    }
  }

  const first = doc.root.children[0];
  if (mind === doc && first) startEdit(first.id, { selectAll: true });
  updateStatus();
  saveAutosaveNow();
  if (!doc.src) toast('新标签 · ' + ((window.MIND_PLATFORM && window.MIND_PLATFORM.mod) || 'Ctrl') + '+S 选个位置写到磁盘');
}

async function openDoc() {
  commitEdit();
  if ('showOpenFilePicker' in window) {
    try {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{
          description: '大纲（Markdown）',
          accept: { 'text/markdown': ['.md', '.markdown'], 'text/plain': ['.mind', '.txt'] },
        }],
      });
      for (const handle of handles) await openHandle(handle);
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      // file:// and blocked pickers fall through to the plain input
    }
  }
  ui.filePick.value = '';
  ui.filePick.click();
}

async function openHandle(handle) {
  if (!handle) return null;
  for (const doc of docs) {
    const other = await docHandle(doc);
    if (!other || !other.isSameEntry) continue;
    try {
      if (await other.isSameEntry(handle)) { activateDoc(doc); return doc; }
    } catch { /* different file systems — compare nothing */ }
  }
  const file = await handle.getFile();
  const text = await file.text();
  const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  await idbPut(id, handle);
  const doc = openTextInTab(text, file.name, { kind: 'file', id, name: file.name });
  doc.handle = handle;
  return doc;
}

async function openLooseFile(file) {
  if (!file) return;
  const doc = openTextInTab(await file.text(), file.name, null);
  // 落盘过、但句柄没拿到（file:// 下走的是这个口）：这份东西确实在磁盘上，
  // 只是页面不知道路径。记下它的真名，交接给 AI 时按名字找，不是「还没存」。
  if (doc) {
    doc.loose = file.name;
    if (typeof syncHandoff === 'function') syncHandoff();   // 左下角那块显示的是真名
  }
  toast('已打开 ' + fileBase(file.name) + ' · ' + ((window.MIND_PLATFORM && window.MIND_PLATFORM.mod) || 'Ctrl') + '+S 选个位置存');
}

function openTextInTab(text, filename, src) {
  const base = fileBase(filename);
  const legacy = /\.mind$/i.test(String(filename || ''));
  const doc = makeDoc({
    name: base,
    root: parseOutline(text, base),
    src: src || null,
    savedAt: src ? Date.now() : 0,
  });
  docs.push(doc);
  activateDoc(doc, { force: true });
  renderTabs();
  updateStatus();
  saveAutosaveNow();
  toast((legacy ? '已打开旧 .mind：' : '已打开 ') + base);
  return doc;
}

// ------------------------------------------------------------------- saving

async function saveDoc(as) {
  commitEdit();
  if (!mind || !mind.root) return;
  const text = toOutline(mind.root);

  if (!as) {
    let handle = await resolveHandle(mind, false);
    if (!handle && mind.src) handle = await resolveHandle(mind, true);   // re-grant on demand
    if (!handle && !mind.src && folderHandle) handle = await createFileInFolder(mind);

    if (handle) {
      if (!(await writeHandle(handle, text))) return;
      mind.dirty = false;
      mind.savedAt = Date.now();
      updateStatus();
      saveAutosaveNow();
      toast('已保存 ' + (mind.src ? mind.src.name : ''));
      return;
    }
  }

  await saveAs(text);
}

async function saveAs(text) {
  const suggested = safeName(mind.name) + '.md';

  if ('showSaveFilePicker' in window) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: suggested,
        types: [
          { description: '大纲（Markdown）', accept: { 'text/markdown': ['.md'] } },
          { description: '纯文本', accept: { 'text/plain': ['.txt'] } },
        ],
      });
      if (!(await writeHandle(handle, text))) return;
      const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      await idbPut(id, handle);
      mind.handle = handle;
      mind.src = { kind: 'file', id, name: handle.name };
      mind.name = fileBase(handle.name);
      mind.dirty = false;
      mind.savedAt = Date.now();
      renderTabs();
      updateStatus();
      saveAutosaveNow();
      toast('已保存 ' + handle.name);
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      // fall through to download
    }
  }

  downloadText(text, suggested, 'text/markdown;charset=utf-8');
  mind.dirty = false;
  mind.savedAt = Date.now();
  updateStatus();
  saveAutosaveNow();
  toast('已下载 ' + suggested);
}

async function closeDoc(doc) {
  if (!doc || !docs.includes(doc)) return;
  const i = docs.indexOf(doc);

  if (doc === mind) {
    if (mind.editingId) commitEdit();
    if (mind.noteOpen) closeNote();
  }
  if (doc.review) {
    doc.review = null;
    if (doc === mind && typeof syncReviewPanel === 'function') syncReviewPanel();
  }

  if (doc.dirty && doc.src) {
    const handle = await resolveHandle(doc, false);
    if (!handle) {
      if (!confirm(`「${doc.name}」需要重新授权文件夹才能保存，现在关掉会丢掉未保存的改动。确定关闭？`)) return;
    } else if (!(await writeHandle(handle, toOutline(doc.root)))) {
      return;
    }
  } else if (!doc.src && (doc.dirty || docHasContent(doc))) {
    if (!confirm(`「${doc.name}」还没写成文件，关掉就只剩浏览器里的临时副本了。确定关闭？`)) return;
  }

  docs.splice(i, 1);
  tabEls.delete(doc);

  if (doc === mind) {
    mind = null;
    if (docs.length) {
      activateDoc(docs[Math.min(i, docs.length - 1)], { force: true });
    } else {
      const fresh = makeDoc({ root: newNode('中心主题') });
      docs.push(fresh);
      activateDoc(fresh, { force: true });
    }
  }

  renderTabs();
  updateStatus();
  saveAutosaveNow();
}

// --------------------------------------------------------------- persistence

function packDoc(doc) {
  return {
    name: doc.name,
    tree: doc.root ? packNode(doc.root) : null,
    at: doc.savedAt || 0,
    src: doc.src || null,
    loose: doc.loose || undefined,
    view: doc.viewed ? { x: doc.view.x, y: doc.view.y, s: doc.view.s } : null,
    note: doc.noteOpen ? { id: doc.noteOwnerId, scroll: doc.noteScroll } : null,
    sel: doc.selectedId || null,
  };
}

function saveAutosaveNow() {
  clearTimeout(autosaveTimer);
  if (!docs.length) return;
  try {
    localStorage.setItem(WS_KEY, JSON.stringify({
      v: 3,
      at: Date.now(),
      active: Math.max(0, docs.indexOf(mind)),
      folder: folderName || '',
      docs: docs.map(packDoc),
    }));
  } catch { /* quota / private mode — the file on disk is the real save */ }
}

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(saveAutosaveNow, 400);
}

function unpackDoc(raw) {
  if (!raw) return null;
  const title = (raw.src && raw.src.name) || raw.loose || raw.name;
  const doc = makeDoc({
    name: raw.name || '未命名',
    root: raw.tree ? asRoot(unpackNode(raw.tree), title) : blankDoc(),
    src: raw.src || null,
    savedAt: raw.at || 0,
    view: raw.view || null,
    selectedId: raw.sel || null,
    noteOpen: !!(raw.note && raw.note.id),
    noteOwnerId: raw.note ? raw.note.id : null,
  });
  if (raw.loose) doc.loose = String(raw.loose);
  if (raw.note) doc.noteScroll = raw.note.scroll || 0;
  return doc;
}

async function restoreWorkspace() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem(WS_KEY) || 'null'); } catch { /* ignore */ }

  if (data && data.v === 3 && Array.isArray(data.docs) && data.docs.length) {
    for (const raw of data.docs) {
      const doc = unpackDoc(raw);
      if (doc) docs.push(doc);
    }
    folderName = data.folder || '';
    if (folderName) {
      folderHandle = await idbGet(FOLDER_ID);
      if (!folderHandle) folderName = '';
    }
    const i = Math.max(0, Math.min(docs.length - 1, data.active | 0));
    activateDoc(docs[i], { force: true });
    await refreshFolderAccess();
    return true;
  }

  let legacy = null;
  try { legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null'); } catch { /* ignore */ }
  if (legacy && legacy.tree) {
    const doc = makeDoc({
      name: legacy.name || '未命名',
      root: asRoot(unpackNode(legacy.tree), legacy.name),
      savedAt: legacy.at || 0,
    });
    docs.push(doc);
    activateDoc(doc, { force: true });
    try { localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ }
    return true;
  }

  const sample = makeDoc({ name: '示例', root: sampleTree() });
  docs.push(sample);
  activateDoc(sample, { force: true });
  return false;
}
