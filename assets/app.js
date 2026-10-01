/* ============================================================
   科研雷达 · Research Radar
   Live data: Europe PMC (journals) + follow-builders (AI builders)
   Zero build, zero backend, zero API keys.
   ============================================================ */
(() => {
'use strict';

/* ---------------- config ---------------- */
const EPMC   = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const FEED   = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/';
const DAYS   = 14;        // discovery window (abstracts lag 2-4 days)
const MAXJ   = 100;       // max articles pulled
const TTL    = 30 * 60e3; // cache freshness: 30 min
const LS_KEY = 'rr.cache.v1';

const DIRS = [
  { key:'ph',     zh:'肺动脉高压', ico:'🌬️',
    re:/pulmonary (arterial )?hypertension|pulmonary vascular resistance|pulmonary artery pressure|precapillary|pulmonary endarterectomy|right ventricular (failure|dysfunction)/i },
  { key:'aortic', zh:'主动脉夹层', ico:'🩺',
    re:/aortic dissection|aortic aneurysm|thoracic aortic|aortic root|aortopathy|tevar|evar|endovascular (aneurysm|aortic|repair)|type [ab] (aortic )?dissection|abdominal aortic|aortic (stent|repair)/i },
  { key:'hf',     zh:'心力衰竭', ico:'💜',
    re:/heart failure|hfpef|hfref|hfmref|cardiac failure|ventricular assist|lvad|ejection fraction|cardiac resynchroni|myocardial recovery|pulmonary oedema|pulmonary edema/i },
  { key:'htn',    zh:'高血压', ico:'🩸',
    re:/hypertension|blood pressure|antihypertensive|hypertensive|resistant hypertension|aldosterone|renin-angiotensin/i },
  { key:'icu',    zh:'重症医学', ico:'🚑',
    re:/sepsis|septic shock|critically ill|intensive care|mechanical ventilation|acute respiratory distress|\bards\b|extracorporeal|\becmo\b|vasopressor|delirium|acute kidney injury|organ (dys)?function|resuscitation|cardiac arrest|sedation|weaning|prone position/i },
  { key:'cvd',    zh:'心血管疾病', ico:'❤️',
    re:/coronary|myocardial infarction|percutaneous coronary|atrial fibrillation|valve|tavr|tavi|stent|atherosclerosis|arrhythmi|stroke|cardiac surgery|cabg|thrombectomy|transcatheter|cardiovascular|lipid|statin|cardiac magnetic/i },
];
const DIR_BY_KEY = Object.fromEntries(DIRS.map(d => [d.key, d]));
const GROUP_ZH = { top:'心血管疾病', cvd:'心血管疾病', hf:'心力衰竭', htn:'高血压',
                   aortic:'主动脉夹层', ph:'肺动脉高压', icu:'重症医学' };

/* ---------------- state ---------------- */
const S = {
  cfg: [], gloss: [],
  jr:  { all: [], byKey: {}, updated: null, loaded: false, error: null },
  ai:  { all: [], updated: null, loaded: false, error: null },
  jFilter: 'top',
  aFilter: 'all',
  tab: 'research',
};

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ---------------- utils ---------------- */
const iso = d => d.toISOString().slice(0, 10);
const esc = s => String(s ?? '');

function decodeEntities(s) {
  // Decode entities FIRST, then strip tags — Europe PMC double-encodes markup, so a
  // tag-strip before decoding leaves `&lt;sup&gt;` behind as a literal `<sup>`.
  let out = String(s || '');
  for (let pass = 0; pass < 2; pass++) {
    out = out
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
      .replace(/&amp;/g, '&');
    out = out.replace(/<[^>]*>/g, ' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

function relTime(input) {
  if (!input) return '';
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d)) return String(input).slice(0, 10);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60)    return '刚刚';
  if (s < 3600)  return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 172800) return '昨天';
  if (s < 604800) return `${Math.floor(s / 86400)} 天前`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
function fmtDate(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d)) return String(input || '—').slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function starTier(imp) {
  if (imp >= 30) return 5;
  if (imp >= 15) return 4;
  if (imp >= 8)  return 3;
  if (imp >= 4)  return 2;
  return 1;
}
function hueOf(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}
function initials(name) {
  const parts = String(name || '?').trim().split(/[\s_-]+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
function el(tag, cls, txt) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
}
function fetchJSON(url, ms = 30000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return fetch(url, { signal: ac.signal, cache: 'no-store' })
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .finally(() => clearTimeout(t));
}
async function fetchJSONRetry(url, tries = 3, ms = 30000) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fetchJSON(url, ms); }
    catch (e) { last = e; if (i < tries - 1) await new Promise(r => setTimeout(r, 900 * (i + 1))); }
  }
  throw last;
}

