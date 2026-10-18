/* Share card. Ports make_card.py: 1080-wide navy newspaper on cream,
   corners filled #111111 (WeChat paints transparent corners white).
   Fonts are self-hosted and must finish loading before any pixel is drawn. */
(function () {
  const S = 1.8;
  const W = Math.round(600 * S);
  const M = 36 * S;
  const BAR_H = 44;
  const CORNER_R = 40;
  const TARGET_H = 1690;
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

  function cwrap(ctx, text, font, width) {
    const m = String(text || '').match(/[：:]/);
    if (!m) return wrap(ctx, text, font, width);
    const at = m.index + m[0].length;
    const head = text.slice(0, at).trim();
    const tail = text.slice(at).trim();
    return wrap(ctx, head, font, width).concat(tail ? wrap(ctx, tail, font, width) : []);
  }

  function tracked(ctx, text, x, y, font, color, extra, draw) {
    ctx.font = font;
    ctx.fillStyle = color;
    let cx = x;
    for (const ch of text) {
      if (draw) ctx.fillText(ch, cx, y);
      cx += ctx.measureText(ch).width + extra;
    }
    return cx;
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

  /** Returns the content height. draw=false only measures. qScale shrinks the title and quotations when a long paper would pass 1690. */
  function layout(ctx, spec, G, draw, slack, qScale) {
    qScale = qScale || 1;
    ctx.textBaseline = 'top';
    let y = 0;
    const put = (x, text, font, color) => {
      ctx.font = font;
      if (draw) {
        ctx.fillStyle = color;
        ctx.fillText(text, x, y);
      }
    };

    if (draw) {
      ctx.fillStyle = NAVY;
      ctx.fillRect(0, 0, W, BAR_H * S);
      ctx.font = sans(15, true);
      ctx.fillStyle = PAPER;
      ctx.textBaseline = 'middle';
      ctx.fillText(spec.tag || '医学期刊 · 精选文章分享', M, BAR_H * S / 2);
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
      const mm = String(spec.date || '').match(/(\d{4})-(\d{2})-(\d{2})/);
      const parts = [];
      if (mm) parts.push(Number(mm[1]) + '年' + Number(mm[2]) + '月' + Number(mm[3]) + '日');
      if (spec.type_line) parts.push(spec.type_line);
      const txt = parts.join('  ·  ');
      ctx.font = serif(15, true);
      ctx.fillStyle = INK;
      ctx.textBaseline = 'middle';
      ctx.fillText(txt, M, (y0 + y1 + 4 * S) / 2);
      ctx.textBaseline = 'top';
    }
    y = (BAR_H + 16 + 33 + 48) * S;

    const typeLabel = spec.type || '';
    if (typeLabel) {
      ctx.font = sans(12, true);
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
        ctx.fillStyle = NAVY;
        ctx.font = sans(12, true);
        ctx.fillText(typeLabel, M + 10 * S, y + 3 * S);
      }
      y += 32 * S;
    }

    const zhFont = serif(30 * qScale, true);
    for (const line of cwrap(ctx, spec.title_zh || '', zhFont, W - 2 * M)) {
      put(M, line, zhFont, INK);
      y += G.title_zh_lh * S;
    }
    y += 6 * S;
    const enFont = source(17 * qScale, false);
    for (const line of cwrap(ctx, spec.title_en || '', enFont, W - 2 * M)) {
      put(M, line, enFont, GR);
      y += G.title_en_lh * S;
    }
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
    let x = tracked(ctx, jen, M, y, jFont, NAVY, 1.6 * S, draw);
    if (jzh) {
      let t = '  ·  ' + jzh;
      const fz = serif(14, true);
      ctx.font = fz;
      if (x + ctx.measureText(t).width > W - M) {
        y += 26 * S;
        x = M;
        t = jzh;
      }
      if (draw) {
        ctx.fillStyle = INK;
        ctx.font = fz;
        ctx.fillText(t, x, y + S);
      }
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
    if (draw) {
      const qe = 'FROM THE ARTICLE';
      const qz = '原文摘句';
      ctx.font = play(11, 600);
      ctx.fillStyle = GR;
      ctx.fillText(qe, M, y);
      const tw = ctx.measureText(qe).width;
      ctx.font = serif(13, true);
      ctx.fillStyle = NAVY;
      ctx.fillText(qz, M + tw + 10 * S, y - 2 * S);
    }
    y += G.label_h * S;

    const quotes = spec.quotes || [];
    for (let i = 0; i < quotes.length; i++) {
      const q = quotes[i];
      if (draw) {
        ctx.font = play(64 * qScale, 700);
        ctx.fillStyle = NAVY;
        ctx.fillText('“', M - 2 * S, y - 14 * S);
      }
      const qx = M + 34 * S;
      const qw = W - qx - M;
      const qen = source(17 * qScale, true);
      for (const line of wrap(ctx, q.en || '', qen, qw)) {
        put(qx, line, qen, INK);
        y += G.en_lh * S;
      }
      y += G.en_gap * S;
      const qzh = serif(14 * qScale, false);
      for (const line of wrap(ctx, q.zh || '', qzh, qw)) {
        put(qx, line, qzh, QZH);
        y += G.zh_lh * S;
      }
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
    put(M, '出处', serif(13, true), SRC);
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
    for (const row of srcLines) {
      for (const line of wrap(ctx, row, srcFont, tw)) {
        put(M, line, srcFont, GR);
        y += 18 * S;
      }
    }
    y += 8 * S;
    put(M, '扫码即读', sans(16, true), DK);
    if (draw) {
      ctx.font = sans(16, true);
      const scanW = ctx.measureText('扫码即读 ').width;
      ctx.font = sans(12, false);
      ctx.fillStyle = NAVY;
      ctx.fillText(spec.qr_note || '链接直达全文', M + scanW, y + 3 * S);
    }
    y += 24 * S;
    put(M, spec.qr_sub || '访问以机构订阅为准', sans(10, false), LG);
    y += 16 * S;
    if (draw) drawQr(ctx, spec.url || '', W - M - qs, fy + 4 * S, qs);
    y = Math.max(y, fy + qs + 4 * S) + (slack || 0) + 12 * S;
    if (draw) {
      ctx.fillStyle = NAVY;
      ctx.fillRect(0, y, W, 6 * S);
    }
    return y + 6 * S;
  }

  function measure(spec, G, slack, qScale) {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = 10;
    return layout(c.getContext('2d'), spec, G, false, slack, qScale);
  }

  async function render(spec) {
    await ensureFonts();
    const G = Object.assign({}, SPACING, spec.spacing || {});
    let qScale = 1;
    let h = measure(spec, G, 0, qScale);
    let guard = 0;
    while (h > TARGET_H && guard < 12) {
      guard++;
      for (const k of Object.keys(G)) G[k] *= 0.9;
      if (guard > 3) qScale *= 0.96;
      h = measure(spec, G, 0, qScale);
    }
    const slack = h < TARGET_H ? TARGET_H - h : 0;
    const H = Math.round(Math.min(h + slack, Math.max(h, TARGET_H)));
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = spec.corner_fill || '#111111';
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    roundPath(ctx, W, H, CORNER_R * W / 1080);
    ctx.clip();
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, W, H);
    layout(ctx, spec, G, true, slack, qScale);
    ctx.restore();
    return canvas;
  }

  window.RRCard = { ensureFonts, render, W, TARGET_H };
})();
