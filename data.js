// Model: a forest of top-level nodes, saved as one plain-text outline.
// No framework and no dependencies — this file must run from file://.
//
// There is no visible root. `mind.root` is a container: its children are the
// top-level nodes, and only those carry a stored position. Everything below a
// top-level node is laid out relative to it, so dragging a top node moves the
// whole cluster and a child can never be dragged loose.

const ACCENT = '#7aa2f7';
const PALETTE = ['#7aa2f7', '#e0af68', '#9ece6a', '#c39bf7', '#f28ba8', '#62cfd6', '#f2a65a', '#8fb8ff'];

// Several documents live at once, one per tab. `mind` is whichever one is on
// screen; switching tabs rebinds it, and every function below keeps working
// unchanged because they all read through that name.
let mind = null;
const docs = [];

const nodes = new Map();     // id -> node (all nodes, visible or not)
const parents = new Map();   // id -> parent node (top level -> null)
const order = [];            // visible nodes, depth-first

let idSeq = 0;

function newNode(text) {
  idSeq++;
  return { id: 'n' + idSeq, text: text == null ? '' : String(text), note: '', collapsed: false, children: [] };
}

// The invisible container. Never drawn, never selectable.
function newRoot() {
  return { id: 'root', virt: true, text: '', note: '', collapsed: false, children: [] };
}

function blankDoc() {
  const root = newRoot();
  const first = newNode('中心主题');
  first.pos = { x: 0, y: 0 };
  root.children.push(first);
  return root;
}

// Older saves and loose trees come back as a single top-level node; wrap them
// so the container invariant always holds.
function asRoot(node) {
  if (!node) return blankDoc();
  if (node.virt) {
    if (Array.isArray(node.comments)) assignCommentIds(node.comments);
    return node;
  }
  node.pos = node.pos || { x: 0, y: 0 };
  const root = newRoot();
  root.children = [node];
  return root;
}

function adoptId(id) {
  const n = parseInt(String(id).slice(1), 10);
  if (Number.isFinite(n) && n > idSeq) idSeq = n;
}

// ---------------------------------------------------------------- indexing

// While a proposal is being reviewed the canvas shows a preview tree instead
// of the real one; every reader goes through here so layout, links and hit
// testing stay on the same tree.
function treeRoot() {
  if (!mind) return null;
  if (mind.review && mind.review.previewRoot) return mind.review.previewRoot;
  return mind.root;
}

function reindex() {
  nodes.clear();
  parents.clear();
  order.length = 0;
  const root = treeRoot();
  if (!root) return;
  root.children.forEach((node, i) => walkIndex(node, null, 0, i, true));
}

function walkIndex(node, parent, depth, branch, visible) {
  nodes.set(node.id, node);
  parents.set(node.id, parent);
  node.depth = depth;
  node.branch = branch;
  node.vis = visible;
  if (visible) order.push(node);
  const kidsVisible = visible && !node.collapsed;
  for (let i = 0; i < node.children.length; i++) {
    walkIndex(node.children[i], node, depth + 1, depth === 0 ? i : branch, kidsVisible);
  }
}

function branchColor(node) {
  if (!node || node.branch < 0) return ACCENT;
  return PALETTE[node.branch % PALETTE.length];
}

function parentOf(node) {
  if (!node) return null;
  return parents.get(node.id) || mind.root;
}

function isTop(node) {
  return !!node && !parents.get(node.id);
}

// Pass a root to count a document that is not the one on screen.
function totalNodes(root) {
  const start = root || (mind && mind.root);
  let n = 0;
  const walk = (x) => { n++; x.children.forEach(walk); };
  if (start) start.children.forEach(walk);
  return n;
}

function isDescendant(candidate, ancestor) {
  let p = candidate;
  while (p) {
    if (p === ancestor) return true;
    p = parents.get(p.id) || null;
  }
  return false;
}

// -------------------------------------------------------------- 蓝图注释框

// 注释框是画布上的标注，不是节点：一个框、一个可改的标题、一个颜色，
// 框住的顶层簇跟着它一起走。它们以整行 HTML 注释的形式存进 .md——
// 和坐标注释同一个思路，任何渲染器里都不可见。
//
//   <!--@comment:120,-40,420,220,#7aa2f7,这一块是渲染层-->

function docComments() {
  if (!mind || !mind.root) return [];
  if (!Array.isArray(mind.root.comments)) mind.root.comments = [];
  return mind.root.comments;
}