/* ---------------- classifier ---------------- */
/** Returns {dir, score}. dir is null when nothing matched; score 0 means no match. */
function classify(title, abstract, group) {
  const t = title || '', a = abstract || '';
  let best = null, bestScore = 0;
  for (const d of DIRS) {
    const tm = (t.match(new RegExp(d.re.source, 'gi')) || []).length;
    const am = (a.match(new RegExp(d.re.source, 'gi')) || []).length;
    const score = tm * 3 + Math.min(am, 6);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return { dir: best, score: bestScore };
}

/* ---------------- Europe PMC ---------------- */
const CHUNKS = 3;   // split the ISSN list so one high-volume journal can't flood the pool
const CAP_PER_JOURNAL = 8;

function epmcURLs(issns) {
  const hi = iso(new Date());
  const lo = iso(new Date(Date.now() - DAYS * 864e5));
  const step = Math.ceil(issns.length / CHUNKS);
  const urls = [];
  for (let i = 0; i < issns.length; i += step) {
    const slice = issns.slice(i, i + step);
    const q = `(${slice.map(x => `ISSN:"${x}"`).join(' OR ')}) AND SRC:MED `
            + `AND HAS_ABSTRACT:Y AND FIRST_PDATE:[${lo} TO ${hi}]`;
    const p = new URLSearchParams({
      query: q, format: 'json', pageSize: String(MAXJ),
      resultType: 'core', sort: 'P_PDATE_D desc',
    });
    urls.push(EPMC + '?' + p.toString());
  }
  return urls;
}

function balanceByJournal(items) {
  const per = {};
  return items.filter(a => (per[a.journal] = (per[a.journal] || 0) + 1) <= CAP_PER_JOURNAL);
}

function mapArticle(r) {
  const j = r.journalInfo?.journal || {};
  const issn = j.issn || j.essn || '';
  const meta = S.cfg.find(c => c.issn === issn)
            || S.cfg.find(c => c.issn === j.essn || c.issn === j.issn)
            || null;
  const journal = meta?.short || j.medlineAbbreviation || j.isoabbreviation || j.title || '—';
  const imp = meta?.if ?? 0;
  const group = meta?.group || 'cvd';
  const title = decodeEntities(r.title);
  const abstract = decodeEntities(r.abstractText);
  const cls = classify(title, abstract, group);

  // General medical journals (NEJM / Lancet / JAMA / BMJ / Nat Med) publish far beyond
  // cardiology — keep only articles that actually match one of the six directions.
  if (group === 'top' && cls.score === 0) return null;

  const dir = cls.dir || DIR_BY_KEY[GROUP_ZH[group]] || DIRS[5];
  const date = r.firstPublicationDate || r.electronicPublicationDate || r.dateOfCreation || '';
  return {
    id: r.doi || r.id || r.pmid,
    title,
    abstract,
    journal, imp, group,
    dir: dir.key, dirZh: dir.zh,
    stars: starTier(imp),
    date,
    ts: date ? Date.parse(date) : 0,
    year: r.pubYear || (date ? date.slice(0, 4) : ''),
    authors: decodeEntities(r.authorString || '').split(',')[0] || '',
    pmid: r.pmid || '',
    doi: r.doi || '',
    oa: !!r.isOpenAccess,
  };
}

async function loadResearch(force) {
  const c = readCache();
  if (!force && c.jr && Date.now() - c.jr.at < TTL) {
    S.jr = { ...S.jr, ...c.jr.data, loaded: true, fromCache: true };
    renderResearch();
    return;
  }
  if (!S.jr.loaded) { /* keep skeleton */ }
  try {
    const raws = await Promise.all(
      epmcURLs(S.cfg.map(x => x.issn)).map(u => fetchJSONRetry(u, 3, 35000))
    );
    const seen = new Set(), raw = [];
    for (const d of raws) {
      for (const r of (d.resultList?.result || [])) {
        const k = String(r.doi || r.id || r.pmid || '').toLowerCase();
        if (!k || seen.has(k)) continue;
        seen.add(k); raw.push(r);
      }
    }
    const items = balanceByJournal(
      raw.map(mapArticle).filter(x => x && x.title).sort((a, b) => b.ts - a.ts)
    );

    const byKey = {};
    for (const it of items) (byKey[it.dir] ||= []).push(it);

    S.jr = {
      all: items, byKey,
      updated: items.length ? items[0].date : null,
      loaded: true, error: null,
    };
    writeCache('jr', { all: items, byKey, updated: S.jr.updated });
  } catch (e) {
    console.warn('[research] live fetch failed:', e);
    if (!S.jr.loaded) {
      const snap = await trySnapshot('data/snapshot-journals.json');
      if (snap?.items?.length) {
        const byKey = {};
        for (const it of snap.items) (byKey[it.dir] ||= []).push(it);
        S.jr = { all: snap.items, byKey, updated: snap.updated, loaded: true, error: 'snapshot' };
      } else {
        S.jr = { ...S.jr, loaded: true, error: e.message };
      }
    }
  }
  renderResearch();
}

/* ---------------- follow-builders ---------------- */
function mapBuilderFeeds(x, blogs, pods) {
  const out = [];
  for (const b of (x?.x || [])) {
    for (const t of (b.tweets || [])) {
      out.push({
        type: 'x', kind: 'X 动态',
        name: b.name || b.handle, handle: b.handle || '',
        text: decodeEntities(t.text),
        ts: Date.parse(t.createdAt || '') || 0,
        date: t.createdAt || '',
        url: t.url || (b.handle ? `https://x.com/${b.handle}` : ''),
        likes: t.likes ?? 0, rt: t.retweets ?? 0, replies: t.replies ?? 0,
      });
    }
  }
  for (const b of (blogs?.blogs || [])) {
    out.push({
      type: 'blog', kind: '官方博客',
      name: b.name || 'Blog', handle: '',
      text: decodeEntities(b.description || b.content || '').slice(0, 1200),
      ts: Date.parse(b.publishedAt || '') || 0,
      date: b.publishedAt || '',
      url: b.url || '',
      title: decodeEntities(b.title || ''),
    });
  }
  for (const p of (pods?.podcasts || [])) {
    out.push({
      type: 'podcast', kind: '播客',
      name: p.name || p.show || 'Podcast', handle: '',
      text: decodeEntities(p.description || p.summary || ''),
      ts: Date.parse(p.publishedAt || p.date || '') || 0,
      date: p.publishedAt || p.date || '',
      url: p.url || '',
      title: decodeEntities(p.title || ''),
    });
  }
  return out.filter(o => o.text || o.title).sort((a, b) => b.ts - a.ts);
}

async function loadBuilders(force) {
  const c = readCache();
  if (!force && c.ai && Date.now() - c.ai.at < TTL) {
    S.ai = { ...S.ai, ...c.ai.data, loaded: true, fromCache: true };
    renderBuilders();
    return;
  }
  try {
    const [x, blogs, pods] = await Promise.all([
      fetchJSONRetry(FEED + 'feed-x.json', 3, 25000),
      fetchJSONRetry(FEED + 'feed-blogs.json', 2, 25000).catch(() => ({ blogs: [] })),
      fetchJSONRetry(FEED + 'feed-podcasts.json', 2, 25000).catch(() => ({ podcasts: [] })),
    ]);
    const items = mapBuilderFeeds(x, blogs, pods);
    S.ai = {
      all: items,
      updated: x?.generatedAt || items[0]?.date || null,
      loaded: true, error: null,
    };
    writeCache('ai', { all: items, updated: S.ai.updated });
  } catch (e) {
    console.warn('[builders] live fetch failed:', e);
    if (!S.ai.loaded) {
      const snap = await trySnapshot('data/snapshot-builders.json');
      if (snap?.items?.length) {
        S.ai = { all: snap.items, updated: snap.updated, loaded: true, error: 'snapshot' };
      } else {
        S.ai = { ...S.ai, loaded: true, error: e.message };
      }
    }
  }
  renderBuilders();
}

async function trySnapshot(path) {
  try { return await fetchJSON(path, 12000); } catch { return null; }
}

/* ---------------- cache ---------------- */
function readCache() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
}
function writeCache(slot, data) {
  try {
    const c = readCache();
    c[slot] = { at: Date.now(), data };
    localStorage.setItem(LS_KEY, JSON.stringify(c));
  } catch { /* quota / private mode - ignore */ }
}

