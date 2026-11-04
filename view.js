// View: DOM nodes on a panned/zoomed canvas, SVG links, cluster layout.
//
// Only top-level nodes have a stored position; their descendants are placed
// relative to them. Moving a cluster is therefore just "change one pos and
// re-run the same layout pass".

const stage = document.getElementById('stage');
const world = document.getElementById('world');
const linkLayer = document.getElementById('linkLayer');
const marquee = document.getElementById('marquee');

world.setAttribute('role', 'tree');
world.setAttribute('aria-label', '思维导图');

const ui = {
  tabs: document.getElementById('tabs'),
  tabNew: document.getElementById('tabNew'),
  folderChip: document.getElementById('folderChip'),
  folderName: document.getElementById('folderName'),
  folderMenu: document.getElementById('folderMenu'),
  searchPanel: document.getElementById('searchPanel'),
  searchInput: document.getElementById('searchInput'),
  searchCount: document.getElementById('searchCount'),
  searchPrev: document.getElementById('searchPrev'),
  searchNext: document.getElementById('searchNext'),
  searchClose: document.getElementById('searchClose'),
  exportMenu: document.getElementById('exportMenu'),
  helpOverlay: document.getElementById('helpOverlay'),
  toast: document.getElementById('toast'),
  dragHint: document.getElementById('dragHint'),
  statCount: document.getElementById('statCount'),
  statSave: document.getElementById('statSave'),
  zoomLabel: document.getElementById('zoomLabel'),
  zoomIn: document.getElementById('zoomIn'),
  zoomOut: document.getElementById('zoomOut'),
  emptyHint: document.getElementById('emptyHint'),
  filePick: document.getElementById('filePick'),
  reviewChip: document.getElementById('reviewChip'),
  reviewPanel: document.getElementById('reviewPanel'),
  reviewDone: document.getElementById('rvDone'),
  reviewDoneHead: document.getElementById('rvDoneHead'),
  reviewDoneList: document.getElementById('rvDoneList'),
  batchBar: document.getElementById('batchBar'),
  batchText: document.getElementById('batchText'),
};

const wraps = new Map();   // id -> { wrap, box, text, badge, ta, badgeState }
const linkEls = new Map();
const linkHits = new Map(); // Alt 提示用的红色叠影层（纯视觉，不收事件）
const commentEls = new Map(); // 蓝图注释框 id -> el
let linkHoverChild = null;  // Alt 悬停时指到的那根线（子节点 id）
const GAP_X = 64;
const GAP_Y = 16;
const CLUSTER_GAP = 88;    // vertical air between two top-level clusters

const anim = { raf: 0, t0: 0, dur: 0, from: new Map() };

// ------------------------------------------------------------ panel resize

// Drag the inner edge of a side panel to resize it — the same behaviour for
// both sides, so they never drift apart. `dir` is the edge the grip sits on:
// 'left' for a panel parked on the right, 'right' for one parked on the left.
function bindPanelResize(panel, grip, opts) {
  const min = opts.min || 280;
  const limit = () => Math.max(min, opts.max ? opts.max() : window.innerWidth - 240);
  let drag = null;

  const apply = (w) => {
    const width = Math.min(Math.max(w, min), limit());
    panel.style.width = width + 'px';
    return width;
  };
  const save = (w) => {
    try { sessionStorage.setItem(opts.key, String(Math.round(w))); } catch { /* ignore */ }
  };

  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    drag = { x0: e.clientX, w0: panel.offsetWidth };
    grip.classList.add('dragging');
    document.body.classList.add('resizing-panel');
    try { grip.setPointerCapture(e.pointerId); } catch { /* synthetic or gone */ }
  });
  grip.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    apply(drag.w0 + (opts.dir === 'right' ? dx : -dx));
    if (opts.onResize) opts.onResize();
  });
  const end = (e) => {
    if (!drag) return;
    drag = null;
    grip.classList.remove('dragging');
    document.body.classList.remove('resizing-panel');
    save(panel.offsetWidth);
    try { if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (opts.onEnd) opts.onEnd();
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);

  // A window that shrinks must not leave a panel wider than the screen.
  window.addEventListener('resize', () => {
    if (panel.hidden) return;
    apply(panel.offsetWidth);
    if (opts.onResize) opts.onResize();
  });

  // Same browser session only: refresh keeps it, closing the tab forgets it.
  try {
    const v = parseInt(sessionStorage.getItem(opts.key), 10);
    if (Number.isFinite(v) && v > 0) apply(v);
  } catch { /* file:// or private mode */ }

  return { apply, limit, save };
}

function rgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---------------------------------------------------------------- DOM nodes

function createNodeEl(node) {
  const wrap = document.createElement('div');
  wrap.className = 'node-wrap';
  wrap.dataset.id = node.id;
  wrap.setAttribute('role', 'treeitem');
  wrap.tabIndex = -1;

  const box = document.createElement('div');
  box.className = 'node';

  const text = document.createElement('div');
  text.className = 'node-text';

  const delta = document.createElement('div');
  delta.className = 'node-delta';
  delta.hidden = true;

  const tag = document.createElement('span');
  tag.className = 'pend-tag';
  tag.hidden = true;

  const badge = document.createElement('button');
  badge.className = 'badge';
  badge.type = 'button';
  badge.tabIndex = -1;
  badge.setAttribute('aria-label', '折叠或展开');

  const mark = document.createElement('button');
  mark.className = 'note-mark';
  mark.type = 'button';
  mark.tabIndex = -1;
  mark.title = '备注  N';
  mark.setAttribute('aria-label', '打开备注');
  mark.innerHTML = '<svg viewBox="0 0 10 10"><path d="M2.2 3.1h5.6M2.2 5h5.6M2.2 6.9h3.6"/></svg>';

  // Approve / reject right on the node — a proposal is judged where it lands,
  // not by scrolling a list on the other side of the window.
  const acts = document.createElement('div');
  acts.className = 'node-acts';
  const okAct = document.createElement('button');
  okAct.className = 'node-act ok';
  okAct.type = 'button';
  okAct.tabIndex = -1;
  okAct.title = '接受这一处改动';
  okAct.setAttribute('aria-label', '接受这一处改动');
  okAct.innerHTML = '<svg viewBox="0 0 10 10"><path d="M2.2 5.3 4.1 7.2 7.8 3"/></svg>';
  const noAct = document.createElement('button');
  noAct.className = 'node-act no';
  noAct.type = 'button';
  noAct.tabIndex = -1;
  noAct.title = '拒绝这一处改动';
  noAct.setAttribute('aria-label', '拒绝这一处改动');
  noAct.innerHTML = '<svg viewBox="0 0 10 10"><path d="M3.1 3.1 6.9 6.9M6.9 3.1 3.1 6.9"/></svg>';
  acts.append(okAct, noAct);

  box.append(text, delta, tag, mark, badge, acts);
  wrap.append(box);
  world.append(wrap);
  return { wrap, box, text, delta, tag, badge, mark, acts, ta: null, badgeState: '', pendKey: '' };
}

function setBadge(rec, node) {
  const state = node.collapsed ? 'c' : 'e';
  if (rec.badgeState === state && rec.badge.dataset.count === String(node.children.length)) return;
  rec.badgeState = state;
  rec.badge.dataset.count = String(node.children.length);
  const label = node.collapsed ? `展开 ${node.children.length} 个子项` : '折叠';
  rec.badge.title = label;
  rec.badge.setAttribute('aria-label', label);
  if (node.collapsed) {
    rec.badge.textContent = String(node.children.length);
  } else {
    rec.badge.innerHTML = '<svg viewBox="0 0 8 8"><path d="M1.5 3 4 5.5 6.5 3"/></svg>';
  }
}

// Pending-change chrome: a small tag in the corner plus (for renames) the old
// text struck through underneath. Rebuilt only when the pending record
// actually changes, so typing and layout stays cheap.
const PEND_LABEL = { add: '新增', del: '删除', drop: '整片删', mod: '改名', note: '备注', move: '移位' };