function parseCommentMarker(body) {
  const m = body.match(/^<!--@comment:(.*)-->\s*$/);
  if (!m) return null;
  const parts = m[1].split(',');
  const x = parseFloat(parts[0]);
  const y = parseFloat(parts[1]);
  const w = parseFloat(parts[2]);
  const h = parseFloat(parts[3]);
  const color = /^#[0-9a-fA-F]{6}$/.test(parts[4] || '') ? parts[4] : '#7aa2f7';
  // 标题后面可能跟着「｜框: …」的归属清单——那是存档时现算的，读回来拆掉，
  // 画布上的标题只显示用户写的那截。
  let text = parts.slice(5).join(',');
  let covers = '';
  const bar = text.indexOf('｜框:');
  if (bar >= 0) { covers = text.slice(bar); text = text.slice(0, bar); }
  text = text.replace(/\s+/g, ' ').trim();
  if (![x, y, w, h].every(Number.isFinite)) return null;
  return { x, y, w: Math.max(90, w), h: Math.max(46, h), color, text, covers };
}

// 从 .md 读回来的注释框在文件里没有 id（格式刻意保持简单），画布上的选中、
// 拖动、删除都靠 id 找框——这里按出现顺序补上，重复的旧 id 也一并换掉。
function assignCommentIds(list) {
  const used = new Set();
  let next = 1;
  for (const c of list) {
    let id = c.id && !used.has(c.id) ? c.id : '';
    if (!id) {
      while (used.has('c' + next)) next++;
      id = 'c' + next;
    }
    c.id = id;
    used.add(id);
  }
  return list;
}

function pathIds(id) {
  const set = new Set();
  let n = nodes.get(id) || null;
  while (n) {
    set.add(n.id);
    n = parents.get(n.id) || null;
  }
  return set;
}

// Where a node sits right now, in canvas coordinates. Used when a cluster is
// broken up and its children have to keep the place they were drawn in.
function settleX(node) {
  if (Number.isFinite(node.tx)) return node.tx;
  if (Number.isFinite(node.cx)) return node.cx;
  return 0;
}
function settleY(node) {
  if (Number.isFinite(node.ty)) return node.ty;
  if (Number.isFinite(node.cy)) return node.cy;
  return 0;
}

// ---------------------------------------------------------------- plain text

// The file is a plain Markdown outline: one list item per node, two spaces per
// level, and a node's note is a ">" quote tucked under its item. Top-level
// nodes end with an invisible HTML comment holding their canvas position —
// invisible in every renderer, obviously machine-written to any reader, and
// simply ignored when the file is handed to an AI.
//
//   - 产品定义 <!--@120,-40-->
//     - 想法
//
// Reading stays lenient: tabs or spaces, with or without the "- " bullet, so
// older outline files (including the tab-indented ones) still load.
const POS_RE = /^(.*?)\s*<!--@(-?\d+),(-?\d+)-->\s*$/;

