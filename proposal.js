// Proposals: an AI never edits the .md directly.
//
// It runs propose.py, which validates the changes and drops a proposal next to
// the outline (proposals/<名字>.proposal). Opening that proposal here replays
// it on the canvas as a preview: renames show the old text struck through,
// additions show as dashed ghosts, deletions stay in place but dimmed. Nothing
// reaches the real tree — let alone the file — until a change is accepted and
// the review is written.

const SEEN_KEY = 'mind.proposals.done.v1';

let pendingProposal = null;    // { text, name, src } fetched but not opened
let pollTimer = 0;
let rvRows = new Map();        // op index -> row element (rebuilt on every repaint)
let chipCount = 0;             // ops waiting for a human
let reviewResizer = null;      // width grip on the panel's right edge
const dismissed = new Set();   // closed by hand this session — do not pop it open again

// 关掉面板再点开，决定不该被重置：按提案文本的指纹，把已定的状态记在本场会话里。
const decisionMemo = new Map();   // textHash -> { states, groupOpen, doneOpen, index }

function rememberDecisions(r) {
  if (!r || !r.textHash) return;
  let m = decisionMemo.get(r.textHash);
  if (!m) {
    m = { states: new Map(), groupOpen: new Map(), doneOpen: false, index: 0 };
    decisionMemo.set(r.textHash, m);
  }
  m.states.clear();
  r.ops.forEach((op, i) => { if (!op.broken && op.state !== 'pending') m.states.set(i, op.state); });
  r.groups.forEach((g, gi) => { if (g && g.open !== undefined) m.groupOpen.set(gi, g.open); });
  m.doneOpen = r.doneOpen;
  m.index = r.index;
}

// ---------------------------------------------------------------- parsing

const OP_KINDS = new Set(['rename', 'note', 'add', 'del', 'drop', 'move']);

const GLYPH = { add: '+', del: '−', drop: '✕', note: '✎', move: '↦', rename: '~' };

const PATH_RE = /^-$|^\d+(\.\d+)*$/;

function parseProposal(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = { target: '', hash: '', ops: [], groups: [] };
  let i = 0;
  let gi = -1;                 // group being filled, -1 for loose ops
  while (i < lines.length && !lines[i].trim()) i++;

  if (i < lines.length && /^\s*→/.test(lines[i])) {
    out.target = lines[i].replace(/^\s*→\s*/, '').trim();
    i++;
  }

  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('~')) { out.hash = line.slice(1).trim().toLowerCase(); continue; }
    if (line.startsWith('#')) continue;

    // A block of changes that only makes sense as a whole ("these three are
    // the same rule; keep the fullest, drop the rest"). begin/why/end.
    if (line === 'end') { gi = -1; continue; }
    const bg = line.match(/^begin(?:\s+(.*))?$/);
    if (bg) {
      out.groups.push({ title: (bg[1] || '').trim() || '修改块', why: '', ops: [] });
      gi = out.groups.length - 1;
      continue;
    }
    const wm = line.match(/^why(?:\s+(.*))?$/);
    if (wm && gi >= 0) {
      let rest = (wm[1] || '').trim();
      if (rest === '<<') {
        const body = [];
        i++;
        while (i < lines.length && lines[i].trim() !== '>>') { body.push(lines[i]); i++; }
        rest = body.join('\n').replace(/\s+$/, '');
      }
      if (rest) out.groups[gi].why = out.groups[gi].why ? out.groups[gi].why + '\n' + rest : rest;
      continue;
    }

    const m = line.match(/^(rename|note|add|del|drop|move)\s+(\S+)\s?(.*)$/);
    if (!m) continue;
    const kind = m[1];
    if (!OP_KINDS.has(kind)) continue;
    const path = m[2];
    let rest = m[3];
    if (!PATH_RE.test(path)) continue;
    if (path === '-' && kind !== 'add') continue;   // 只有新增顶层能写 -

    const op = {
      kind, path, text: '', block: '', parentPath: '',
      state: 'pending', broken: false,
      targetReal: null, parentReal: null, pid: null, pids: null, label: path, index: out.ops.length,
      g: gi >= 0 ? gi : null, open: false,
    };

    if (kind === 'move') {
      // move <要动的节点> <新的父节点>，`-` 表示挂回顶层
      op.parentPath = rest.trim();
      if (!PATH_RE.test(op.parentPath)) continue;
    } else if (rest.trim() === '<<') {
      const body = [];
      i++;
      while (i < lines.length && lines[i].trim() !== '>>') { body.push(lines[i]); i++; }
      op.block = body.join('\n').replace(/\s+$/, '');
    } else {
      op.text = rest.replace(/\s+$/, '');
    }

    // `note 1 一句备注` / `add 1 新节点` 这种单行写法，propose.py 是允许的
    //（正文取行尾原样）；正文块就是这一行，后面的预览和落盘都走 block。
    if ((kind === 'add' || kind === 'note') && !op.block && op.text) op.block = op.text;

    if ((kind === 'add' || kind === 'note') && !op.block && !op.text) continue;
    out.ops.push(op);
    if (gi >= 0) out.groups[gi].ops.push(op.index);
  }
  return out;
}

// ---------------------------------------------------------------- targets

function resolvePath(path) {
  if (path === '-') return mind.root;
  const parts = path.split('.').map(Number);
  let list = mind.root.children;
  let node = null;
  for (const p of parts) {
    node = list[p - 1];
    if (!node) return null;
    list = node.children;
  }
  return node;
}

// Where a `move` puts things. `-` is the top level (the container).
function resolveParent(path) {
  return resolvePath(path);
}

function pathLabel(path, trimLast) {
  if (path === '-') return '顶层';
  const parts = path.split('.').map(Number);
  let list = mind.root.children;
  let node = null;
  const names = [];
  for (const p of parts) {
    node = list[p - 1];
    if (!node) return path;
    const t = String(node.text || '未命名').replace(/\s+/g, ' ');
    names.push(t.length > 12 ? t.slice(0, 12) + '…' : t);
    list = node.children;
  }
  if (trimLast) names.pop();
  return names.length ? names.join(' › ') : '顶层';
}

// ---------------------------------------------------------------- preview

function pendOf(node) {
  if (!node.pend) {
    node.pend = {
      add: false, del: false, mod: false, note: false, move: false,
      old: '', noteLines: '', to: '', state: '', act: false, g: null, grp: '',
      shadow: false, n: 0,
    };
  }
  return node.pend;
}

// 一个 add 是一整棵子树，一次决定。整棵都要看起来"还没定"，
// 否则下面那些节点跟已经在文件里的一模一样，谁也看不出它们还在提案里。
function markShadow(node) {
  let n = 0;
  for (const kid of node.children) {
    n++;
    pendOf(kid).shadow = true;
    n += markShadow(kid);
  }
  return n;
}

function markDeleted(node) {
  const p = pendOf(node);
  p.del = true;
  p.act = true;   // 整枝都可以在画布上判；点子孙也由 opsForNode 归到同一条删除
  for (const kid of node.children) markDeleted(kid);
}

// Outline fragment -> real node objects. Same syntax as the .md itself, so a
// block can carry notes and positions: it goes through the real parser.
function nodesFromBlock(block) {
  const text = String(block || '').trim();
  if (!text) return [];
  return parseOutline(text).children;
}