function setPend(rec, node) {
  const p = node.pend;
  const kind = p ? (p.del ? 'del' : (p.add ? 'add' : (p.move ? 'move' : (p.mod ? 'mod' : (p.note ? 'note' : ''))))) : '';
  const state = p && p.state ? p.state : '';
  const key = kind + '|' + state + '|' + (p && p.act ? '1' : '') + '|' + (p && p.old ? p.old : '') + '|' + (p && p.noteLines ? p.noteLines : '') + '|' + (p && p.to ? p.to : '') + '|' + (p && p.grp ? p.grp : '') + '|' + (p && p.shadow ? '1' : '') + '|' + (p && p.n ? p.n : '');
  if (rec.pendKey === key) return;
  rec.pendKey = key;

  const clean = state === 'ok';   // 已经同意的：呈现的就是生效后的样子，不再挂幽灵标记
  rec.wrap.classList.toggle('pend', !!kind && !clean);
  rec.wrap.classList.toggle('pend-shadow', !!(p && p.shadow && !kind) && !clean);
  rec.wrap.classList.toggle('pend-add', kind === 'add' && !clean);
  rec.wrap.classList.toggle('pend-del', kind === 'del' && !clean);
  rec.wrap.classList.toggle('pend-mod', kind === 'mod' && !clean);
  rec.wrap.classList.toggle('pend-note', kind === 'note' && !clean);
  rec.wrap.classList.toggle('pend-move', kind === 'move' && !clean);
  rec.wrap.classList.toggle('pend-ok', !!clean);
  rec.wrap.classList.toggle('pend-no', state === 'no');
  rec.wrap.classList.toggle('has-acts', !!(p && p.act && mind.review));

  if (!kind || clean) {
    rec.tag.hidden = true;
    rec.delta.hidden = true;
    return;
  }
  rec.tag.hidden = false;
  const glyph = kind === 'add' ? '+' : (kind === 'del' ? '−' : (kind === 'mod' ? '~' : (kind === 'move' ? '↦' : '✎')));
  rec.tag.textContent = state === 'ok' ? '✓' : (state === 'no' ? '✕' : glyph);
  rec.tag.dataset.kind = kind;
  rec.tag.dataset.state = state;
  const size = kind === 'add' && p.n > 1 ? `（整棵 ${p.n} 个节点，一起决定）` : '';
  rec.tag.title = (PEND_LABEL[kind] || '') + size
    + (state === 'ok' ? ' · 已接受' : (state === 'no' ? ' · 已拒绝' : ''))
    + (p.grp ? ' · 块「' + p.grp + '」' : '');

  if (kind === 'mod' && p.old) {
    rec.delta.hidden = false;
    rec.delta.dataset.t = 'mod';
    rec.delta.textContent = p.old;
  } else if (kind === 'note' && p.noteLines) {
    rec.delta.hidden = false;
    rec.delta.dataset.t = 'note';
    rec.delta.textContent = '备注 ' + p.noteLines;
  } else if (kind === 'move' && p.to) {
    rec.delta.hidden = false;
    rec.delta.dataset.t = 'note';
    rec.delta.textContent = '搬到 ' + p.to;
  } else {
    rec.delta.hidden = true;
  }
}

function updateNodeEl(node, rec) {
  const color = branchColor(node);
  rec.wrap.style.setProperty('--branch', color);
  rec.wrap.style.setProperty('--branch-line', rgba(color, .30));
  rec.wrap.style.setProperty('--branch-strong', rgba(color, .58));
  rec.wrap.dataset.depth = String(node.depth);
  rec.wrap.style.display = node.vis ? '' : 'none';

  const noted = !!String(node.note || '').trim();
  rec.wrap.classList.toggle('has-note', noted);
  rec.wrap.classList.toggle('root', node.depth === 0);
  rec.wrap.classList.toggle('has-children', node.children.length > 0);
  rec.wrap.classList.toggle('collapsed', !!node.collapsed && node.children.length > 0);
  rec.wrap.classList.toggle('selected', mind.selection.has(node.id));

  const hit = mind.hits.some(n => n.id === node.id);
  const current = mind.hits[mind.hitIndex] && mind.hits[mind.hitIndex].id === node.id;
  rec.wrap.classList.toggle('hit', hit);
  rec.wrap.classList.toggle('current', current);

  setPend(rec, node);

  rec.wrap.setAttribute('aria-level', String(node.depth + 1));
  rec.wrap.setAttribute('aria-label', (node.text || '未命名') + (noted ? '，有备注' : ''));
  if (node.children.length) rec.wrap.setAttribute('aria-expanded', node.collapsed ? 'false' : 'true');
  else rec.wrap.removeAttribute('aria-expanded');

  if (mind.editingId !== node.id) rec.text.textContent = node.text;
  rec.text.hidden = false;

  if (node.children.length) setBadge(rec, node);
}

