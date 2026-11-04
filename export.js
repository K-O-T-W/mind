// Export: PNG (2×) and SVG. Text lines are read from the live DOM so the
// exported breaks are exactly the ones on screen. The outline itself is
// already Markdown, so there is no separate text export.

let measureCanvas = null;

function exportAs(kind) {
  commitEdit();
  if (!mind.root) return;
  settle();

  // Read text at 1:1 so glyph rectangles are exact CSS pixels, not scaled.
  const saved = { ...mind.view };
  mind.view.x = 0;
  mind.view.y = 0;
  mind.view.s = 1;
  applyView();

  let data;
  try {
    data = collectExport();
  } finally {
    mind.view = saved;
    applyView();
  }

  if (kind === 'png') drawPng(data);
  else if (kind === 'svg') drawSvg(data);
}

function exportBase() {
  return (mind.name || '未命名').replace(/[\\/:*?"<>|]/g, '-');
}

function collectExport() {
  const stageRect = stage.getBoundingClientRect();
  const b = mapBounds();
  const pad = 64;
  const items = [];

  for (const node of order) {
    const rec = wraps.get(node.id);
    if (!rec) continue;
    const style = getComputedStyle(rec.text);
    items.push({
      node,
      color: branchColor(node),
      style: {
        size: parseFloat(style.fontSize) || 14,
        weight: style.fontWeight || '400',
        family: style.fontFamily || 'sans-serif',
        lineHeight: parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 14) * 1.5,
        color: style.color || '#e7eaf0',
      },
      lines: textLines(rec.text, stageRect),
    });
  }

  return {
    b,
    pad,
    width: b.w + pad * 2,
    height: b.h + pad * 2,
    items,
    byId: new Map(items.map(item => [item.node.id, item])),
  };
}

function textLines(textEl, stageRect) {
  const tn = textEl.firstChild;
  if (!tn || !tn.data) return [];
  const range = document.createRange();
  const lines = [];
  let current = null;
  const data = tn.data;

  for (let i = 0; i < data.length;) {
    const code = data.codePointAt(i);
    const len = code > 0xffff ? 2 : 1;
    const ch = data.slice(i, i + len);
    range.setStart(tn, i);
    range.setEnd(tn, i + len);
    const rect = range.getBoundingClientRect();
    i += len;
    if (!rect.width && !rect.height) continue;
    const top = rect.top - stageRect.top;
    const left = rect.left - stageRect.left;
    if (!current || Math.abs(top - current.top) > 1.5) {
      current = { top, left, text: ch };
      lines.push(current);
    } else {
      current.text += ch;
      if (left < current.left) current.left = left;
    }
  }
  return lines;
}

function withNodeClip(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

function baselineOffset(ctx, style, scale) {
  const size = style.size * scale;
  const line = style.lineHeight * scale;
  ctx.font = `${style.weight} ${size}px ${style.family}`;
  const m = ctx.measureText('Hg');
  const ascent = m.actualBoundingBoxAscent || size * 0.8;
  const descent = m.actualBoundingBoxDescent || size * 0.22;
  return (line - ascent - descent) / 2 + ascent;
}

// ---------------------------------------------------------------- PNG

function drawPng(data) {
  let scale = 2;
  scale = Math.min(scale, 8000 / data.width, 8000 / data.height, Math.sqrt(32e6 / (data.width * data.height)));
  scale = Math.max(.3, scale);

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(data.width * scale));
  canvas.height = Math.max(1, Math.round(data.height * scale));
  const ctx = canvas.getContext('2d');

  const X = v => (v - data.b.x + data.pad) * scale;
  const Y = v => (v - data.b.y + data.pad) * scale;

  ctx.fillStyle = '#0b0d11';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // links first, under the boxes
  ctx.lineCap = 'round';
  for (const item of data.items) {
    const parent = data.byId.get((parents.get(item.node.id) || {}).id);
    if (!parent) continue;
    const x1 = parent.node.tx + parent.node.w;
    const y1 = parent.node.ty + parent.node.h / 2;
    const x2 = item.node.tx;
    const y2 = item.node.ty + item.node.h / 2;
    const dx = Math.max(34, (x2 - x1) * 0.52);
    ctx.beginPath();
    ctx.moveTo(X(x1), Y(y1));
    ctx.bezierCurveTo(X(x1 + dx), Y(y1), X(x2 - dx), Y(y2), X(x2), Y(y2));
    ctx.strokeStyle = rgba(item.color, .46);
    ctx.lineWidth = 1.5 * scale;
    ctx.stroke();
  }

  const measure = document.createElement('canvas').getContext('2d');

  for (const item of data.items) {
    const n = item.node;
    const x = X(n.tx);
    const y = Y(n.ty);
    const w = n.w * scale;
    const h = n.h * scale;
    const root = n.depth === 0;

    withNodeClip(ctx, x, y, w, h, (root ? 12 : 9) * scale);
    ctx.fillStyle = root ? '#1e2738' : '#161b24';
    ctx.fill();
    ctx.strokeStyle = rgba(item.color, root ? .55 : .30);
    ctx.lineWidth = (root ? 1.4 : 1) * scale;
    ctx.stroke();

    ctx.save();
    withNodeClip(ctx, x, y, w, h, (root ? 12 : 9) * scale);
    ctx.clip();

    const offset = baselineOffset(measure, item.style, scale);
    ctx.font = `${item.style.weight} ${item.style.size * scale}px ${item.style.family}`;
    ctx.fillStyle = item.style.color;
    ctx.textBaseline = 'alphabetic';
    for (const line of item.lines) {
      ctx.fillText(line.text, X(line.left), Y(line.top) + offset);
    }
    ctx.restore();

    if (String(n.note || '').trim()) {
      ctx.beginPath();
      ctx.arc(X(n.tx + n.w), Y(n.ty), 3.2 * scale, 0, Math.PI * 2);
      ctx.fillStyle = rgba(item.color, .75);
      ctx.fill();
    }

    if (n.collapsed && n.children.length) {
      const cx = X(n.tx + n.w);
      const cy = Y(n.ty + n.h / 2);
      ctx.beginPath();
      ctx.arc(cx, cy, 9 * scale, 0, Math.PI * 2);
      ctx.fillStyle = item.color;
      ctx.fill();
      ctx.fillStyle = '#0b0d11';
      ctx.font = `700 ${10 * scale}px ${item.style.family}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(n.children.length), cx, cy + 0.5 * scale);
      ctx.textAlign = 'left';
    }
  }

  canvas.toBlob((blob) => {
    if (!blob) { toast('导出失败：图片太大'); return; }
    downloadBlob(blob, exportBase() + '.png');
    toast('已导出 PNG');
  }, 'image/png');
}

// ---------------------------------------------------------------- SVG

function xml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function drawSvg(data) {
  if (!measureCanvas) measureCanvas = document.createElement('canvas').getContext('2d');
  const X = v => (v - data.b.x + data.pad);
  const Y = v => (v - data.b.y + data.pad);
  const out = [];

  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(data.width)}" height="${Math.round(data.height)}" viewBox="0 0 ${Math.round(data.width)} ${Math.round(data.height)}">`);
  out.push(`<title>${xml(mind.name || '产品定义')}</title>`);
  out.push(`<rect width="100%" height="100%" fill="#0b0d11"/>`);

  for (const item of data.items) {
    const parent = data.byId.get((parents.get(item.node.id) || {}).id);
    if (!parent) continue;
    const x1 = parent.node.tx + parent.node.w;
    const y1 = parent.node.ty + parent.node.h / 2;
    const x2 = item.node.tx;
    const y2 = item.node.ty + item.node.h / 2;
    const dx = Math.max(34, (x2 - x1) * 0.52);
    out.push(`<path d="M${X(x1)} ${Y(y1)} C${X(x1 + dx)} ${Y(y1)} ${X(x2 - dx)} ${Y(y2)} ${X(x2)} ${Y(y2)}" fill="none" stroke="${rgba(item.color, .46)}" stroke-width="1.5" stroke-linecap="round"/>`);
  }

  for (const item of data.items) {
    const n = item.node;
    const root = n.depth === 0;
    out.push(`<rect x="${X(n.tx)}" y="${Y(n.ty)}" width="${n.w}" height="${n.h}" rx="${root ? 12 : 9}" fill="${root ? '#1e2738' : '#161b24'}" stroke="${rgba(item.color, root ? .55 : .30)}" stroke-width="${root ? 1.4 : 1}"/>`);

    if (String(n.note || '').trim()) {
      out.push(`<circle cx="${X(n.tx + n.w)}" cy="${Y(n.ty)}" r="3.2" fill="${rgba(item.color, .75)}"/>`);
    }

    const offset = baselineOffset(measureCanvas, item.style, 1);
    for (const line of item.lines) {
      out.push(`<text x="${X(line.left)}" y="${Y(line.top) + offset}" font-family="${xml(item.style.family)}" font-size="${item.style.size}" font-weight="${item.style.weight}" fill="${item.style.color}" xml:space="preserve">${xml(line.text)}</text>`);
    }

    if (n.collapsed && n.children.length) {
      const cx = X(n.tx + n.w);
      const cy = Y(n.ty + n.h / 2);
      out.push(`<circle cx="${cx}" cy="${cy}" r="9" fill="${item.color}"/>`);
      out.push(`<text x="${cx}" y="${cy}" font-family="${xml(item.style.family)}" font-size="10" font-weight="700" fill="#0b0d11" text-anchor="middle" dominant-baseline="central">${n.children.length}</text>`);
    }
  }

  out.push('</svg>');
  downloadText(out.join('\n'), exportBase() + '.svg', 'image/svg+xml;charset=utf-8');
  toast('已导出 SVG');
}
