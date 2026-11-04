// Wiring: pointer gestures, search, files, menus, toolbar.

let lastTap = { id: null, at: 0, x: 0, y: 0 };

function bindUI() {
  document.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const act = btn.dataset.act;
      runAction(act, btn);
      if (act !== 'export') btn.blur();
    });
  });

  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerup', onPointerUp);
  stage.addEventListener('pointercancel', onPointerUp);
  stage.addEventListener('click', onClick);
  stage.addEventListener('dblclick', onDblClick);
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  stage.addEventListener('wheel', onWheel, { passive: false });

  // 按住 Alt 时给连线一点颜色，提示这里可以剪断（虚幻引擎同款）。
  const altHint = (on) => {
    stage.classList.toggle('alt-cut', on);
    if (!on && typeof linkHoverChild !== 'undefined' && linkHoverChild !== null) {
      linkHoverChild = null;
      drawLinks();
    }
  };
  window.addEventListener('keydown', (e) => { if (e.key === 'Alt' && !e.repeat) altHint(true); });
  window.addEventListener('keyup', (e) => { if (e.key === 'Alt') altHint(false); });
  window.addEventListener('blur', () => altHint(false));

  // A node hugging the left edge would park its verdict buttons under the
  // review panel; put them on the other side instead.
  stage.addEventListener('pointerover', (e) => {
    const wrap = e.target.closest('.node-wrap');
    if (!wrap || !wrap.classList.contains('has-acts')) return;
    const room = (typeof panelInsets === 'function') ? panelInsets().left : 0;
    wrap.classList.toggle('acts-flip', wrap.getBoundingClientRect().left - 42 < room + 8);
  });

  ui.tabNew.addEventListener('click', () => { newDoc(); ui.tabNew.blur(); });
  ui.tabs.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    ui.tabs.scrollLeft += e.deltaY;
  }, { passive: false });

  ui.folderChip.addEventListener('click', () => { onFolderChip(); ui.folderChip.blur(); });
  ui.folderMenu.querySelectorAll('[data-folder]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const act = btn.dataset.folder;
      closeFolderMenu();
      if (act === 'grant') await reGrantFolder();
      else if (act === 'write') await materializeScratch();
      else if (act === 'switch') await bindFolder();
      else if (act === 'unbind') await unbindFolder();
      else if (act === 'review') await scanProposals(true);
    });
  });

  ui.zoomIn.addEventListener('click', () => { zoomBy(1.2); ui.zoomIn.blur(); });
  ui.zoomOut.addEventListener('click', () => { zoomBy(1 / 1.2); ui.zoomOut.blur(); });
  ui.zoomLabel.addEventListener('click', () => { zoomBy(1 / mind.view.s); ui.zoomLabel.blur(); });

  bindNoteUI();
  if (typeof bindHandoffUI === 'function') bindHandoffUI();
  if (typeof bindReviewUI === 'function') bindReviewUI();

  ui.searchInput.addEventListener('input', () => runSearch(ui.searchInput.value));
  ui.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
    e.stopPropagation();
  });
  ui.searchPrev.addEventListener('click', () => { stepHit(-1); ui.searchInput.focus(); });
  ui.searchNext.addEventListener('click', () => { stepHit(1); ui.searchInput.focus(); });
  ui.searchClose.addEventListener('click', closeSearch);

  ui.helpOverlay.addEventListener('pointerdown', (e) => {
    if (e.target === ui.helpOverlay) closeHelp();
  });
  document.getElementById('helpClose').addEventListener('click', closeHelp);

  ui.exportMenu.querySelectorAll('[data-export]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.export;
      closeExportMenu();
      exportAs(kind);
    });
  });

  document.addEventListener('pointerdown', (e) => {
    if (!ui.exportMenu.hidden) {
      if (!ui.exportMenu.contains(e.target) && !(mind.menuAnchor && mind.menuAnchor.contains(e.target))) closeExportMenu();
    }
    if (!ui.folderMenu.hidden) {
      if (!ui.folderMenu.contains(e.target) && !ui.folderChip.contains(e.target)) closeFolderMenu();
    }
    // 点到色板外面就收起所有注释框的色板。
    document.querySelectorAll('.comment-swatches').forEach((row) => {
      if (row.hidden) return;
      if (!row.contains(e.target) && !row.closest('.comment').contains(e.target)) row.hidden = true;
    });
  }, true);

  ui.filePick.addEventListener('change', async () => {
    const files = Array.from(ui.filePick.files || []);
    ui.filePick.value = '';
    for (const file of files) await openLooseFile(file);
  });

  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
  });
  window.addEventListener('drop', async (e) => {
    const dt = e.dataTransfer;
    if (!dt || !dt.files || !dt.files.length) return;
    e.preventDefault();
    const files = Array.from(dt.files);

    // A proposal is not a document: it opens as a review of the one on screen.
    const proposal = files.find((f) => /\.proposal$/i.test(f.name));
    if (proposal && typeof openProposalText === 'function') {
      openProposalText(await proposal.text(), proposal.name);
      return;
    }

    // Ask for real file handles before the first await — the items are only
    // readable during the event itself. Firefox has no handles; those files
    // still open, they just cannot be written back in place.
    const handles = await Promise.all(Array.from(dt.items || []).map((it) =>
      (it.kind === 'file' && typeof it.getAsFileSystemHandle === 'function')
        ? it.getAsFileSystemHandle().catch(() => null)
        : Promise.resolve(null)));

    for (let i = 0; i < files.length; i++) {
      if (handles[i]) await openHandle(handles[i]);
      else await openLooseFile(files[i]);
    }
  });

  let lastW = stage.clientWidth;
  let lastH = stage.clientHeight;
  window.addEventListener('resize', () => {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    mind.view.x += (w - lastW) / 2;
    mind.view.y += (h - lastH) / 2;
    lastW = w;
    lastH = h;
    applyView();
  });

  window.addEventListener('pagehide', saveAutosaveNow);
  window.addEventListener('focus', () => { if (typeof pollProposals === 'function') pollProposals(); });
  document.addEventListener('keydown', onKeyDown);
}

