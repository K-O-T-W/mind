// Handoff: 把「要改什么」连同文件位置和 propose 的用法一起交给外面的 AI。
//
// 这里没有内置 Agent，也不打算有。这个工具能替 AI 做的只有一件事：把上下文
// 交代清楚。所以左下角那个小胶囊才是入口：点一下摊开，写一句，按一下复制——
// 剪贴板里是一段任何 AI 都能直接吃下的委托，卡片随即收起，像真的发出去了。
//
// 提示词里两条路径都是绝对路径，没有「找不到就写文件名」这种退路：
// 浏览器拿不到路径，就回来问本地服务（文件名 + 树指纹对上的那种）；
// 服务也答不上来，就让人自己填一次，记住。宁可不发，也不发一段假的。
//
// Ctrl+Z 那一下是自己实现的：用脚本清空 textarea 会把浏览器自己的撤销栈一起
// 抹掉，原生 undo 救不回来。

const AI_PATHS_KEY = 'mind.ai.paths';

function handoffMac() { return !!(window.MIND_PLATFORM && window.MIND_PLATFORM.isMac); }
function handoffMod() { return (window.MIND_PLATFORM && window.MIND_PLATFORM.mod) || 'Ctrl'; }
function handoffPython() { return (window.MIND_PLATFORM && window.MIND_PLATFORM.python) || 'python'; }
function handoffSep() { return (window.MIND_PLATFORM && window.MIND_PLATFORM.sep) || '\\'; }

let ai = null;                 // 绑好的 DOM
let aiOpen = false;
let aiTool = null;             // { root, propose }：工具目录与 propose.py 的绝对路径
let aiToolPending = null;
const aiPaths = new Map();     // doc.key + 文件名 -> 服务找到的绝对路径
const aiAsked = new Set();     // 问过一次就不再追问
let aiManual = {};             // 文件名（小写）-> 手填的绝对路径，跨会话记住
let aiHeld = '';               // 复制走的那段话，等着放回来
let aiBadgeTimer = 0;
let aiShownKey = '';
let aiLocating = '';           // 正在找这份文件（doc.key + 名字）
let aiFind = null;             // { key, promise }：复制时等它一下，别催人填

function bindHandoffUI() {
  const bar = document.getElementById('aiBar');
  if (!bar) return;
  ai = {
    bar,
    card: document.getElementById('aiCard'),
    pill: document.getElementById('aiPill'),
    pillLabel: document.getElementById('aiPillLabel'),
    text: document.getElementById('aiText'),
    copy: document.getElementById('aiCopy'),
    target: document.getElementById('aiTarget'),
    undo: document.getElementById('aiUndo'),
    keys: document.getElementById('aiKeys'),
  };
  if (!ai.card || !ai.pill || !ai.text || !ai.copy) { ai = null; return; }

  try { aiManual = JSON.parse(localStorage.getItem(AI_PATHS_KEY) || '{}') || {}; } catch { aiManual = {}; }

  ai.pill.addEventListener('click', () => {
    if (aiOpen) setAiOpen(false, 'pill');
    else setAiOpen(true);
  });
  ai.text.addEventListener('input', onAiInput);
  ai.text.addEventListener('keydown', onAiKey);
  ai.copy.addEventListener('click', () => { copyHandoff(); });
  ai.undo.addEventListener('click', () => { restoreHeld(); });
  ai.target.addEventListener('click', () => { editAiPath(); });

  askToolInfo();
  onAiInput();
  syncHandoff();
}

// ---------------------------------------------------------------- 开合

function setAiOpen(open, to) {
  if (!ai) return;
  if (open && ai.bar.hidden) return;
  aiOpen = !!open;
  ai.card.hidden = !aiOpen;
  ai.bar.classList.toggle('open', aiOpen);
  ai.pill.setAttribute('aria-expanded', aiOpen ? 'true' : 'false');
  if (aiOpen) {
    ai.text.focus();
    const end = ai.text.value.length;
    ai.text.setSelectionRange(end, end);
  } else if (to === 'stage') {
    focusStage();
  } else if (to === 'pill') {
    ai.pill.focus();
  }
}

