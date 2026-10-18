/* Share card. Ports make_card.py: 1080-wide navy newspaper on cream,
   corners filled #111111 (opaque; WeChat paints transparent corners white).
   Font sizes and line heights are the GIMAP6 reference and never shrink.
   All three quotations are drawn. The card grows past the old 1920px cap
   instead of dropping a quote. Line spacing stays at or above the reference. */
(function () {
  const S = 1.8;
  const W = Math.round(600 * S);
  const M = 36 * S;
  const BAR_H = 44;
  const CORNER_R = 40;
  const TARGET_H = 1690;
  const MAX_H = 1920;
  const PAPER = '#f6f1e7';
  const INK = '#1a1815';
  const DK = '#1c1a17';
  const GR = '#625c54';
  const LG = '#968e82';
  const SEP = '#d2c8b8';
  const NAVY = '#1f3a5f';
  const SOFT = '#e0e6ee';
  const QZH = '#57534e';
  const SRC = '#7a3300';
  const CORNER = '#111111';
  const PUNCT = '。，、；：！？）》”’';

  const SPACING = {
    title_zh_lh: 39, title_en_lh: 22, label_gap: 11, label_h: 16.5,
    en_lh: 21.5, en_gap: 2, zh_lh: 19.5, zh_gap: 6, sep_gap: 6,
  };

  let fontsReady = null;

  function fontUrl(file) {
    return new URL('assets/fonts/' + file, document.baseURI).toString();
  }

  function ensureFonts() {
    if (fontsReady) return fontsReady;
    fontsReady = (async () => {
      const specs = [
        ['RR Playfair', 'playfair-700.woff2', '700', 'normal'],
        ['RR Playfair', 'playfair-600.woff2', '600', 'normal'],
        ['RR Source', 'source-serif-400-italic.woff2', '400', 'italic'],
        ['RR Source', 'source-serif-600.woff2', '600', 'normal'],
        ['RR Serif', 'noto-serif-sc-700.woff2', '700', 'normal'],
        ['RR Serif', 'noto-serif-sc-400.woff2', '400', 'normal'],
        ['RR Sans', 'noto-sans-sc-700.woff2', '700', 'normal'],
        ['RR Sans', 'noto-sans-sc-400.woff2', '400', 'normal'],
      ];
      const faces = specs.map(([family, file, weight, style]) =>
        new FontFace(family, 'url(' + fontUrl(file) + ')', { weight, style, display: 'block' }));
      const loaded = await Promise.all(faces.map(face => face.load()));
      for (const face of loaded) document.fonts.add(face);
      await document.fonts.ready;
    })().catch(err => {
      fontsReady = null;
      throw err;
    });
    return fontsReady;
  }

  function px(sz) { return Math.max(1, Math.round(sz * S)); }
  function sans(sz, bold) { return (bold ? '700 ' : '400 ') + px(sz) + 'px "RR Sans"'; }
  function serif(sz, bold) { return (bold ? '700 ' : '400 ') + px(sz) + 'px "RR Serif"'; }
  function play(sz, weight) { return weight + ' ' + px(sz) + 'px "RR Playfair"'; }
  function source(sz, italic) {
    return italic
      ? 'italic 400 ' + px(sz) + 'px "RR Source"'
      : '600 ' + px(sz) + 'px "RR Source"';
  }
  function fontPxOf(font) {
    const m = String(font).match(/(\d+(?:\.\d+)?)px/);
    return m ? Number(m[1]) : 16;
  }

  function clampSpacing(extra) {
    const G = {};
    for (const k of Object.keys(SPACING)) {
      const v = Number(extra && extra[k]);
      G[k] = Number.isFinite(v) ? Math.max(SPACING[k], v) : SPACING[k];
    }
    return G;
  }

  function toks(t) {
    return String(t || '').match(/[A-Za-z0-9\u00C0-\u024F'’.,;:!?()%\-–—/&“”"]+\s*|\s+|./g) || [];
  }

  function wrap(ctx, text, font, width) {
    ctx.font = font;
    const L = [];
    let cur = '';
    for (const k of toks(text)) {
      if (ctx.measureText(cur + k).width > width && cur.trim()) {
        if (PUNCT.includes(k) && cur.length > 1) {
          L.push(cur.slice(0, -1).trimEnd());
          cur = cur.slice(-1) + k;
        } else {
          L.push(cur.trimEnd());
          cur = k.trimStart();
        }
      } else cur += k;
    }
    if (cur.trim()) L.push(cur.trimEnd());
    if (L.length > 1 && L[L.length - 1].trim().length <= 2 && /[\u4e00-\u9fff]/.test(L[L.length - 1]) && L[L.length - 2].length > 4) {
      L[L.length - 1] = L[L.length - 2].slice(-2) + L[L.length - 1];
      L[L.length - 2] = L[L.length - 2].slice(0, -2);
    }
    return L.filter(line => line.trim());
  }

  /** Trial-design tail such as ": a phase 3, multicentre, randomised … trial." */
  function isDesignSubtitle(tail) {
    const t = String(tail || '').replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
    if (!/^(a|an)\b/i.test(t) || !/\b(trial|study)\b/i.test(t)) return false;
    const markers = t.match(/\b(phase\s+[0-9ivx]+|multicentre|multicenter|randomi[sz]ed|double-blind|placebo-controlled|open-label|crossover|non-inferiority|parallel-group|single-blind|active-controlled)\b/ig) || [];
    if (markers.length >= 2) return true;
    return /^(a|an)\s+(phase\s+[0-9ivx]+|multicentre|multicenter|double-blind|placebo-controlled|open-label|crossover)\b/i.test(t);
  }

  function trimDesignSubtitle(title) {
    const s = String(title || '').replace(/\s+/g, ' ').trim();
    const idx = s.search(/[：:]/);
    if (idx < 12) return s;
    const head = s.slice(0, idx).trim();
    const tail = s.slice(idx + 1).trim();
    if (!head || !isDesignSubtitle(tail)) return s;
    return head;
  }

  function cwrap(ctx, text, font, width) {
    const m = String(text || '').match(/[：:]/);
    if (!m) return wrap(ctx, text, font, width);
    const at = m.index + m[0].length;
    const head = text.slice(0, at).trim();
    const tail = text.slice(at).trim();
    return wrap(ctx, head, font, width).concat(tail ? wrap(ctx, tail, font, width) : []);
  }

  function fitTitleZh(ctx, title) {
    const font = serif(30, true);
    const width = W - 2 * M;
    const full = String(title || '');
    const lines = cwrap(ctx, full, font, width);
    if (lines.length <= 2) return full;
    const m = full.match(/[：:]/);
    if (!m || m.index < 8) return full;
    const head = full.slice(0, m.index).trim();
    const headLines = wrap(ctx, head, font, width);
    if (!headLines.length || headLines.length >= lines.length) return full;
    return head;
  }

  function textInk(ctx, text, x, y, font, baseline) {
    ctx.font = font;
    ctx.textBaseline = baseline || 'top';
    const m = ctx.measureText(text || '');
    const size = fontPxOf(font);
    let asc = Number.isFinite(m.actualBoundingBoxAscent) ? m.actualBoundingBoxAscent : 0;
    let desc = Number.isFinite(m.actualBoundingBoxDescent) ? m.actualBoundingBoxDescent : 0;
    let left = Number.isFinite(m.actualBoundingBoxLeft) ? m.actualBoundingBoxLeft : 0;
    let right = Number.isFinite(m.actualBoundingBoxRight) ? m.actualBoundingBoxRight : m.width;
    if (asc + desc < 1) {
      if ((baseline || 'top') === 'middle') {
        asc = size / 2;
        desc = size / 2;
      } else if (baseline === 'alphabetic') {
        asc = size * 0.8;
        desc = size * 0.2;
      } else {
        asc = 0;
        desc = size;
      }
    }
    if (right + left < 1) right = Math.max(m.width, 1);
    return {
      x: x - left,
      y: y - asc,
      w: Math.max(1, left + right),
      h: Math.max(1, asc + desc),
    };
  }

  function tracked(ctx, text, x, y, font, color, extra, draw) {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textBaseline = 'top';
    let cx = x;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const ch of text) {
      const ink = textInk(ctx, ch, cx, y, font, 'top');
      minX = Math.min(minX, ink.x);
      minY = Math.min(minY, ink.y);
      maxX = Math.max(maxX, ink.x + ink.w);
      maxY = Math.max(maxY, ink.y + ink.h);
      if (draw) ctx.fillText(ch, cx, y);
      cx += ctx.measureText(ch).width + extra;
    }
    if (!Number.isFinite(minX)) return { end: x, box: null };
    return { end: cx, box: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
  }

  function drawQr(ctx, url, x, y, size) {
    if (typeof qrcode !== 'function') throw new Error('qr');
    const qr = qrcode(0, 'M');
    qr.addData(String(url || ''));
    qr.make();
    const n = qr.getModuleCount();
    const cell = size / n;
    ctx.fillStyle = PAPER;
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = '#111111';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!qr.isDark(r, c)) continue;
        const px0 = Math.round(c * cell);
        const py0 = Math.round(r * cell);
        const px1 = Math.round((c + 1) * cell);
        const py1 = Math.round((r + 1) * cell);
        ctx.fillRect(x + px0, y + py0, Math.max(1, px1 - px0), Math.max(1, py1 - py0));
      }
    }
  }

  function roundPath(ctx, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(rr, 0);
    ctx.arcTo(w, 0, w, h, rr);
    ctx.arcTo(w, h, 0, h, rr);
    ctx.arcTo(0, h, 0, 0, rr);
    ctx.arcTo(0, 0, w, 0, rr);
    ctx.closePath();
  }

  function intersects(a, b) {
    const pad = 0.6;
    return a.x < b.x + b.w - pad
      && a.x + a.w > b.x + pad
      && a.y < b.y + b.h - pad
      && a.y + a.h > b.y + pad;
  }

  function allowPair(a, b) {
    const mark = a.role === 'mark' ? a : (b.role === 'mark' ? b : null);
    const other = mark === a ? b : (mark === b ? a : null);
    if (!mark || !other) return false;
    return other.role === 'qen' && other.quote === mark.quote;
  }

  function forbiddenOverlaps(blocks) {
    const hits = [];
    for (let i = 0; i < blocks.length; i++) {
      for (let j = i + 1; j < blocks.length; j++) {
        if (!intersects(blocks[i], blocks[j])) continue;
        if (allowPair(blocks[i], blocks[j])) continue;
        hits.push([blocks[i], blocks[j]]);
      }
    }
    return hits;
  }

  function assertLayout(blocks) {
    const hits = forbiddenOverlaps(blocks);
    if (hits.length) {
      const [a, b] = hits[0];
      throw new Error('卡片文字重叠：' + a.role + ' 与 ' + b.role);
    }
    const runs = new Map();
    for (const b of blocks) {
      if (!b.run || !(b.minAdvance > 0)) continue;
      if (!runs.has(b.run)) runs.set(b.run, []);
      runs.get(b.run).push(b);
    }
    for (const [run, rows] of runs) {
      rows.sort((a, b) => a.y0 - b.y0);
      const minFont = rows[0].minFont || 0;
      for (const row of rows) {
        if (minFont && row.fontPx + 0.01 < minFont) {
          throw new Error('字号低于参考值（' + run + '）');
        }
      }
      for (let i = 1; i < rows.length; i++) {
        const gap = rows[i].y0 - rows[i - 1].y0;
        const need = rows[i].minAdvance;
        if (gap + 0.01 < need) {
          throw new Error('行距 ' + gap.toFixed(1) + ' 低于参考 ' + need.toFixed(1) + '（' + run + '）');
        }
      }
    }
  }

  /**
   * Content height and every text box. draw=false only measures.
   * Spacing and type sizes stay at the reference; markPad only inserts
   * extra room so the quotation mark clears the label.
   */
  function layout(ctx, spec, G, draw, slack, markPad, markDrop) {
    markPad = markPad || 0;
    markDrop = markDrop || 0;
    const blocks = [];
    const note = (box, meta) => {
      if (box) blocks.push(Object.assign({}, box, meta));
    };
    const paint = (x, yy, text, font, color, meta) => {
      if (!text) return;
      const box = textInk(ctx, text, x, yy, font, 'top');
      note(box, Object.assign({
        y0: yy,
        fontPx: fontPxOf(font),
      }, meta));
      if (draw) {
        ctx.font = font;
        ctx.fillStyle = color;
        ctx.textBaseline = 'top';
        ctx.fillText(text, x, yy);
      }
    };

    ctx.textBaseline = 'top';
    let y = 0;

    if (draw) {
      ctx.fillStyle = NAVY;
      ctx.fillRect(0, 0, W, BAR_H * S);
    }
    const header = spec.tag || '医学期刊 · 精选文章分享';
    const headerFont = sans(15, true);
    const headerY = BAR_H * S / 2;
    note(
      textInk(ctx, header, M, headerY, headerFont, 'middle'),
      { role: 'header', y0: headerY, fontPx: fontPxOf(headerFont) },
    );
    if (draw) {
      ctx.font = headerFont;
      ctx.fillStyle = PAPER;
      ctx.textBaseline = 'middle';
      ctx.fillText(header, M, headerY);
      ctx.textBaseline = 'top';
    }

    const y0 = (BAR_H + 22) * S;
    const y1 = (BAR_H + 16 + 33 + 48 - 14) * S;
    if (draw) {
      ctx.strokeStyle = INK;
      ctx.lineWidth = Math.max(1, Math.round(2 * S));
      for (const yy of [y0, y1]) {
        ctx.beginPath();
        ctx.moveTo(M, yy);
        ctx.lineTo(W - M, yy);
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(M, yy + 4 * S);
        ctx.lineTo(W - M, yy + 4 * S);
        ctx.stroke();
        ctx.lineWidth = Math.max(1, Math.round(2 * S));
      }
    }
    const mm = String(spec.date || '').match(/(\d{4})-(\d{2})-(\d{2})/);
    const parts = [];
    if (mm) parts.push(Number(mm[1]) + '年' + Number(mm[2]) + '月' + Number(mm[3]) + '日');
    if (spec.type_line) parts.push(spec.type_line);
    const dateTxt = parts.join('  ·  ');
    const dateFont = serif(15, true);
    const dateY = (y0 + y1 + 4 * S) / 2;
    if (dateTxt) {
      note(
        textInk(ctx, dateTxt, M, dateY, dateFont, 'middle'),
        { role: 'date', y0: dateY, fontPx: fontPxOf(dateFont) },
      );
      if (draw) {
        ctx.font = dateFont;
        ctx.fillStyle = INK;
        ctx.textBaseline = 'middle';
        ctx.fillText(dateTxt, M, dateY);
        ctx.textBaseline = 'top';
      }
    }
    y = (BAR_H + 16 + 33 + 48) * S;

    const typeLabel = spec.type || '';
    if (typeLabel) {
      const typeFont = sans(12, true);
      ctx.font = typeFont;
      const tw = ctx.measureText(typeLabel).width;
      if (draw) {
        ctx.fillStyle = SOFT;
        const x0 = M;
        const y0p = y;
        const bw = tw + 20 * S;
        const bh = 24 * S;
        const rad = 12 * S;
        ctx.beginPath();
        ctx.moveTo(x0 + rad, y0p);
        ctx.arcTo(x0 + bw, y0p, x0 + bw, y0p + bh, rad);
        ctx.arcTo(x0 + bw, y0p + bh, x0, y0p + bh, rad);
        ctx.arcTo(x0, y0p + bh, x0, y0p, rad);
        ctx.arcTo(x0, y0p, x0 + bw, y0p, rad);
        ctx.closePath();
        ctx.fill();
      }
      paint(M + 10 * S, y + 3 * S, typeLabel, typeFont, NAVY, { role: 'type' });
      y += 32 * S;
    }

    const zhFont = serif(30, true);
    const zhAdv = G.title_zh_lh * S;
    const zhLines = cwrap(ctx, spec.title_zh || '', zhFont, W - 2 * M);
    zhLines.forEach((line, i) => {
      paint(M, y, line, zhFont, INK, {
        role: 'title_zh', run: 'title_zh', minAdvance: zhAdv, minFont: px(30), line: i,
      });
      y += zhAdv;
    });
    y += 6 * S;
    const enFont = source(17, false);
    const enAdv = G.title_en_lh * S;
    const enLines = cwrap(ctx, spec.title_en || '', enFont, W - 2 * M);
    enLines.forEach((line, i) => {
      paint(M, y, line, enFont, GR, {
        role: 'title_en', run: 'title_en', minAdvance: enAdv, minFont: px(17), line: i,
      });
      y += enAdv;
    });
    y += 12 * S;

    if (draw) {
      ctx.strokeStyle = INK;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(M, y);
      ctx.lineTo(W - M, y);
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(M, y + 4 * S);
      ctx.lineTo(W - M, y + 4 * S);
      ctx.stroke();
    }
    y += 12 * S;

    const jen = String(spec.journal_en || spec.journal || '').toUpperCase();
    const jzh = spec.journal_zh || '';
    const jFont = play(15, 700);
    const trackedRow = tracked(ctx, jen, M, y, jFont, NAVY, 1.6 * S, draw);
    note(trackedRow.box, { role: 'journal', y0: y, fontPx: fontPxOf(jFont), minFont: px(15) });
    let x = trackedRow.end;
    if (jzh) {
      let t = '  ·  ' + jzh;
      const fz = serif(14, true);
      ctx.font = fz;
      if (x + ctx.measureText(t).width > W - M) {
        y += 26 * S;
        x = M;
        t = jzh;
      }
      paint(x, y + S, t, fz, INK, { role: 'journal_zh', minFont: px(14) });
    }
    y += 26 * S;
    if (draw) {
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(M, y);
      ctx.lineTo(W - M, y);
      ctx.stroke();
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(M, y + 4 * S);
      ctx.lineTo(W - M, y + 4 * S);
      ctx.stroke();
    }
    y += G.label_gap * S;
    const qe = 'FROM THE ARTICLE';
    const qz = '原文摘句';
    const qeFont = play(11, 600);
    const qzFont = serif(13, true);
    paint(M, y, qe, qeFont, GR, { role: 'label', minFont: px(11) });
    ctx.font = qeFont;
    const qeW = ctx.measureText(qe).width;
    paint(M + qeW + 10 * S, y - 2 * S, qz, qzFont, NAVY, { role: 'label_zh', minFont: px(13) });
    y += G.label_h * S;
    y += markPad;

    const quotes = spec.quotes || [];
    for (let i = 0; i < quotes.length; i++) {
      const q = quotes[i];
      const markFont = play(64, 700);
      const markY = y - 14 * S + markDrop;
      paint(M - 2 * S, markY, '“', markFont, NAVY, {
        role: 'mark', quote: i, minFont: px(64),
      });
      const qx = M + 34 * S;
      const qw = W - qx - M;
      const qen = source(17, true);
      const qenAdv = G.en_lh * S;
      wrap(ctx, q.en || '', qen, qw).forEach((line, li) => {
        paint(qx, y, line, qen, INK, {
          role: 'qen', run: 'qen-' + i, quote: i, minAdvance: qenAdv, minFont: px(17), line: li,
        });
        y += qenAdv;
      });
      y += G.en_gap * S;
      const qzh = serif(14, false);
      const qzhAdv = G.zh_lh * S;
      wrap(ctx, q.zh || '', qzh, qw).forEach((line, li) => {
        paint(qx, y, line, qzh, QZH, {
          role: 'qzh', run: 'qzh-' + i, quote: i, minAdvance: qzhAdv, minFont: px(14), line: li,
        });
        y += qzhAdv;
      });
      y += G.zh_gap * S;
      if (i < quotes.length - 1) {
        if (draw) {
          ctx.strokeStyle = SEP;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(W / 2 - 30 * S, y);
          ctx.lineTo(W / 2 + 30 * S, y);
          ctx.stroke();
        }
        y += G.sep_gap * S;
      }
    }

    y += 4 * S + Math.round(13 * 1080 / W);
    if (draw) {
      ctx.strokeStyle = SEP;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(M, y - 10 * S);
      ctx.lineTo(W - M, y - 10 * S);
      ctx.stroke();
    }
    const qs = Math.round(120 * S);
    const fy = y;
    const tw = W - 2 * M - qs - 20 * S;
    paint(M, y, '出处', serif(13, true), SRC, { role: 'source_label', minFont: px(13) });
    y += 22 * S;
    const journalLine = spec.journal_zh
      ? (spec.journal_en || spec.journal || '') + '（' + spec.journal_zh + '）'
      : (spec.journal || spec.journal_en || '');
    const srcLines = [
      journalLine,
      [spec.date, spec.article_no].filter(Boolean).join(' · '),
      spec.doi ? 'DOI: ' + spec.doi : '',
      spec.authors || '',
    ].filter(Boolean);
    const srcFont = sans(12, false);
    const srcAdv = 18 * S;
    let srcN = 0;
    for (const row of srcLines) {
      for (const line of wrap(ctx, row, srcFont, tw)) {
        paint(M, y, line, srcFont, GR, {
          role: 'source', run: 'source', minAdvance: srcAdv, minFont: px(12), line: srcN++,
        });
        y += srcAdv;
      }
    }
    y += 8 * S;
    const scanFont = sans(16, true);
    paint(M, y, '扫码即读', scanFont, DK, { role: 'scan', minFont: px(16) });
    ctx.font = scanFont;
    const scanW = ctx.measureText('扫码即读 ').width;
    paint(M + scanW, y + 3 * S, spec.qr_note || '链接直达全文', sans(12, false), NAVY, {
      role: 'scan_note', minFont: px(12),
    });
    y += 24 * S;
    paint(M, y, spec.qr_sub || '访问以机构订阅为准', sans(10, false), LG, {
      role: 'qr_sub', minFont: px(10),
    });
    y += 16 * S;
    if (draw) drawQr(ctx, spec.url || '', W - M - qs, fy + 4 * S, qs);
    y = Math.max(y, fy + qs + 4 * S) + (slack || 0) + 12 * S;
    if (draw) {
      ctx.fillStyle = NAVY;
      ctx.fillRect(0, y, W, 6 * S);
    }
    return { height: y + 6 * S, blocks };
  }

  function fitSpec(ctx, spec, G, markPad, markDrop) {
    const title_zh = fitTitleZh(ctx, spec.title_zh || '');
    const title_en = trimDesignSubtitle(spec.title_en || '');
    const quotes = (spec.quotes || []).filter(q => q && (q.en || q.zh)).slice(0, 3);
    const next = Object.assign({}, spec, { title_zh, title_en, quotes });
    const rawHeight = layout(ctx, next, G, false, 0, markPad, markDrop).height;
    return { spec: next, rawHeight, dropped: false };
  }

  function probeContext() {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = 32;
    return c.getContext('2d', { alpha: false });
  }

  async function render(spec) {
    await ensureFonts();
    const G = clampSpacing(spec && spec.spacing);
    const probe = probeContext();
    let markPad = 0;
    let markDrop = 0;
    let fit = fitSpec(probe, spec || {}, G, markPad, markDrop);
    const slack = 0;
    let laid = null;
    for (let i = 0; i < 20; i++) {
      laid = layout(probe, fit.spec, G, false, slack, markPad, markDrop);
      const hits = forbiddenOverlaps(laid.blocks);
      if (!hits.length) break;
      const markVsLabel = hits.some(([a, b]) => {
        const roles = a.role + ' ' + b.role;
        return roles.includes('mark') && (roles.includes('label'));
      });
      if (markVsLabel && markDrop < 40) {
        markDrop += 4;
        continue;
      }
      if (hits.some(([a, b]) => a.role === 'mark' || b.role === 'mark') && markPad < 64) {
        markPad += 8;
        fit = fitSpec(probe, spec || {}, G, markPad, markDrop);
        continue;
      }
      break;
    }
    assertLayout(laid.blocks);
    const H = Math.ceil(laid.height);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = CORNER;
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    roundPath(ctx, W, H, CORNER_R * W / 1080);
    ctx.clip();
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, W, H);
    const drawn = layout(ctx, fit.spec, G, true, slack, markPad, markDrop);
    ctx.restore();
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = CORNER;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    assertLayout(drawn.blocks);
    canvas.__rr = {
      width: W,
      height: H,
      quotes: (fit.spec.quotes || []).length,
      title_zh: fit.spec.title_zh || '',
      title_en: fit.spec.title_en || '',
      rawHeight: fit.rawHeight,
      droppedQuote: fit.dropped,
      markPad,
      markDrop,
      maxH: MAX_H,
      blocks: drawn.blocks,
    };
    return canvas;
  }

  window.RRCard = { ensureFonts, render, W, TARGET_H, MAX_H, SPACING };
})();