function runAction(act, btn) {
  switch (act) {
    case 'new': newDoc(); break;
    case 'open': openDoc(); break;
    case 'save': saveDoc(false); break;
    case 'undo': undo(); break;
    case 'redo': redo(); break;
    case 'search': openSearch(); break;
    case 'fit': fit(); break;
    case 'export': toggleExportMenu(btn); break;
    case 'help': openHelp(); break;
    case 'review': if (typeof openReview === 'function') openReview(); break;
    case 'scan': if (typeof scanProposals === 'function') scanProposals(true); break;
    default: break;
  }
}

// ---------------------------------------------------------------- gestures

function grabPointer(id) {
  try { stage.setPointerCapture(id); } catch { /* synthetic or already gone */ }
}

// 色板：色点按下弹出，选一个换注释框的颜色。
function toggleCommentSwatches(cEl) {
  const row = cEl.querySelector('.comment-swatches');
  if (!row) return;
  if (!row.childElementCount) {
    for (const color of PALETTE) {
      const b = document.createElement('button');
      b.className = 'comment-swatch';
      b.type = 'button';
      b.tabIndex = -1;
      b.dataset.c = color;
      b.title = color;
      b.style.background = color;
      row.appendChild(b);
    }
  }
  row.hidden = !row.hidden;
}