function buildPreview() {
  const r = mind.review;
  let pid = 0;
  const map = new Map();

  const clone = (n) => {
    pid++;
    const c = {
      id: 'p' + pid,
      text: n.text,
      note: n.note || '',
      collapsed: false,
      children: [],
      pos: n.pos ? { x: n.pos.x, y: n.pos.y } : null,
      real: n,
      pend: null,
    };
    map.set(n.id, c);
    c.children = n.children.map(clone);
    return c;
  };

  const root = {
    id: 'pvroot', virt: true, text: '', note: '', collapsed: false,
    children: mind.root.children.map(clone),
  };

  const detach = (node) => {
    const walk = (parent) => {
      const i = parent.children.indexOf(node);
      if (i >= 0) { parent.children.splice(i, 1); return true; }
      return parent.children.some((kid) => walk(kid));
    };
    walk(root);
  };
  const inTree = (node) => {
    if (!node) return false;
    const walk = (parent) => parent === node || parent.children.some(walk);
    return walk(root);
  };
  const parentInTree = (node) => {
    const walk = (parent) => {
      for (const kid of parent.children) {
        if (kid === node) return parent;
        const hit = walk(kid);
        if (hit) return hit;
      }
      return null;
    };
    return walk(root);
  };

  for (const op of r.ops) {
    if (op.state === 'rejected') continue;   // 拒绝的当它不存在：画布还原成原样
    if (op.kind === 'rename') {
      const node = op.targetReal ? map.get(op.targetReal.id) : null;
      if (!node) continue;
      const p = pendOf(node);
      p.mod = true;
      p.old = node.text;
      node.text = op.text || '未命名';
      op.pid = node.id;
    } else if (op.kind === 'note') {
      const node = op.targetReal ? map.get(op.targetReal.id) : null;
      if (!node) continue;
      const p = pendOf(node);
      p.note = true;
      p.noteLines = noteSummary(node.note, op.block);
      node.note = op.block;
      op.pid = node.id;
    } else if (op.kind === 'del' || op.kind === 'drop') {
      const node = op.targetReal ? map.get(op.targetReal.id) : null;
      if (!node) continue;
      op.count = countTree(node);
      op.pid = node.id;
      if (op.state === 'accepted') {
        // 生效后的样子：del 的子节点原地升一级，drop 整片从画布上消失。
        if (op.kind === 'del') {
          const lift = (parent) => {
            const i = parent.children.indexOf(node);
            if (i >= 0) {
              const kids = node.children.splice(0);
              // 和真实 unlinkNode 一样：升到顶层的孩子留在原来的画布位置，
              // 不能在接受预览里突然跳到左边那一列。
              if (parent.virt) {
                for (const k of kids) {
                  if (k.real) k.pos = { x: settleX(k.real), y: settleY(k.real) };
                }
              }
              parent.children.splice(i, 0, ...kids);
              return true;
            }
            return parent.children.some((kid) => lift(kid));
          };
          lift(root);
        } else {
          detach(node);
        }
      } else {
        markDeleted(node);
      }
    } else if (op.kind === 'move') {
      const node = op.targetReal ? map.get(op.targetReal.id) : null;
      const dst = op.parentPath === '-' ? root : (op.parentReal ? map.get(op.parentReal.id) : null);
      if (!node || !dst || dst === node) continue;
      if (!inTree(node) || !inTree(dst)) continue;     // 已被更早的改动删掉
      // dst 是不是 node 自己或自己的子孙？（这里必须从 node 往下找，
      // 反过来会把“搬到顶层/搬到祖先”误判成搬进自己。）
      const contains = (parent, target) => parent === target || parent.children.some((kid) => contains(kid, target));
      if (contains(node, dst)) continue;               // cannot move a node into itself
      if (parentInTree(node) === dst) { op.pid = node.id; continue; }   // 已经在这个父级下面
      detach(node);
      dst.children.push(node);
      const p = pendOf(node);
      p.move = true;
      // label it the way the parent reads on screen, not the way the file has it
      p.to = op.parentPath === '-' ? '顶层' : String(dst.text || '未命名');
      if (op.parentPath === '-' && op.targetReal) {
        // 停在它原来画着的位置：预览不该看起来像整串节点被删掉了。
        const sx = settleX(op.targetReal);
        const sy = settleY(op.targetReal);
        if (Number.isFinite(sx) && Number.isFinite(sy)) node.pos = { x: sx, y: sy };
      }
      op.pid = node.id;
    } else if (op.kind === 'add') {
      const kids = nodesFromBlock(op.block);
      let nodes = 0;
      for (const k of kids) {
        const p = pendOf(k);
        p.add = true;
        p.n = 1 + markShadow(k);
        nodes += p.n;
      }
      op.nodes = nodes;
      op.pids = kids.map((k) => k.id);
      if (op.path === '-') {
        const empty = root.children.length === 0;
        let right = 0;
        for (const t of root.children) {
          if (!t.pos) continue;
          right = Math.max(right, t.pos.x + (t.real && t.real.w ? t.real.w : 260));
        }
        let y = 0;
        for (const k of kids) {
          if (!k.pos && !empty) k.pos = { x: right + 140, y };
          y += 320;
        }
        root.children.push(...kids);
        op.pid = kids[0] ? kids[0].id : null;
      } else {
        const node = op.targetReal ? map.get(op.targetReal.id) : null;
        if (!node) continue;
        node.collapsed = false;
        node.children.push(...kids);
        op.pid = kids[0] ? kids[0].id : null;
      }
    }
  }

  // A block is a claim about several places at once, so every node it touches
  // remembers which block it belongs to — the tag on the node can say it.
  const pidx = previewIndex(root);
  for (const op of r.ops) {
    if (op.g == null || op.state === 'rejected') continue;
    const group = r.groups[op.g];
    for (const id of (op.pids || (op.pid ? [op.pid] : []))) {
      const n = pidx.get(id);
      if (n && n.pend) { n.pend.g = op.g; n.pend.grp = group ? group.title : ''; }
    }
  }

  stampPendStates(pidx, r.ops);
  return root;
}

// id -> node for a preview tree, before it is installed as the render tree.
function previewIndex(root) {
  const map = new Map();
  const walk = (n) => { map.set(n.id, n); n.children.forEach(walk); };
  root.children.forEach(walk);
  return map;
}

// Every node touched by the proposal carries the verdict of the ops that own
// it: accepted, rejected, or still open. A dropped subtree inherits its root's
// verdict so the whole branch dims together.
function stampPendStates(map, ops) {
  for (const n of map.values()) {
    if (!n.pend) continue;
    n.pend.state = '';
    n.pend.act = false;
  }

  const groups = new Map();
  for (const op of ops) {
    const ids = op.pids || (op.pid ? [op.pid] : []);
    for (const id of ids) {
      const n = map.get(id);
      if (!n || !n.pend) continue;
      n.pend.act = true;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(op.broken ? 'rejected' : op.state);
    }
  }
  // del/drop 是一整枝：子孙也放在画布上判，点哪个都由 opsForNode 归到同一条。
  for (const op of ops) {
    if (op.state === 'rejected' || (op.kind !== 'del' && op.kind !== 'drop')) continue;
    const root = map.get(op.pid);
    if (!root) continue;
    const markAct = (n) => {
      if (n.pend && n.pend.del) n.pend.act = true;
      n.children.forEach(markAct);
    };
    markAct(root);
  }
  for (const [id, states] of groups) {
    const ok = states.filter((s) => s === 'accepted').length;
    const no = states.filter((s) => s === 'rejected').length;
    map.get(id).pend.state = ok === states.length ? 'ok' : (no === states.length ? 'no' : '');
  }

  for (const n of map.values()) {
    if (!n.pend || !n.pend.state) continue;
    const inherit = (kid) => {
      if (kid.pend && (kid.pend.del || kid.pend.shadow)) {
        kid.pend.state = n.pend.state;
        if (kid.pend.del) kid.pend.act = true;   // 影子节点不给按钮，只跟着变颜色
      }
      kid.children.forEach(inherit);
    };
    n.children.forEach(inherit);
  }
}

function noteSummary(oldText, newText) {
  const a = String(oldText || '').split('\n').filter((l) => l.trim());
  const b = String(newText || '').split('\n').filter((l) => l.trim());
  const d = lineDiff(a.join('\n'), b.join('\n'));
  let add = 0, del = 0;
  for (const row of d) { if (row.t === 'add') add++; else if (row.t === 'del') del++; }
  const bits = [];
  if (del) bits.push('−' + del);
  if (add) bits.push('+' + add);
  return bits.join(' ') || '改写';
}