/* ---------------- render: research ---------------- */
function chip(label, count, pressed, onClick, cls = '') {
  const b = el('button', 'chip' + (cls ? ' ' + cls : ''));
  b.type = 'button';
  b.setAttribute('aria-pressed', String(!!pressed));
  if (label.ico) b.append(el('span', 'ci', label.ico));
  b.append(document.createTextNode(label.text));
  if (count != null) b.append(el('span', 'cnt', `(${count})`));
  b.addEventListener('click', onClick);
  return b;
}

function renderResearch() {
  const host = $('#researchChips');
  const all = S.jr.all;
  const topCount = all.filter(a => a.imp >= 20).length;

  host.replaceChildren();
  host.append(
    chip({ ico:'🏆', text:'顶刊速递' }, topCount, S.jFilter === 'top', () => setJFilter('top')),
    chip({ ico:'🌐', text:'全部' }, all.length, S.jFilter === 'all', () => setJFilter('all')),
    chip({ ico:'📚', text:'专业词汇' }, S.gloss.length, false, openGlossary),
  );
  for (const d of DIRS) {
    const n = (S.jr.byKey[d.key] || []).length;
    host.append(chip({ ico:d.ico, text:d.zh }, n, S.jFilter === d.key, () => setJFilter(d.key)));
  }

  $('#litDate').textContent = S.jr.updated ? fmtDate(S.jr.updated) : '—';

  const list = filteredArticles();
  $('#researchHead').textContent = headLabel(list.length);
  renderArticleList($('#researchCards'), list);
}