function focusHandoff() {
  if (!ai || ai.bar.hidden) return;
  setAiOpen(true);
}

// ---------------------------------------------------------------- 输入框

function onAiInput() {
  if (!ai) return;
  ai.copy.disabled = !ai.text.value.trim();
  growAiText();
  updateAiMeta();
}

// 一行起步，最多六行左右，再多就自己滚。
function growAiText() {
  const t = ai.text;
  t.style.height = '0px';
  const h = Math.min(Math.max(t.scrollHeight, 24), 132);
  t.style.height = h + 'px';
  t.style.overflowY = t.scrollHeight > 132 ? 'auto' : 'hidden';
}

// 右下角那个位置：平时是快捷键提示，手上还留着刚才那段话时变成「放回」。
function updateAiMeta() {
  if (!ai) return;
  const held = !!(aiHeld && ai.text.value === '');
  ai.undo.hidden = !held;
  ai.keys.hidden = held;
}

function onAiKey(e) {
  if (e.isComposing || e.keyCode === 229) return;
  const mod = e.ctrlKey || e.metaKey;

  if (mod && e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    copyHandoff();
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    setAiOpen(false, 'stage');
    return;
  }
  // 只有「刚复制完、框是空的」这一刻才接管 Ctrl+Z；平时打字交还给浏览器。
  if (mod && !e.shiftKey && !e.altKey && (e.key === 'z' || e.key === 'Z')
      && ai.text.value === '' && aiHeld) {
    e.preventDefault();
    e.stopPropagation();
    restoreHeld();
  }
}

function restoreHeld() {
  if (!ai || !aiHeld) return;
  const text = aiHeld;
  aiHeld = '';
  ai.text.value = text;
  onAiInput();
  const end = text.length;
  ai.text.setSelectionRange(end, end);
  ai.text.focus();
  toast('放回来了 · 再按 ' + handoffMod() + '+Enter 重新复制');
}

// ---------------------------------------------------------------- 交给 AI

async function copyHandoff() {
  if (!ai || !mind) return;
  const ask = ai.text.value.replace(/\s+$/, '');
  if (!ask.trim()) { ai.text.focus(); return; }

  // AI 读的是磁盘上的那个文件。没落盘的先别发；有改动的先写下去——
  // 不然它对着旧版本改，我刷新之后看到的就是两份不同的东西。
  const doc = mind;
  if (!doc.src && !doc.loose) {
    toast('这份文档还没存成文件：先 ' + handoffMod() + '+S 存一次，AI 才有得改');
    ai.text.focus();
    return;
  }
  if (doc.dirty) {
    // 只走「文件句柄已经在手上」这条路：这里不该弹出保存框或者重新授权框。
    const handle = await resolveHandle(doc, false).catch(() => null);
    if (handle) { try { await saveDoc(false); } catch { /* 结果在下面看 */ } }
    if (mind !== doc) return;
    if (doc.dirty) {
      toast('没存上，AI 会看到旧版本：先 ' + handoffMod() + '+S 存一次');
      ai.text.focus();
      return;
    }
  }

  const info = await askToolInfo();
  if (mind !== doc) return;
  if (!info || !info.propose) {
    toast('不知道 propose.py 在哪：这个页面得从工具目录起服务打开');
    ai.text.focus();
    return;
  }
  if (!aiKnownPath(doc) && aiFind && aiFind.key === aiPathKey(doc)) {
    // 还在找就等它一下——比让人对着「找不到」手填路径好。
    try { await aiFind.promise; } catch { /* 找不到再说 */ }
    if (mind !== doc) return;
  }
  if (!aiKnownPath(doc)) {
    toast('先填一下这份文件的完整路径');
    editAiPath();
    return;
  }

  const ok = await writeClipboard(buildBrief(ask));
  if (!ok) {
    toast('这个浏览器不让写剪贴板：先手动选一遍吧');
    ai.text.focus();
    ai.text.select();
    return;
  }

  aiHeld = ai.text.value;
  ai.text.value = '';
  onAiInput();
  setAiOpen(false, 'stage');
  paintCopied(true);
  toast('已复制 · 粘给 AI 就行；要放回就点左下角');
}