// Line-level diff, good enough for a note and small enough to keep here.
function lineDiff(a, b) {
  const A = a ? String(a).split('\n') : [];
  const B = b ? String(b).split('\n') : [];
  const n = A.length, m = B.length;
  if (n * m > 60000) {
    return [...A.map((t) => ({ t: 'del', text: t })), ...B.map((t) => ({ t: 'add', text: t }))];
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: 'same', text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', text: A[i] }); i++; }
    else { out.push({ t: 'add', text: B[j] }); j++; }
  }
  while (i < n) out.push({ t: 'del', text: A[i++] });
  while (j < m) out.push({ t: 'add', text: B[j++] });
  return out;
}

// ---------------------------------------------------------------- opening

function openProposalText(text, name, src) {
  if (!mind || !mind.root) return false;
  commitEdit();
  const fail = () => {
    pendingProposal = null;
    if (!mind.review) setChip(0);   // 已经打开的旧提案不受影响
    return false;
  };
  const parsed = parseProposal(text);
  if (!parsed.ops.length) { toast('这份提案里没有能读的改动'); return fail(); }

  // A big block reads as one line until you want to look inside; a small one
  // opens right away, because there is nothing to hide.
  for (const g of parsed.groups) g.open = g.ops.length <= 3;

  // 同一场会话里关掉又打开：把上次的决定、折叠状态和看到的地方原样放回来。
  const memo = decisionMemo.get(hashText(text));
  if (memo) {
    for (const [i, s] of memo.states) {
      const op = parsed.ops[i];
      if (op && !op.broken) op.state = s;
    }
    for (const [gi, open] of memo.groupOpen) {
      const g = parsed.groups[gi];
      if (g) g.open = open;
    }
  }

  // Dropped into the wrong tab is the usual first attempt — say which document
  // it belongs to instead of "the nodes are all gone".
  const want = String(parsed.target || '').replace(/\.(md|markdown|txt|mind)$/i, '');
  if (want && mind.name && want.toLowerCase() !== String(mind.name).toLowerCase()) {
    toast(`这份提案是给「${parsed.target}」的，现在打开的是「${mind.name}」——先切到那份再拖`);
    return fail();
  }

  if (mind.review) {
    rememberDecisions(mind.review);
    finishReview(false, false);
  }

  const broken = [];
  for (const op of parsed.ops) {
    if (op.path !== '-') {
      op.targetReal = resolvePath(op.path);
      if (!op.targetReal) { op.broken = true; op.state = 'rejected'; broken.push(op); continue; }
    }
    if (op.kind === 'move') {
      op.parentReal = resolveParent(op.parentPath);
      const intoSelf = op.parentReal && op.targetReal
        && (op.parentReal === op.targetReal || isDescendant(op.parentReal, op.targetReal));
      if (!op.parentReal || intoSelf) {
        op.broken = true;
        op.state = 'rejected';
        broken.push(op);
      }
    }
  }
  // 同一份提案里还有"搬进正被删掉的那一片"这种组合：单看每一步都合法，
  // 落下去却会把节点搬到一个已经不在树上的父级里（节点直接消失）。在打开
  // 提案时也按 propose.py 的规则标坏，旧文件或手写的提案同样挡住。
  for (const op of parsed.ops) {
    if (op.broken) continue;
    const dropVictims = parsed.ops.filter((o) => o !== op && o.kind === 'drop' && o.targetReal);
    const delVictims = parsed.ops.filter((o) => o !== op && o.kind === 'del' && o.targetReal);
    const conflict = dropVictims.some((o) => {
      const victim = o.targetReal;
      return (op.targetReal === victim && op.kind !== 'drop')
        || (op.targetReal && op.targetReal !== victim && isDescendant(op.targetReal, victim))
        || (op.kind === 'move' && op.parentReal && isDescendant(op.parentReal, victim));
    }) || delVictims.some((o) => {
      return (op.kind !== 'del' && op.targetReal === o.targetReal)
        || (op.kind === 'move' && op.parentReal === o.targetReal);
    });
    if (conflict) {
      op.broken = true;
      op.state = 'rejected';
      broken.push(op);
    }
  }
  const live = parsed.ops.filter((o) => !o.broken);
  if (!live.length) {
    const missing = broken.some((o) => !o.targetReal);
    toast(missing ? '提案里的节点都已经不在了' : '提案里的改动都不能用了：目标或移动位置对不上');
    markSeen(hashText(text));
    return fail();
  }

  if (mind.editingId) commitEdit();

  const stale = parsed.hash && parsed.hash !== treeHash(mind.root);
  const firstPending = parsed.ops.findIndex((o) => !o.broken);
  const resumed = !!(memo && Number.isInteger(memo.index)
    && parsed.ops[memo.index] && !parsed.ops[memo.index].broken);
  mind.review = {
    name: name || '提案',
    src: src || 'drop',
    hash: parsed.hash,
    textHash: hashText(text),
    stale,
    ops: parsed.ops,
    groups: parsed.groups,
    doneOpen: memo ? memo.doneOpen : false,
    broken: broken.length,
    index: resumed ? memo.index : (firstPending < 0 ? 0 : firstPending),
    snap: snapshot(),
    previewRoot: null,
  };

  rebuildPreview();
  syncReviewPanel();
  const first = mind.review.ops[mind.review.index];
  if (first) focusOp(mind.review.index);
  pendingProposal = null;
  toast(`${live.length} 项改动待审批${stale ? ' · 文档已变动，位置可能对不上' : ''}`);
  return true;
}

function openReview() {
  if (mind && mind.review) { syncReviewPanel(); return; }
  if (pendingProposal) {
    openProposalText(pendingProposal.text, pendingProposal.name, pendingProposal.src);
    return;
  }
  scanProposals(true);
}

function closeReview() {
  if (!mind || !mind.review) return;
  const hash = mind.review.textHash;
  if (hash) dismissed.add(hash);
  rememberDecisions(mind.review);   // 当前走到哪条、哪些块折着，也一起记住
  finishReview(false, false);
  toast('没写入，改动还在；点右上角「待审批」随时再打开');
}

// ---------------------------------------------------------------- panel

function bindReviewUI() {
  if (!ui.reviewPanel) return;
  const close = document.getElementById('rvClose');
  const write = document.getElementById('rvWrite');
  const all = document.getElementById('rvAll');
  const drop = document.getElementById('rvDrop');
  const list = document.getElementById('rvList');

  close.addEventListener('click', closeReview);
  write.addEventListener('click', writeReview);
  all.addEventListener('click', acceptAll);
  drop.addEventListener('click', discardAll);

  // The working list and the decided strip behave the same way on purpose:
  // one click model for both, so a second thought is not a different mode.
  const onListClick = (e) => {
    // Show the whole block behind a one-line preview.
    const more = e.target.closest('[data-more]');
    if (more) {
      const op = mind && mind.review && mind.review.ops[Number(more.dataset.i)];
      if (op) { op.open = !op.open; renderReviewRows(); }
      return;
    }

    const ghead = e.target.closest('.rv-ghead');
    if (ghead) {
      const gi = Number(ghead.dataset.g);
      if (e.target.closest('[data-yes]')) { decideGroup(gi, 'accepted'); return; }
      if (e.target.closest('[data-no]')) { decideGroup(gi, 'rejected'); return; }
      if (e.target.closest('[data-back]')) { revertGroup(gi); return; }
      const g = mind && mind.review && mind.review.groups[gi];
      if (g) { g.open = g.open === false; renderReviewRows(); rememberDecisions(mind.review); }
      return;
    }

    const row = e.target.closest('.rv-row');
    if (!row) return;
    const i = Number(row.dataset.i);
    if (e.target.closest('[data-yes]')) { decide(i, 'accepted'); return; }
    if (e.target.closest('[data-no]')) { decide(i, 'rejected'); return; }
    if (e.target.closest('[data-back]')) { decide(i, 'pending'); return; }
    focusOp(i);
  };

  // Hovering a card lights up every node it touches on the canvas.
  const onListHover = (e) => {
    const card = e.target.closest('.rv-group');
    markGroup(card ? Number(card.dataset.g) : -1);
  };

  list.addEventListener('click', onListClick);
  list.addEventListener('mouseover', onListHover);
  list.addEventListener('mouseleave', () => markGroup(-1));

  if (ui.reviewDoneList) {
    ui.reviewDoneList.addEventListener('click', onListClick);
    ui.reviewDoneList.addEventListener('mouseover', onListHover);
    ui.reviewDoneList.addEventListener('mouseleave', () => markGroup(-1));
  }
  if (ui.reviewDoneHead) {
    ui.reviewDoneHead.addEventListener('click', () => {
      if (!mind || !mind.review) return;
      mind.review.doneOpen = !mind.review.doneOpen;
      renderReviewRows();
      rememberDecisions(mind.review);
    });
  }

  if (ui.reviewChip) ui.reviewChip.addEventListener('click', () => { openReview(); ui.reviewChip.blur(); });

  // Same grip as the note panel, mirrored to the other side of the window.
  const grip = document.getElementById('rvGrip');
  if (grip && typeof bindPanelResize === 'function') {
    reviewResizer = bindPanelResize(ui.reviewPanel, grip, {
      key: 'review.width.v1',
      min: 300,
      max: () => window.innerWidth - 380 - ((mind && mind.noteOpen) ? notePanel.offsetWidth + 26 : 0),
      dir: 'right',
      onEnd: () => {
        const op = mind && mind.review && mind.review.ops[mind.review.index];
        const node = op ? nodes.get(op.pid) : null;
        if (node) ensureVisible(node);
      },
    });
  }

  const barOk = document.getElementById('batchOk');
  const barNo = document.getElementById('batchNo');
  if (barOk) barOk.addEventListener('click', () => { batchDecide('accepted'); focusStage(); });
  if (barNo) barNo.addEventListener('click', () => { batchDecide('rejected'); focusStage(); });

  pollProposals(1200);
}