function headLabel(n) {
  if (S.jFilter === 'top')   return `顶刊速递 ${n} 篇`;
  if (S.jFilter === 'all')   return `最新推送 ${n} 篇`;
  return `${DIR_BY_KEY[S.jFilter]?.zh || ''} ${n} 篇`;
}

function filteredArticles() {
  if (S.jFilter === 'all') return S.jr.all;
  if (S.jFilter === 'top') return S.jr.all.filter(a => a.imp >= 20);
  return S.jr.byKey[S.jFilter] || [];
}

function setJFilter(k) {
  S.jFilter = k;
  renderResearch();
  const sc = $('#scrollArea');
  const y = $('#researchChips').offsetTop;
  sc.scrollTo({ top: Math.max(0, y - 96), behavior: 'smooth' });
}

function starsNode(n) {
  const w = el('span', 'stars');
  for (let i = 1; i <= 5; i++) {
    const s = el('span', i <= n ? '' : 'off', '★');
    w.append(s);
  }
  return w;
}

function articleCard(a) {
  const c = el('article', 'card art');
  c.dataset.id = a.id;

  const top = el('div', 'art-top');
  const caret = el('span', 'caret');
  caret.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  top.append(caret, el('h3', 'art-title', a.title));

  const badges = el('div', 'art-badges');
  badges.append(el('span', 'badge dir dir-' + a.dir, a.dirZh));
  badges.append(el('span', 'badge jr', a.journal));
  badges.append(starsNode(a.stars));
  if (a.year) badges.append(el('span', 'yr', a.year));

  c.append(top, badges);

  let body = null;
  c.addEventListener('click', ev => {
    if (ev.target.closest('a')) return;
    const open = c.classList.toggle('open');
    if (open) {
      if (!body) {
        body = el('div', 'art-body');
        const p = el('p', 'art-abstract');
        p.append(...highlight(a.abstract || '（该记录暂无摘要）', a.dir));
        const meta = el('div', 'art-meta');
        if (a.authors) meta.append(el('span', '', '👤 ' + a.authors));
        if (a.date)    meta.append(el('span', '', '🗓 ' + a.date));
        if (a.imp)     meta.append(el('span', '', `⭐ IF ≈ ${a.imp}`));
        if (a.oa)      meta.append(el('span', '', '🔓 开放获取'));
        const links = el('div', 'art-links');
        if (a.doi)  links.append(link('https://doi.org/' + a.doi, 'DOI 全文', ''));
        if (a.pmid) links.append(link('https://pubmed.ncbi.nlm.nih.gov/' + a.pmid + '/', 'PubMed', 'alt'));
        body.append(p, meta, links);
      }
      c.append(body);
      requestAnimationFrame(() => c.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    } else if (body) {
      body.remove();
    }
  });
  return c;
}

function link(href, label, cls) {
  const a = el('a', 'lnk' + (cls ? ' ' + cls : ''), label + ' ↗');
  a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
  return a;
}

function highlight(text, dirKey) {
  const d = DIR_BY_KEY[dirKey];
  if (!d || !text) return [document.createTextNode(text || '')];
  const re = new RegExp('(' + d.re.source + ')', 'gi');
  const parts = String(text).split(re);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    out.push(i % 2 === 1 ? el('span', 'hl', parts[i]) : document.createTextNode(parts[i]));
  }
  return out.length ? out : [document.createTextNode(text)];
}