// 复制完卡片收起，回执落在胶囊上：对勾 +「已复制」，一秒多之后自己复原。
function paintCopied(on) {
  if (!ai) return;
  clearTimeout(aiBadgeTimer);
  ai.pill.classList.toggle('copied', on);
  ai.pillLabel.textContent = on ? '已复制' : '让 AI 改';
  if (on) aiBadgeTimer = setTimeout(() => paintCopied(false), 1300);
}

async function writeClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 权限被拒：退回到老办法 */ }

  const box = document.createElement('textarea');
  box.value = text;
  box.setAttribute('readonly', '');
  box.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  document.body.appendChild(box);
  box.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  box.remove();
  return ok;
}

// 这一整段就是「内置 Agent」的全部。它只交代上下文，不装懂。
function buildBrief(ask) {
  const doc = mind;
  const path = aiKnownPath(doc);
  const propose = aiTool.propose;
  const run = '"' + propose + '"';
  const py = handoffPython();

  const lines = [
    '我在用「产品定义」这个画布工具维护一份 Markdown 大纲。不要直接编辑这个 .md：',
    '用下面的 propose.py 把改动写成一份待审批的提案，我在画布上逐条看过、点过接受之后，它才会写进文件。',
    '',
    '目标文件',
    '  ' + path,
    '',
    '提案程序',
    '  ' + propose,
    '',
    '这份大纲的样子',
    '  一行一个节点，两个空格一级；节点下面的 `> ` 行是它的备注，可以写很多行，也能放代码块。',
    '  顶层节点行尾的 <!--@x,y--> 是画布坐标，蓝图注释框是整行的 <!--@comment:...-->，都不是内容，别动。',
    '',
    '怎么改',
    '  1) 先读现在的结构，它会给出每个节点的路径编号',
    '       ' + py + ' ' + run + ' tree "' + path + '"',
    '     `1` 是第一个顶节点，`1.2` 是它的第二个子节点；编号只在「此刻」有效，所以每次都从刚跑出来的 tree 读。',
    '  2) 把改动写成操作清单（UTF-8 文本，一行一条；正文取行尾原样，多行用 << >> 包起来）',
    '       rename 2.3 新的名字',
    '       note 2.3 <<',
    '       备注正文，随便多少行',
    '       >>',
    '       add 2.3 <<',
    '       新的子节点',
    '         缩进两格就是它的下一级',
    '       >>',
    '       add - <<',
    '       全新的一簇',
    '       >>',
    '       del 1.4          # 只删这一层，子节点升一级留在原地',
    '       drop 1.4         # 连整棵子树一起删',
    '       move 2.3 1.1     # 搬到另一个节点下面；`-` 表示搬到顶层',
    '  3) 校验并写提案',
    '       ' + py + ' ' + run + ' write "' + path + '" ops.txt',
    '     校验没过会指出第几行、哪个路径不存在；改完再跑。成功后 proposals/ 里会多一份 .proposal。',
    '  4) 几处改动其实是同一件事时，用修改块包成一块，我审批时看的就是这个「为什么」',
    '       begin 去冗余 · 坐标系的三处重复',
    '       why 这三条说的是同一件事，留最完整的 1.3.2，另外两条删掉。',
    '       drop 1.3.4',
    '       drop 2.1.1',
    '       rename 3.2 坐标系（唯一声明）',
    '       end',
    '',
    '写好后跟我说一声。画布上会自己亮起「待审批」，我逐条点接受或拒绝——没点头之前，磁盘上的 .md 一个字都不会变。',
    '',
    '我要的改动：',
    ask,
  ];
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- 位置

function aiFileName(doc) {
  if (doc && doc.src && doc.src.name) return doc.src.name;
  if (doc && doc.loose) return doc.loose;          // 从磁盘选进来的：连扩展名一起留着
  return ((doc && doc.name) || '未命名') + '.md';
}

function aiPathKey(doc) {
  return doc.key + '\u0000' + aiFileName(doc);
}

function aiManualPath(doc) {
  return aiManual[aiFileName(doc).toLowerCase()] || '';
}

function aiKnownPath(doc) {
  if (!doc) return '';
  return aiManualPath(doc) || aiPaths.get(aiPathKey(doc)) || '';
}

// 卡片只有 412 宽，长路径要折。折中间：开头和文件名两头都留着，
// 一眼能看出「这是个绝对路径，改的是这个文件」。
function aiShortPath(p) {
  const limit = 62;
  if (p.length <= limit) return p;
  const head = /^[A-Za-z]:\\/.test(p) ? p.slice(0, 3) : (p.startsWith('/') ? '/' : '');
  let tail = p.slice(p.length - (limit - head.length - 2));
  const cut = Math.max(tail.indexOf('\\'), tail.indexOf('/'));
  if (cut > 0) tail = tail.slice(cut);
  return head + '…' + tail;
}

// 工具自己也是一个文件：页面从哪儿打开，propose.py 就在它旁边。
// file:// 下问不了服务，但 location 本身就带着绝对路径。
function toolFromLocation() {
  if (location.protocol !== 'file:') return null;
  let p = location.pathname;
  try { p = decodeURIComponent(p); } catch { /* 保持原样 */ }
  const cut = p.lastIndexOf('/');
  if (cut <= 0) return null;
  p = p.slice(0, cut);
  if (handoffMac()) return { root: p, propose: p + '/propose.py' };
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  p = p.replace(/\//g, '\\');
  return { root: p, propose: p + '\\propose.py' };
}

function askToolInfo() {
  if (aiToolPending) return aiToolPending;
  aiToolPending = (async () => {
    let data = null;
    try {
      const res = await fetch('api/where', { cache: 'no-store' });
      if (res.ok) data = await res.json();
    } catch { data = null; }
    if (!data || typeof data.root !== 'string' || !data.root) data = toolFromLocation();
    aiTool = (data && data.root)
      ? { root: data.root, propose: data.propose || data.root + handoffSep() + 'propose.py' }
      : null;
    return aiTool;
  })();
  return aiToolPending;
}

// 名字先筛，树指纹再确认：指纹对上的那个才是同一个文件，不是同名文件。
function ensureDocPath(doc) {
  if (!doc || (!doc.src && !doc.loose)) return null;
  if (aiManualPath(doc)) return null;
  const key = aiPathKey(doc);
  if (aiPaths.has(key) || aiAsked.has(key)) return null;
  aiAsked.add(key);
  aiLocating = key;
  aiShownKey = '';

  const task = (async () => {
    try {
      const info = await askToolInfo();
      if (!info || !info.root) return;
      const name = aiFileName(doc);
      const hash = (typeof treeHash === 'function' && doc.root) ? treeHash(doc.root) : '';
      const res = await fetch('api/find?name=' + encodeURIComponent(name)
        + '&hash=' + encodeURIComponent(hash), { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (data && typeof data.path === 'string' && data.path) aiPaths.set(key, data.path);
    } catch { /* 服务没开：等手填 */ } finally {
      if (aiLocating === key) aiLocating = '';
      aiShownKey = '';
      syncHandoff();
    }
  })();

  aiFind = { key, promise: task };
  return task;
}

async function aiPathExists(path) {
  const info = await askToolInfo();
  if (!info) return null;                  // 问不了就别拦
  try {
    const res = await fetch('api/check?path=' + encodeURIComponent(path), { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return !!(data && data.file);
  } catch {
    return null;
  }
}

function saveManualPaths() {
  try { localStorage.setItem(AI_PATHS_KEY, JSON.stringify(aiManual)); } catch { /* 存不下就算了 */ }
}

// 点路径那一行就地改：服务找错了、或者压根没找到，都有地方补。
async function editAiPath() {
  if (!ai || !mind) return;
  if (!aiOpen) setAiOpen(true);
  if (ai.target.querySelector('.ai-path-input')) return;

  const doc = mind;
  const current = aiKnownPath(doc);
  const input = document.createElement('input');
  input.className = 'ai-path-input';
  input.value = current;
  input.placeholder = (handoffMac() ? '/Users/你的名字/Documents/' : 'C:\\完整\\路径\\') + aiFileName(doc);
  input.spellcheck = false;
  input.setAttribute('aria-label', '这份文件的完整路径');

  ai.target.textContent = '';
  ai.target.classList.remove('missing');
  ai.target.appendChild(input);
  input.focus();
  input.select();

  let closed = false;
  // 收尾：把编辑框摘掉再交给 syncHandoff，否则它以为「还在改」而不重画。
  const end = () => {
    input.remove();
    aiShownKey = '';
    syncHandoff();
    if (aiOpen) ai.text.focus();     // 别把焦点丢给画布：Ctrl+Enter 会变成「新建节点」
  };
  const finish = async (save, how) => {
    if (closed) return;
    closed = true;
    const value = input.value.trim().replace(/^"(.*)"$/, '$1');
    if (!save || !value || value === current) { end(); return; }

    // 提示词里只放绝对路径：相对的、光一个文件名的，一律不收。
    const absolute = /^[A-Za-z]:[\\\/]/.test(value) || /^\\\\/.test(value) || value.startsWith('/');
    if (!absolute) {
      if (how === 'enter') {
        closed = false;
        input.focus();
        toast('要完整的绝对路径，比如 ' + (handoffMac() ? '/Users/…/x.md' : 'C:\\…\\x.md'));
      } else {
        end();
        toast('不是绝对路径，位置没改');
      }
      return;
    }

    const exists = await aiPathExists(value);
    if (exists === false) {
      if (how === 'enter') {                 // 手敲的就让他接着改；点走开的就算了
        closed = false;
        input.focus();
        toast('这个路径上没有文件：再对一下');
      } else {
        end();
        toast('路径没填对，位置没改');
      }
      return;
    }

    aiManual[aiFileName(doc).toLowerCase()] = value;
    saveManualPaths();
    end();
    toast('记下了 · 以后这份文件就用这个位置');
  };

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); finish(true, 'enter'); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true, 'blur'));
}

// ---------------------------------------------------------------- 状态

function syncHandoff() {
  if (!ai) return;

  // 审批的时候不该再往 AI 手里塞改动，这块也让位给审批面板。
  if (!mind || mind.review) {
    if (aiOpen) setAiOpen(false);
    ai.bar.hidden = true;
    return;
  }
  ai.bar.hidden = false;

  const doc = mind;
  ensureDocPath(doc);
  const path = aiKnownPath(doc);
  const name = aiFileName(doc);
  const saved = !!(doc.src || doc.loose);
  const locating = aiLocating === aiPathKey(doc);
  const key = [path, name, saved ? '1' : '0', locating ? '1' : '0'].join('\u0000');

  // 正在手填路径的时候别把输入框刷掉
  if (ai.target.querySelector('.ai-path-input')) return;

  if (key !== aiShownKey) {
    aiShownKey = key;
    if (!saved) {
      ai.target.textContent = '还没存成文件';
      ai.target.classList.add('missing');
      ai.target.title = '这份文档还没存过：先 ' + handoffMod() + '+S，AI 才有得改';
    } else if (!path) {
      if (locating) {
        ai.target.textContent = '正在找 ' + name + '…';
        ai.target.classList.remove('missing');
        ai.target.title = '在磁盘上按名字和树指纹找这份文件';
      } else {
        ai.target.textContent = '找不到 ' + name + ' 的位置 · 点这里填';
        ai.target.classList.add('missing');
        ai.target.title = '没在磁盘上认出这份文件：点一下，把完整路径填进来';
      }
    } else {
      ai.target.textContent = aiShortPath(path);
      ai.target.classList.remove('missing');
      ai.target.title = '这份文件的完整路径（点一下可以改）\n' + path;
    }
  }
}