function syncReviewPanel() {
  if (typeof syncHandoff === 'function') syncHandoff();   // 审批时左下角那块让位
  if (!ui.reviewPanel) return;
  if (!mind || !mind.review) {
    ui.reviewPanel.hidden = true;
    paintChip();
    return;
  }
  ui.reviewPanel.hidden = false;
  clampReviewWidth();
  paintChip();
  renderReviewRows();
}

// Opening the note panel shrinks the room this one may take; keep it honest.
function clampReviewWidth() {
  if (reviewResizer && ui.reviewPanel && !ui.reviewPanel.hidden) {
    reviewResizer.apply(ui.reviewPanel.offsetWidth);
  }
}

// The approval entry is always in the toolbar, dim when there is nothing to
// look at — hiding it entirely is how "how do I even review" happens.
function setChip(n) {
  chipCount = n || 0;
  paintChip();
}

function paintChip() {
  if (!ui.reviewChip) return;
  ui.reviewChip.hidden = !!(mind && mind.review);
  const on = chipCount > 0;
  ui.reviewChip.classList.toggle('quiet', !on);
  const label = document.getElementById('reviewCount');
  if (label) label.textContent = on ? `待审批 ${chipCount}` : '审批';
  ui.reviewChip.title = on
    ? `${chipCount} 项改动等你点头`
    : '看看有没有待审批的改动';
}

// Switching tabs must not leave the previous document's count on screen.
function resetProposalState() {
  pendingProposal = null;
  chipCount = 0;
  paintChip();
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

// ---------------------------------------------------------------- panel rows

// Which ops still need a human, in file order. A block stamps its verdict on
// the whole card: members stay together, and the card only sinks to the
// decided side once every one of them is decided. Splitting a block in half
// would take the sentence that explains it away from the rest.
function reviewPlan(r) {
  const done = new Set();
  const dead = new Set();
  r.groups.forEach((g, gi) => {
    const live = g.ops.map((i) => r.ops[i]).filter((o) => o && !o.broken);
    if (!live.length) { dead.add(gi); return; }
    if (live.every((o) => o.state !== 'pending')) done.add(gi);
  });

  const pending = [];
  const settled = [];
  const seen = new Set();
  r.ops.forEach((op, i) => {
    // A target that disappeared since the proposal was written stays visible:
    // its row is disabled and says so, instead of silently vanishing.
    if (op.broken) { pending.push({ kind: 'op', i }); return; }
    if (op.g != null) {
      if (seen.has(op.g) || dead.has(op.g)) { seen.add(op.g); return; }
      seen.add(op.g);
      (done.has(op.g) ? settled : pending).push({ kind: 'group', gi: op.g });
      return;
    }
    (op.state === 'pending' ? pending : settled).push({ kind: 'op', i });
  });
  return { pending, settled };
}

function renderReviewRows() {
  const r = mind && mind.review;
  const list = document.getElementById('rvList');
  if (!r || !list) return;

  const live = r.ops.filter((o) => !o.broken);
  const dead = r.ops.length - live.length;
  const pending = live.filter((o) => o.state === 'pending').length;
  const accepted = live.filter((o) => o.state === 'accepted').length;
  const rejected = live.filter((o) => o.state === 'rejected').length;

  const head = document.getElementById('rvCount');
  if (head) {
    head.textContent = `${live.length} 项 · ${pending} 待定 · ${accepted} 接受 · ${rejected} 拒绝`
      + (dead ? ` · ${dead} 失效` : '');
  }
  const file = document.getElementById('rvFile');
  if (file) file.textContent = r.name;
  const warn = document.getElementById('rvWarn');
  if (warn) warn.hidden = !r.stale;

  const writeBtn = document.getElementById('rvWrite');
  if (writeBtn) {
    writeBtn.disabled = !accepted;
    writeBtn.textContent = accepted ? `写入 ${accepted} 项` : '写入';
  }
  const allBtn = document.getElementById('rvAll');
  if (allBtn) {
    allBtn.hidden = !pending;
    allBtn.textContent = `全部接受 ${pending + accepted}`;
  }

  list.textContent = '';
  rvRows = new Map();
  const plan = reviewPlan(r);

  for (const entry of plan.pending) {
    if (entry.kind === 'group') list.append(groupCard(r, entry.gi, false));
    else list.append(opRow(r, entry.i, {}));
  }
  if (!plan.pending.length) list.append(settledEmpty(pending, accepted));

  // Decided changes drop out of the working list and collect in a strip at the
  // bottom of the panel: always there, never in the way, one click from a
  // second thought.
  const done = ui.reviewDone;
  const doneList = ui.reviewDoneList;
  const doneHead = ui.reviewDoneHead;
  const count = document.getElementById('rvDoneCount');
  if (done && doneList && doneHead) {
    done.hidden = !plan.settled.length;
    doneList.textContent = '';
    doneList.hidden = !r.doneOpen;
    doneHead.setAttribute('aria-expanded', r.doneOpen ? 'true' : 'false');
    const caret = document.getElementById('rvDoneCaret');
    if (caret) caret.textContent = r.doneOpen ? '▾' : '▸';
    if (count) count.textContent = `${accepted + rejected} 项 · ${accepted} 接受 · ${rejected} 拒绝`;
    doneHead.title = r.doneOpen ? '收起已决的' : '展开已决的，可以退回重审';
    if (r.doneOpen) {
      for (const entry of plan.settled) {
        if (entry.kind === 'group') doneList.append(groupCard(r, entry.gi, true));
        else doneList.append(opRow(r, entry.i, { done: true }));
      }
    }
  }

  highlightRow(r.index);
  chipCount = pending;
  paintChip();
}

// ---- one row per change

function blockView(op, rows, cls, emptyText) {
  const box = el('div', 'rv-block');
  const pre = el('pre', 'rv-note' + (cls ? ' ' + cls : ''));
  const limit = op.open ? rows.length : Math.min(rows.length, 8);
  for (let k = 0; k < limit; k++) {
    const ln = el('div', 'rv-ln');
    ln.dataset.t = rows[k].t;
    ln.textContent = rows[k].text;
    pre.append(ln);
  }
  if (!rows.length) pre.append(el('div', 'rv-ln', emptyText || '（空）'));
  box.append(pre);
  if (rows.length > 8) {
    const more = el('button', 'rv-more', op.open ? '收起' : `还有 ${rows.length - 8} 行 · 展开`);
    more.type = 'button';
    more.dataset.more = '1';
    more.dataset.i = String(op.index);
    box.append(more);
  }
  return box;
}

// The first line of an add block is the node being created; the rest is its
// subtree. Showing it in the header beats repeating the parent path.
function addedName(block) {
  for (const line of String(block || '').split('\n')) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) return '';
    const text = line.replace(/^[-*+]\s+/, '').trim();
    if (!text || text.startsWith('>')) continue;
    return text;
  }
  return '';
}