function onPointerDown(e) {
  if (e.target.closest('#searchPanel')) return;
  if (e.target.closest('#reviewPanel')) return;
  // 记住鼠标在画布里的位置：空地按 C 时，注释框就在这儿长出来。
  mind.lastMouseClient = { x: e.clientX, y: e.clientY };

  // Alt+点连线 = 剪断（虚幻引擎同款）。几何命中，不依赖事件落在连线上；
  // 没剪到就照常往下走（选中节点 / 框选）。审批预览里不动真树。
  if (e.altKey && e.button === 0 && !mind.review) {
    const w = toWorld(e.clientX, e.clientY);
    const childId = hitLinkAt(w.x, w.y);
    if (childId) {
      e.preventDefault();
      e.stopPropagation();
      cutLink(childId);
      linkHoverChild = null;
      return;
    }
  }

  // 蓝图注释框：点标题/框体拖整框带节点，右下角拉伸，色点开色板。
  // 删除走“选中 + Delete”，不在框上放 ×——和节点的选中手感保持一致。
  const cEl = e.target.closest('.comment');
  if (cEl && e.button === 0 && !mind.review) {
    const c = docComments().find((x) => x.id === cEl.dataset.id);
    if (!c) return;
    blankClickOk = false;
    if (e.target.closest('.comment-edit')) return;   // 正在改标题，让输入框接
    if (mind.editingId) commitEdit();

    // 点框上任何地方（标题、框体、色点、色板）都先选中它——和节点一样，
    // 选中是一件事，接下来的动作只是选中之后做的事。
    mind.selectedCommentId = c.id;
    mind.selection = new Set();
    mind.selectedId = null;
    paintSelection();
    renderComments();
    if (typeof syncNotePanel === 'function') syncNotePanel();

    if (e.target.closest('.comment-dot')) {
      e.preventDefault();
      toggleCommentSwatches(cEl);
      focusStage();
      return;
    }
    const sw = e.target.closest('.comment-swatch');
    if (sw) {
      e.preventDefault();
      const snap = snapshot();
      c.color = sw.dataset.c || c.color;
      pushUndo(snap);
      markDirty();
      const row = cEl.querySelector('.comment-swatches');
      if (row) row.hidden = true;
      renderComments();
      saveAutosaveNow();
      focusStage();
      return;
    }
    const snap = snapshot();
    if (e.target.closest('.comment-grip')) {
      mind.commentDrag = { id: c.id, mode: 'resize', x0: e.clientX, y0: e.clientY, w0: c.w, h0: c.h, snap, moved: false };
    } else {
      const tops = [...commentCaptures(c)].map((id) => {
        const n = nodes.get(id);
        return { id, x: n && n.pos ? n.pos.x : 0, y: n && n.pos ? n.pos.y : 0 };
      });
      mind.commentDrag = { id: c.id, mode: 'move', x0: e.clientX, y0: e.clientY, x: c.x, y: c.y, tops, snap, moved: false };
    }
    // 指针先不抓：一抓，click/dblclick 就被重定向到 stage，双击标题改名会失灵。
    // 真拖起来（过了阈值）再抓。
    focusStage();
    return;
  }

  // Verdict buttons ride on the node itself.
  const act = e.target.closest('.node-act');
  if (act) {
    blankClickOk = false;
    const wrap = act.closest('.node-wrap');
    const node = wrap ? nodes.get(wrap.dataset.id) : null;
    if (node && typeof decideNode === 'function') {
      decideNode(node, act.classList.contains('ok') ? 'accepted' : 'rejected');
    }
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  if (e.target.closest('.badge')) {
    blankClickOk = false;
    if (mind.editingId) commitEdit();
    return;
  }
  if (e.target.closest('.note-mark')) {
    blankClickOk = false;
    const wrap = e.target.closest('.node-wrap');
    const node = wrap ? nodes.get(wrap.dataset.id) : null;
    if (node) {
      select(node.id, { ensure: false });
      openNote(node.id);
    }
    e.preventDefault();
    return;
  }
  if (e.target.closest('textarea')) return;

  // Middle or right button pans; the left button is for selecting and moving.
  if (e.button === 1 || e.button === 2) {
    mind.panning = { x0: e.clientX, y0: e.clientY, vx: mind.view.x, vy: mind.view.y, moved: false };
    blankClickOk = false;
    grabPointer(e.pointerId);
    stage.classList.add('panning');
    e.preventDefault();
    return;
  }
  if (e.button !== 0) return;

  const wrap = e.target.closest('.node-wrap');
  if (wrap) {
    const node = nodes.get(wrap.dataset.id);
    if (!node) return;
    blankClickOk = false;
    if (mind.editingId && mind.editingId !== node.id) commitEdit();

    if (e.shiftKey) {
      select(node.id, { add: true, ensure: false });
      focusStage();
      return;
    }

    const now = performance.now();
    if (lastTap.id === node.id && now - lastTap.at < 380 &&
        Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 8) {
      lastTap.id = null;
      select(node.id, { ensure: false });
      startEdit(node.id);
      return;
    }
    lastTap = { id: node.id, at: now, x: e.clientX, y: e.clientY };

    select(node.id, { ensure: false });
    focusStage();
    if (mind.review) return;                 // read-only while a proposal is open

    const free = isTop(node);
    mind.dragging = {
      id: node.id, x0: e.clientX, y0: e.clientY,
      free, base: free && node.pos ? { x: node.pos.x, y: node.pos.y } : null,
      sx: 0, sy: 0, snap: null, started: false, dropId: null,
    };
    grabPointer(e.pointerId);
    return;
  }

  // Empty canvas: drag a box to pick several nodes — also while a proposal is
  // open, because deciding a batch is the whole point of picking them.
  mind.marquee = {
    x0: e.clientX, y0: e.clientY, moved: false,
    add: e.shiftKey,
    base: new Set(mind.selection),
    hits: [],
  };
  grabPointer(e.pointerId);
}

function onPointerMove(e) {
  // 记住鼠标在屏幕上的位置（不是世界坐标）：平移/缩放后按 C 仍然长在指针下面。
  mind.lastMouseClient = { x: e.clientX, y: e.clientY };

  // 注释框：拖动 = 框和框住的簇一起走；拉伸 = 只改框的大小。
  if (mind.commentDrag) {
    const d = mind.commentDrag;
    const c = docComments().find((x) => x.id === d.id);
    if (!c) { mind.commentDrag = null; return; }
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) <= 3) return;
    if (!d.moved) { d.moved = true; settle(); grabPointer(e.pointerId); }
    const s = mind.view.s || 1;
    const dx = (e.clientX - d.x0) / s;
    const dy = (e.clientY - d.y0) / s;
    if (d.mode === 'resize') {
      c.w = Math.max(110, Math.round(d.w0 + dx));
      c.h = Math.max(56, Math.round(d.h0 + dy));
      const el = commentEls.get(c.id);
      if (el) {
        el.style.width = c.w + 'px';
        el.style.height = c.h + 'px';
      }
      return;
    }
    c.x = Math.round(d.x + dx);
    c.y = Math.round(d.y + dy);
    // 框体必须跟手：只改数据不动 transform，框会原地不动、节点先飞走，
    // 落手后下一次渲染框再瞬移过去——这就是"拖动跳来跳去"的根源。
    const el = commentEls.get(c.id);
    if (el) el.style.transform = `translate3d(${c.x}px, ${c.y}px, 0)`;
    for (const t of d.tops) {
      const n = nodes.get(t.id);
      if (n && n.pos) { n.pos.x = t.x + dx; n.pos.y = t.y + dy; }
    }
    computeLayout();
    stick();
    return;
  }

  // Alt 悬停：把正下方那根线染红，剪哪儿看得见。手势进行中不掺和。
  if (e.altKey && !mind.panning && !mind.dragging && !mind.marquee && !mind.review) {
    const w = toWorld(e.clientX, e.clientY);
    const c = hitLinkAt(w.x, w.y);
    if (c !== linkHoverChild) { linkHoverChild = c; drawLinks(); }
  } else if (linkHoverChild !== null) {
    linkHoverChild = null;
    drawLinks();
  }

  if (mind.panning) {
    cancelViewAnim();                        // 手接管了，别再让动画拽镜头
    const p = mind.panning;
    const dx = e.clientX - p.x0;
    const dy = e.clientY - p.y0;
    if (Math.abs(dx) + Math.abs(dy) > 3) p.moved = true;
    mind.view.x = p.vx + dx;
    mind.view.y = p.vy + dy;
    applyView();
    return;
  }

  if (mind.marquee) {
    updateMarquee(e);
    return;
  }

  if (!mind.dragging) return;

  const d = mind.dragging;
  const node = nodes.get(d.id);
  if (!node) return;
  const rec = wraps.get(d.id);

  const scale = mind.view.s || 1;
  const dx = (e.clientX - d.x0) / scale;
  const dy = (e.clientY - d.y0) / scale;

  if (!d.started) {
    if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) <= 5) return;
    d.started = true;
    settle();                                  // kill any running layout animation
    d.snap = snapshot();
    d.sx = Number.isFinite(node.cx) ? node.cx : node.tx;
    d.sy = Number.isFinite(node.cy) ? node.cy : node.ty;
    lastTap.id = null;
    if (rec) rec.wrap.classList.add('dragging');
    document.body.classList.add('dragging-node');
  }

  if (d.free && node.pos) {
    // The cluster rides along: one position changes, the layout puts every
    // descendant under it on the same frame.
    node.pos.x = d.base.x + dx;
    node.pos.y = d.base.y + dy;
    computeLayout();
    stick();
  } else if (rec) {
    // A child stays attached — it only follows the pointer to show what it
    // would be dropped onto.
    rec.wrap.style.transform = `translate3d(${d.sx + dx}px, ${d.sy + dy}px, 0)`;
  }

  // The box rides with the cursor; pointer-events is off while dragging so
  // elementFromPoint sees what is underneath instead of the box itself.
  d.dx = dx;
  d.dy = dy;

  const under = document.elementFromPoint(e.clientX, e.clientY);
  const over = under ? under.closest('.node-wrap') : null;
  let target = over ? nodes.get(over.dataset.id) : null;
  if (target && (target === node || isDescendant(target, node))) target = null;

  const dropId = target ? target.id : null;
  if (dropId !== d.dropId) {
    if (d.dropId) {
      const old = wraps.get(d.dropId);
      if (old) old.wrap.classList.remove('drop');
    }
    d.dropId = dropId;
    if (target) {
      const trec = wraps.get(target.id);
      if (trec) trec.wrap.classList.add('drop');
    }
  }

  ui.dragHint.hidden = !target;
  if (target) {
    ui.dragHint.textContent = `成为「${target.text || '未命名'}」的子节点`;
    ui.dragHint.style.left = (e.clientX + 16) + 'px';
    ui.dragHint.style.top = (e.clientY + 18) + 'px';
  }
}