function syncDom() {
  for (const [id, rec] of wraps) {
    if (!nodes.has(id)) { rec.wrap.remove(); wraps.delete(id); }
  }
  for (const node of nodes.values()) {
    let rec = wraps.get(node.id);
    if (!rec) { rec = createNodeEl(node); wraps.set(node.id, rec); }
    updateNodeEl(node, rec);
  }
  renderComments();
}

// ---------------------------------------------------------- 蓝图注释框

function renderComments() {
  const list = docComments();
  // 撤销/切标签后，选中的框可能已经不在这个文档里了——别留一个悬空的 id。
  if (mind && mind.selectedCommentId && !list.some((c) => c.id === mind.selectedCommentId)) {
    mind.selectedCommentId = null;
  }
  const seen = new Set();
  for (const c of list) {
    seen.add(c.id);
    let el = commentEls.get(c.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'comment';
      el.dataset.id = c.id;
      el.innerHTML =
        '<div class="comment-head">' +
        '<span class="comment-dot" title="颜色"></span>' +
        '<span class="comment-title"></span>' +
        '<div class="comment-swatches" hidden></div>' +
        '</div>' +
        '<div class="comment-body"></div>' +
        '<div class="comment-grip" title="拖右下角调整大小"></div>';
      world.insertBefore(el, world.firstChild);
      commentEls.set(c.id, el);
    }
    el.style.setProperty('--c', c.color || '#7aa2f7');
    el.style.transform = `translate3d(${Math.round(c.x)}px, ${Math.round(c.y)}px, 0)`;
    el.style.width = Math.round(c.w) + 'px';
    el.style.height = Math.round(c.h) + 'px';
    el.classList.toggle('selected', mind.selectedCommentId === c.id);
    // 选中的框要压在其他框上面，但从这里 appendChild 挪元素是禁忌：
    // 点击框的 pointerdown 里就会重渲染一次，元素被"移出再插回"之后浏览器
    // 不再把它当成同一个点击目标——click 和 dblclick 整个都不来了，双击
    // 改标题因此失灵。层级交给 CSS（.comment 负一层，.comment.selected 零层）。
    const title = el.querySelector('.comment-title');
    if (!title.hidden && title.textContent !== (c.text || '注释')) {
      title.textContent = c.text || '注释';
    }
  }
  for (const [id, el] of commentEls) {
    if (!seen.has(id)) { el.remove(); commentEls.delete(id); }
  }
}

// 框住了哪些簇：按「簇的根节点中心在不在框里」判定（和存档的判定同一条规则）。
// 擦到边不算——不然拖一次框，路过谁就把谁拖走。
function commentCaptures(c) {
  const set = new Set();
  const root = mind && mind.root;
  if (!root) return set;
  for (const t of root.children) {
    const w = Number.isFinite(t.w) ? t.w : 140;
    const h = Number.isFinite(t.h) ? t.h : 34;
    const cx = (t.pos ? t.pos.x : 0) + w / 2;
    const cy = (t.pos ? t.pos.y : 0) + h / 2;
    if (cx > c.x && cx < c.x + c.w && cy > c.y && cy < c.y + c.h) set.add(t.id);
  }
  return set;
}

function markFresh(id) {
  const rec = wraps.get(id);
  if (!rec) return;
  rec.wrap.classList.remove('fresh');
  void rec.wrap.offsetWidth;
  rec.wrap.classList.add('fresh');
  setTimeout(() => rec.wrap.classList.remove('fresh'), 240);
}

// Switching tabs throws the whole canvas away — node ids only mean something
// inside their own document, so cached elements and links must not survive.
// A review rebuild does the same, because preview ids are positional.
function resetViewDom() {
  cancelAnimationFrame(anim.raf);
  anim.from.clear();
  for (const rec of wraps.values()) rec.wrap.remove();
  wraps.clear();
  for (const path of linkEls.values()) path.remove();
  linkEls.clear();
  for (const path of linkHits.values()) path.remove();
  linkHits.clear();
  for (const el of commentEls.values()) el.remove();
  commentEls.clear();
}

// ---------------------------------------------------------------- layout