// 面板行里只留短位置：末一两段（父 › 节点），不挂 1.2.3 这种序号——
// 完整路径放在悬停提示里，位置本身由画布呈现。
function opWhere(op) {
  const tail = (s, n) => String(s || '').split(' › ').slice(-n).filter(Boolean).join(' › ');
  if (op.kind === 'add') {
    const name = addedName(op.block);
    const parent = op.path === '-' ? '新的顶层' : tail(pathLabel(op.path), 1);
    return [parent, name].filter(Boolean).join(' › ');
  }
  return tail(pathLabel(op.path), 2);
}

// An add block carries a whole subtree. Show it as a tree, not as eight lines
// of markdown: the reviewer has to be able to read every node being added.
// 折叠时备注只报行数，展开才铺全文——不展开也能看出"这里带了备注"。
function addRows(op, full) {
  const rows = [];
  const walkNode = (n, depth) => {
    const pad = '  '.repeat(depth);
    rows.push({ t: 'add', text: '+ ' + pad + String(n.text || '未命名') });
    const lines = String(n.note || '').replace(/\s+$/, '').split('\n').filter((l) => l.trim());
    if (lines.length) {
      if (full) {
        for (const line of lines) rows.push({ t: 'same', text: pad + '  ' + line });
      } else {
        rows.push({ t: 'note', text: pad + '  · 备注 ' + lines.length + ' 行' });
      }
    }
    for (const kid of n.children) walkNode(kid, depth + 1);
  };
  for (const k of nodesFromBlock(op.block)) walkNode(k, 0);
  return rows;
}

function opRow(r, i, opts) {
  const op = r.ops[i];
  const row = el('div', 'rv-row');
  row.dataset.i = String(i);
  row.classList.toggle('in-group', !!opts.group);
  row.classList.toggle('in-done', !!opts.done);
  row.classList.toggle('cur', i === r.index);
  row.classList.toggle('ok', op.state === 'accepted');
  row.classList.toggle('no', op.state === 'rejected');
  row.classList.toggle('bad', !!op.broken);

  const kind = el('span', 'rv-kind', GLYPH[op.kind] || '~');
  kind.dataset.k = op.kind;

  const body = el('div', 'rv-body');
  const line1 = el('div', 'rv-line1');
  const where = el('span', 'rv-where', opWhere(op));
  where.title = op.path === '-' ? '新的顶层' : pathLabel(op.path);
  line1.append(where);
  const stateTag = el('span', 'rv-state', op.broken ? '目标没了' : (op.state === 'accepted' ? '接受' : op.state === 'rejected' ? '拒绝' : ''));
  line1.append(stateTag);
  body.append(line1);

  if (op.kind === 'rename') {
    const d = el('div', 'rv-diff');
    d.append(el('span', 'rv-old', (op.targetReal && op.targetReal.text) || '未命名'));
    d.append(el('span', 'rv-arrow', '→'));
    d.append(el('span', 'rv-new', op.text || '未命名'));
    body.append(d);
  } else if (op.kind === 'del') {
    const p = nodeOf(op);
    const count = op.count || (p ? countTree(p) : 1);
    const note = count > 1
      ? `连它下面 ${count - 1} 个节点一起移除 · 子节点升一级`
      : '移除这一个 · 没有子节点';
    body.append(el('div', 'rv-diff rv-dim', note));
  } else if (op.kind === 'drop') {
    const p = nodeOf(op);
    const count = op.count || (p ? countTree(p) : 1);
    body.append(el('div', 'rv-diff rv-dim', `整片删掉，含下面 ${count - 1} 个节点`));
    if (p && p.note) {
      const rows = lineDiff(p.note, '').map((row) => ({ t: row.t, text: '− ' + row.text }));
      body.append(blockView(op, rows, ''));
    }
  } else if (op.kind === 'move') {
    const p = nodeOf(op);
    const to = (p && p.pend && p.pend.to) || (op.parentPath === '-' ? '顶层' : pathLabel(op.parentPath));
    const d = el('div', 'rv-diff');
    d.append(el('span', 'rv-arrow', '搬到'));
    d.append(el('span', 'rv-new', to));
    body.append(d);
  } else if (op.kind === 'note') {
    // 程序自己比对的逐行 diff：只看变了的行，一眼看出这次改了什么。
    const old = op.targetReal ? op.targetReal.note : '';
    const rows = lineDiff(old, op.block);
    const changed = rows.filter((row) => row.t !== 'same');
    const view = changed.length
      ? changed.map((row) => ({ t: row.t, text: (row.t === 'add' ? '+ ' : '− ') + row.text }))
      : rows.slice(0, 8).map((row) => ({ t: 'same', text: '  ' + row.text }));
    body.append(blockView(op, view, '', '（清空备注）'));
  } else if (op.kind === 'add') {
    if (op.nodes > 1) {
      body.append(el('div', 'rv-diff rv-dim', `整棵新增 ${op.nodes} 个节点 · 一起接受或拒绝`));
    }
    body.append(blockView(op, addRows(op, op.open), 'rv-add', '（空节点）'));
  }

  const act = el('div', 'rv-act');
  const yes = el('button', 'rv-btn yes', '✓');
  yes.dataset.yes = '1';
  yes.type = 'button';
  yes.title = op.state === 'accepted' ? '已经是接受了，再点一次退回未定' : '接受这一项  Enter';
  yes.disabled = !!op.broken;
  const no = el('button', 'rv-btn no', '✕');
  no.dataset.no = '1';
  no.type = 'button';
  no.title = op.state === 'rejected' ? '已经是拒绝了，再点一次退回未定' : '拒绝这一项  X';
  no.disabled = !!op.broken;
  act.append(yes, no);

  if (op.state !== 'pending' && !op.broken) {
    const back = el('button', 'rv-btn back', '↩');
    back.dataset.back = '1';
    back.type = 'button';
    back.title = '退回未定，重新考虑';
    act.append(back);
  }

  row.append(kind, body, act);
  rvRows.set(i, row);
  return row;
}

// ---- one card per block

function groupCard(r, gi, done) {
  const g = r.groups[gi];
  const ops = g.ops.map((i) => r.ops[i]).filter((o) => o && !o.broken);
  const ok = ops.filter((o) => o.state === 'accepted').length;
  const no = ops.filter((o) => o.state === 'rejected').length;
  const open = g.open !== false;

  const card = el('div', 'rv-group');
  card.dataset.g = String(gi);
  card.classList.toggle('closed', !open);
  card.classList.toggle('done', !!done);

  const head = el('div', 'rv-ghead');
  head.dataset.g = String(gi);

  const title = el('span', 'rv-gtitle', g.title);
  title.title = g.why || g.title;
  head.append(el('span', 'rv-caret', open ? '▾' : '▸'), title);

  // What is in here, at a glance — a block with a − in it is the one to read.
  // `+` 后面数的是节点，不是条数：一条 add 可能是一整棵 20 个节点。
  const kinds = {};
  for (const o of ops) kinds[o.kind] = (kinds[o.kind] || 0) + 1;
  const addNodes = ops.filter((o) => o.kind === 'add').reduce((n, o) => n + (o.nodes || 1), 0);
  const tally = el('span', 'rv-gkinds');
  for (const k of ['add', 'rename', 'note', 'move', 'del', 'drop']) {
    if (!kinds[k]) continue;
    const mark = el('span', 'rv-gkind', (GLYPH[k] || '~') + (k === 'add' ? addNodes : kinds[k]));
    mark.dataset.k = k;
    if (k === 'add') mark.title = `${kinds[k]} 项新增，共 ${addNodes} 个节点`;
    tally.append(mark);
  }
  head.append(tally);

  const progress = ok + no === ops.length && ok === ops.length ? '全接受'
    : ok + no === ops.length && no === ops.length ? '全拒绝'
      : `${ok + no}/${ops.length}`;
  head.append(el('span', 'rv-gcount', progress));

  const act = el('div', 'rv-act');
  const allYes = ok === ops.length;
  const allNo = no === ops.length;
  const yes = el('button', 'rv-btn yes', '✓');
  yes.dataset.yes = '1';
  yes.type = 'button';
  yes.title = allYes ? `整块收回未定（${ops.length} 项）` : `整块接受（${ops.length} 项一起）`;
  const noBtn = el('button', 'rv-btn no', '✕');
  noBtn.dataset.no = '1';
  noBtn.type = 'button';
  noBtn.title = allNo ? `整块收回未定（${ops.length} 项）` : `整块拒绝（${ops.length} 项一起）`;
  act.append(yes, noBtn);
  if (done) {
    const back = el('button', 'rv-btn back', '↩');
    back.dataset.back = '1';
    back.type = 'button';
    back.title = '整块退回未定';
    act.append(back);
  }
  head.append(act);
  card.append(head);

  const body = el('div', 'rv-gbody');
  if (g.why) body.append(el('p', 'rv-why', g.why));
  for (const op of ops) body.append(opRow(r, r.ops.indexOf(op), { group: true, done }));
  card.append(body);
  return card;
}