function onPointerUp(e) {
  if (mind.dragging) {
    const d = mind.dragging;
    const node = nodes.get(d.id);
    if (d.dropId) {
      const rec = wraps.get(d.dropId);
      if (rec) rec.wrap.classList.remove('drop');
    }
    if (node) {
      const rec = wraps.get(node.id);
      if (rec) rec.wrap.classList.remove('dragging');
    }
    if (d.started) {
      skipClickUntil = performance.now() + 400;
      const target = d.dropId ? nodes.get(d.dropId) : null;
      if (node && target) {
        reparentNode(node, target);
      } else if (d.free && node) {
        pushUndo(d.snap);
        markDirty();
        updateStatus();
        saveAutosaveNow();
      } else if (node) {
        // Drop the box where the cursor let go, so the layout animation starts
        // from under the pointer instead of snapping back first.
        const scale = mind.view.s || 1;
        node.cx = d.sx + (e.clientX - d.x0) / scale;
        node.cy = d.sy + (e.clientY - d.y0) / scale;
        animateLayout(true, 180);
      }
    }
    document.body.classList.remove('dragging-node');
    ui.dragHint.hidden = true;
    mind.dragging = null;
  }

  if (mind.commentDrag) {
    const d = mind.commentDrag;
    if (d.moved) {
      skipClickUntil = performance.now() + 300;
      blankClickOk = false;
      pushUndo(d.snap);
      markDirty();
      updateStatus();
      saveAutosaveNow();
    }
    mind.commentDrag = null;
  }

  if (mind.marquee) {
    const m = mind.marquee;
    marquee.hidden = true;
    stage.classList.remove('marquee-on');
    if (m.moved) {
      skipClickUntil = performance.now() + 200;
      blankClickOk = false;
    } else {
      blankClickOk = true;
    }
    mind.marquee = null;
  }

  if (mind.panning) {
    blankClickOk = !mind.panning.moved;
    stage.classList.remove('panning');
    mind.panning = null;
  }

  try {
    if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId);
  } catch { /* ignore */ }
}