function measureNodes() {
  for (const node of order) {
    const rec = wraps.get(node.id);
    if (!rec) continue;
    node.w = rec.wrap.offsetWidth;
    node.h = rec.wrap.offsetHeight;
  }
}

// Each top-level node is its own cluster: sized on its own, placed at its own
// stored spot. Clusters never push each other around, which is the whole point
// of dropping the single centre.
function computeLayout() {
  const root = treeRoot();
  if (!root) return;

  const size = (node) => {
    if (node.collapsed || !node.children.length) {
      node.subH = node.h;
      node.kidsH = 0;
      return node.subH;
    }
    let total = 0;
    for (const child of node.children) total += size(child);
    total += GAP_Y * (node.children.length - 1);
    node.kidsH = total;
    node.subH = Math.max(node.h, total);
    return node.subH;
  };

  const place = (node, x, top) => {
    node.tx = x;
    node.ty = top + (node.subH - node.h) / 2;
    if (node.collapsed || !node.children.length) return;
    let childTop = top + (node.subH - node.kidsH) / 2;
    for (const child of node.children) {
      place(child, x + node.w + GAP_X, childTop);
      childTop += child.subH + GAP_Y;
    }
  };

  for (const node of root.children) size(node);

  // Clusters that came from a plain outline have no position yet; give them
  // one under everything else and remember it, so the file gains coordinates
  // the next time it is saved instead of shuffling on every open.
  let bottom = null;
  for (const node of root.children) {
    if (!node.pos) continue;
    const b = node.pos.y + (node.subH || node.h || 0);
    if (bottom == null || b > bottom) bottom = b;
  }
  if (bottom == null) bottom = 0;
  for (const node of root.children) {
    if (node.pos) continue;
    node.pos = { x: 0, y: bottom };
    bottom += (node.subH || node.h || 0) + CLUSTER_GAP;
  }

  for (const node of root.children) {
    place(node, node.pos.x, node.pos.y - (node.subH - node.h) / 2);
  }
}

function setPos(node) {
  const rec = wraps.get(node.id);
  if (!rec) return;
  rec.wrap.style.transform = `translate3d(${node.cx || 0}px, ${node.cy || 0}px, 0)`;
}

// Put every visible node where layout says it is, without animating. Used
// while dragging a cluster so the children track the pointer exactly.
function stick() {
  cancelAnimationFrame(anim.raf);
  for (const node of order) {
    node.cx = node.tx;
    node.cy = node.ty;
    setPos(node);
  }
  drawLinks();
}

function animateLayout(animate = true, dur = 200) {
  cancelAnimationFrame(anim.raf);
  anim.from.clear();

  for (const node of order) {
    const known = Number.isFinite(node.cx) && Number.isFinite(node.cy);
    if (!animate || !known) {
      node.cx = node.tx;
      node.cy = node.ty;
      setPos(node);
    } else {
      anim.from.set(node.id, { x: node.cx, y: node.cy });
    }
  }

  if (!animate) { drawLinks(); return; }

  anim.t0 = performance.now();
  anim.dur = Math.max(1, dur);
  const step = (now) => {
    const t = Math.min(1, (now - anim.t0) / anim.dur);
    const e = 1 - Math.pow(1 - t, 3);
    for (const node of order) {
      const from = anim.from.get(node.id);
      if (from) {
        node.cx = from.x + (node.tx - from.x) * e;
        node.cy = from.y + (node.ty - from.y) * e;
      } else {
        node.cx = node.tx;
        node.cy = node.ty;
      }
      setPos(node);
    }
    drawLinks();
    if (t < 1) anim.raf = requestAnimationFrame(step);
  };
  anim.raf = requestAnimationFrame(step);
}

function settle() {
  cancelAnimationFrame(anim.raf);
  for (const node of order) {
    node.cx = node.tx;
    node.cy = node.ty;
    setPos(node);
  }
  drawLinks();
}

// ---------------------------------------------------------------- links