function settledEmpty(pending, accepted) {
  const box = el('div', 'rv-empty');
  if (!pending && !accepted) {
    box.append(el('div', 'rv-empty-t', '没有能落地的改动'));
    box.append(el('div', 'rv-empty-s', '全部被拒了。关掉提案，文件一个字都没动。'));
    return box;
  }
  box.append(el('div', 'rv-empty-t', '都决定了'));
  box.append(el('div', 'rv-empty-s', accepted
    ? `写入 ${accepted} 项就落到文件里。反悔的话，收起的那一节「已决」可以退回。`
    : '没有要写入的改动。'));
  return box;
}

function nodeOf(op) {
  if (!op || !op.pid) return null;
  return nodes.get(op.pid) || null;
}

function countTree(node) {
  let n = 0;
  const walk = (x) => { n++; x.children.forEach(walk); };
  if (node) walk(node);
  return n;
}

function highlightRow(i) {
  for (const [k, row] of rvRows) row.classList.toggle('cur', k === i);
  const row = rvRows.get(i);
  if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
}

// 点画布上的节点 → 面板指到它挂着的改动：双向联动的另一半。
// 顺带把这一条设为"当前"，这样 Enter / X 就是对它做决定。
function pointOpAt(nodeId) {
  const r = mind && mind.review;
  if (!r || !nodeId) return;
  const ops = opsForNode(nodes.get(nodeId));
  if (!ops.length) return;
  const op = ops[0];
  const i = r.ops.indexOf(op);
  if (i < 0) return;
  r.index = i;
  if (op.state !== 'pending' && !r.doneOpen) r.doneOpen = true;
  highlightRow(i);
  markGroup(op.g == null ? -1 : op.g);
}

// Hovering a card marks every node it touches, so a block reads as one move
// on the canvas too — three "isolated" deletions show up as one cleanup.
function markGroup(gi) {
  if (!mind || !mind.review) return;
  for (const [id, rec] of wraps) {
    const node = nodes.get(id);
    const on = gi >= 0 && node && node.pend && node.pend.g === gi;
    rec.wrap.classList.toggle('grp-hit', !!on);
  }
}

// ---------------------------------------------------------------- decisions

function rebuildPreview() {
  const r = mind && mind.review;
  if (!r) return;
  r.previewRoot = buildPreview();
  resetViewDom();
  reindex();
  const op = r.ops[r.index];
  const node = op ? nodes.get(op.pid) : null;
  if (node) {
    mind.selectedId = node.id;
    mind.selection = new Set([node.id]);
  }
  render({ animate: false });
  updateStatus();
  syncBatchBar();
}

// Which operations a node stands for: its own, or — for a node inside a
// dropped branch — the one that owns the branch.
function opsForNode(node) {
  const r = mind && mind.review;
  if (!r || !node) return [];
  let n = node;
  while (n) {
    const hit = r.ops.filter((o) => !o.broken && (o.pid === n.id || (o.pids && o.pids.includes(n.id))));
    if (hit.length) return hit;
    n = parents.get(n.id) || null;
  }
  return [];
}

// A decision changes what the preview should look like (accepted = applied,
// rejected = gone), so the preview is rebuilt from scratch — the tree is
// small, the human just clicked, and honesty beats micro-optimizations.
function syncReviewChrome() {
  const r = mind && mind.review;
  if (!r) return;
  rememberDecisions(r);
  rebuildPreview();
  chipCount = r.ops.filter((o) => o.state === 'pending' && !o.broken).length;
  paintChip();
  syncBatchBar();
}

// The next change still waiting, going forward and then wrapping. Decided
// rows sink out of the list, so the eye has to be told where to go next —
// otherwise every verdict leaves the panel pointing at a row that just left.
function nextPendingFrom(r, from) {
  const waiting = (o) => o && !o.broken && o.state === 'pending';
  for (let k = from + 1; k < r.ops.length; k++) if (waiting(r.ops[k])) return k;
  for (let k = 0; k < from; k++) if (waiting(r.ops[k])) return k;
  return null;
}

function decide(i, state) {
  const r = mind && mind.review;
  if (!r) return;
  const op = r.ops[i];
  if (!op || op.broken) return;
  op.state = op.state === state ? 'pending' : state;
  r.index = op.state === 'pending' ? i : (nextPendingFrom(r, i) ?? i);
  syncReviewChrome();
  renderReviewRows();
  focusOp(r.index, true);
}

// Whole block in one click: accept / reject every member, or take it all back
// to undecided when they already share the verdict.
function decideGroup(gi, state) {
  const r = mind && mind.review;
  const g = r && r.groups[gi];
  if (!g) return;
  const ops = g.ops.map((i) => r.ops[i]).filter((o) => o && !o.broken);
  if (!ops.length) return;
  const same = ops.every((o) => o.state === state);
  for (const o of ops) o.state = same ? 'pending' : state;
  const first = r.ops.indexOf(ops[0]);
  const jump = same ? first : nextPendingFrom(r, Math.max(...g.ops));
  r.index = jump == null ? first : jump;
  syncReviewChrome();
  renderReviewRows();
  focusOp(r.index, true);
}

function revertGroup(gi) {
  const r = mind && mind.review;
  const g = r && r.groups[gi];
  if (!g) return;
  for (const i of g.ops) {
    const op = r.ops[i];
    if (op && !op.broken) op.state = 'pending';
  }
  r.index = g.ops[0];
  syncReviewChrome();
  renderReviewRows();
  focusOp(r.index, true);
}

// Verdict straight from the node: all of its operations move together, and
// clicking the same verdict again takes it back to undecided.
function decideNode(node, state) {
  const ops = opsForNode(node);
  if (!ops.length) return false;
  return decideList(ops, state);
}

function decideList(list, state) {
  const r = mind && mind.review;
  if (!r || !list.length) return false;
  const next = list.every((o) => o.state === state) ? 'pending' : state;
  for (const op of list) op.state = next;
  const first = r.ops.indexOf(list[0]);
  if (first >= 0) r.index = first;
  syncReviewChrome();
  renderReviewRows();
  focusOp(r.index, true);
  return true;
}

function selectionOps() {
  const r = mind && mind.review;
  if (!r || !mind.selection || mind.selection.size < 2) return [];
  const seen = new Set();
  for (const id of mind.selection) {
    for (const op of opsForNode(nodes.get(id))) seen.add(op);
  }
  return [...seen];
}

// The bar under the canvas: decide everything currently selected in one click.
function syncBatchBar() {
  const bar = ui.batchBar;
  if (!bar) return;
  const r = mind && mind.review;
  if (!r || !mind.selection || mind.selection.size < 2) { bar.hidden = true; return; }
  const ops = selectionOps();
  if (!ops.length) { bar.hidden = true; return; }
  let nodesN = 0;
  for (const id of mind.selection) if (opsForNode(nodes.get(id)).length) nodesN++;
  bar.hidden = false;
  ui.batchText.textContent = `${nodesN} 个节点 · ${ops.length} 项改动`;
}