function updateMarquee(e) {
  const m = mind.marquee;
  const r = stage.getBoundingClientRect();
  const x0 = m.x0 - r.left;
  const y0 = m.y0 - r.top;
  const x1 = e.clientX - r.left;
  const y1 = e.clientY - r.top;

  if (!m.moved && Math.abs(x1 - x0) + Math.abs(y1 - y0) <= 4) return;
  m.moved = true;
  stage.classList.add('marquee-on');

  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  const w = Math.abs(x1 - x0);
  const h = Math.abs(y1 - y0);

  marquee.hidden = false;
  marquee.style.transform = `translate(${left}px, ${top}px)`;
  marquee.style.width = w + 'px';
  marquee.style.height = h + 'px';

  const s = mind.view.s || 1;
  const wx0 = (left - mind.view.x) / s;
  const wy0 = (top - mind.view.y) / s;
  const wx1 = wx0 + w / s;
  const wy1 = wy0 + h / s;

  const hits = [];
  for (const node of order) {
    const nx = Number.isFinite(node.tx) ? node.tx : node.cx;
    const ny = Number.isFinite(node.ty) ? node.ty : node.cy;
    if (nx < wx1 && nx + (node.w || 0) > wx0 && ny < wy1 && ny + (node.h || 0) > wy0) hits.push(node);
  }

  // 注释框也是可选中的东西：框住整个框、或者框过它的标题栏，就算选中它。
  // 只在框体内部拖一小块时不算——那里应该是在选里面的节点。
  const commentHits = [];
  if (!mind.review) {
    for (const c of docComments()) {
      const head = c.y + Math.min(26, c.h);
      const headHit = !(c.x > wx1 || c.x + c.w < wx0 || head < wy0 || c.y > wy1);
      const inside = c.x >= wx0 && c.y >= wy0 && c.x + c.w <= wx1 && c.y + c.h <= wy1;
      if (headHit || inside) commentHits.push(c);
    }
  }

  if (commentHits.length) {
    // 注释框和节点是两种选中；框到注释就选注释，节点让位。
    const c = commentHits[commentHits.length - 1];
    mind.selection = new Set();
    mind.selectedId = null;
    mind.selectedCommentId = c.id;
    renderComments();
  } else {
    const set = new Set(m.add ? m.base : []);
    for (const n of hits) set.add(n.id);
    mind.selection = set;
    mind.selectedId = hits.length ? hits[hits.length - 1].id : (set.size ? [...set][set.size - 1] : null);
    if (mind.selectedCommentId !== null) {
      mind.selectedCommentId = null;   // 框选的是节点，注释框放下
      renderComments();
    }
  }
  paintSelection();
  updateStatus();
}