function renderArticleList(host, list) {
  host.replaceChildren();
  if (!S.jr.loaded) return;
  if (S.jr.error && !list.length) {
    host.append(emptyBox('📡', '数据暂时取不到',
      '网络或接口波动，稍后重试。也可以先看看缓存内容。', '重新加载', () => refresh(true)));
    return;
  }
  if (!list.length) {
    host.append(emptyBox('🔍', '这个方向今天还没有新文章',
      '摘要入库通常滞后 2–4 天。换个方向，或切换到「全部」看看。', null, null));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const a of list) frag.append(articleCard(a));
  host.append(frag);
}

function emptyBox(ico, title, desc, btn, onClick) {
  const b = el('div', 'empty');
  b.append(el('div', 'em-ico', ico), el('h4', '', title), el('p', '', desc));
  if (btn && onClick) {
    const bt = el('button', '', btn);
    bt.type = 'button';
    bt.addEventListener('click', onClick);
    b.append(bt);
  }
  return b;
}

/* ---------------- render: builders ---------------- */
function renderBuilders() {
  const host = $('#builderChips');
  const all = S.ai.all;
  const counts = { all: all.length, x: 0, blog: 0, podcast: 0 };
  for (const p of all) counts[p.type] = (counts[p.type] || 0) + 1;

  host.replaceChildren();
  host.append(
    chip({ ico:'🌐', text:'全部' }, counts.all, S.aFilter === 'all', () => setAFilter('all')),
    chip({ ico:'🐦', text:'X 动态' }, counts.x, S.aFilter === 'x', () => setAFilter('x')),
    chip({ ico:'📻', text:'播客' }, counts.podcast, S.aFilter === 'podcast', () => setAFilter('podcast')),
    chip({ ico:'📘', text:'官方博客' }, counts.blog, S.aFilter === 'blog', () => setAFilter('blog')),
  );

  // per-builder chips (top 8 by post count)
  const byHandle = {};
  for (const p of all) if (p.type === 'x' && p.handle) (byHandle[p.handle] ||= []).push(p);
  const top = Object.entries(byHandle).sort((a, b) => b[1].length - a[1].length).slice(0, 8);
  for (const [h, arr] of top) {
    host.append(chip({ text:'@' + h }, arr.length, S.aFilter === 'h:' + h,
      () => setAFilter('h:' + h)));
  }

  $('#aiDate').textContent = S.ai.updated ? fmtDate(S.ai.updated) : '—';

  const list = filteredPosts();
  $('#builderHead').textContent = S.aFilter.startsWith('h:')
    ? `@${S.aFilter.slice(2)} 的动态 ${list.length} 条`
    : `最新动态 ${list.length} 条`;
  renderPostList($('#builderCards'), list);
}