function parseOutline(text, title) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  const rows = [];
  const comments = [];
  let fence = null;          // open fenced block inside a note

  for (const line of lines) {
    // Inside a fence every line belongs to the code, blank lines included,
    // and "- " / "> " lose their meaning until the closing fence.
    if (fence) {
      const row = rows[rows.length - 1];
      if (!line.trim()) { row.note.push(''); continue; }
      const m = line.match(/^([ \t]*)(.*)$/);
      const lead = m[1];
      const body = m[2];
      // A line left of the fence cannot be code — the fence was never closed.
      // Recover instead of swallowing the rest of the file.
      if (lead.length < fence.cut) fence = null;
      else {
        const close = body.match(/^(`{3,}|~{3,})[ \t]*$/);
        if (close && close[1][0] === fence.ch && close[1].length >= fence.len) {
          row.note.push(lead.length >= fence.cut ? line.slice(fence.cut) : body);
          fence = null;
          continue;
        }
        row.note.push(lead.length >= fence.cut ? line.slice(fence.cut) : body);
        continue;
      }
    }

    if (!line.trim()) continue;
    const m = line.match(/^([ \t]*)(.*)$/);
    let cols = 0;
    for (const ch of m[1]) cols += ch === '\t' ? 4 : 1;
    let body = m[2];

    // A "```" line opens a code block that belongs to the node above it.
    const open = body.match(/^(`{3,}|~{3,})(.*)$/);
    if (open && rows.length) {
      fence = { ch: open[1][0], len: open[1].length, cut: m[1].length };
      rows[rows.length - 1].note.push(body);
      continue;
    }

    // A ">" line continues the note of the node above it, however long it is.
    const quoted = body.match(/^>( ?)(.*)$/);
    if (quoted && rows.length) {
      rows[rows.length - 1].note.push(quoted[2]);
      continue;
    }
    if (quoted) body = quoted[2];

    // 蓝图注释框：顶层整行的机器标注，不是节点，跳过不进大纲。
    if (cols === 0 && /^<!--@comment:.*-->\s*$/.test(body)) {
      const c = parseCommentMarker(body);
      if (c) comments.push(c);
      continue;
    }

    body = body.replace(/^[-*+]\s+/, '');
    body = body.replace(/^\\(?=[-*+>])/, '');

    let pos = null;
    const pm = body.match(POS_RE);
    if (pm) { body = pm[1]; pos = { x: Number(pm[2]), y: Number(pm[3]) }; }
    rows.push({ cols, text: body, note: [], pos });
  }

  assignCommentIds(comments);
  const root = newRoot();
  if (!rows.length) {
    const first = newNode('中心主题');
    first.pos = { x: 0, y: 0 };
    root.children.push(first);
    root.comments = comments;
    return root;
  }

  let unit = 4;
  const positives = rows.map(r => r.cols).filter(v => v > 0);
  if (positives.length) unit = Math.max(1, Math.min(8, Math.min(...positives)));

  const roots = [];
  const stack = [];
  for (const row of rows) {
    let depth = Math.floor(row.cols / unit);
    if (depth > stack.length) depth = stack.length;
    stack.length = depth;
    const node = newNode(row.text.trim());
    if (row.note.length) node.note = row.note.join('\n').replace(/\s+$/, '');
    if (row.pos && depth === 0) node.pos = row.pos;
    if (stack.length) stack[stack.length - 1].children.push(node);
    else roots.push(node);
    stack.push(node);
  }

  root.children = roots;
  root.comments = comments;
  return root;
}

// Every line carries a "- " bullet, so node text may start with "- ", "* " or
// ">" and still read back unchanged. No escaping needed on the way out.
function toOutline(root) {
  const start = root || (mind && mind.root);
  const out = [];
  const walk = (node, depth) => {
    let text = String(node.text || '').replace(/[\r\n]+/g, ' ').trim();
    if (!text) text = '未命名';
    let line = '  '.repeat(depth) + '- ' + text;
    if (depth === 0 && node.pos) {
      line += ` <!--@${Math.round(node.pos.x)},${Math.round(node.pos.y)}-->`;
    }
    out.push(line);
    const note = String(node.note || '').replace(/\r\n?/g, '\n');
    if (note.trim()) {
      const indent = '  '.repeat(depth + 1);
      let fence = null;
      for (const ln of note.split('\n')) {
        const m = ln.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
        if (fence) {
          // Code lines stay bare: no "> " prefix, so every Markdown reader
          // sees a real fenced block nested in the list item.
          out.push(ln ? indent + ln : '');
          if (m && m[1][0] === fence.ch && m[1].length >= fence.len && !m[2].trim()) fence = null;
          continue;
        }
        if (m) {
          fence = { ch: m[1][0], len: m[1].length };
          out.push(indent + ln);
          continue;
        }
        out.push(indent + (ln ? '> ' + ln : '>'));
      }
    }
    for (const child of node.children) walk(child, depth + 1);
  };
  // 蓝图注释框不是孤儿标注：它框住谁（簇的根节点中心在框内），就写在那个簇的
  // 上面一层，并把框住的名字列进行尾——AI 读文件时，注释就是那一块的节标题。
  // 归属每次存档现算，不存在过期。
  const comments = (start && Array.isArray(start.comments)) ? start.comments : [];
  const before = new Map();     // 顶节点 -> 要插在它上面的注释行
  const tail = [];
  if (start && start.virt) {
    for (const c of comments) {
      const tops = [];
      for (const t of start.children) {
        const w = Number.isFinite(t.w) ? t.w : 140;
        const h = Number.isFinite(t.h) ? t.h : 34;
        const cx = (t.pos ? t.pos.x : 0) + w / 2;
        const cy = (t.pos ? t.pos.y : 0) + h / 2;
        if (cx > c.x && cx < c.x + c.w && cy > c.y && cy < c.y + c.h) tops.push(t);
      }
      const text = String(c.text || '').replace(/--+>/g, '—').replace(/[｜]/g, '丨').replace(/[\r\n]+/g, ' ').trim();
      const color = /^#[0-9a-fA-F]{6}$/.test(String(c.color || '')) ? c.color : '#7aa2f7';
      let title = text;
      if (tops.length) {
        const names = tops.map((t) =>
          String(t.text || '').replace(/--+>/g, '—').replace(/[｜,]/g, ' ').trim().slice(0, 24) || '未命名');
        title = text + '｜框: ' + names.join('、');
      }
      const line = `<!--@comment:${Math.round(c.x)},${Math.round(c.y)},${Math.round(c.w)},${Math.round(c.h)},${color},${title}-->`;
      if (tops.length) {
        const first = tops[0];
        if (!before.has(first)) before.set(first, []);
        before.get(first).push(line);
      } else {
        tail.push(line);
      }
    }
  }
  const walkTop = (node, lines) => {
    const pre = before.get(node);
    if (pre) for (const l of pre) lines.push(l);
  };
  if (start && start.virt) {
    for (const c of start.children) {
      walkTop(c, out);
      walk(c, 0);
    }
  } else if (start) {
    walk(start, 0);
  }
  for (const l of tail) out.push(l);
  return out.join('\n') + (out.length ? '\n' : '');
}

// Structure fingerprint: what a proposal was written against. Depth + text of
// every node, FNV-1a over the UTF-8 bytes — the same numbers are computed by
// propose.py, so a stale proposal can be caught before it rewrites the wrong
// line.
function treeHash(root) {
  const start = root || (mind && mind.root);
  const lines = [];
  const walk = (n, d) => {
    lines.push(d + '|' + String(n.text == null ? '' : n.text).trim());
    for (const c of n.children) walk(c, d + 1);
  };
  if (start) {
    if (start.virt) start.children.forEach((c) => walk(c, 0));
    else walk(start, 0);
  }
  const bytes = new TextEncoder().encode(lines.join('\n'));
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------- snapshots

function packNode(node) {
  const out = {
    id: node.id,
    text: node.text,
    collapsed: !!node.collapsed,
    children: node.children.map(packNode),
  };
  if (node.note) out.note = node.note;
  if (node.pos) out.pos = { x: Math.round(node.pos.x), y: Math.round(node.pos.y) };
  if (node.virt) {
    out.virt = true;
    // 注释框挂在虚拟根上，快照和工作区持久化都靠这里带走。
    if (Array.isArray(node.comments) && node.comments.length) {
      out.comments = node.comments.map((c) => ({ ...c }));
    }
  }
  return out;
}

function unpackNode(data) {
  const node = newNode(data && data.text != null ? data.text : '');
  if (data && data.id) { node.id = data.id; adoptId(node.id); }
  node.note = (data && data.note) ? String(data.note) : '';
  node.collapsed = !!(data && data.collapsed);
  if (data && data.virt) {
    node.virt = true; node.id = 'root';
    if (Array.isArray(data.comments)) node.comments = data.comments.map((c) => ({ ...c }));
  }
  if (data && data.pos) node.pos = { x: Number(data.pos.x) || 0, y: Number(data.pos.y) || 0 };
  node.children = ((data && data.children) || []).map(unpackNode);
  return node;
}

function snapshot() {
  return (mind && mind.root) ? JSON.stringify(packNode(mind.root)) : '';
}

function restoreSnapshot(json) {
  try {
    const data = JSON.parse(json);
    mind.root = asRoot(unpackNode(data));
    reindex();
    return true;
  } catch {
    return false;
  }
}

function pushUndo(snap) {
  const value = snap || snapshot();
  if (!value) return;
  if (mind.undo[mind.undo.length - 1] === value) return;
  mind.undo.push(value);
  if (mind.undo.length > 120) mind.undo.shift();
  mind.redo.length = 0;
  if (typeof updateUndoButtons === 'function') updateUndoButtons();
}

// ---------------------------------------------------------------- sample

function sampleTree() {
  return parseOutline([
    '产品定义',
    '\t> 每个节点都能带一段备注，选中后按 N 打开侧栏；备注会一起存进 .md 大纲。',
    '\t想法',
    '\t\t随手记下，Tab 让它变成子项',
    '\t\t> 点底部的「代码块」，选 JSON / TypeScript / Rust，再把代码粘进去：',
    '\t\t```rust',
    '\t\t#[derive(Clone, Copy)]',
    '\t\tpub struct Vec3 {',
    '\t\t  pub x: f32, pub y: f32, pub z: f32,',
    '\t\t}',
    '\t\t```',
    '\t\t回车继续在同一层写',
    '\t\t先按 F2 再输入，输入法不打架',
    '\t输出',
    '\t\t存成 .md：一行一个节点，缩进表示层级',
    '\t\t导出 PNG / SVG 给别人看',
    '画布',
    '\t拖动顶节点，整棵子树跟着走',
    '\t子节点跟着父节点，不能单独摆',
    '\t\t想让它自由，就删掉父节点——子节点会留在原地独立出来',
    '\t双击空白，在那儿长出一个新的顶节点',
    '\t框选一块再按 Delete，一次删掉一整片',
    '\t拖节点到另一个节点上，仍然是换父级',
    'AI 怎么改这份文件',
    '\t它不直接动 .md',
    '\t\t跑 propose.py 把改动写成一份提案',
    '\t\t打开这里就能看到改了哪几处，一条条点接受或拒绝',
    '\t接受之前，磁盘上的 .md 一个字都不会变',
  ].join('\n'), '产品定义');
}