function onClick(e) {
  if (e.target.closest('#searchPanel')) return;
  if (e.target.closest('#reviewPanel')) return;
  if (e.target.closest('.note-mark')) return;

  const badge = e.target.closest('.badge');
  if (badge) {
    e.stopPropagation();
    const wrap = badge.closest('.node-wrap');
    if (wrap) toggleCollapse(nodes.get(wrap.dataset.id));
    focusStage();
    return;
  }

  if (performance.now() < skipClickUntil) return;

  const wrap = e.target.closest('.node-wrap');
  if (wrap) {
    const node = nodes.get(wrap.dataset.id);
    if (!node) return;
    if (mind.editingId && mind.editingId !== node.id) commitEdit();
    select(node.id, { ensure: false });
    return;
  }
  if (blankClickOk && !e.shiftKey) clearSelection();
  blankClickOk = false;
}

function onDblClick(e) {
  if (e.target.closest('.badge') || e.target.closest('.note-mark') || e.target.closest('textarea')) return;
  // 双击注释框任意地方 = 改标题（UE 同款）；色点/色板/拉伸角除外。
  const cEl = e.target.closest('.comment');
  if (cEl) {
    if (mind.review) return;
    if (e.target.closest('.comment-edit, .comment-dot, .comment-swatch, .comment-grip')) return;
    editCommentTitle(cEl.dataset.id);
    return;
  }
  const wrap = e.target.closest('.node-wrap');
  if (!wrap) {
    // Double-click on empty canvas grows a new cluster right there.
    if (mind.review) return;
    const p = toWorld(e.clientX, e.clientY);
    addTopLevelAt(p.x, p.y);
    return;
  }
  const node = nodes.get(wrap.dataset.id);
  if (!node) return;
  select(node.id);
  startEdit(node.id);
}

function onWheel(e) {
  e.preventDefault();
  cancelViewAnim();                          // 滚轮接管镜头，滑行到此为止
  const unit = e.deltaMode === 1 ? 18 : (e.deltaMode === 2 ? stage.clientHeight : 1);
  if (e.ctrlKey || e.metaKey) {
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * unit * 0.0022));
  } else {
    mind.view.x -= e.deltaX * unit;
    mind.view.y -= e.deltaY * unit;
    applyView();
  }
}