function drawLinks() {
  const hot = pathIds(mind.selectedId);
  const seen = new Set();

  for (const node of order) {
    const parent = parents.get(node.id);
    if (!parent) continue;
    const key = parent.id + '>' + node.id;
    seen.add(key);

    let path = linkEls.get(key);
    if (!path) {
      path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      linkLayer.appendChild(path);
      linkEls.set(key, path);
    }

    const x1 = (Number.isFinite(parent.cx) ? parent.cx : parent.tx) + parent.w;
    const y1 = (Number.isFinite(parent.cy) ? parent.cy : parent.ty) + parent.h / 2;
    const x2 = Number.isFinite(node.cx) ? node.cx : node.tx;
    const y2 = (Number.isFinite(node.cy) ? node.cy : node.ty) + node.h / 2;
    const dx = Math.max(34, (x2 - x1) * 0.52);

    path.setAttribute('d', `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`);
    const isHot = hot.has(node.id);
    const hovered = linkHoverChild === node.id;
    const gone = node.pend && node.pend.del;
    path.style.stroke = isHot ? ACCENT : (hovered ? 'rgba(255, 107, 107, .95)' : rgba(branchColor(node), .42));
    path.style.strokeWidth = isHot ? '2.2' : (hovered ? '2.4' : (node.depth === 1 ? '1.8' : '1.5'));
    path.style.opacity = isHot ? '1' : '.92';
    path.style.strokeDasharray = gone ? '4 4' : '';

    // Alt 提示层：按住 Alt 时整片连线垫一层淡红——剪哪儿，看得见。
    let hit = linkHits.get(key);
    if (!hit) {
      hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hit.setAttribute('class', 'link-hit');
      linkLayer.appendChild(hit);
      linkHits.set(key, hit);
    }
    hit.setAttribute('d', path.getAttribute('d'));
  }

  for (const [key, path] of linkEls) {
    if (!seen.has(key)) { path.remove(); linkEls.delete(key); }
  }
  for (const [key, hit] of linkHits) {
    if (!seen.has(key)) { hit.remove(); linkHits.delete(key); }
  }
}

// Alt 剪线的几何命中：在每条连线的贝塞尔上找离指针最近的点，12 屏幕像素内算中。
// 不走 SVG 指针事件——节点层永远压在连线层上面，靠 path 收事件看层叠脸色。
//
// 采样密度必须跟着线长走。以前固定取 16 个点：一个父节点挂几十个子节点时，
// 扇形被拉开、最外那根线能有一两千像素，16 段的点距就到一两百像素——指针
// 明明压在线上，最近采样点还在一百像素开外，于是既不算命中（红线不亮），
// Alt 也剪不断。现在按控制多边形的长度折算屏幕像素，每约 4 像素采一点。
//
// 距离算的是到「相邻采样点连成的弦」，不是到采样点本身：这种大扇形里几十根
// 线的 x 跨度只有 GAP_X（64px）、竖直方向却有一两千像素，屏幕上挤成一条相距
// 一两像素的竖线束，按采样点算距离误差和线间距同量级，会选到隔壁那根——红线
// 亮错、Alt 剪错枝。按弦算，最近的那根永远是真正压在指针下面的那根。
function hitLinkAt(wx, wy) {
  const s = mind.view.s || 1;
  const tol = 12 / s;
  const tol2 = tol * tol;
  let best = null;
  let bestD = tol2;

  for (const node of order) {
    const parent = parents.get(node.id);
    if (!parent) continue;
    if (node.pend && node.pend.del) continue;
    // 顶层的簇挂在虚拟根上：那个根没有尺寸，也没有连线可画。
    if (!Number.isFinite(parent.w) || !Number.isFinite(parent.h)) continue;
    const x1 = (Number.isFinite(parent.cx) ? parent.cx : parent.tx) + parent.w;
    const y1 = (Number.isFinite(parent.cy) ? parent.cy : parent.ty) + parent.h / 2;
    const x2 = Number.isFinite(node.cx) ? node.cx : node.tx;
    const y2 = (Number.isFinite(node.cy) ? node.cy : node.ty) + node.h / 2;
    if (Math.abs(x2 - x1) < 2 && Math.abs(y2 - y1) < 2) continue;
    const dx = Math.max(34, (x2 - x1) * 0.52);

    // 先粗筛：两个控制点的 y 都等于某端点的 y，所以曲线整体落在两端点的
    // 竖向区间里；x 方向最多被控制点带出去 dx。线多的时候这一步省掉九成采样。
    const pad = tol + dx;
    if (wx < Math.min(x1, x2) - pad || wx > Math.max(x1, x2) + pad) continue;
    if (wy < Math.min(y1, y2) - tol || wy > Math.max(y1, y2) + tol) continue;

    // 控制多边形长度是曲线长度的上界，用它折算采样步数就够了。
    const polyLen = dx + Math.hypot(x2 - x1 - 2 * dx, y2 - y1) + dx;
    const steps = Math.min(400, Math.max(12, Math.ceil((polyLen * s) / 4)));

    let d2 = bestD;
    let px = x1;
    let py = y1;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const mt = 1 - t;
      const sx = mt*mt*mt*x1 + 3*mt*mt*t*(x1 + dx) + 3*mt*t*t*(x2 - dx) + t*t*t*x2;
      const sy = mt*mt*mt*y1 + 3*mt*mt*t*y1 + 3*mt*t*t*y2 + t*t*t*y2;
      const ax = sx - px;
      const ay = sy - py;
      const len2 = ax * ax + ay * ay;
      let u = len2 > 0 ? ((wx - px) * ax + (wy - py) * ay) / len2 : 0;
      if (u < 0) u = 0; else if (u > 1) u = 1;
      const ex = px + ax * u - wx;
      const ey = py + ay * u - wy;
      const q = ex * ex + ey * ey;
      if (q < d2) d2 = q;
      px = sx;
      py = sy;
    }
    if (d2 < bestD) { bestD = d2; best = node.id; }
  }
  return best;
}