function filteredPosts() {
  if (S.aFilter === 'all') return S.ai.all;
  if (S.aFilter.startsWith('h:')) return S.ai.all.filter(p => p.handle === S.aFilter.slice(2));
  return S.ai.all.filter(p => p.type === S.aFilter);
}

function setAFilter(k) {
  S.aFilter = k;
  renderBuilders();
  const sc = $('#scrollArea');
  sc.scrollTo({ top: Math.max(0, $('#builderChips').offsetTop - 96), behavior: 'smooth' });
}

function postCard(p) {
  const c = el('article', 'card post');

  const top = el('div', 'post-top');
  const av = el('div', 'avatar', initials(p.name));
  const h = hueOf(p.handle || p.name || 'x');
  av.style.background = `linear-gradient(140deg, hsl(${h} 68% 58%), hsl(${(h + 38) % 360} 66% 46%))`;
  const who = el('div', 'who');
  who.append(el('div', 'nm', p.title || p.name));
  who.append(el('div', 'hd', (p.handle ? '@' + p.handle + ' · ' : '') + p.kind));
  top.append(av, who, el('span', 'post-time', relTime(p.date)));

  const txt = el('p', 'post-text clamp');
  txt.textContent = p.text;

  const foot = el('div', 'post-foot');
  if (p.type === 'x') {
    // ♥ / 💬 render as colour glyphs; the retweet arrow does not on Windows, so use RT.
    foot.append(
      el('span', 'm', '♥ ' + p.likes),
      el('span', 'm', 'RT ' + p.rt),
      el('span', 'm', '💬 ' + p.replies),
    );
  }
  if (p.url) {
    const a = el('a', 'go', '查看原文 ↗');
    a.href = p.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    foot.append(a);
  }

  c.append(top, txt, foot);

  if ((p.text || '').length > 220) {
    const more = el('button', 'post-more', '展开全文');
    more.type = 'button';
    more.addEventListener('click', () => {
      const clamped = txt.classList.toggle('clamp');
      more.textContent = clamped ? '展开全文' : '收起';
    });
    c.append(more);
  }
  return c;
}

function renderPostList(host, list) {
  host.replaceChildren();
  if (!S.ai.loaded) return;
  if (S.ai.error && !list.length) {
    host.append(emptyBox('📡', '资讯暂时取不到',
      '上游 feed 波动，稍后重试。', '重新加载', () => refresh(true)));
    return;
  }
  if (!list.length) {
    host.append(emptyBox('🌙', '这个筛选下暂时没有动态',
      '换个筛选，或稍后再来看看。', null, null));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const p of list) frag.append(postCard(p));
  host.append(frag);
}