// ---------------------------------------------------------------- search

function openSearch() {
  commitEdit();
  mind.searchOpen = true;
  ui.searchPanel.hidden = false;
  ui.searchInput.value = '';
  runSearch('');
  ui.searchInput.focus();
  ui.searchInput.select();
}

function closeSearch() {
  mind.searchOpen = false;
  ui.searchPanel.hidden = true;
  mind.hits = [];
  mind.hitIndex = -1;
  applyHitClasses();
  focusStage();
}

function runSearch(query) {
  const q = String(query || '').trim().toLowerCase();
  mind.hits = [];
  mind.hitIndex = -1;
  if (q) {
    for (const node of nodes.values()) {
      const text = String(node.text).toLowerCase();
      const note = String(node.note || '').toLowerCase();
      if (text.includes(q) || note.includes(q)) mind.hits.push(node);
    }
  }
  if (mind.hits.length) focusHit(0, true);
  else { applyHitClasses(); updateSearchCount(); }
}

function focusHit(index, jump = true) {
  const n = mind.hits.length;
  if (!n) { updateSearchCount(); return; }
  mind.hitIndex = ((index % n) + n) % n;
  const node = mind.hits[mind.hitIndex];

  if (jump) {
    let expanded = false;
    let p = parents.get(node.id);
    while (p) {
      if (p.collapsed) { p.collapsed = false; expanded = true; }
      p = parents.get(p.id);
    }
    if (expanded) { reindex(); render({ animate: false }); }
    select(node.id);
  }
  applyHitClasses();
  updateSearchCount();
}

function stepHit(delta) {
  if (!mind.hits.length) return;
  focusHit(mind.hitIndex + delta, true);
}

function updateSearchCount() {
  ui.searchCount.textContent = `${mind.hits.length ? mind.hitIndex + 1 : 0}/${mind.hits.length}`;
}

function applyHitClasses() {
  const set = new Set(mind.hits.map(n => n.id));
  const current = mind.hits[mind.hitIndex] ? mind.hits[mind.hitIndex].id : null;
  for (const [id, rec] of wraps) {
    rec.wrap.classList.toggle('hit', set.has(id));
    rec.wrap.classList.toggle('current', id === current);
  }
}

// ---------------------------------------------------------------- help

function openHelp() {
  commitEdit();
  mind.helpOpen = true;
  ui.helpOverlay.hidden = false;
  document.getElementById('helpClose').focus();
}

function closeHelp() {
  mind.helpOpen = false;
  ui.helpOverlay.hidden = true;
  focusStage();
}

// ---------------------------------------------------------------- export menu

function toggleExportMenu(anchor) {
  if (!ui.exportMenu.hidden) { closeExportMenu(); return; }
  mind.menuAnchor = anchor;
  ui.exportMenu.hidden = false;
  anchor.setAttribute('aria-expanded', 'true');
  const r = anchor.getBoundingClientRect();
  const w = ui.exportMenu.offsetWidth;
  ui.exportMenu.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px';
  ui.exportMenu.style.top = (r.bottom + 6) + 'px';
}

function closeExportMenu() {
  ui.exportMenu.hidden = true;
  if (mind.menuAnchor) mind.menuAnchor.setAttribute('aria-expanded', 'false');
  mind.menuAnchor = null;
}

// ---------------------------------------------------------------- boot

window.Mind = {
  get mind() { return mind; },
  get docs() { return docs; },
  nodes, order, wraps,
  select, render, fit, zoomBy, startEdit, commitEdit,
  addChild, addSibling, indentNode, outdentNode, deleteNode, deleteSelection, reparentNode,
  addTopLevelAt, undo, redo, toOutline, parseOutline, treeHash, exportAs,
  openNote, closeNote, toggleNote,
  newDoc, openDoc, saveDoc, closeDoc, activateDoc, openTextInTab,
  openReview, closeReview, decide, decideNode, decideList, stepReview, acceptAll, discardAll, scanProposals,
  decideGroup, revertGroup, markGroup,
  selectionOps, syncBatchBar, batchDecide,
};

boot().catch((err) => {
  console.error(err);
  toast('启动出错：' + ((err && err.message) || err));
});