function batchDecide(state) {
  const r = mind && mind.review;
  if (!r) return;
  const ops = selectionOps();
  if (!ops.length) return;
  decideList(ops, state);
}

function focusOp(i, keepRow) {
  const r = mind && mind.review;
  if (!r) return;
  const op = r.ops[i];
  if (!op) return;
  r.index = i;

  // A decided row lives on the decided side; reveal the strip before pointing.
  // 但折叠的修改块不再被强行展开——那是"莫名其妙的展开"的来源。
  let redraw = false;
  if (op.state !== 'pending' && !r.doneOpen) { r.doneOpen = true; redraw = true; }

  const node = nodes.get(op.pid);
  if (node) {
    mind.selectedId = node.id;
    mind.selection = new Set([node.id]);
    paintSelection();
    drawLinks();
    centerOnNode(node);              // 滑到正中间，不再瞬移、不再落在边缘
    if (typeof syncNotePanel === 'function') syncNotePanel();
  }
  if (!keepRow || redraw) renderReviewRows();
  else highlightRow(i);
  markGroup(op.g == null ? -1 : op.g);
}

function stepReview(delta) {
  const r = mind && mind.review;
  if (!r) return;
  const waiting = [];
  const rest = [];
  r.ops.forEach((o, i) => {
    if (o.broken) return;
    (o.state === 'pending' ? waiting : rest).push(i);
  });
  // Walk what still needs a decision; only when nothing is left, the decided.
  const seq = waiting.length ? waiting : rest;
  if (!seq.length) return;
  let k = seq.indexOf(r.index);
  if (k < 0) k = delta > 0 ? -1 : 0;
  const next = seq[((k + delta) % seq.length + seq.length) % seq.length];
  focusOp(next);
}

function reviewKey(e, mod) {
  const r = mind && mind.review;
  if (!r) return false;
  if (e.key === 'Escape') {
    e.preventDefault();
    // 审批时右侧备注也能开；Esc 先收备注，再按一次才关审批面板。
    if (mind.noteOpen) closeNote();
    else closeReview();
    return true;
  }
  if (mod && e.key === 'Enter') { e.preventDefault(); acceptAll(); return true; }
  if (mod) return false;
  if (e.key === 'ArrowDown') { e.preventDefault(); stepReview(1); return true; }
  if (e.key === 'ArrowUp') { e.preventDefault(); stepReview(-1); return true; }
  if (e.key === 'Enter') {
    e.preventDefault();
    // A sweep of picked nodes decides as one; nothing picked means the row.
    const picked = selectionOps();
    if (picked.length) decideList(picked, 'accepted');
    else decide(r.index, 'accepted');
    return true;
  }
  // Looking at the note stays useful while deciding — it opens read-only.
  if (e.key === 'n' || e.key === 'N') { e.preventDefault(); if (!e.repeat) toggleNote(); return true; }
  if (e.key === 'Backspace' || e.key === 'Delete' || e.key === 'x' || e.key === 'X') {
    e.preventDefault();
    const picked = selectionOps();
    if (picked.length) decideList(picked, 'rejected');
    else decide(r.index, 'rejected');
    return true;
  }
  return false;
}

function acceptAll() {
  const r = mind && mind.review;
  if (!r) return;
  // 全部接受只做决定，不落盘：画布当场呈现全部生效后的样子，
  // 满意点「写入」落盘，哪条反悔了去「已决」里 ↩。预览和提交的边界就在这。
  for (const op of r.ops) if (!op.broken) op.state = 'accepted';
  syncReviewChrome();
  renderReviewRows();
  const first = r.ops.findIndex((o) => !o.broken);
  if (first >= 0) focusOp(first, true);
  toast('全部标为接受 ·「写入」才落盘，反悔去「已决」里 ↩');
}

// Write exactly what has been accepted. Anything still undecided is dropped —
// say so before it happens instead of silently losing the rest of a proposal.
async function writeReview() {
  const r = mind && mind.review;
  if (!r) return;
  const accepted = r.ops.filter((o) => o.state === 'accepted' && !o.broken).length;
  if (!accepted) return;
  const pending = r.ops.filter((o) => o.state === 'pending' && !o.broken).length;
  if (pending && !confirm(`还有 ${pending} 项没决定，写入之后它们就没了。继续？`)) return;
  finishReview(true, true);
  // 「写入」对绑定了文件的文档就是真的落盘；没绑定文件的仍然只进
  // localStorage，之后可以自己 Ctrl+S 选位置。失败时保存逻辑会 toast。
  if (mind && mind.src) await saveDoc(false);
}

function discardAll() {
  const r = mind && mind.review;
  if (!r) return;
  for (const op of r.ops) if (!op.broken) op.state = 'rejected';
  finishReview(false, true);
  toast('提案已丢弃，文件没动');
}

// ---------------------------------------------------------------- committing

function applyOp(op) {
  const node = op.targetReal;
  if (op.kind === 'rename') {
    if (!node || !locate(node)) return false;
    node.text = op.text || '未命名';
    op.pid = node.id;
    return true;
  }
  if (op.kind === 'note') {
    if (!node || !locate(node)) return false;
    node.note = op.block;
    op.pid = node.id;
    return true;
  }
  if (op.kind === 'del') {
    if (!node || !locate(node)) return false;
    unlinkNode(node);                 // children stay, one level up
    return true;
  }
  if (op.kind === 'drop') {
    if (!node) return false;
    const parent = locate(node);
    if (!parent) return false;
    parent.children.splice(parent.children.indexOf(node), 1);
    return true;
  }
  if (op.kind === 'move') {
    const dst = op.parentPath === '-' ? mind.root : op.parentReal;
    if (!node || !dst || dst === node) return false;
    if (dst !== mind.root && !locate(dst)) return false;   // 父级已经在更早的改动里被删掉
    const from = locate(node);
    if (!from) return false;
    // a node cannot be dragged into its own subtree
    let up = dst;
    while (up) {
      if (up === node) return false;
      up = locate(up);
    }
    if (dst === from) return true;   // 已经在这个父级下面：没有可搬的
    from.children.splice(from.children.indexOf(node), 1);
    if (dst === mind.root) {
      node.pos = node.pos || { x: settleX(node), y: settleY(node) };
    } else {
      delete node.pos;
    }
    dst.children.push(node);
    op.pid = node.id;
    return true;
  }
  if (op.kind === 'add') {
    const kids = nodesFromBlock(op.block);
    if (!kids.length) return false;
    if (op.path === '-') {
      const empty = mind.root.children.length === 0;
      let right = 0;
      for (const t of mind.root.children) {
        if (t.pos) right = Math.max(right, t.pos.x + (t.w || 260));
      }
      let y = 0;
      for (const k of kids) {
        if (!k.pos && !empty) k.pos = { x: right + 140, y };
        y += 320;
      }
      mind.root.children.push(...kids);
      op.pid = kids[0].id;
      return true;
    }
    if (!node || !locate(node)) return false;
    node.collapsed = false;
    node.children.push(...kids);
    op.pid = kids[0].id;
    return true;
  }
  return false;
}