/* ---------------- glossary ---------------- */
function openGlossary() {
  const sh = $('#glossSheet');
  sh.hidden = false;
  $('#glossSearch').value = '';
  renderGlossary('');
  setTimeout(() => $('#glossSearch').focus(), 320);
}
function closeGlossary() { $('#glossSheet').hidden = true; }

function renderGlossary(q) {
  const host = $('#glossList');
  const key = q.trim().toLowerCase();
  const list = key
    ? S.gloss.filter(g => (g.en + g.zh + g.def).toLowerCase().includes(key))
    : S.gloss;
  host.replaceChildren();
  if (!list.length) {
    host.append(emptyBox('🔍', '没有匹配的术语', '换个关键词试试。', null, null));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const g of list) {
    const d = el('div', 'gl');
    const head = el('div', '');
    head.append(el('span', 'gl-en', g.en), el('span', 'gl-zh', g.zh));
    d.append(head, el('p', 'gl-def', g.def));
    frag.append(d);
  }
  host.append(frag);
}

/* ---------------- tabs ---------------- */
function setTab(tab) {
  S.tab = tab;
  $$('.seg').forEach(b => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', String(on));
  });
  $('#segmented').dataset.i = tab === 'research' ? '0' : '1';
  $('#panel-research').hidden = tab !== 'research';
  $('#panel-builders').hidden = tab !== 'builders';
  $('#scrollArea').scrollTop = 0;

  const sub = tab === 'research'
    ? '顶刊速递 · 心血管 + 重症'
    : 'AI Builder · 一手动态';
  $('#brandSub').textContent = sub;

  if (tab === 'builders' && !S.ai.loaded) loadBuilders(false);
}

/* ---------------- refresh ---------------- */
async function refresh(force = true) {
  const btn = $('#refreshBtn');
  btn.classList.add('spin');
  toast('正在拉取最新数据…', 1600);
  try {
    await Promise.all([loadResearch(true), loadBuilders(true)]);
    const ok = (S.jr.all.length ? 1 : 0) + (S.ai.all.length ? 1 : 0);
    toast(ok === 2 ? '已更新到最新' : ok === 1 ? '部分数据已更新' : '暂时取不到数据，稍后重试');
  } catch {
    toast('刷新失败，请检查网络');
  } finally {
    btn.classList.remove('spin');
    stampFoot();
  }
}

function stampFoot() {
  $('#footTime').textContent = '更新于 ' + relTime(new Date());
}

/* ---------------- boot ---------------- */
window.__rr = S;   // debug hook for the QA harness

async function boot() {
  // instant paint from cache
  const c = readCache();
  if (c.jr?.data?.all?.length) { S.jr = { ...c.jr.data, loaded: true }; renderResearch(); }
  if (c.ai?.data?.all?.length) { S.ai = { ...c.ai.data, loaded: true }; renderBuilders(); }

  try {
    const [cfg, gloss] = await Promise.all([
      fetchJSON('data/journals.config.json', 15000),
      fetchJSON('data/glossary.json', 15000).catch(() => []),
    ]);
    S.cfg = cfg || [];
    S.gloss = gloss || [];
  } catch (e) {
    console.warn('[boot] config load failed:', e);
    S.cfg = []; S.gloss = [];
  }
  renderResearch();
  renderBuilders();

  await loadResearch(false);
  if (S.tab === 'builders') await loadBuilders(false);
  stampFoot();

  // background warm-up of the other tab
  setTimeout(() => { if (!S.ai.loaded) loadBuilders(false); }, 1200);

  // always re-validate in the background on open
  setTimeout(() => { loadResearch(true); loadBuilders(true); }, 2500);
}

/* ---------------- wire up ---------------- */
$$('.seg').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
$('#refreshBtn').addEventListener('click', () => refresh(true));
$('#glossSearch').addEventListener('input', e => renderGlossary(e.target.value));
$('#glossSheet').addEventListener('click', e => { if (e.target.closest('[data-close]')) closeGlossary(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeGlossary(); });

boot();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
})();
