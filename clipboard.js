// Copy / paste for node clusters.
//
// Copy takes the selected nodes, keeps only the "copy roots" (a node whose
// ancestor is also selected is already inside that ancestor's subtree), and
// writes each block as a standalone Markdown snippet at column 0. The same
// text goes to the system clipboard so it can be dropped straight into an AI
// chat; a structured copy stays in `clipBuffer` for an exact paste back into
// the tree.
//
// Paste hangs fresh clones (new ids, note/collapsed kept) under the selected
// node. Several roots become several sibling blocks there. Ctrl+C / Ctrl+V
// (Cmd on macOS) drive both; the toolbar buttons call the same functions.

let clipBuffer = null;   // { roots: packed nodes, text: string }

function clipboardSelectionIds() {
  const ids = [...(mind && mind.selection ? mind.selection : [])];
  if (!ids.length) {
    // 注释框选中时节点选中已被清空；别把 Ctrl+C 落到上一次选过的节点上。
    if (mind && mind.selectedCommentId != null) return [];
    const one = selectedNode();
    if (one) ids.push(one.id);
  }
  return ids;
}

function clipboardCopyRoots() {
  const root = treeRoot();
  return rootsAmong(root, clipboardSelectionIds());
}

function subtreeCount(node) {
  let n = 1;
  for (const child of node.children) n += subtreeCount(child);
  return n;
}

function snippetLineCount(text) {
  const body = String(text || '').replace(/\n$/, '');
  return body ? body.split('\n').length : 0;
}

// Clipboard API first; execCommand when the page is file:// or the permission
// is refused. Returns whether the system clipboard actually got the text.
async function writeClipboardText(text) {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the old path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

async function copySelection() {
  if (!mind) return;
  const roots = clipboardCopyRoots();
  if (!roots.length) {
    toast('先选中节点再复制');
    return;
  }

  const text = outlineSnippet(roots);
  clipBuffer = { roots: roots.map(packNode), text };

  const nodes = roots.reduce((n, r) => n + subtreeCount(r), 0);
  const lines = snippetLineCount(text);
  const what = roots.length > 1 ? `${roots.length} 个根 / ${nodes} 个节点` : `${nodes} 个节点`;

  const ok = await writeClipboardText(text);
  toast(ok
    ? `已复制 ${what} · ${lines} 行 Markdown`
    : `已复制 ${what} 到 Mind 剪贴板（系统剪贴板没写成）`);
  if (typeof focusStage === 'function') focusStage();
}

function pasteClipboard() {
  if (!mind) return;
  if (mind.review) {
    toast('审批预览里不能粘贴');
    return;
  }
  if (!clipBuffer || !clipBuffer.roots || !clipBuffer.roots.length) {
    toast('还没有复制过的节点（Ctrl+C 复制，再选中节点或空白处 Ctrl+V 粘贴）');
    return;
  }

  const target = selectedNode();
  if (!target) {
    const added = pasteToCanvas();
    if (!added.length) return;
    const total = added.reduce((n, r) => n + subtreeCount(r), 0);
    toast(`已粘贴 ${total} 个节点到空白处`);
    if (typeof focusStage === 'function') focusStage();
    return;
  }

  const snap = snapshot();
  target.collapsed = false;

  const added = [];
  for (const data of clipBuffer.roots) {
    const clone = cloneForPaste(data);
    if (!clone) continue;
    target.children.push(clone);
    added.push(clone);
  }
  if (!added.length) return;

  pushUndo(snap);
  mind.selection = new Set(added.map((n) => n.id));
  mind.selectedId = added[0].id;
  mind.selectedCommentId = null;

  markDirty();
  reindex();
  render({ animate: true, dur: 190 });
  for (const node of added) markFresh(node.id);
  paintSelection();
  drawLinks();
  if (typeof syncNotePanel === 'function') syncNotePanel();
  if (typeof syncBatchBar === 'function') syncBatchBar();
  ensureVisible(added[0]);
  saveAutosaveNow();

  const nodes = added.reduce((n, r) => n + subtreeCount(r), 0);
  const label = String(target.text || '').replace(/\s+/g, ' ').trim() || '未命名';
  toast(`已粘贴 ${nodes} 个节点到「${label}」下`);
  if (typeof focusStage === 'function') focusStage();
}

// 没有选中节点：粘贴成新的顶层簇，落在鼠标处的空白上。多个根竖着排开，
// 第一个簇的中心对准指针，和双击空白新建节点的落点手感一致。
function pasteToCanvas() {
  const at = (typeof mouseWorldForNewComment === 'function')
    ? mouseWorldForNewComment()
    : viewportCenterWorld();

  const snap = snapshot();
  const added = [];
  for (const data of clipBuffer.roots) {
    const clone = cloneForPaste(data);
    if (!clone) continue;
    clone.pos = { x: at.x, y: at.y };
    mind.root.children.push(clone);
    added.push(clone);
  }
  if (!added.length) return [];

  pushUndo(snap);
  mind.selection = new Set(added.map((n) => n.id));
  mind.selectedId = added[0].id;
  mind.selectedCommentId = null;

  markDirty();
  reindex();
  // 先不带布局动画：此刻还没量过克隆的高度，等 render 量完再定最终坐标，
  // 否则会先落在粗位置上、再被第二遍坐标拽一下。
  render({ animate: false });

  let y = at.y - ((added[0].subH || added[0].h || 34) / 2);
  for (const clone of added) {
    clone.pos = {
      x: Math.round(at.x - ((clone.w || 140) / 2)),
      y: Math.round(y),
    };
    y += (clone.subH || clone.h || 34) + 24;
  }
  computeLayout();
  stick();

  for (const node of added) markFresh(node.id);
  paintSelection();
  drawLinks();
  if (typeof syncNotePanel === 'function') syncNotePanel();
  if (typeof syncBatchBar === 'function') syncBatchBar();
  updateStatus();
  saveAutosaveNow();
  return added;
}
