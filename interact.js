// Wiring: pointer gestures, search, files, menus, toolbar.

let lastTap = { id: null, at: 0, x: 0, y: 0 };
let bodyCommentPress = null;

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
  stage.addEventListener('contextmenu', onContextMenu);
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
  bindCtxMenu();
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
    if (!ui.ctxMenu.hidden && !ui.ctxMenu.contains(e.target)) closeCtxMenu();
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
    case 'copy': if (typeof copySelection === 'function') copySelection(); break;
    case 'paste': if (typeof pasteClipboard === 'function') pasteClipboard(); break;
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
    for (const swatch of COMMENT_PALETTE) {
      const b = document.createElement('button');
      b.className = 'comment-swatch';
      b.type = 'button';
      b.tabIndex = -1;
      b.dataset.c = swatch.c;
      b.title = swatch.n + ' ' + swatch.c;
      b.style.background = swatch.c;
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

  // 右键只留给上下文菜单，不启动任何手势（平移改成中键）。
  if (e.button === 2) return;

  // 中键只有一个职责：平移。放在所有控件分支之前，免得中键落在输入框、
  // 备注点或审批按钮上时被别的逻辑接走，也顺手挡掉浏览器默认的中键手势。
  // 按下先 settle：刚新建/删除节点时布局动画还在跑，不落位就拖动会一边
  // 搬镜头一边看节点滑，像画面在跳。
  if (e.button === 1) {
    if (typeof settle === 'function') settle();
    mind.panning = { x0: e.clientX, y0: e.clientY, vx: mind.view.x, vy: mind.view.y, moved: false };
    blankClickOk = false;
    grabPointer(e.pointerId);
    stage.classList.add('panning');
    e.preventDefault();
    e.stopPropagation();
    return;
  }

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

  // 蓝图注释框：只有标题条能拖整框带节点，右下角拉伸，色点开色板。
  // 框体内部不接拖动——那一块要让给画布框选，否则框里的节点永远选不上。
  // 删除走“选中 + Delete”，不在框上放 ×——和节点的选中手感保持一致。
  const cEl = e.target.closest('.comment');
  const cHead = e.target.closest('.comment-head');
  const cGrip = e.target.closest('.comment-grip');
  bodyCommentPress = null;
  if (cEl && e.button === 0 && !mind.review && (cHead || cGrip)) {
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

  // 框体内部：单击不选中框（只有标题条能选中它）；按下这一刻也不选中。
  // 这里只记下起点，让 marquee 延迟抓指针——双击建节点要保住 body 这个 target。
  const cBody = e.target.closest('.comment-body');
  if (cEl && cBody && e.button === 0 && !mind.review && !e.shiftKey) {
    if (mind.editingId) commitEdit();
    bodyCommentPress = cEl.dataset.id;
    blankClickOk = false;
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

  // 中键已在最前面处理；这里只剩左键和右键（右键更早已返回）。
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
  // Inside a comment body we do NOT capture the pointer on press: the browser
  // must keep the dblclick target on the body so title editing still works.
  // Capture starts only once the drag actually moves (see updateMarquee).
  const bodyStart = !!bodyCommentPress;
  mind.marquee = {
    x0: e.clientX, y0: e.clientY, moved: false,
    add: e.shiftKey,
    base: new Set(mind.selection),
    bodyStart,
    captured: !bodyStart,
    hits: [],
  };
  if (!bodyStart) grabPointer(e.pointerId);
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
      // No movement: a normal click, which may select the comment body in onClick.
      blankClickOk = true;
    }
    bodyCommentPress = null;
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
  if (!m.captured) {
    m.captured = true;
    grabPointer(e.pointerId);
  }
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

  // 注释框只有一个触发区：顶部标题条。框体内部一律当空地——那一块要能框选
  // 节点、双击建节点、右键出画布菜单，不能因为压在框上就变成操作注释。
  const commentHits = [];
  if (!mind.review) {
    for (const c of docComments()) {
      const head = c.y + Math.min(26, c.h);
      const headHit = !(c.x > wx1 || c.x + c.w < wx0 || head < wy0 || c.y > wy1);
      if (headHit) commentHits.push(c);
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
  if (blankClickOk && !e.shiftKey) {
    // 单击框体内部 = 单击空地：注释框只有标题条能选中。框体内部那一块留给
    // 双击新建节点和拖框选节点，不该在点击时亮一下注释框的选中描边。
    clearSelection();
    focusStage();
  }
  blankClickOk = false;
}

function onDblClick(e) {
  if (e.target.closest('.badge') || e.target.closest('.note-mark') || e.target.closest('textarea')) return;
  // 注释框只有顶部标题条是“改名区”：双击标题条改名；双击框体内部不拦截，
  // 落到下面“空地双击”的分支——在指针处新建节点。框里要能继续长节点，
  // 不能整块框都吃掉双击（那会和双击建节点的操作撞车）。
  const cEl = e.target.closest('.comment');
  if (cEl) {
    if (mind.review) return;
    if (e.target.closest('.comment-dot, .comment-swatch, .comment-grip, .comment-edit')) return;
    if (e.target.closest('.comment-head')) {
      editCommentTitle(cEl.dataset.id);
      return;
    }
    // 框体内部：继续往下走。
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
  if (!ui.ctxMenu.hidden) closeCtxMenu();
  const unit = e.deltaMode === 1 ? 18 : (e.deltaMode === 2 ? stage.clientHeight : 1);
  // 滚轮直接缩放，指针是锚点；Ctrl 不再是前提，滚轮也不再负责平移。
  zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * unit * 0.0022));
}

// ---------------------------------------------------------------- context menu

// 右键 = 画布上的操作面板。菜单项按右键命中的目标分三套：节点、注释框、空白。
// 每一项对应一个已有快捷键命令，所以菜单只是把藏在键盘里的动作摆到明面上。
let ctxKind = 'canvas';
let ctxTargetId = null;

function ctxComment() {
  const id = ctxTargetId || mind.selectedCommentId;
  return id ? (docComments().find((c) => c.id === id) || null) : null;
}

function closeCtxMenu() {
  if (!ui.ctxMenu || ui.ctxMenu.hidden) return;
  ui.ctxMenu.hidden = true;
  ui.ctxMenu.innerHTML = '';
  ctxKind = 'canvas';
  ctxTargetId = null;
}

function ctxNodeItems(node) {
  const top = isTop(node);
  const siblings = (top ? mind.root : (parentOf(node) || mind.root)).children;
  const i = siblings.indexOf(node);
  const hasClip = !!(typeof clipBuffer !== 'undefined' && clipBuffer && clipBuffer.roots && clipBuffer.roots.length);
  return [
    { cmd: 'edit', label: '编辑文字', hint: 'F2' },
    { cmd: 'child', label: '添加子节点', hint: 'Tab' },
    { cmd: 'sibling', label: '添加同级节点', hint: 'Enter' },
    { sep: true },
    { cmd: 'note', label: node.note ? '查看 / 编辑备注' : '添加备注', hint: 'N' },
    { cmd: 'copy', label: '复制（含子树）', hint: 'Ctrl+C' },
    { cmd: 'paste', label: '粘贴到这里', hint: 'Ctrl+V', disabled: !hasClip },
    { sep: true },
    { cmd: 'up', label: '上移一位', hint: 'Alt+↑', disabled: top || i <= 0 },
    { cmd: 'down', label: '下移一位', hint: 'Alt+↓', disabled: top || i < 0 || i >= siblings.length - 1 },
    { cmd: 'indent', label: '缩进一级', hint: 'Ctrl+]', disabled: top || i <= 0 },
    { cmd: 'outdent', label: '取消缩进', hint: 'Ctrl+[', disabled: top },
    { cmd: 'collapse', label: node.collapsed ? '展开子项' : '折叠子项', hint: '空格', disabled: !node.children.length },
    { sep: true },
    { cmd: 'commentSel', label: '用注释框框住', hint: 'C' },
    { cmd: 'delete', label: '删除节点', hint: 'Delete', danger: true },
  ];
}

function ctxCommentItems() {
  return [
    { cmd: 'renameComment', label: '重命名注释', hint: 'F2 / 双击标题' },
    { colors: true, label: '换颜色' },
    { sep: true },
    { cmd: 'deleteComment', label: '删除注释框', hint: 'Delete · 节点保留', danger: true },
  ];
}

function ctxCanvasItems() {
  return [
    { cmd: 'newHere', label: '在此新建节点', hint: '双击空白' },
    { cmd: 'commentHere', label: '在此新建注释框', hint: 'C' },
    { sep: true },
    { cmd: 'fit', label: '适应画布', hint: 'F' },
    { cmd: 'search', label: '搜索', hint: 'Ctrl+F' },
    { cmd: 'undo', label: '撤销', hint: 'Ctrl+Z', disabled: !mind.undo.length },
    { cmd: 'redo', label: '重做', hint: 'Ctrl+Shift+Z', disabled: !mind.redo.length },
    { sep: true },
    { cmd: 'help', label: '操作说明', hint: '?' },
  ];
}

function renderCtxMenu(items) {
  const menu = ui.ctxMenu;
  menu.innerHTML = '';
  for (const it of items) {
    if (it.sep) {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      menu.appendChild(sep);
      continue;
    }
    if (it.colors) {
      const label = document.createElement('div');
      label.className = 'menu-label';
      label.textContent = it.label || '换颜色';
      menu.appendChild(label);
      const row = document.createElement('div');
      row.className = 'ctx-colors';
      const cur = ctxComment();
      for (const sw of COMMENT_PALETTE) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ctx-color' + (cur && cur.color === sw.c ? ' on' : '');
        b.dataset.color = sw.c;
        b.title = sw.n;
        b.setAttribute('aria-label', sw.n);
        b.style.background = sw.c;
        row.appendChild(b);
      }
      menu.appendChild(row);
      continue;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.dataset.cmd = it.cmd;
    if (it.disabled) b.disabled = true;
    if (it.danger) b.classList.add('danger');
    const label = document.createElement('span');
    label.textContent = it.label;
    b.appendChild(label);
    if (it.hint) {
      const hint = document.createElement('span');
      hint.className = 'menu-hint';
      hint.textContent = it.hint;
      b.appendChild(hint);
    }
    menu.appendChild(b);
  }
}

function openCtxMenu(clientX, clientY, kind, items, targetId) {
  ctxKind = kind;
  ctxTargetId = targetId || null;
  renderCtxMenu(items);
  const menu = ui.ctxMenu;
  menu.hidden = false;
  menu.style.left = '0px';
  menu.style.top = '0px';
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = Math.max(6, Math.min(window.innerWidth - w - 6, clientX)) + 'px';
  menu.style.top = Math.max(6, Math.min(window.innerHeight - h - 6, clientY)) + 'px';
  const first = menu.querySelector('button:not(:disabled)');
  if (first) first.focus({ preventScroll: true });
}

function onContextMenu(e) {
  // 输入框和搜索面板里保留浏览器原生菜单（复制、粘贴要用）。
  if (e.target.closest('#searchPanel, input, textarea, [contenteditable]')) return;
  e.preventDefault();
  if (!mind || mind.review) return;

  const wrap = e.target.closest('.node-wrap');
  // 注释框的触发区只有顶部标题条；框体内部一律当空地（右键要能新建节点）。
  const cHead = e.target.closest('.comment-head');

  if (wrap) {
    const node = nodes.get(wrap.dataset.id);
    if (!node) return;
    if (mind.editingId) commitEdit();
    select(node.id, { ensure: false });
    openCtxMenu(e.clientX, e.clientY, 'node', ctxNodeItems(node), node.id);
    return;
  }
  if (cHead) {
    const cEl = cHead.closest('.comment');
    const c = cEl && docComments().find((x) => x.id === cEl.dataset.id);
    if (!c) return;
    if (mind.editingId) commitEdit();
    mind.selectedCommentId = c.id;
    mind.selection = new Set();
    mind.selectedId = null;
    renderComments();
    paintSelection();
    if (typeof syncNotePanel === 'function') syncNotePanel();
    openCtxMenu(e.clientX, e.clientY, 'comment', ctxCommentItems(c), c.id);
    return;
  }
  // 空白：和左键点空白一样放下选中，菜单只放画布级动作。
  if (mind.editingId) commitEdit();
  clearSelection();
  openCtxMenu(e.clientX, e.clientY, 'canvas', ctxCanvasItems(), null);
}

function runCtxCmd(cmd, kind, targetId) {
  const node = kind === 'node' ? selectedNode() : null;
  const c = (kind === 'comment' && targetId)
    ? docComments().find((x) => x.id === targetId) || null
    : null;
  switch (cmd) {
    case 'edit': if (node) startEdit(node.id); break;
    case 'child': if (node) addChild(node); break;
    case 'sibling': if (node) addSibling(node); break;
    case 'note': if (node) openNote(node.id); break;
    case 'copy': if (typeof copySelection === 'function') copySelection(); break;
    case 'paste': if (typeof pasteClipboard === 'function') pasteClipboard(); break;
    case 'up': if (node) moveSibling(node, -1); break;
    case 'down': if (node) moveSibling(node, 1); break;
    case 'indent': if (node) indentNode(node); break;
    case 'outdent': if (node) outdentNode(node); break;
    case 'collapse': if (node) toggleCollapse(node); break;
    case 'commentSel': createCommentFromSelection(); break;
    case 'delete':
      if (node) {
        if (mind.selection.size > 1) deleteSelection();
        else deleteNode(node);
      }
      break;
    case 'renameComment': if (c) editCommentTitle(c.id); break;
    case 'deleteComment': if (c) deleteCommentById(c.id); break;
    case 'newHere': {
      const p = mouseWorldForNewComment();
      addTopLevelAt(p.x, p.y);
      break;
    }
    case 'commentHere': createCommentFromSelection(); break;
    case 'fit': fit(); break;
    case 'search': openSearch(); break;
    case 'undo': undo(); break;
    case 'redo': redo(); break;
    case 'help': openHelp(); break;
    default: break;
  }
}

function bindCtxMenu() {
  ui.ctxMenu.addEventListener('click', (e) => {
    const swatch = e.target.closest('.ctx-color');
    if (swatch) {
      const c = ctxComment();
      const color = swatch.dataset.color;
      const kind = ctxKind;
      const targetId = ctxTargetId;
      closeCtxMenu();
      if (c && color && c.color !== color) {
        const snap = snapshot();
        c.color = color;
        pushUndo(snap);
        markDirty();
        renderComments();
        saveAutosaveNow();
      }
      focusStage();
      return;
    }
    const btn = e.target.closest('button[data-cmd]');
    if (!btn || btn.disabled) return;
    const cmd = btn.dataset.cmd;
    const kind = ctxKind;
    const targetId = ctxTargetId;
    closeCtxMenu();
    runCtxCmd(cmd, kind, targetId);
    // 会打开编辑框/备注/搜索的命令自己管焦点；别用 focusStage 把输入框顶掉，
    // 否则空节点一失焦就被当空文本删掉。
    const ae = document.activeElement;
    if (!ae || (ae.tagName !== 'TEXTAREA' && ae.tagName !== 'INPUT')) focusStage();
  });
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