function finishReview(commit, markDone) {
  const r = mind && mind.review;
  if (!r) return;
  const accepted = r.ops.filter((o) => o.state === 'accepted' && !o.broken);
  const file = r.name;
  const src = r.src;
  const snap = r.snap;
  // Stay on the node the eye was on: preview ids die with the preview, so
  // remember the real node behind the focused change.
  const focused = r.ops[r.index];
  const keepId = focused && focused.targetReal && locate(focused.targetReal)
    ? focused.targetReal.id
    : null;

  mind.review = null;
  let applied = 0;

  if (commit && accepted.length) {
    pushUndo(snap);
    for (const op of accepted) if (applyOp(op)) applied++;
    if (applied) mind.dirty = true;
  }
  if (markDone) {
    markSeen(r.textHash);
    decisionMemo.delete(r.textHash);   // 提案已经消费，记住的决定也该清了
  }

  resetViewDom();
  reindex();
  if (keepId && nodes.has(keepId)) {
    mind.selectedId = keepId;
    mind.selection = new Set([keepId]);
  }
  revealSelection();
  render({ animate: false });
  if (mind.selectedId) select(mind.selectedId);
  // The panel was showing the note on disk while a preview was up; now that the
  // review is over it has to read the tree again (and turn editable).
  if (mind.noteOpen) syncNotePanel(true);
  syncReviewPanel();
  if (ui.batchBar) ui.batchBar.hidden = true;
  updateStatus();
  saveAutosaveNow();
  focusStage();

  if (commit || markDone) setChip(0);

  if (commit) {
    toast(applied ? `已写入 ${applied} 项改动` : '没有可写入的改动');
    if (applied) removeProposalFile(src, file);
  } else if (markDone) {
    removeProposalFile(src, file);
  } else {
    pollProposals(400);
  }
}

// A consumed proposal must not sit in proposals/ forever: another browser (or a
// cleared localStorage) would offer it again, and accepting it twice writes the
// same nodes twice. The served route deletes it through server.py, which also
// keeps index.txt and pending.js in step; the folder route removes the sibling
// file. file:// has no write channel, so there the seen-hash is the only guard.
async function removeProposalFile(src, name) {
  if (src === 'http') {
    try {
      await fetch('proposals/' + encodeURIComponent(name), { method: 'DELETE' });
    } catch { /* plain http.server, or already gone — the seen-hash still covers it */ }
    return;
  }
  if (src !== 'folder' || !folderHandle) return;
  try {
    const doc = mind;
    if (!doc || !doc.src || doc.src.kind !== 'folder') return;
    await folderHandle.removeEntry(doc.src.name + '.proposal');
  } catch { /* nothing to clean up, or no permission — the hash already covers it */ }
}

// ---------------------------------------------------------------- discovery

function hashText(text) {
  const bytes = new TextEncoder().encode(String(text || ''));
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function seenSet() {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch { return new Set(); }
}

function markSeen(hash) {
  if (!hash) return;
  try {
    const set = seenSet();
    set.add(hash);
    const list = [...set].slice(-200);
    localStorage.setItem(SEEN_KEY, JSON.stringify(list));
  } catch { /* private mode */ }
}

// proposals/index.txt is the single thing to look at: propose.py keeps it in
// sync, so the page never has to guess a file name (and never 404s once a
// second while nothing is pending).
async function readIndex() {
  try {
    const res = await fetch('proposals/index.txt?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return { status: 'offline', rows: [] };
    const rows = [];
    for (const line of (await res.text()).split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const [file, doc] = t.split('\t');
      if (file) rows.push({ file, doc: doc || '' });
    }
    return { status: 'ok', rows };
  } catch {
    return { status: 'offline', rows: [] };
  }
}

// Double-clicking index.html gives a file:// page, and the browser forbids
// fetch() there. A <script> still loads from the same folder, so propose.py
// mirrors the pending proposals into proposals/pending.js and the page reads
// that — no server, no dragging, just a refresh.
let pendingScriptEl = null;

function loadPendingScript() {
  return new Promise((resolve) => {
    if (pendingScriptEl) { try { pendingScriptEl.remove(); } catch { /* gone */ } pendingScriptEl = null; }
    window.__MIND_PROPOSALS__ = null;

    const s = document.createElement('script');
    s.src = 'proposals/pending.js?t=' + Date.now();
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { s.remove(); } catch { /* gone */ }
      if (pendingScriptEl === s) pendingScriptEl = null;
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 2500);
    s.onload = () => finish(Array.isArray(window.__MIND_PROPOSALS__) ? window.__MIND_PROPOSALS__ : []);
    s.onerror = () => finish(null);
    pendingScriptEl = s;
    document.head.appendChild(s);
  });
}

// status: ok | empty | offline | gone | noscript
async function findProposal(doc) {
  if (!doc) return { status: 'empty' };

  if (location.protocol === 'file:') {
    const rows = await loadPendingScript();
    if (rows === null) {
      const sib = await siblingProposal(doc);
      return sib || { status: 'noscript' };
    }
    const hit = rows.find((r) => r.doc === doc.name);
    if (!hit || !String(hit.text || '').trim()) {
      const sib = await siblingProposal(doc);   // 同目录提案不进 pending.js，也能找到
      return sib || { status: 'empty' };
    }
    return { status: 'ok', text: hit.text, name: hit.file, src: 'script' };
  }

  const index = await readIndex();
  if (index.status !== 'ok') {
    const sib = await siblingProposal(doc);
    return sib || { status: index.status };
  }

  const want = doc.name || '未命名';
  const hit = index.rows.find((r) => r.doc === want) || index.rows.find((r) => r.file === want + '.proposal');
  if (!hit) {
    const sib = await siblingProposal(doc);
    return sib || { status: 'empty' };
  }

  try {
    const res = await fetch('proposals/' + encodeURIComponent(hit.file) + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) {
      // `propose.py write --sibling` 把提案放在文档旁边、不进 proposals/：
      // 清单里可能碰巧还有一条旧记录，这时先看同目录，别直接报“文件没了”。
      const sib = await siblingProposal(doc);
      return sib || { status: 'gone', file: hit.file };
    }
    const text = await res.text();
    if (!text.trim()) return { status: 'empty' };
    return { status: 'ok', text, name: hit.file, src: 'http' };
  } catch {
    return { status: 'offline' };
  }
}

// A document living in a bound workspace folder can carry its proposal next to
// it instead of in the served folder.
async function siblingProposal(doc) {
  if (!doc.src || doc.src.kind !== 'folder' || !folderHandle) return null;
  try {
    const fh = await folderHandle.getFileHandle(doc.src.name + '.proposal');
    const file = await fh.getFile();
    const text = await file.text();
    if (text.trim()) return { status: 'ok', text, name: file.name, src: 'folder' };
  } catch { /* nothing sitting there */ }
  return null;
}

// Polling backs off while nothing shows up — a proposal usually arrives minutes
// after the AI was asked, not seconds, and an idle tab should stay quiet.
let pollDelay = 3000;

function pollProposals(delay = 0) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(runPoll, delay || pollDelay);
}

async function runPoll() {
  if (!mind || mind.review) { pollProposals(); return; }
  const found = await findProposal(mind);
  if (!mind || mind.review) return;
  if (found.status !== 'ok' || seenSet().has(hashText(found.text))) {
    pendingProposal = null;
    setChip(0);
    pollDelay = Math.min(15000, pollDelay + 1500);
    pollProposals();
    return;
  }
  pendingProposal = found;
  pollDelay = 3000;
  const n = parseProposal(found.text).ops.length;
  setChip(n);
  pollProposals();
  // The whole point: refresh the page and the review is already on screen.
  // Closing it by hand keeps it closed for the rest of the session.
  if (!dismissed.has(hashText(found.text)) && !mind.editingId) openReview();
}

async function scanProposals(announce) {
  if (!mind) return;
  if (mind.review) { syncReviewPanel(); return; }

  const found = await findProposal(mind);
  if (found.status === 'noscript') {
    if (announce) toast('还没有提案：proposals/pending.js 不在（用 propose.py 写一份就有了）');
    return;
  }
  if (found.status === 'offline') {
    if (announce) toast('没连上本地服务（或 proposals/index.txt 不在）');
    return;
  }
  if (found.status === 'gone') {
    pendingProposal = null;
    setChip(0);
    if (announce) toast('清单里有这份提案，但文件已经不在了');
    return;
  }
  if (found.status !== 'ok') {
    pendingProposal = null;
    setChip(0);
    if (announce) toast('没有待审批的提案');
    return;
  }
  if (seenSet().has(hashText(found.text))) {
    pendingProposal = null;
    setChip(0);
    if (announce) toast('这份提案已经处理过了');
    return;
  }
  pendingProposal = found;
  setChip(parseProposal(found.text).ops.length);
  openReview();
}