// ---------------------------------------------------------------- view

function applyView() {
  const { x, y, s } = mind.view;
  world.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${s})`;
  linkLayer.setAttribute('transform', `translate(${x} ${y}) scale(${s})`);

  if (s < .28) {
    stage.style.backgroundImage = 'none';
  } else {
    stage.style.backgroundImage = 'radial-gradient(circle, rgba(255,255,255,.062) 1px, transparent 1.15px)';
    stage.style.backgroundSize = `${24 * s}px ${24 * s}px`;
    stage.style.backgroundPosition = `${x}px ${y}px`;
  }
  ui.zoomLabel.textContent = Math.round(s * 100) + '%';
}

function mapBounds() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of order) {
    minX = Math.min(minX, node.tx);
    minY = Math.min(minY, node.ty);
    maxX = Math.max(maxX, node.tx + node.w);
    maxY = Math.max(maxY, node.ty + node.h);
  }
  // 注释框也占地方：适应画布时把它们一起框进来。
  for (const c of docComments()) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x + c.w);
    maxY = Math.max(maxY, c.y + c.h);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

// The note panel sits on the right, the review panel on the left; keep the map
// inside the band that is left over.
function panelInsets() {
  const left = (mind.review && ui.reviewPanel && !ui.reviewPanel.hidden)
    ? ui.reviewPanel.offsetWidth + 26
    : 0;
  const right = (typeof noteInset === 'function') ? noteInset() : 0;
  return { left, right };
}

function viewWidth() {
  const { left, right } = panelInsets();
  return Math.max(160, stage.clientWidth - left - right);
}

function fit(pad = 76, maxScale = 1.35) {
  settle();
  const b = mapBounds();
  const { left } = panelInsets();
  const W = viewWidth() || 1;
  const H = stage.clientHeight || 1;
  const s = clamp(Math.min((W - pad * 2) / b.w, (H - pad * 2) / b.h), .16, maxScale);
  mind.view.s = s;
  mind.view.x = left + (W - b.w * s) / 2 - b.x * s;
  mind.view.y = (H - b.h * s) / 2 - b.y * s;
  applyView();
}

function zoomAt(clientX, clientY, factor) {
  cancelViewAnim();
  const rect = stage.getBoundingClientRect();
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const oldS = mind.view.s;
  const s = clamp(oldS * factor, .12, 2.6);
  mind.view.x = px - (px - mind.view.x) * (s / oldS);
  mind.view.y = py - (py - mind.view.y) * (s / oldS);
  mind.view.s = s;
  applyView();
}

function zoomBy(factor) {
  const rect = stage.getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
}

function ensureVisible(node) {
  if (!node || !node.vis) return;
  const { x, y, s } = mind.view;
  const margin = 56;
  const { left: edge } = panelInsets();
  const W = viewWidth();
  const H = stage.clientHeight;
  const left = x + (Number.isFinite(node.cx) ? node.cx : node.tx) * s;
  const top = y + (Number.isFinite(node.cy) ? node.cy : node.ty) * s;
  const w = node.w * s;
  const h = node.h * s;

  let dx = 0, dy = 0;
  if (w + margin * 2 <= W) {
    if (left < edge + margin) dx = edge + margin - left;
    else if (left + w > edge + W - margin) dx = edge + W - margin - (left + w);
  } else if (left > edge + margin) dx = edge + margin - left;

  if (h + margin * 2 <= H) {
    if (top < margin) dy = margin - top;
    else if (top + h > H - margin) dy = H - margin - (top + h);
  } else if (top > margin) dy = margin - top;

  if (dx || dy) {
    mind.view.x += dx;
    mind.view.y += dy;
    applyView();
  }
}

// 滑过去，把节点停在可用视野的正中间——审批面板跳转用的是这个。
// 瞬移会让人"它去哪了"，一小段滑行让人"哦，在这儿"。
let viewRaf = 0;

function cancelViewAnim() {
  if (viewRaf) { cancelAnimationFrame(viewRaf); viewRaf = 0; }
}

function centerOnNode(node, dur = 360) {
  if (!node || !node.vis) return;
  const { left } = panelInsets();
  const W = viewWidth();
  const H = stage.clientHeight;
  const s0 = mind.view.s;
  const s1 = s0 < 0.6 ? 0.85 : s0;          // 缩得太小时顺手放大到能看清
  const x0 = mind.view.x, y0 = mind.view.y;
  const x1 = left + W / 2 - (node.tx + (node.w || 0) / 2) * s1;
  const y1 = H / 2 - (node.ty + (node.h || 0) / 2) * s1;
  cancelViewAnim();
  if (!Number.isFinite(x1) || !Number.isFinite(y1)) return;
  if (dur <= 0 || (Math.abs(x1 - x0) < .5 && Math.abs(y1 - y0) < .5 && s1 === s0)) {
    mind.view.s = s1; mind.view.x = x1; mind.view.y = y1;
    applyView();
    return;
  }
  const t0 = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - t, 3);
    mind.view.s = s0 + (s1 - s0) * e;
    mind.view.x = x0 + (x1 - x0) * e;
    mind.view.y = y0 + (y1 - y0) * e;
    applyView();
    viewRaf = t < 1 ? requestAnimationFrame(step) : 0;
  };
  viewRaf = requestAnimationFrame(step);
}

// World coordinates <-> screen, for "create a node right here".
function toWorld(clientX, clientY) {
  const rect = stage.getBoundingClientRect();
  const s = mind.view.s || 1;
  return {
    x: (clientX - rect.left - mind.view.x) / s,
    y: (clientY - rect.top - mind.view.y) / s,
  };
}

// ---------------------------------------------------------------- selection

function paintSelection() {
  for (const [id, rec] of wraps) rec.wrap.classList.toggle('selected', mind.selection.has(id));
  if (typeof syncBatchBar === 'function') syncBatchBar();
}

// opts.add keeps the rest of the selection (shift-click / shift-marquee).
function select(id, opts = {}) {
  if (!nodes.has(id)) return;
  if (opts.add) {
    if (mind.selection.has(id)) mind.selection.delete(id);
    else mind.selection.add(id);
  } else if (!(mind.selection.size === 1 && mind.selection.has(id))) {
    mind.selection = new Set([id]);
  }
  mind.selectedId = id;
  mind.selectedCommentId = null;   // 选节点就放下注释框
  renderComments();
  paintSelection();
  drawLinks();
  if (typeof syncNotePanel === 'function') syncNotePanel();
  if (opts.ensure !== false) ensureVisible(nodes.get(id));
  // 双向联动：点画布上带改动的节点，审批面板也要指到那一条。
  if (mind.review && typeof pointOpAt === 'function') pointOpAt(id);
}

function selectedNodes() {
  const out = [];
  for (const id of mind.selection) {
    const n = nodes.get(id);
    if (n) out.push(n);
  }
  return out;
}

function render(opts = {}) {
  syncDom();
  measureNodes();
  computeLayout();
  animateLayout(opts.animate !== false, opts.dur || 200);
  if (typeof updateStatus === 'function') updateStatus();
}
