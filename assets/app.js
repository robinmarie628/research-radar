/* ============================================================
   科研雷达 · Research Radar
   Live data: Europe PMC (journals) + Crossref (PII → ClinicalKey / ScienceDirect)
              + Crossref online dates & PubMed abstracts (最近一周)
              + follow-builders (AI builders)
   Zero build, zero API keys in the client.
   Favorites stay in localStorage. The 收藏 view downloads a Markdown file.
   Email Routing needs a custom domain, which this account does not have,
   so the page does not call /api/favorites or the Worker /favorites route.
   ============================================================ */
(() => {
'use strict';

const APP_VERSION = '2026.10.18.47';  // 改动前端资源时同步 bump（并同步 sw.js 的 V）

/* ---------------- endpoints / tuning ---------------- */
const EPMC     = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const CROSSREF = 'https://api.crossref.org/works';
const FEED     = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/';

/* 前端 → Cloudflare Worker → 触发 GitHub Actions 重新生成数据。
   部署好 Worker 后，把下面这个 URL 换成你自己的 *.workers.dev 地址
   （或绑定的自定义域名）。详见 research-radar/worker/README-deploy.md */
const WORKER_URL = 'https://research-radar-trigger.robinmarie628.workers.dev';
const DAYS     = 30;        // discovery window — abstracts lag 2–4 days, so never use 1
const MAXJ     = 100;       // Europe PMC page size (resultType=core). One page is not the pool.
const CHUNKS   = 3;         // ISSN slices. Each slice is paged until every journal has its cap.
const EPMC_PAGES = 15;      // 1500 core rows per slice — enough for the busiest third of the pool
/* 30 天池。旗舰 + 子刊合计按 7:3（FLAGSHIP_SHARE）。专科刊不进这个比例。
   每刊上限：旗舰 28、专科 6。子刊先保证领域保底（DOMAIN_FLOOR），
   保底之后再按影响因子轮流补到大约 30%。一个领域若窗口里不足 6 篇，就停在有的篇数。
   全池大约 300–400（POOL_MAX）。 */
const FLAGSHIP_CAP = 28;
const SUB_CAP = 3;
const SPECIALTY_CAP = 6;
const FLAGSHIP_SHARE = 0.7;
const DOMAIN_FLOOR = 6;
const POOL_MAX = 400;
function journalCap(meta) {
  // Subs may be fetched up to the domain floor. The 7:3 budget, not this
  // ceiling, is what leaves a typical companion journal at one or two papers.
  if (meta?.tier === 'flagship') return FLAGSHIP_CAP;
  if (meta?.tier === 'sub') return Math.max(SUB_CAP, DOMAIN_FLOOR);
  return SPECIALTY_CAP;
}
function articleTier(a) {
  return a?.tier === 'flagship' || a?.tier === 'sub' ? a.tier : 'specialty';
}
const PICK_N   = 8;         // 今日精选 size
const PICK_BASIC    = 4;    // …其中基础 / 分子医学
const PICK_CLINICAL = 4;    // …其中临床研究
const TTL      = 30 * 60e3; // cache freshness
const LS_KEY   = 'rr.cache.v5';  // v4 treated Europe PMC isOpenAccess "N" as open access
const SEEN_KEY = 'rr.seen.v1';
const FAV_KEY  = 'rr.fav.v1';
/* Crossref polite pool + NCBI identification. Browsers forbid a custom
 * User-Agent, so Crossref gets `mailto` and NCBI gets tool + email.
 * Not a secret; no API key. */
const API_MAIL = 'research-radar@users.noreply.github.com';
const EUTILS   = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
const WEEK_ABS_MIN = 40;
const NCBI_GAP_MS  = 400;

/* ---------------- 领域 (domain) ---------------- */
const DOMAIN_META = {
  '综合医学':   { ico:'🏥', hue:212, py:'zongheyixue' },
  '心血管':     { ico:'❤️', hue:352, py:'xinxueguan' },
  '呼吸与重症': { ico:'🌬️', hue:196, py:'huxiyuzhongzheng' },
  '肿瘤':       { ico:'🎗️', hue:330, py:'zhongliu' },
  '神经':       { ico:'🧠', hue:268, py:'shenjing' },
  '感染':       { ico:'🦠', hue:150, py:'ganran' },
  '血液':       { ico:'🩸', hue:0,   py:'xueye' },
  '内分泌代谢': { ico:'🧪', hue:36,  py:'neifenmidaxie' },
  '消化肝病':   { ico:'⚕️', hue:20,  py:'xiaohuaganbing' },
  '公共卫生':   { ico:'🌍', hue:172, py:'gonggongweisheng' },
  '眼科':       { ico:'👁️', hue:220, py:'yanke' },
  '儿科':       { ico:'🧒', hue:44,  py:'erke' },
  '精神心理':   { ico:'🧩', hue:288, py:'jingshenxinli' },
  '风湿免疫':   { ico:'🛡️', hue:186, py:'fengshimianyi' },
  '肾脏':       { ico:'💧', hue:206, py:'shenzang' },
  '皮肤':       { ico:'✋', hue:14,  py:'pifu' },
  '泌尿':       { ico:'🚹', hue:236, py:'miniao' },
  '血管外科':   { ico:'🦵', hue:256, py:'xueguanwaike' },
  '全球健康':   { ico:'🌏', hue:158, py:'quanqiujiankang' },
  '数字医疗':   { ico:'📱', hue:246, py:'shuziyiliao' },
  '老年医学':   { ico:'🧓', hue:30,  py:'laonianyixue' },
  '基础医学':   { ico:'🧬', hue:300, py:'jichuyixue' },
};
const DOMAIN_ORDER = Object.keys(DOMAIN_META).sort((a, b) => dmPy(a).localeCompare(dmPy(b)));
function dmPy(name) { return (DOMAIN_META[name] && DOMAIN_META[name].py) || name; }
const dm = d => DOMAIN_META[d] || { ico:'📄', hue:212 };

/* ---------------- 研究类型 (study design) ----------------
   pubTypes is useless (almost always just "Journal Article"), so the design has
   to be read out of the abstract text. Array order == priority.            */
const STUDY = [
  { key:'guideline', zh:'指南/共识', rank:6,
    re:/(clinical )?practice guideline|consensus (statement|document|recommendation)|expert consensus|society (guideline|recommendation)|guideline[- ]directed/i },
  // NB: a bare "meta-analys" is NOT enough — GWAS papers routinely report a "combined
  // meta-analysis" as a statistical step. Require meta-analysis to be the study design.
  { key:'meta', zh:'荟萃分析', rank:6,
    re:/systematic review and meta-analys|in this meta-analys|we (conducted|performed|did) a meta-analys|meta-analysis of \d|network meta-analys|individual participant data|pooled analysis of \d/i },
  { key:'gwas', zh:'遗传关联研究', rank:5,
    re:/genome[- ]wide association stud|(?<![A-Za-z])GWAS(?![A-Za-z])|mendelian randomi[sz]ation|exome[- ]wide association|polygenic (risk )?score/i },
  // target trial emulation uses observational data to mimic a trial — NOT an RCT
  { key:'emulation', zh:'目标试验模拟', rank:4,
    re:/target trial emulation|emulat(e|ing|ed) a (pragmatic |hypothetical )?target trial/i },
  { key:'rct', zh:'随机对照试验', rank:6,
    re:/randomi[sz]ed (controlled |clinical |placebo[- ]controlled )?(trial|study)|randomly (assigned|allocated)|double[- ]blind|placebo[- ]controlled|1:1 (ratio )?randomi/i },
  { key:'gdb', zh:'疾病负担分析', rank:5,
    re:/global burden of disease|global, regional, and national (burden|prevalence|estimates)|disability[- ]adjusted life|\bdalys?\b/i },
  { key:'multicenter', zh:'多中心研究', rank:5,
    re:/multicent(er|re)|multinational|multisite|\d+ (sites|centres|centers|hospitals) (in|across)|across \d+ countries/i },
  { key:'cohort', zh:'前瞻队列', rank:5,
    re:/prospective (cohort|observational|population|registry|study)|population[- ]based cohort|nationwide (cohort|register)|longitudinal (cohort|study)|community[- ]based cohort/i },
  { key:'registry', zh:'注册研究', rank:4,
    re:/\bregistry\b|real[- ]world (evidence|data|cohort)|nationwide (register|database)/i },
  { key:'basic', zh:'基础研究', rank:4,
    re:/\bmice\b|\bmurine\b|\brats?\b|in vitro|in vivo|knockout|organoid|single[- ]cell (rna|sequencing|transcriptom)|transcriptom|CRISPR|western blot|cryo-?EM|xenograft|cell line/i },
  { key:'casecontrol', zh:'病例对照', rank:3,
    re:/case[- ]control|nested case[- ]control/i },
  { key:'retrospective', zh:'回顾性研究', rank:3,
    re:/retrospective (cohort|study|analysis|review)|chart review|medical records/i },
  { key:'review', zh:'综述', rank:2,
    re:/this review|we review|narrative review|state[- ]of[- ]the[- ]art review|review (summari[sz]es|discusses|highlights)|in this (review|overview)|scoping review/i },
  { key:'editorial', zh:'评论/社论', rank:1,
    re:/this (editorial|commentary|viewpoint)|we (argue|contend) that/i },
];
const STUDY_BY_KEY = Object.fromEntries(STUDY.map(s => [s.key, s]));
const STUDY_OTHER = { key:'other', zh:'研究论文', rank:3 };
const STUDY_LABELS = new Set(STUDY.map(s => s.zh).concat([STUDY_OTHER.zh]));
/** Chinese titles do not take a closing full stop. Same rule as stripTitleStop in mt.js. */
function stripTitleStop(text) {
  const s = String(text || '').trim();
  if (!/[\u4e00-\u9fff]/.test(s)) return s;
  return s.replace(/(?:\s*[.。])+\s*$/g, '').trim();
}
/** Drop a trailing （journal，domain，study type） left by the old digest prompt.
 *  Parentheses that belong to the translation, such as （ASCVD）, stay. */
function stripTitleMeta(text) {
  let s = stripTitleStop(text);
  const m = s.match(/(?:（|\()([^（）()]*)[，,]([^（）()]*)[，,]([^（）()]*)(?:）|\))\s*$/);
  if (!m) return s;
  const journal = m[1].trim();
  const domain = m[2].trim();
  const kind = m[3].trim();
  const journalOk = /^[A-Za-z0-9][A-Za-z0-9 .:&/+-]{0,48}$/.test(journal);
  const domainOk = /^[\u4e00-\u9fff]{2,8}(?:与[\u4e00-\u9fff]{1,6})?$/.test(domain);
  if (journalOk && domainOk && STUDY_LABELS.has(kind)) return stripTitleStop(s.slice(0, m.index));
  return s;
}
/**
 * Same rule as preserveTitleContrast in functions/_lib/mt.js.
 * A shortened colon clause must keep delayed / prompt / early / late initiation.
 */
function preserveTitleContrast(en, zh) {
  const TITLE_TIMING = [
    { re: /\bdelayed\b/i, zh: ['延迟', '推迟', '延后'], gloss: '延迟' },
    { re: /\bprompt\b/i, zh: ['及时', '即刻'], gloss: '及时' },
    { re: /\bearly(?![- ]onset)\b/i, zh: ['早期', '提早', '提前'], gloss: '早期' },
    { re: /\blate\b/i, zh: ['晚期'], gloss: '晚期' },
    { re: /\bimmediate\b/i, zh: ['立即', '即刻', '及时'], gloss: '立即' },
  ];
  const out = stripTitleStop(zh);
  if (!out || !/[\u4e00-\u9fff]/.test(out)) return out;
  const src = String(en || '').replace(/\s+/g, ' ').trim();
  const cut = src.search(/[：:]/);
  if (cut < 2) return out;
  const tail = src.slice(cut + 1).trim().replace(/[.。\s]+$/g, '');
  const hits = TITLE_TIMING.filter(t => t.re.test(tail));
  if (!hits.length || !/\b(treatment|therapy|initiation|initiating)\b/i.test(tail)) return out;
  const initiation = /\binitiat/i.test(tail);
  const treatment = /\b(treatment|therapy)\b/i.test(tail);
  let core = '';
  if (hits.length === 1 && hits[0].gloss === '延迟' && treatment && initiation) core = '延迟治疗启动';
  else if (hits.length === 1 && treatment && initiation) core = hits[0].gloss + '开始治疗';
  else if (treatment && initiation) core = hits.map(h => h.gloss).join('与') + '开始治疗';
  else if (initiation) core = hits.map(h => h.gloss).join('与') + '启动';
  else if (treatment) core = hits.map(h => h.gloss).join('与') + '治疗';
  else core = hits.map(h => h.gloss).join('与');
  const gloss = /^\s*impact\s+of\s+/i.test(tail) ? core + '的影响' : core;
  const idx = Math.max(out.lastIndexOf('：'), out.lastIndexOf(':'));
  const scope = idx >= 0 ? out.slice(idx + 1) : out;
  if (hits.every(h => h.zh.some(w => scope.includes(w)))) return out;
  if (idx >= 0) return stripTitleStop(out.slice(0, idx) + '：' + gloss);
  return stripTitleStop(out + '：' + gloss);
}

/* ---------------- abstract section headings ----------------
   Europe PMC returns real structure: <h4>Background</h4>…<h4>Results</h4>…
   Mapped onto the prompt's 目的 / 方法 / 结果 / 结论.                        */
const SEC_HEAD = [
  ['objective', /^(background|objectives?|aims?|purpose|research question|rationale|introduction|importance|context|question|hypothesis|why (did|do) we|what is known|unmet need|significance of this study|summary|overview|topic|topic importance|impact and implications)/i],
  ['methods',   /^(methods?|materials and methods|study design|design|patients and methods|setting|approach|experimental approach|patients|participants|subjects?|data sources|study selection|study population|exposure|interventions?|procedures?|measurements?|main outcomes? (and )?measures?|outcomes? and measures|data collection|statistical analysis|study (design|population|setting|sample)|structure)/i],
  ['results',   /^(results?|findings|main results|results? and discussion|measurements? and main results?|outcomes?|analysis|key results|review findings)/i],
  ['conclusion',/^(conclusions?|interpretation|discussion|significance|outlook|perspectives?|implications?|meaning|conclusions? and relevance|clinical (implications?|relevance)|future (directions|perspectives)|concluding remarks|translations?)/i],
];
const SEC_SKIP = /^(clinical trial registration|trial registration|registration|funding|systematic review registration|conflict of interest|declarations? of interest|financial disclosure|transparency|author contributions?|copyright|data (availability|sharing)|acknowledg|supplementary|ethics|role of the funding|abbreviations)/i;
const SEC_LABEL = { objective:'目的', methods:'方法', results:'结果', conclusion:'结论' };

/** 通俗版摘要的五个字段（由每日 LLM digest 生成），按此顺序展示 */
const DIGEST_FIELDS = [
  ['background', '背景'],
  ['methods',    '怎么做'],
  ['innovation', '创新点'],
  ['takeaway',   '看点'],
  ['future',     '未来方向'],
];

/** pubTypes is usually just ["Journal Article"], but when a journal does supply real
 *  design tags they are authoritative — so check them before reading the text. */
const PT_STRONG = [
  [/Randomized Controlled Trial|Clinical Trial, Phase (II|III|IV)/i, 'rct'],
  [/Practice Guideline|Guideline/i, 'guideline'],
  [/Meta-Analysis/i, 'meta'],
  [/Multicenter Study/i, 'multicenter'],
];

/* ---------------- state ---------------- */
const S = {
  cfg: [], gloss: [], domains: [],
  jr: { all: [], picks: [], byKey: {}, updated: null, loaded: false, error: null },
  week: { items: [], loaded: false, loading: false, error: '' },
  ai: { all: [], updated: null, loaded: false, error: null },
  digest: { date: null, items: [], byDoi: new Map(), loaded: false },
  bd: { date: null, headline: '', bullets: [], sentiment: '', byId: new Map(), loaded: false },
  jFilter: 'pick',
  jView: 'card',
  q: '',
  domainsOpen: false,
  aFilter: 'all',
  seen: new Set(),
  fav: { order: [], items: {} },
  tab: 'research',
  /* Machine-translated titles. Seed + localStorage, then /api/translate. */
  mt: { seeded: false, byDoi: new Map(), byNorm: new Map(), local: new Map(), stop: '' },
};

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ---------------- utils ---------------- */
const iso = d => d.toISOString().slice(0, 10);

/** Decode entities FIRST, then strip tags — Europe PMC double-encodes markup, so a
 *  tag-strip before decoding leaves `&lt;sup&gt;` behind as a literal `<sup>`. */
function cleanText(s) {
  let out = String(s || '');
  for (let p = 0; p < 2; p++) {
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

/** Parse a structured abstract into 目的/方法/结果/结论. Runs on the RAW text
 *  (before tag-stripping) because the headings ARE the tags. */
function parseAbstract(raw) {
  const text = String(raw || '');
  const headRe = /<(h[1-6]|b|strong)>([^<]{2,60}?)<\/\1>/gi;
  const marks = [];
  let m;
  while ((m = headRe.exec(text))) {
    const label = m[2].replace(/[:\s]+$/, '').trim();
    const known = SEC_HEAD.some(([, re]) => re.test(label)) || SEC_SKIP.test(label);
    if (known) marks.push({ label, start: m.index, end: headRe.lastIndex });
  }
  if (!marks.length) return { structured: false, sections: null, text: cleanText(text) };

  const acc = { objective: [], methods: [], results: [], conclusion: [], other: [] };
  if (marks[0].start > 0) {
    const lead = cleanText(text.slice(0, marks[0].start));
    if (lead) acc.other.push(lead);
  }
  for (let i = 0; i < marks.length; i++) {
    const body = text.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].start : text.length);
    const label = marks[i].label;
    if (SEC_SKIP.test(label)) continue;
    let slot = 'other';
    for (const [key, re] of SEC_HEAD) if (re.test(label)) { slot = key; break; }
    const c = cleanText(body);
    if (c) acc[slot].push(c);
  }
  const sections = {};
  for (const k of Object.keys(acc)) sections[k] = acc[k].join(' ').trim();

  if (!sections.objective && !sections.methods && !sections.results && !sections.conclusion) {
    return { structured: false, sections: null, text: cleanText(text) };
  }
  return { structured: true, sections, text: '' };
}

function detectStudy(title, abstract, isBasic, pubTypes) {
  const t = ((title || '') + ' ' + (abstract || '')).slice(0, 5000);
  const pt = (pubTypes || []).join(' | ');
  if (isBasic) {
    const rv = STUDY.find(s => s.key === 'review');
    return (rv.re.test(t) || /\bReview\b/i.test(pt)) ? rv : STUDY_BY_KEY.basic;
  }
  for (const [re, key] of PT_STRONG) if (re.test(pt)) return STUDY_BY_KEY[key];
  for (const s of STUDY) if (s.re.test(t)) return s;
  if (/\bReview\b/i.test(pt)) return STUDY_BY_KEY.review;
  return STUDY_OTHER;
}

function relTime(input) {
  if (!input) return '';
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d)) return String(input).slice(0, 10);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60)     return '刚刚';
  if (s < 3600)   return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400)  return `${Math.floor(s / 3600)} 小时前`;
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
function initials(name) {
  const p = String(name || '?').trim().split(/[\s_-]+/).filter(Boolean);
  if (!p.length) return '?';
  if (p.length === 1) return p[0].slice(0, 2).toUpperCase();
  return (p[0][0] + p[1][0]).toUpperCase();
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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
/** One retry for 429/5xx. A 404 (unknown ISSN) is not worth three attempts. */
async function fetchJSONSoft(url, ms = 20000) {
  try { return await fetchJSON(url, ms); }
  catch (e) {
    if (/HTTP 4/.test(String(e && e.message)) && !/HTTP 429/.test(String(e && e.message))) throw e;
    await sleep(800);
    return await fetchJSON(url, ms);
  }
}
async function fetchText(url, ms = 25000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}
async function fetchTextRetry(url, tries = 2, ms = 25000) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fetchText(url, ms); }
    catch (e) { last = e; if (i < tries - 1) await sleep(1000 * (i + 1)); }
  }
  throw last;
}

/* ---------------- seen / 去重 ---------------- */
function readSeen() { try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); } catch { return new Set(); } }
function writeSeen() {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...S.seen].slice(-3000))); } catch { /* ignore */ }
}
function markSeen(a) {
  if (!a || !a.id || S.seen.has(a.id)) return;
  S.seen.add(a.id);
  writeSeen();
  bumpUnread();
}
function bumpUnread() {
  const chip = $('#researchChips .chip[data-k="unread"]');
  if (!chip) return;
  const n = S.jr.all.filter(a => !S.seen.has(a.id)).length;
  const c = chip.querySelector('.cnt');
  if (c) c.textContent = `(${n})`;
}

/* ---------------- favorites / 小红心 ----------------
   Local only. The key is the lowercased DOI when one exists, else the
   article id, so a paper stays favorited after it leaves the 30-day pool.
   A small snapshot keeps the 收藏 list readable in that case. */
function readFav() {
  try {
    const raw = JSON.parse(localStorage.getItem(FAV_KEY) || 'null');
    if (Array.isArray(raw)) return { order: raw.map(k => String(k).toLowerCase()).filter(Boolean), items: {} };
    const order = Array.isArray(raw?.order) ? raw.order.map(k => String(k).toLowerCase()).filter(Boolean) : [];
    const items = raw?.items && typeof raw.items === 'object' ? raw.items : {};
    return { order, items };
  } catch { return { order: [], items: {} }; }
}
function writeFav() {
  try { localStorage.setItem(FAV_KEY, JSON.stringify({ order: S.fav.order, items: S.fav.items })); }
  catch { /* quota / private mode */ }
}
function favKey(a) {
  return String(a?.doi || a?.id || '').trim().toLowerCase();
}
function favTitle(a) {
  const zh = stripTitleMeta((a?.digest && a.digest.titleZh) || a?.titleZh || '');
  return String(zh || a?.title || '未命名').trim();
}
function favAbstract(a) {
  const direct = String(a?.abstract || '').trim();
  if (direct) return direct;
  const sec = a?.sections;
  if (!sec) return '';
  return ['objective', 'methods', 'results', 'conclusion', 'other']
    .map(k => String(sec[k] || '').trim())
    .filter(Boolean)
    .join('\n\n');
}
function favSnapshot(a) {
  const k = favKey(a);
  return {
    id: a.id || k,
    doi: a.doi || (k.startsWith('10.') ? k : ''),
    title: a.title || '',
    titleZh: stripTitleMeta((a.digest && a.digest.titleZh) || ''),
    abstract: favAbstract(a).slice(0, 12000),
    journal: a.journal || '',
    domain: a.domain || '',
    studyKey: a.studyKey || 'other',
    studyZh: a.studyZh || '',
    basic: !!a.basic,
    stars: a.stars || 0,
    year: a.year || '',
    date: a.date || '',
    pmid: a.pmid || '',
    authorCite: Array.isArray(a.authorCite) ? a.authorCite.slice(0, 24) : [],
    volume: a.volume || '',
    issue: a.issue || '',
    pages: a.pages || '',
    oa: !!a.oa,
    issn: a.issn || '',
    platforms: Array.isArray(a.platforms) ? a.platforms.slice() : [],
    pii: a.pii || '',
  };
}
function articleFromFavSnap(snap, key) {
  const doi = snap.doi || (String(key).startsWith('10.') ? key : '');
  return {
    id: snap.id || key,
    doi,
    title: snap.title || '',
    abstract: snap.abstract || '',
    sections: null,
    structured: false,
    journal: snap.journal || '—',
    platforms: Array.isArray(snap.platforms) ? snap.platforms.slice() : [],
    domain: snap.domain || '',
    basic: !!snap.basic,
    studyKey: snap.studyKey || 'other',
    studyZh: snap.studyZh || '',
    stars: snap.stars || 0,
    year: snap.year || '',
    date: snap.date || '',
    pmid: snap.pmid || '',
    authorCite: Array.isArray(snap.authorCite) ? snap.authorCite : [],
    volume: snap.volume || '',
    issue: snap.issue || '',
    pages: snap.pages || '',
    oa: !!snap.oa,
    issn: snap.issn || '',
    keywords: [],
    digest: snap.titleZh ? { titleZh: stripTitleMeta(snap.titleZh) } : null,
    pii: snap.pii || undefined,
  };
}
function articleIndex() {
  const map = new Map();
  const add = a => {
    const k = favKey(a);
    if (k && !map.has(k)) map.set(k, a);
  };
  for (const a of S.jr.all || []) add(a);
  for (const a of S.jr.picks || []) add(a);
  for (const a of (S.week && S.week.items) || []) add(a);
  return map;
}
function favoriteArticles() {
  const pool = articleIndex();
  const out = [];
  let dirty = false;
  for (const k of S.fav.order) {
    const live = pool.get(k);
    if (live) {
      const abs = favAbstract(live);
      const snap = S.fav.items[k];
      if (snap && abs && !snap.abstract) {
        snap.abstract = abs.slice(0, 12000);
        dirty = true;
      }
      out.push(live);
      continue;
    }
    const snap = S.fav.items[k];
    if (snap) out.push(articleFromFavSnap(snap, k));
  }
  if (dirty) writeFav();
  return out;
}
function paintFavChrome(key) {
  const on = S.fav.order.includes(key);
  for (const b of document.querySelectorAll('.fav-btn')) {
    if ((b.dataset.fav || '') !== key) continue;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', on ? '取消收藏' : '收藏');
  }
  const cnt = document.querySelector('#researchChips .chip[data-k="fav"] .cnt');
  if (cnt) cnt.textContent = `(${S.fav.order.length})`;
}
function toggleFav(a) {
  const k = favKey(a);
  if (!k) { toast('这篇文章缺少稳定编号，暂时无法收藏'); return; }
  const idx = S.fav.order.indexOf(k);
  if (idx >= 0) {
    S.fav.order.splice(idx, 1);
    delete S.fav.items[k];
    toast('已取消收藏');
  } else {
    S.fav.order.unshift(k);
    S.fav.items[k] = favSnapshot(a);
    if (S.fav.order.length > 200) {
      const drop = S.fav.order.pop();
      if (drop) delete S.fav.items[drop];
    }
    toast('已加入收藏');
  }
  writeFav();
  if (S.jFilter === 'fav' && !searchQuery()) renderResearch();
  else paintFavChrome(k);
}
function favButton(a) {
  const k = favKey(a);
  const on = !!(k && S.fav.order.includes(k));
  const b = el('button', 'fav-btn' + (on ? ' is-on' : ''));
  b.type = 'button';
  if (k) b.dataset.fav = k;
  b.setAttribute('aria-pressed', String(on));
  b.setAttribute('aria-label', on ? '取消收藏' : '收藏');
  b.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 19.2C12 19.2 5.2 15.2 5.2 10.6 5.2 8.1 7.1 6.5 9.4 6.5c1.3 0 2.3.7 2.6 1.6.3-.9 1.3-1.6 2.6-1.6 2.3 0 4.2 1.6 4.2 4.1 0 4.6-6.8 8.6-6.8 8.6z"/></svg>';
  if (!k) b.disabled = true;
  b.addEventListener('click', ev => {
    ev.preventDefault();
    ev.stopPropagation();
    toggleFav(a);
  });
  return b;
}
function syncFavHash() {
  const url = new URL(location.href);
  const want = S.jFilter === 'fav';
  if (want) url.hash = 'fav';
  else if (url.hash === '#fav') url.hash = '';
  else return;
  if (url.href !== location.href) history.replaceState(null, '', url);
}

/* ---------------- Europe PMC ---------------- */
function cfgByIssn(value) {
  if (!value || !S.cfg?.length) return null;
  return S.cfg.find(c => c.issn === value || c.essn === value) || null;
}
/** Config row for a Europe PMC record, whether the hit is filed under issn or essn. */
function metaForEpmc(r) {
  const j = r?.journalInfo?.journal || {};
  const fromJournal = cfgByIssn(j.issn) || cfgByIssn(j.essn);
  if (fromJournal) return fromJournal;
  const parts = String(r?.journalIssn || '').split(/[;,]/).map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    const hit = cfgByIssn(part);
    if (hit) return hit;
  }
  return null;
}
function epmcSlices(cfg) {
  const rows = (cfg || []).filter(c => c && c.issn);
  const step = Math.max(1, Math.ceil(rows.length / CHUNKS));
  const slices = [];
  for (let i = 0; i < rows.length; i += step) slices.push(rows.slice(i, i + step));
  return slices;
}
function epmcWindow() {
  return {
    hi: iso(new Date()),
    lo: iso(new Date(Date.now() - DAYS * 864e5)),
  };
}
/** Page one ISSN slice until every journal has its tier cap, or the cursor ends. */
async function fetchEpmcChunk(slice) {
  const { lo, hi } = epmcWindow();
  const issns = [];
  for (const m of slice) {
    for (const id of [m.issn, m.essn]) {
      if (id && !issns.includes(id)) issns.push(id);
    }
  }
  const q = `(${issns.map(x => `ISSN:"${x}"`).join(' OR ')}) AND SRC:MED `
          + `AND HAS_ABSTRACT:Y AND FIRST_PDATE:[${lo} TO ${hi}]`;
  const out = [];
  const seen = new Set();
  const counts = {};
  let cursor = '*';
  for (let page = 0; page < EPMC_PAGES; page++) {
    const url = EPMC + '?' + new URLSearchParams({
      query: q, format: 'json', pageSize: String(MAXJ),
      resultType: 'core', sort: 'P_PDATE_D desc', cursorMark: cursor,
    });
    const d = await fetchJSONRetry(url, 3, 35000);
    const rows = d?.resultList?.result || [];
    if (!rows.length) break;
    for (const r of rows) {
      const meta = metaForEpmc(r);
      const key = String(r.doi || r.id || r.pmid || '').toLowerCase();
      if (!meta || !key || seen.has(key)) continue;
      const bucket = meta.issn;
      if ((counts[bucket] || 0) >= journalCap(meta)) continue;
      seen.add(key);
      counts[bucket] = (counts[bucket] || 0) + 1;
      out.push(r);
    }
    if (slice.every(m => (counts[m.issn] || 0) >= journalCap(m))) break;
    const next = d.nextCursorMark;
    if (!next || next === cursor) break;
    cursor = next;
    await sleep(200);
  }
  return out;
}
async function fetchEpmcPool(cfg) {
  const slices = epmcSlices(cfg);
  const parts = await Promise.all(slices.map(async slice => {
    try { return await fetchEpmcChunk(slice); }
    catch (e) {
      console.warn('[epmc]', e.message || e);
      return null;
    }
  }));
  if (!parts.length || parts.every(p => p == null)) throw new Error('Europe PMC 暂时不可用');
  return parts.filter(Boolean);
}

function asList(x) { return x == null ? [] : (Array.isArray(x) ? x : [x]); }
function citeInitials(given) {
  const s = String(given || '').replace(/\./g, '').trim();
  if (!s) return '';
  if (/^[A-Z]{1,4}$/.test(s)) return s;
  return s.split(/[\s-]+/).filter(Boolean).map(p => p[0] || '').join('').toUpperCase();
}
function citePerson(family, given) {
  const last = String(family || '').trim();
  const ini = citeInitials(given);
  if (last && ini) return last + ' ' + ini;
  return last || ini;
}
function epmcAuthorCite(r) {
  const names = [];
  for (const a of asList(r?.authorList?.author)) {
    const n = citePerson(a.lastName, a.initials || a.firstName);
    if (n) names.push(n);
    else if (a.fullName) names.push(String(a.fullName).replace(/\s+/g, ' ').trim());
  }
  if (names.length) return names;
  return String(r?.authorString || '').split(/,\s*/).map(s => s.replace(/\.$/, '').trim()).filter(Boolean);
}
function crossrefAuthorCite(authors) {
  const names = [];
  for (const au of authors || []) {
    const n = citePerson(au.family, au.given) || String(au.name || '').trim();
    if (n) names.push(n);
  }
  return names;
}

function isOpenAccessFlag(v) {
  if (v === true || v === 1) return true;
  const s = String(v == null ? '' : v).trim().toUpperCase();
  return s === 'Y' || s === 'TRUE' || s === '1';
}
function licenseBlob(license) {
  return Array.isArray(license)
    ? license.map(x => String((x && (x.URL || x.url)) || x || '')).join(' ')
    : String(license || '');
}
function licenseIsOpen(license) {
  return /creativecommons\.org\/licenses\/(?:by|cc0)\b/i.test(licenseBlob(license));
}
/** "CC BY-NC-ND 4.0" from a Creative Commons license URL. */
function licenseName(license) {
  const m = licenseBlob(license).match(/creativecommons\.org\/licenses\/(by(?:-[a-z]{2,3}){0,3}|cc0)\/(\d+(?:\.\d+)?)/i);
  if (!m) return '';
  if (m[1].toLowerCase() === 'cc0') return 'CC0 ' + m[2];
  return 'CC ' + m[1].toUpperCase() + ' ' + m[2];
}
/** Online-first when Crossref records a published-online date, or a day-level created date against a month-only print date. */
function publishedOnline(msg) {
  if (msg?.['published-online']?.['date-parts']?.[0]?.length) return true;
  const print = (msg?.['published-print'] || msg?.issued || {})['date-parts']?.[0] || [];
  const created = msg?.created?.['date-parts']?.[0] || [];
  return print.length > 0 && print.length < 3 && created.length >= 3;
}
/** Keep a volume only when the sources agree and it looks like a journal volume. */
function reliableVolume(current, other) {
  const ok = v => /^\d{1,4}[A-Za-z]?$/.test(String(v || '').trim());
  const c = String(current || '').trim();
  if (arguments.length < 2) return ok(c) ? c : '';
  const o = String(other || '').trim();
  if (c && o && c !== o) return '';
  const v = c || o;
  return ok(v) ? v : '';
}
/** Page labels such as 1455-1472 or e100739. A DOI or PII is not a page range. */
function reliablePages(p) {
  const s = String(p || '').trim().replace(/\s+/g, '');
  return /^(?:e\d+|\d+(?:[–—-]\d+)?(?:\.e\d+)?)$/i.test(s) ? s : '';
}
async function publisherRecord(a) {
  if (a && a._pub) return a._pub;
  const doi = String(a?.doi || '').trim();
  if (!/^10\.\d{4,}\//.test(doi)) return null;
  try {
    const res = await fetch(CROSSREF + '/' + encodeURIComponent(doi));
    if (!res.ok) return null;
    const msg = (await res.json())?.message || {};
    const licensed = Array.isArray(msg.license) ? msg.license.length > 0 : !!msg.license;
    const pub = {
      oa: licenseIsOpen(msg.license) || (!licensed && isOpenAccessFlag(a?.oa)),
      volume: msg.volume || '',
      pages: msg.page || '',
      issue: msg.issue || '',
      licenseLabel: licenseName(msg.license),
      publishedOnline: publishedOnline(msg),
    };
    if (a) a._pub = pub;
    return pub;
  } catch {
    return null;
  }
}

function mapArticle(r) {
  const j = r.journalInfo?.journal || {};
  const meta = metaForEpmc(r);
  const issn = meta?.issn || j.issn || j.essn || '';
  const title = cleanText(r.title);
  if (!title) return null;

  const parsed = parseAbstract(r.abstractText);
  const isBasic = !!(meta && meta.basic);
  const study = detectStudy(title, parsed.text || (parsed.sections
    ? Object.values(parsed.sections).join(' ') : ''), isBasic,
    r.pubTypeList?.pubType || []);
  const date = r.firstPublicationDate || r.electronicPublicationDate || r.dateOfCreation || '';

  return {
    id: (r.doi || r.id || r.pmid || '').toLowerCase(),
    title,
    abstract: parsed.text,
    sections: parsed.sections,
    structured: parsed.structured,
    journal: meta?.short || j.medlineAbbreviation || j.isoabbreviation || '—',
    issn: meta?.issn || issn,
    platforms: Array.isArray(meta?.platforms) ? meta.platforms.slice() : [],
    domain: meta?.domain || '综合医学',
    tier: meta?.tier || 'specialty',
    imp: meta?.if ?? 0,
    basic: isBasic,
    studyKey: study.key, studyZh: study.zh, studyRank: study.rank,
    stars: starTier(meta?.if ?? 0),
    date,
    ts: date ? Date.parse(date) : 0,
    year: r.pubYear || (date ? date.slice(0, 4) : ''),
    authors: cleanText(r.authorString || '').split(',')[0] || '',
    authorCite: epmcAuthorCite(r),
    volume: reliableVolume(r.journalInfo?.volume),
    issue: r.journalInfo?.issue || '',
    pages: reliablePages(r.pageInfo),
    pmid: r.pmid || '',
    doi: r.doi || '',
    keywords: keywordList(r.keywordList),
    oa: isOpenAccessFlag(r.isOpenAccess) || licenseIsOpen(r.license),
    pii: undefined,
  };
}

function composePool(items) {
  const ordered = [...items].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const per = {}, capped = [];
  for (const a of ordered) {
    if ((per[a.journal] || 0) >= journalCap({ tier: articleTier(a) })) continue;
    per[a.journal] = (per[a.journal] || 0) + 1;
    capped.push(a);
  }
  const flagship = capped.filter(a => articleTier(a) === 'flagship');
  const subs = capped.filter(a => articleTier(a) === 'sub');
  const specialty = capped.filter(a => articleTier(a) === 'specialty');
  const kept = flagship.concat(specialty);
  const keptIds = new Set(kept.map(a => a.id));
  const seenSub = new Set();
  for (const a of subs) {
    if (seenSub.has(a.journal)) continue;
    seenSub.add(a.journal);
    kept.push(a);
    keptIds.add(a.id);
  }
  const domainCount = domain => kept.filter(a => a.domain === domain).length;
  const domains = [];
  const seenD = new Set();
  for (const a of capped) {
    const d = a.domain || '综合医学';
    if (!seenD.has(d)) { seenD.add(d); domains.push(d); }
  }
  for (const domain of domains) {
    let need = DOMAIN_FLOOR - domainCount(domain);
    if (need <= 0) continue;
    const extra = capped.filter(a => a.domain === domain && !keptIds.has(a.id))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    for (const a of extra) {
      if (need <= 0) break;
      kept.push(a);
      keptIds.add(a.id);
      need--;
    }
  }
  const targetSub = flagship.length
    ? Math.round(flagship.length * (1 - FLAGSHIP_SHARE) / FLAGSHIP_SHARE)
    : subs.length;
  const currentSub = kept.filter(a => articleTier(a) === 'sub').length;
  let budget = Math.max(0, targetSub - currentSub);
  const groups = new Map();
  for (const a of subs) {
    if (keptIds.has(a.id)) continue;
    if (!groups.has(a.journal)) groups.set(a.journal, []);
    groups.get(a.journal).push(a);
  }
  const order = [...groups.keys()].sort((a, b) => (groups.get(b)[0].imp || 0) - (groups.get(a)[0].imp || 0));
  const perSub = {};
  for (const a of kept) {
    if (articleTier(a) === 'sub') perSub[a.journal] = (perSub[a.journal] || 0) + 1;
  }
  let added = 0;
  while (added < budget) {
    let moved = false;
    for (const j of order) {
      if (added >= budget) break;
      if ((perSub[j] || 0) >= SUB_CAP) continue;
      const g = groups.get(j);
      if (g.length) {
        const a = g.shift();
        kept.push(a);
        keptIds.add(a.id);
        perSub[j] = (perSub[j] || 0) + 1;
        added++;
        moved = true;
      }
    }
    if (!moved) break;
  }
  if (kept.length > POOL_MAX) {
    const drop = new Set();
    const liveCount = domain => kept.filter(a => !drop.has(a.id) && a.domain === domain).length;
    const extras = kept.filter(a => articleTier(a) === 'specialty')
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    for (const a of extras) {
      if (kept.length - drop.size <= POOL_MAX) break;
      if (liveCount(a.domain) <= DOMAIN_FLOOR) continue;
      drop.add(a.id);
    }
    kept.splice(0, kept.length, ...kept.filter(a => !drop.has(a.id)));
  }
  kept.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return kept;
}

/** 今日精选：8 篇 = 4 篇临床 + 4 篇基础/分子医学。
 *  先拿旗舰（基础一刊一篇；临床先一刊一篇，再允许第二篇），
 *  旗舰不够再用专科，最后才是子刊。 */
function curate(items, n = PICK_N) {
  const rank = a => (articleTier(a) === 'flagship' ? 2 : articleTier(a) === 'specialty' ? 1 : 0) * 100000
    + a.studyRank * 1000 + (a.imp || 0) + (a.structured ? 40 : 0);
  const pool = [...items].sort((a, b) => rank(b) - rank(a));
  const picked = [], perJ = {}, perD = {};
  const cnt = basic => picked.filter(p => !!p.basic === basic).length;
  const add = (it, jCap) => {
    if (!it || picked.includes(it)) return false;
    if ((perJ[it.journal] || 0) >= jCap) return false;
    picked.push(it);
    perJ[it.journal] = (perJ[it.journal] || 0) + 1;
    perD[it.domain] = (perD[it.domain] || 0) + 1;
    return true;
  };
  // 1) 基础旗舰，一刊一篇
  for (const it of pool) {
    if (cnt(true) >= PICK_BASIC) break;
    if (it.basic && articleTier(it) === 'flagship') add(it, 1);
  }
  // 2) 临床旗舰，先一刊一篇，再允许第二篇
  for (const it of pool) {
    if (cnt(false) >= PICK_CLINICAL) break;
    if (!it.basic && articleTier(it) === 'flagship') add(it, 1);
  }
  for (const it of pool) {
    if (cnt(false) >= PICK_CLINICAL) break;
    if (!it.basic && articleTier(it) === 'flagship') add(it, 2);
  }
  // 3) 基础其余名额，一刊一篇（专科先于子刊，因为 pool 已按层级排过）
  for (const it of pool) {
    if (cnt(true) >= PICK_BASIC) break;
    if (it.basic) add(it, 1);
  }
  // 4) 临床其余名额，优先不同领域
  for (const it of pool) {
    if (cnt(false) >= PICK_CLINICAL) break;
    if (!it.basic && !perD[it.domain]) add(it, 2);
  }
  for (const it of pool) {
    if (cnt(false) >= PICK_CLINICAL) break;
    if (!it.basic) add(it, 2);
  }
  // 3) 某一边不足时补足总数
  for (const it of pool) { if (picked.length >= n) break; add(it, 2); }
  // 4) 一刊上限仍挡路时放开，池子够大就凑满 n
  for (const it of pool) { if (picked.length >= n) break; add(it, 99); }
  return picked.slice(0, n).sort((a, b) => rank(b) - rank(a));
}

function keywordList(list) {
  const raw = list?.keyword ?? list;
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return arr.map(k => cleanText(typeof k === 'string' ? k : (k?.text || k?.value || ''))).filter(Boolean);
}

/** 文章列表 + 精选的指纹。后台重新校验时用它判断「数据有没有真的变」，
 *  没变就不重渲染 —— 否则会把用户正在读的卡片关掉。 */
function jrSignature() {
  return S.jr.all.map(x => x.id).join('|') + '#' + S.jr.picks.map(x => x.id).join('|');
}

let jrLiveAt = 0;
function loadResearch(force) {
  if (loadResearch.flight) return loadResearch.flight;
  loadResearch.flight = loadResearchNow(force).finally(() => { loadResearch.flight = null; });
  return loadResearch.flight;
}
async function loadResearchNow(force) {
  const c = readCache();
  if (!force && c.jr && Date.now() - c.jr.at < TTL) {
    S.jr = { ...S.jr, ...c.jr.data, loaded: true, fromCache: true };
    applyDigest();
    S.jr._sig = jrSignature();
    renderResearch();
    loadPII(S.jr.picks);
    return;
  }
  try {
    const groups = await fetchEpmcPool(S.cfg);
    const seen = new Set(), raw = [];
    for (const group of groups) {
      for (const r of group) {
        const k = String(r.doi || r.id || r.pmid || '').toLowerCase();
        if (!k || seen.has(k)) continue;
        seen.add(k); raw.push(r);
      }
    }
    const items = composePool(
      raw.map(mapArticle).filter(Boolean).sort((a, b) => b.ts - a.ts)
    );
    const byKey = {};
    for (const it of items) {
      (byKey[it.domain] ||= []).push(it);
      (byKey[it.basic ? 'basic' : 'clinical'] ||= []).push(it);
    }
    S.jr = {
      all: items, byKey, picks: curate(items),
      updated: items.length ? items[0].date : null,
      fetchedAt: new Date().toISOString(),       // 数据实际拉取时间（≠ 最新文章发表日；Europe PMC 索引有 1-2 天延迟，发表日会滞后）
      loaded: true, error: null,
    };
    jrLiveAt = Date.now();
  } catch (e) {
    console.warn('[research] live fetch failed:', e);
    if (!S.jr.loaded) {
      const snap = await trySnapshot('data/snapshot-journals.json');
      if (snap?.items?.length) {
        const byKey = {};
        for (const it of snap.items) {
          (byKey[it.domain] ||= []).push(it);
          (byKey[it.basic ? 'basic' : 'clinical'] ||= []).push(it);
        }
        S.jr = { all: snap.items, byKey, picks: curate(snap.items),
                 updated: snap.updated, fetchedAt: snap.generatedAt, loaded: true, error: 'snapshot' };
      } else {
        S.jr = { ...S.jr, loaded: true, error: e.message };
      }
    }
  }
  applyDigest();
  if (S.jr.loaded && S.jr.all?.length) {
    writeCache('jr', {
      all: S.jr.all, byKey: S.jr.byKey, picks: S.jr.picks,
      updated: S.jr.updated, fetchedAt: S.jr.fetchedAt,
    });
  }
  loadPII(S.jr.picks);
  const sig = jrSignature();
  const prev = S.jr._sig;
  S.jr._sig = sig;
  if (sig === prev && S.jr.loaded) return;   // 数据没变，保持界面原样
  renderResearch();
}

/* ---------------- 最近一周: Crossref online date + PubMed abstract --------
   Europe PMC FIRST_PDATE lags about a week, so the 7-day chip cannot read
   the 30-day pool. Crossref `from-online-pub-date` is current; its abstracts
   are often empty (NEJM). PubMed E-utilities already have those abstracts.
   Results live in S.week and the `week` cache slot (same 30 min TTL). A
   failure here never blocks the Europe PMC list. */
let weekGen = 0;

function normDoi(s) {
  return String(s || '').trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
}
function abstractChars(a) {
  if (a?.structured && a.sections) {
    return Object.values(a.sections).reduce((n, s) => n + String(s || '').trim().length, 0);
  }
  return String(a?.abstract || '').trim().length;
}
function crossrefDay(item) {
  const parts = (item?.['published-online'] || item?.issued || {})['date-parts']?.[0];
  if (!parts || parts.length < 3 || !parts[0]) return '';
  const [y, m, d] = parts;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
async function mapPool(items, limit, fn) {
  const n = Math.max(1, Math.min(limit, items.length || 1));
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}
async function crossrefJournalWorks(issn, lo, hi) {
  const items = [];
  let offset = 0;
  for (let page = 0; page < 3; page++) {
    const url = `https://api.crossref.org/journals/${encodeURIComponent(issn)}/works?` + new URLSearchParams({
      filter: `type:journal-article,from-online-pub-date:${lo},until-online-pub-date:${hi}`,
      rows: '100',
      offset: String(offset),
      select: 'DOI,title,abstract,author,published-online,issued',
      mailto: API_MAIL,
    });
    const data = await fetchJSONSoft(url, 20000);
    const batch = data?.message?.items || [];
    items.push(...batch);
    const total = data?.message?.['total-results'] || 0;
    offset += batch.length;
    if (!batch.length || offset >= total || offset >= 300) break;
  }
  return items;
}
function mapCrossrefWork(item, meta, lo, hi) {
  const title = cleanText((item.title || [])[0] || '');
  const doi = normDoi(item.DOI);
  const date = crossrefDay(item);
  if (!title || !doi || !date || date < lo || date > hi) return null;
  const abstract = cleanText(item.abstract || '');
  const authorCite = crossrefAuthorCite(item.author);
  const author0 = (item.author || [])[0] || {};
  const authors = authorCite[0] || cleanText([author0.family, author0.given].filter(Boolean).join(' ') || author0.name || '');
  const isBasic = !!(meta && meta.basic);
  const study = detectStudy(title, abstract, isBasic, []);
  return {
    id: doi,
    title,
    abstract,
    sections: null,
    structured: false,
    journal: meta?.short || '—',
    issn: meta?.issn || '',
    platforms: Array.isArray(meta?.platforms) ? meta.platforms.slice() : [],
    domain: meta?.domain || '综合医学',
    tier: meta?.tier || 'specialty',
    imp: meta?.if ?? 0,
    basic: isBasic,
    studyKey: study.key, studyZh: study.zh, studyRank: study.rank,
    stars: starTier(meta?.if ?? 0),
    date,
    ts: Date.parse(date) || 0,
    year: date.slice(0, 4),
    authors,
    authorCite,
    volume: reliableVolume(item.volume),
    issue: item.issue || '',
    pages: reliablePages(item.page),
    pmid: '',
    doi,
    keywords: [],
    oa: licenseIsOpen(item.license),
    pii: undefined,
  };
}
function sectionKeyForLabel(label) {
  if (!label || SEC_SKIP.test(label)) return '';
  for (const [k, re] of SEC_HEAD) if (re.test(label)) return k;
  return 'other';
}
function parsePubmedArticle(art) {
  const nodes = [...art.querySelectorAll('Abstract AbstractText')];
  const sections = { objective: '', methods: '', results: '', conclusion: '', other: '' };
  const chunks = [];
  let mapped = false;
  for (const n of nodes) {
    const label = (n.getAttribute('Label') || '').trim();
    const text = cleanText(n.textContent || '');
    if (!text) continue;
    chunks.push(label ? `${label}: ${text}` : text);
    const key = sectionKeyForLabel(label);
    if (!key) continue;
    if (key !== 'other') mapped = true;
    sections[key] = sections[key] ? sections[key] + ' ' + text : text;
  }
  const text = chunks.join('\n');
  const structured = mapped && !!(sections.objective || sections.methods || sections.results || sections.conclusion);
  const ids = [...art.querySelectorAll('ArticleId')];
  const doiNode = ids.find(n => (n.getAttribute('IdType') || '').toLowerCase() === 'doi')
    || [...art.querySelectorAll('ELocationID')].find(n => (n.getAttribute('EIdType') || '').toLowerCase() === 'doi');
  return {
    doi: normDoi(doiNode?.textContent || ''),
    pmid: art.querySelector('MedlineCitation > PMID')?.textContent?.trim() || '',
    pubTypes: [...art.querySelectorAll('PublicationType')].map(n => (n.textContent || '').trim()).filter(Boolean),
    text,
    structured,
    sections: structured ? sections : null,
  };
}
function applyPubmedHit(a, hit) {
  if (hit.pmid) a.pmid = hit.pmid;
  const text = String(hit.text || '').trim();
  if (text.length < WEEK_ABS_MIN && abstractChars({ structured: hit.structured, sections: hit.sections, abstract: text }) < WEEK_ABS_MIN) return;
  a.abstract = hit.structured ? '' : text;
  a.sections = hit.structured ? hit.sections : null;
  a.structured = !!hit.structured;
  const blob = hit.structured ? Object.values(hit.sections).join(' ') : text;
  const study = detectStudy(a.title, blob, a.basic, hit.pubTypes || []);
  a.studyKey = study.key;
  a.studyZh = study.zh;
  a.studyRank = study.rank;
}
async function fillPubmedAbstracts(articles) {
  const dois = [...new Set(articles.map(a => a.doi).filter(Boolean))];
  const pmids = [];
  for (let i = 0; i < dois.length; i += 40) {
    const chunk = dois.slice(i, i + 40);
    const term = chunk.map(d => `${d}[doi]`).join(' OR ');
    const url = EUTILS + 'esearch.fcgi?' + new URLSearchParams({
      db: 'pubmed', retmode: 'json', retmax: '80', term,
      tool: 'research-radar', email: API_MAIL,
    });
    try {
      const data = await fetchJSONRetry(url, 2, 20000);
      pmids.push(...(data?.esearchresult?.idlist || []));
    } catch (e) { console.warn('[pubmed esearch]', e.message || e); }
    if (i + 40 < dois.length) await sleep(NCBI_GAP_MS);
  }
  const uniq = [...new Set(pmids)];
  const byDoi = new Map();
  for (let i = 0; i < uniq.length; i += 80) {
    if (i) await sleep(NCBI_GAP_MS);
    const url = EUTILS + 'efetch.fcgi?' + new URLSearchParams({
      db: 'pubmed', id: uniq.slice(i, i + 80).join(','), retmode: 'xml',
      tool: 'research-radar', email: API_MAIL,
    });
    try {
      const xml = await fetchTextRetry(url);
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      if (doc.querySelector('parsererror')) continue;
      for (const art of doc.querySelectorAll('PubmedArticle')) {
        const hit = parsePubmedArticle(art);
        if (hit.doi) byDoi.set(hit.doi, hit);
      }
    } catch (e) { console.warn('[pubmed efetch]', e.message || e); }
  }
  for (const a of articles) {
    const hit = byDoi.get(a.doi);
    if (hit) applyPubmedHit(a, hit);
  }
}
async function fetchWeekArticles() {
  const lo = utcDay(-6);
  const hi = utcDay(0);
  const found = [];
  let attempts = 0;
  let failures = 0;
  await mapPool(S.cfg.filter(m => m && m.issn), 3, async (meta) => {
    const ids = [meta.issn, meta.essn].filter((id, i, all) => id && all.indexOf(id) === i);
    for (const issn of ids) {
      attempts++;
      try {
        const works = await crossrefJournalWorks(issn, lo, hi);
        for (const w of works) {
          const art = mapCrossrefWork(w, meta, lo, hi);
          if (art) found.push(art);
        }
        // Print ISSN is enough when it returns the week's articles. BMJ's
        // print ISSN is empty at Crossref; the electronic ISSN is the one
        // that actually lists the issue, so keep going only when this one
        // came back empty.
        if (works.length) break;
      } catch (e) {
        failures++;
        console.warn('[crossref]', issn, e.message || e);
      }
    }
  });
  const byDoi = new Map();
  for (const a of found) if (!byDoi.has(a.doi)) byDoi.set(a.doi, a);
  const list = [...byDoi.values()];
  if (!list.length && attempts && failures === attempts) throw new Error('Crossref 暂时不可用');
  await fillPubmedAbstracts(list);
  return list
    .filter(a => a.title && abstractChars(a) >= WEEK_ABS_MIN)
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.title.localeCompare(b.title));
}

/** Crossref+PubMed rows, swapping in the Europe PMC card when the same DOI is already pooled. */
function weekList() {
  const pool = new Map();
  for (const a of S.jr.all || []) {
    const d = normDoi(a.doi);
    if (d && !pool.has(d)) pool.set(d, a);
  }
  const out = [];
  const seen = new Set();
  for (const a of S.week.items || []) {
    const d = normDoi(a.doi);
    if (!d || seen.has(d)) continue;
    seen.add(d);
    const hit = pool.get(d);
    out.push(hit && abstractChars(hit) >= WEEK_ABS_MIN ? hit : a);
  }
  return out;
}
function weekChipCount() {
  if (!S.week.loaded && !(S.week.items || []).length) return '…';
  return weekList().length;
}
function paintWeek() {
  if (S.jFilter === 'week') { renderResearch(); return; }
  const cnt = document.querySelector('#researchChips .chip[data-k="week"] .cnt');
  if (cnt) cnt.textContent = `(${weekChipCount()})`;
  else renderResearch();
}
async function loadWeek(force = false) {
  const gen = ++weekGen;
  if (!S.cfg.length) return;
  const c = readCache();
  const fresh = c.week && Date.now() - c.week.at < TTL && Array.isArray(c.week.data?.items);
  if (!force && fresh) {
    if (gen !== weekGen) return;
    S.week = { items: c.week.data.items, loaded: true, loading: false, error: '' };
    paintWeek();
    return;
  }
  S.week.loading = true;
  S.week.error = '';
  paintWeek();
  try {
    const items = await fetchWeekArticles();
    if (gen !== weekGen) return;
    S.week = { items, loaded: true, loading: false, error: '' };
    writeCache('week', { items });
  } catch (e) {
    if (gen !== weekGen) return;
    console.warn('[week]', e);
    S.week.loading = false;
    S.week.loaded = true;
    S.week.error = e.message || String(e);
  }
  if (gen === weekGen) paintWeek();
}

/* ---------------- Crossref PII → publisher deep link --------------------
   Which button to show lives on the journal row (`platforms` in
   journals.config.json), not in a hardcoded title list:
     ck in platforms + PII → ClinicalKey
     else sd in platforms + PII → ScienceDirect
     else DOI only
   ClinicalKey wins when both are listed. Snapshot items often have no ISSN;
   those match the config row's exact `short` or `title`.
   Europe PMC exposes no PII, so it comes from Crossref's alternative-id.
   `filter=doi:a,doi:b` batches ~20 DOIs per request.
   The id is the compact Elsevier PII (`S` + digits, no hyphens), which is
   what both ClinicalKey (`1-s2.0-` + PII) and ScienceDirect (`/pii/` + PII)
   accept. Example: S0092867411001279.                                        */
const PII_RE = /^S[0-9X]{10,}$/;
const PII_KEY = 'rr.pii.v1';
let piiCache = readPiiMap();

function readPiiMap() { try { return JSON.parse(localStorage.getItem(PII_KEY) || '{}'); } catch { return {}; } }
function savePiiMap() { try { localStorage.setItem(PII_KEY, JSON.stringify(piiCache)); } catch { /* quota */ } }

/** PII never changes for a DOI, so it is cached forever. On failure the DOI is left
 *  uncached so a later attempt retries; the DOI link is always the visible fallback. */
async function loadPII(items) {
  const targets = (items || []).filter(a => a && a.doi);
  if (!targets.length) return;

  const miss = [];
  for (const a of targets) {
    const k = a.doi.toLowerCase();
    if (k in piiCache) a.pii = piiCache[k];
    else if (a.pii === undefined) miss.push(k);
  }

  const uniq = [...new Set(miss)];
  for (let i = 0; i < uniq.length; i += 20) {
    const chunk = uniq.slice(i, i + 20);
    try {
      const d = await fetchJSONRetry(CROSSREF + '?' + new URLSearchParams({
        filter: chunk.map(x => 'doi:' + x).join(','),
        rows: String(chunk.length + 5), select: 'DOI,alternative-id',
      }), 2, 20000);
      const got = {};
      for (const it of (d.message?.items || [])) {
        const alt = (it['alternative-id'] || [])[0] || '';
        got[String(it.DOI || '').toLowerCase()] = PII_RE.test(alt) ? alt : '';
      }
      for (const k of chunk) piiCache[k] = got[k] || '';
      savePiiMap();
    } catch { /* transient — leave uncached so a later expand retries */ }
  }

  for (const a of targets) {
    const k = a.doi.toLowerCase();
    if (a.pii === undefined && k in piiCache) a.pii = piiCache[k];
  }

  $$('#researchCards .art').forEach(node => {
    const a = S.jr.all.find(x => x.id === node.dataset.id);
    if (a && a.pii) addFullTextLink(node, a);
  });
}

/** Config row for this article: exact ISSN, else exact short/title. */
function journalRow(a) {
  if (!a || !S.cfg?.length) return null;
  if (a.issn) {
    const byIssn = cfgByIssn(a.issn);
    if (byIssn) return byIssn;
  }
  if (!a.journal) return null;
  return S.cfg.find(c => c.short === a.journal || c.title === a.journal) || null;
}

/** Platforms from the current config row, else the copy stored on the article. */
function articlePlatforms(a) {
  const row = journalRow(a);
  if (row && Array.isArray(row.platforms)) return row.platforms;
  if (a && Array.isArray(a.platforms)) return a.platforms;
  return [];
}

/** Publisher chip for a resolved PII. ck beats sd; neither means DOI only. */
function fullTextLink(a) {
  if (!a || !a.pii) return null;
  const plats = articlePlatforms(a);
  if (plats.includes('ck')) {
    return {
      href: 'https://www.clinicalkey.com/#!/content/playContent/1-s2.0-' + a.pii,
      label: 'ClinicalKey',
      cls: 'ck',
    };
  }
  if (plats.includes('sd')) {
    return {
      href: 'https://www.sciencedirect.com/science/article/pii/' + a.pii,
      label: 'ScienceDirect',
      cls: 'sd',
    };
  }
  return null;
}

function addFullTextLink(node, a) {
  const links = node.querySelector('.art-links');
  const spec = fullTextLink(a);
  if (!links || !spec || links.querySelector('.lnk.ck, .lnk.sd')) return;
  links.prepend(link(spec.href, spec.label, spec.cls));
  // The body was built before the PII arrived, so the DOI chip missed the
  // secondary style it gets when the publisher link is known up front.
  for (const n of links.querySelectorAll('.lnk')) {
    if (/doi\.org/.test(n.getAttribute('href') || '')) n.classList.add('alt');
  }
}

/* ---------------- follow-builders ---------------- */
function mapBuilderFeeds(x, blogs, pods) {
  const out = [];
  for (const b of (x?.x || [])) {
    for (const t of (b.tweets || [])) {
      out.push({
        type: 'x', kind: 'X 动态',
        name: b.name || b.handle, handle: b.handle || '',
        text: cleanText(t.text), ts: Date.parse(t.createdAt || '') || 0,
        date: t.createdAt || '', url: t.url || (b.handle ? `https://x.com/${b.handle}` : ''),
        likes: t.likes ?? 0, rt: t.retweets ?? 0, replies: t.replies ?? 0,
        id: t.url || '',
      });
    }
  }
  for (const b of (blogs?.blogs || [])) {
    out.push({ type: 'blog', kind: '官方博客', name: b.name || 'Blog', handle: '',
      text: cleanText(b.description || b.content || '').slice(0, 1200),
      ts: Date.parse(b.publishedAt || '') || 0, date: b.publishedAt || '',
      url: b.url || '', title: cleanText(b.title || '') });
  }
  for (const p of (pods?.podcasts || [])) {
    out.push({ type: 'podcast', kind: '播客', name: p.name || p.show || 'Podcast', handle: '',
      text: cleanText(p.description || p.summary || ''),
      ts: Date.parse(p.publishedAt || p.date || '') || 0,
      date: p.publishedAt || p.date || '', url: p.url || '', title: cleanText(p.title || '') });
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
    S.ai = { all: items, updated: x?.generatedAt || items[0]?.date || null, loaded: true, error: null };
    writeCache('ai', { all: items, updated: S.ai.updated });
  } catch (e) {
    console.warn('[builders] live fetch failed:', e);
    if (!S.ai.loaded) {
      const snap = await trySnapshot('data/snapshot-builders.json');
      S.ai = snap?.items?.length
        ? { all: snap.items, updated: snap.updated, loaded: true, error: 'snapshot' }
        : { ...S.ai, loaded: true, error: e.message };
    }
  }
  renderBuilders();
}

async function trySnapshot(path) {
  try { return await fetchJSON(path, 12000); } catch { return null; }
}

/* ---------------- 创新 / 看点 digest ----------------
   Generated daily by scripts/build_digest.py (GitHub Action) and committed as
   static JSON. When it is fresh, its DOIs *define* 今日精选 so the editorial
   notes always line up with the shortlist. Falls back to live curation otherwise. */
async function loadDigest() {
  const d = await trySnapshot('data/digest.json');
  if (!d || !Array.isArray(d.items) || !d.items.length) return;
  await loadSnapArticles();
  for (const it of d.items) {
    if (it && it.titleZh) it.titleZh = stripTitleMeta(it.titleZh);
  }
  S.digest = {
    date: d.date || null,
    items: d.items,
    byDoi: new Map(d.items.map(x => [String(x.doi || '').toLowerCase(), x])),
    model: d.model || '',
    loaded: true,
  };
  applyDigest();
  renderResearch();
}

/** Snapshot articles, keyed by DOI. Used when a digest pick has fallen out of
 *  the live Europe PMC pool. */
async function loadSnapArticles() {
  if (S.snapByDoi) return S.snapByDoi;
  const snap = await trySnapshot('data/snapshot-journals.json');
  const map = new Map();
  for (const a of [...(snap?.items || []), ...(snap?.picks || [])]) {
    const doi = String(a?.doi || a?.id || '').toLowerCase();
    if (doi && !map.has(doi)) map.set(doi, a);
  }
  S.snapByDoi = map;
  return map;
}

/** 今日 AI 动态总览 + 每条动态的中文一句话（由 scripts/build_builder_digest.py 生成） */
async function loadBuilderDigest() {
  const d = await trySnapshot('data/builder-digest.json');
  if (!d || !Array.isArray(d.posts)) return;
  S.bd = {
    date: d.date || null,
    headline: d.headline || '',
    bullets: Array.isArray(d.bullets) ? d.bullets : [],
    sentiment: d.sentiment || '',
    byId: new Map(d.posts.map(x => [String(x.id || ''), x.summaryZh || ''])),
    loaded: true,
  };
  renderBuilders();
}

function applyDigest() {
  if (!S.digest.loaded || !S.jr.all) return;
  // Notes still attach when a pooled paper is in the digest. The shortlist
  // itself is the flagship-first curation, not the digest's DOI order.
  const byDoi = new Map(S.jr.all.map(a => [String(a.doi || '').toLowerCase(), a]));
  for (const d of S.digest.items || []) {
    const doi = String(d.doi || '').toLowerCase();
    const a = doi ? byDoi.get(doi) : null;
    if (a) a.digest = d;
  }
  S.jr.picks = curate(S.jr.all);
}

function articleFromDigest(d) {
  const doi = String(d?.doi || '').toLowerCase();
  const snap = doi && S.snapByDoi ? S.snapByDoi.get(doi) : null;
  if (snap) return { ...snap, id: snap.id || doi, doi: snap.doi || doi, digest: d };
  const meta = S.cfg.find(c => c.short === d.journal || c.title === d.journal) || null;
  if (!doi && !d?.title) return null;
  return {
    id: doi || ('digest:' + (d.title || '')),
    title: d.title || d.titleZh || '（无标题）',
    abstract: '',
    sections: null,
    structured: false,
    journal: d.journal || meta?.short || '—',
    issn: meta?.issn || '',
    platforms: Array.isArray(d.platforms) ? d.platforms : (meta?.platforms || []),
    domain: d.domain || meta?.domain || '综合医学',
    tier: meta?.tier || 'specialty',
    imp: meta?.if ?? 0,
    basic: d.basic != null ? !!d.basic : !!meta?.basic,
    studyKey: d.studyKey || 'other',
    studyZh: d.studyZh || '研究论文',
    studyRank: 3,
    stars: starTier(meta?.if ?? 0),
    date: d.date || '',
    ts: d.date ? Date.parse(d.date) : 0,
    year: (d.date || '').slice(0, 4),
    authors: '',
    pmid: '',
    doi,
    keywords: [],
    oa: false,
    pii: undefined,
    digest: d,
  };
}

function ensureInAll(a) {
  if (!a) return;
  const doi = String(a.doi || '').toLowerCase();
  const exists = S.jr.all.some(x => (doi && String(x.doi || '').toLowerCase() === doi) || x.id === a.id);
  if (exists) return;
  S.jr.all.push(a);
  if (!S.jr.byKey) S.jr.byKey = {};
  (S.jr.byKey[a.domain] ||= []).push(a);
  (S.jr.byKey[a.basic ? 'basic' : 'clinical'] ||= []).push(a);
}

/** Exactly 4 clinical + 4 basic when the pool allows it. Digest order is kept
 *  for the papers already chosen; the short side is filled from `pool`. */
function composeEight(preferred, pool) {
  const picked = [];
  const used = new Set();
  const idOf = a => String(a?.doi || a?.id || '').toLowerCase();
  const take = a => {
    const id = idOf(a);
    if (!a || !id || used.has(id)) return false;
    used.add(id);
    picked.push(a);
    return true;
  };
  let nb = 0, nc = 0;
  for (const a of preferred || []) {
    if (a.basic && nb < PICK_BASIC && take(a)) nb++;
    else if (!a.basic && nc < PICK_CLINICAL && take(a)) nc++;
  }
  const rank = a => (articleTier(a) === 'flagship' ? 2 : articleTier(a) === 'specialty' ? 1 : 0) * 100000
    + (a.studyRank || 0) * 1000 + (a.imp || 0);
  const rest = [...(pool || [])].sort((a, b) => rank(b) - rank(a));
  const fill = (basic, need) => {
    for (const cap of [basic ? 1 : 2, 99]) {
      for (const a of rest) {
        if ((basic ? nb : nc) >= need) return;
        if (!!a.basic !== basic) continue;
        const before = picked.length;
        const perJ = picked.filter(x => x.journal === a.journal).length;
        if (perJ >= cap) continue;
        if (take(a)) {
          if (basic) nb++; else nc++;
        }
        if (picked.length === before) continue;
      }
    }
  };
  fill(true, PICK_BASIC);
  fill(false, PICK_CLINICAL);
  return picked.slice(0, PICK_N);
}

/* ---------------- cache ---------------- */
function readCache() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; } }
function writeCache(slot, data) {
  try {
    const c = readCache();
    c[slot] = { at: Date.now(), data };
    localStorage.setItem(LS_KEY, JSON.stringify(c));
  } catch { /* quota / private mode */ }
}

/* ---------------- render helpers ---------------- */
function chip(label, count, pressed, onClick, cls = '', key = '') {
  const b = el('button', 'chip' + (cls ? ' ' + cls : ''));
  b.type = 'button';
  if (key) b.dataset.k = key;
  b.setAttribute('aria-pressed', String(!!pressed));
  if (label.ico) b.append(el('span', 'ci', label.ico));
  b.append(document.createTextNode(label.text));
  if (count != null) b.append(el('span', 'cnt', `(${count})`));
  b.addEventListener('click', onClick);
  return b;
}

/** Navy folder for specialty domains. Utility chips stay outside it. */
function domainFolderChip(count, open, activeDomain) {
  const b = el('button', 'chip folder' + (open ? ' is-open' : ''));
  b.type = 'button';
  b.dataset.k = 'domains';
  b.setAttribute('aria-expanded', String(open));
  const label = activeDomain && !open ? `学科 · ${activeDomain}` : '学科';
  b.setAttribute('aria-label', open ? '收起学科' : '展开学科');
  b.append(document.createTextNode(label));
  b.append(el('span', 'cnt', `(${count})`));
  b.append(el('span', 'chev', open ? '▴' : '▾'));
  b.addEventListener('click', () => {
    S.domainsOpen = !S.domainsOpen;
    renderResearch();
    const next = $('#researchChips .chip.folder');
    if (next) next.focus();
  });
  return b;
}
function starsNode(n) {
  const w = el('span', 'stars');
  for (let i = 1; i <= 5; i++) w.append(el('span', i <= n ? '' : 'off', '★'));
  return w;
}
function link(href, label, cls) {
  const a = el('a', 'lnk' + (cls ? ' ' + cls : ''), label + ' ↗');
  a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
  return a;
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

/* ---------------- render: research ---------------- */
function renderResearch() {
  const host = $('#researchChips');
  const all = S.jr.all;
  const unread = all.filter(a => !S.seen.has(a.id)).length;

  host.replaceChildren();
  host.append(
    chip({ ico:'⭐', text:'今日精选' }, S.jr.picks.length, S.jFilter === 'pick', () => setJFilter('pick'), '', 'pick'),
    chip({ ico:'🌐', text:'全部' }, all.length, S.jFilter === 'all', () => setJFilter('all'), '', 'all'),
    chip({ ico:'✨', text:'未读' }, unread, S.jFilter === 'unread', () => setJFilter('unread'), '', 'unread'),
    chip({ ico:'📅', text:'最近一周' }, weekChipCount(), S.jFilter === 'week', () => setJFilter('week'), '', 'week'),
    chip({ ico:'♥', text:'收藏' }, S.fav.order.length, S.jFilter === 'fav', () => setJFilter('fav'), '', 'fav'),
    chip({ ico:'🧬', text:'基础/分子' }, (S.jr.byKey.basic || []).length, S.jFilter === 'basic', () => setJFilter('basic'), '', 'basic'),
    chip({ ico:'📚', text:'专业词汇' }, S.gloss.length, false, openGlossary),
  );
  const domains = DOMAIN_ORDER.filter(d => (S.jr.byKey[d] || []).length);
  if (domains.length) {
    const activeDom = domains.includes(S.jFilter) ? S.jFilter : '';
    host.append(domainFolderChip(domains.length, !!S.domainsOpen, activeDom));
    if (S.domainsOpen) {
      for (const d of domains) {
        host.append(chip({ ico: dm(d).ico, text: d }, (S.jr.byKey[d] || []).length, S.jFilter === d, () => setJFilter(d)));
      }
    }
  }

  $('#litDate').textContent = S.jr.fetchedAt ? fmtDate(S.jr.fetchedAt) : '—';
  // derive the banner counts from the config so they can never drift from reality
  const nClin = S.cfg.filter(c => !c.basic).length;
  const nBas  = S.cfg.filter(c => c.basic).length;
  const eClin = $('#jClin'), eBas = $('#jBasic');
  if (eClin) eClin.textContent = nClin || '—';
  if (eBas)  eBas.textContent  = nBas  || '—';

  const q = searchQuery();
  const list = filteredArticles();
  const isPick = !q && S.jFilter === 'pick';
  if (q) {
    $('#researchHead').textContent = `搜索结果 ${list.length} 篇`;
    $('#researchSub').textContent = `在全部 ${all.length} 篇里匹配「${S.q.trim()}」· 标题、摘要、期刊、关键词`;
  } else {
    $('#researchHead').textContent = headLabel(list.length, isPick);
    $('#researchSub').textContent = isPick
      ? `每日精选 ${PICK_N} 篇 · ${PICK_CLINICAL} 篇临床 + ${PICK_BASIC} 篇基础/分子 · 点卡片展开摘要`
      : S.jFilter === 'fav'
        ? '小红心只存在这台浏览器 · 可下载 Markdown 清单'
        : S.jFilter === 'week'
          ? `在线发表 ${utcDay(-6)} – ${utcDay(0)}（UTC）· Crossref 发现，摘要优先 PubMed`
          : '点卡片任意位置展开摘要（摘要较长可在框内滚动）';
  }
  const dlBtn = $('#downloadFavBtn');
  if (dlBtn) dlBtn.hidden = S.jFilter !== 'fav' || !!q;

  applyAllCachedMt();
  if (S.jView === 'index') renderIndexTable($('#researchCards'), list);
  else renderArticleList($('#researchCards'), list, isPick);
  queueMachineTitles();
}

function headLabel(n, isPick) {
  if (S.jFilter === 'pick')   return `今日精选 ${n} 篇`;
  if (S.jFilter === 'all')    return `最新推送 ${n} 篇`;
  if (S.jFilter === 'unread') return `未读 ${n} 篇`;
  if (S.jFilter === 'week')   return `最近一周 ${n} 篇`;
  if (S.jFilter === 'fav')    return `收藏 ${n} 篇`;
  if (S.jFilter === 'basic')  return `基础/分子医学 ${n} 篇`;
  return `${S.jFilter} ${n} 篇`;
}

function searchQuery() { return String(S.q || '').trim(); }

function searchTokens(q) {
  return String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function articleHaystack(a) {
  const d = a.digest || {};
  const parts = [
    a.title, d.titleZh, a.mtZh, a.abstract, a.journal, a.domain, a.studyZh,
    ...(a.keywords || []),
  ];
  if (a.sections) parts.push(...Object.values(a.sections));
  for (const k of ['background', 'methods', 'innovation', 'takeaway', 'future']) {
    if (d[k]) parts.push(d[k]);
  }
  return parts.filter(Boolean).join('\n').toLowerCase();
}

function articleMatches(a, q) {
  const tokens = searchTokens(q);
  if (!tokens.length) return true;
  const hay = articleHaystack(a);
  return tokens.every(t => hay.includes(t));
}

function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Paint `text` into `node` with <mark class="hit"> around each query token. */
function fillHighlighted(node, text, q) {
  const src = String(text || '');
  const tokens = searchTokens(q);
  node.replaceChildren();
  if (!tokens.length) { node.textContent = src; return; }
  const re = new RegExp(tokens.map(escapeReg).join('|'), 'gi');
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (!m[0]) { re.lastIndex++; continue; }
    if (m.index > last) node.append(document.createTextNode(src.slice(last, m.index)));
    node.append(el('mark', 'hit', m[0]));
    last = m.index + m[0].length;
  }
  if (last < src.length) node.append(document.createTextNode(src.slice(last)));
}

function matchSnippet(a, q) {
  const tokens = searchTokens(q);
  if (!tokens.length) return '';
  const visible = [a.title, (a.digest && a.digest.titleZh) || '', a.journal].join(' ').toLowerCase();
  if (tokens.every(t => visible.includes(t))) return '';
  const d = a.digest || {};
  const blobs = [a.abstract, ...(a.keywords || [])];
  if (a.sections) blobs.push(...Object.values(a.sections));
  for (const k of ['background', 'methods', 'innovation', 'takeaway', 'future']) {
    if (d[k]) blobs.push(d[k]);
  }
  const blob = blobs.filter(Boolean).join(' ');
  const lower = blob.toLowerCase();
  let at = -1;
  let tok = '';
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) { at = i; tok = t; }
  }
  if (at < 0) return '';
  const start = Math.max(0, at - 28);
  const end = Math.min(blob.length, at + tok.length + 42);
  return (start ? '…' : '') + blob.slice(start, end).trim() + (end < blob.length ? '…' : '');
}

function setSearchQuery(raw) {
  S.q = String(raw || '');
  const btn = $('#researchSearchClear');
  if (btn) btn.hidden = !searchQuery();
  renderResearch();
}

/** UTC calendar day, same clock as the Europe PMC window (`iso`). */
function utcDay(offset = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function filteredArticles() {
  const q = searchQuery();
  if (q) return S.jr.all.filter(a => articleMatches(a, q));
  const k = S.jFilter;
  if (k === 'pick')   return S.jr.picks;
  if (k === 'all')    return S.jr.all;
  if (k === 'unread') return S.jr.all.filter(a => !S.seen.has(a.id));
  if (k === 'week')   return weekList();
  if (k === 'fav')    return favoriteArticles();
  if (k === 'basic')  return S.jr.byKey.basic || [];
  return S.jr.byKey[k] || [];
}

function setJFilter(k) {
  S.jFilter = k;
  syncFavHash();
  renderResearch();
  const sc = $('#scrollArea');
  sc.scrollTo({ top: Math.max(0, $('#researchChips').offsetTop - 96), behavior: 'smooth' });
}

/** A finger that travelled more than a few pixels was a pan, not a tap. */
function cardGestureMoved(start, x, y) {
  if (!start) return false;
  const dx = x - start.x;
  const dy = y - start.y;
  return dx * dx + dy * dy > 64;
}

/**
 * Vertical pan inside a clipped abstract. dy > 0 means the finger moved down.
 * Returns true when this box consumed the gesture, so the page must not scroll
 * and the card must not treat the pan as a tap that closes it.
 */
function abstractPan(el, dy) {
  if (!el || !dy) return false;
  const overflow = el.scrollHeight - el.clientHeight;
  if (overflow <= 1) return false;
  const atTop = el.scrollTop <= 0;
  const atBottom = el.scrollTop >= overflow - 1;
  if ((dy > 0 && atTop) || (dy < 0 && atBottom)) return false;
  el.scrollTop -= dy;
  return true;
}

function bindAbstractScroll(el) {
  let y = 0;
  el.addEventListener('touchstart', ev => {
    const t = ev.touches && ev.touches[0];
    y = t ? t.clientY : 0;
  }, { passive: true });
  el.addEventListener('touchmove', ev => {
    const t = ev.touches && ev.touches[0];
    if (!t) return;
    const dy = t.clientY - y;
    y = t.clientY;
    if (abstractPan(el, dy)) ev.preventDefault();
  }, { passive: false });
}

function articleCard(a, isPick, pickRank) {
  const c = el('article', 'card art');
  c.dataset.id = a.id;
  // the LLM digest can nominate the top pick; otherwise the first curated slot wins
  const isTop = !!(a.digest && a.digest.topPick) || (isPick && pickRank === 1);
  if (isPick && isTop) c.classList.add('top-pick');

  const top = el('div', 'art-top');
  const caret = el('span', 'caret');
  caret.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const titleWrap = el('div', 'art-titlewrap');
  if (isPick && isTop) titleWrap.append(el('span', 'pick-ribbon', '⭐ 今日首选'));
  else if (isPick) titleWrap.append(el('span', 'pick-num', 'NO.' + pickRank));
  // 有中文标题就用中文（英文原标题收进下方的「英文原标题与摘要」折叠块）
  const titleZh = stripTitleMeta((a.digest && a.digest.titleZh) || '');
  const h3 = el('h3', 'art-title');
  fillHighlighted(h3, titleZh || a.title, searchQuery());
  titleWrap.append(h3);
  const zhLine = machineTitleNode(a);
  if (zhLine) titleWrap.append(zhLine);
  const actions = el('div', 'art-actions');
  actions.append(shareButton(a), favButton(a));
  top.append(caret, titleWrap, actions);

  const badges = el('div', 'art-badges');
  badges.append(el('span', 'badge dom', a.domain));
  badges.append(el('span', 'badge study s-' + a.studyKey, a.studyZh));
  badges.append(el('span', 'badge ' + (a.basic ? 'bas' : 'clin'), a.basic ? '基础' : '临床'));
  const jr = el('span', 'badge jr');
  fillHighlighted(jr, a.journal, searchQuery());
  badges.append(jr);
  badges.append(starsNode(a.stars));
  if (a.year) badges.append(el('span', 'yr', a.year));

  c.append(top, badges);
  const snip = matchSnippet(a, searchQuery());
  if (snip) {
    const p = el('p', 'search-snip');
    fillHighlighted(p, snip, searchQuery());
    c.append(p);
  }

  let body = null;
  let press = null;
  const pointOf = ev => (ev.touches && ev.touches[0]) || ev;
  const armPress = ev => {
    const t = pointOf(ev);
    if (!t || t.clientX == null) return;
    press = { x: t.clientX, y: t.clientY, moved: false };
  };
  const trackPress = ev => {
    if (!press || press.moved) return;
    const t = pointOf(ev);
    if (!t || t.clientX == null) return;
    if (cardGestureMoved(press, t.clientX, t.clientY)) press.moved = true;
  };
  c.addEventListener('pointerdown', armPress, { passive: true });
  c.addEventListener('pointermove', trackPress, { passive: true });
  c.addEventListener('touchstart', armPress, { passive: true });
  c.addEventListener('touchmove', trackPress, { passive: true });
  c.addEventListener('click', ev => {
    // A vertical pan on the abstract used to bubble as a click and fold the card.
    if (press && press.moved) { press = null; return; }
    // 忽略链接和按钮 —— 否则点「查看英文摘要」会冒泡到这里，把整张卡片折叠掉
    if (ev.target.closest('a, button, input, select, textarea, #mtPop')) return;
    // A drag-selection is not a tap. Opening the card would move the text.
    const sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed && String(sel).trim()) return;
    hideMtPop();
    const open = c.classList.toggle('open');
    if (!open) { if (body) body.remove(); return; }

    if (!body) body = buildArticleBody(a, c);
    c.append(body);
    markSeen(a);
    if (a.pii === undefined) loadPII([a]).then(() => { if (a.pii) addFullTextLink(c, a); });
    requestAnimationFrame(() => c.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  });
  return c;
}

function buildArticleBody(a, card) {
  const body = el('div', 'art-body');
  const d = a.digest;
  const hasDigest = !!(d && DIGEST_FIELDS.some(([k]) => d[k]));

  // 通俗版五段（背景 / 创新点 / 怎么做的 / 看点·临床含义 / 未来方向）—— 每日 LLM 生成，
  // 放在最前面，因为它们比英文摘要更好读。没有 digest 时不显示。
  if (hasDigest) {
    const note = el('div', 'editor-note');
    if (d.topPick && d.topReason) {
      const why = el('div', 'en-row en-why');
      why.append(el('span', 'en-lab', '首选理由'));
      why.append(el('span', 'en-txt', d.topReason));
      note.append(why);
    }
    for (const [key, label] of DIGEST_FIELDS) {
      const txt = String(d[key] || '').trim();
      if (!txt) continue;
      const r = el('div', 'en-row en-' + key);
      r.append(el('span', 'en-lab', label));
      r.append(el('span', 'en-txt', txt));
      note.append(r);
    }
    body.append(note);
  }

  // 英文原标题 + 摘要原文，放在同一个折叠块里。有通俗版时默认折叠。
  const box = el('div', 'rawbox');
  const enTitle = el('div', 'rawtitle');
  enTitle.append(el('span', 'rawtitle-lab', 'EN'));
  const enTxt = el('span', 'rawtitle-txt');
  fillHighlighted(enTxt, a.title, searchQuery());
  enTitle.append(enTxt);
  box.append(enTitle);

  if (a.structured && a.sections) {
    for (const k of ['objective', 'methods', 'results', 'conclusion', 'other']) {
      const txt = a.sections[k];
      if (!txt) continue;
      const row = el('div', 'sec sec-' + k);
      row.append(el('span', 'sec-lab', SEC_LABEL[k] || '其他'));
      const p = el('p', 'sec-txt');
      fillHighlighted(p, txt, searchQuery());
      bindAbstractScroll(p);
      row.append(p);
      box.append(row);
    }
  } else if (a.abstract) {
    const p = el('p', 'art-abstract');
    fillHighlighted(p, a.abstract, searchQuery());
    bindAbstractScroll(p);
    box.append(p);
  }

  if (hasDigest) {
    const t = el('button', 'rawtoggle', '▸ 查看英文原标题与摘要');
    t.type = 'button';
    box.hidden = true;
    t.addEventListener('click', ev => {
      ev.stopPropagation();                       // 双保险：不要冒泡到卡片
      box.hidden = !box.hidden;
      t.textContent = box.hidden ? '▸ 查看英文原标题与摘要' : '▾ 收起英文原标题与摘要';
    });
    body.append(t, box);
  } else {
    body.append(box);
  }

  const meta = el('div', 'art-meta');
  if (a.authors) meta.append(el('span', '', '👤 ' + a.authors));
  if (a.date)    meta.append(el('span', '', '🗓 ' + a.date));
  if (a.imp)     meta.append(el('span', '', `⭐ IF ≈ ${a.imp}`));
  if (a.oa)      meta.append(el('span', '', '🔓 开放获取'));
  body.append(meta);

  const links = el('div', 'art-links');
  const ft = fullTextLink(a);
  if (ft)     links.append(link(ft.href, ft.label, ft.cls));
  if (a.doi)  links.append(link('https://doi.org/' + a.doi, 'DOI 全文', a.pii ? 'alt' : ''));
  if (a.pmid) links.append(link('https://pubmed.ncbi.nlm.nih.gov/' + a.pmid + '/', 'PubMed', 'alt'));
  body.append(links);
  return body;
}

function researchEmpty() {
  if (searchQuery()) {
    return emptyBox('🔍', '没有匹配的文章', '换个关键词，或清空搜索看回当前筛选。', '清除搜索', () => {
      const input = $('#researchSearch');
      if (input) input.value = '';
      setSearchQuery('');
    });
  }
  if (S.jFilter === 'week') {
    if ((S.week.loading || !S.week.loaded) && !weekList().length) {
      return emptyBox('📅', '正在查找最近一周', '从 Crossref 按在线发表日发现，再向 PubMed 要摘要。');
    }
    if (S.week.error && !weekList().length) {
      return emptyBox('📅', '最近一周暂时取不到', '主列表不受影响。稍后点右上角刷新重试。', '重新加载', () => refresh(true));
    }
    return emptyBox('📅', '这 7 天还没有带摘要的新文章', `在线发表日 ${utcDay(-6)} 至 ${utcDay(0)}（UTC）。`);
  }
  if (S.jFilter === 'fav') return emptyBox('♥', '还没有收藏', '点文章卡片右上角的小红心，把想留下来的文献收进这里。收藏只存在这台设备上。');
  if (S.jFilter === 'unread') return emptyBox('✅', '都读完了', '这一轮的新文章你都看过了，等明天的更新吧。');
  return emptyBox('🔍', '这里今天还没有新文章', '摘要入库通常滞后 2–4 天。换个筛选看看。');
}

function renderArticleList(host, list, isPick) {
  host.replaceChildren();
  if (S.jFilter !== 'week' && S.jFilter !== 'fav' && !S.jr.loaded) return;
  if (S.jr.error && !list.length && S.jFilter !== 'week' && S.jFilter !== 'fav') {
    host.append(emptyBox('📡', '数据暂时取不到',
      '网络或接口波动，稍后重试。', '重新加载', () => refresh(true)));
    return;
  }
  if (!list.length) {
    host.append(researchEmpty());
    return;
  }
  const frag = document.createDocumentFragment();
  list.forEach((a, i) => frag.append(articleCard(a, isPick, i + 1)));
  host.append(frag);
}

/** 窄索引表 — # / 期刊 / 类型 / 领域 / 临床或基础 */
function indexLetter(journal) {
  const ch = String(journal || '').trim().charAt(0);
  if (!ch) return '#';
  return /[A-Za-z]/.test(ch) ? ch.toUpperCase() : ch;
}

function sortByJournal(list) {
  return [...list].sort((a, b) => {
    const c = String(a.journal || '').localeCompare(String(b.journal || ''), 'en', { sensitivity: 'base' });
    if (c) return c;
    return String(a.title || '').localeCompare(String(b.title || ''), 'en', { sensitivity: 'base' });
  });
}

function renderIndexTable(host, list) {
  host.replaceChildren();
  if (S.jFilter !== 'week' && S.jFilter !== 'fav' && !S.jr.loaded) return;
  if (!list.length) {
    host.append(researchEmpty());
    return;
  }
  const wrap = el('div', 'idxwrap');
  const t = el('table', 'idx');
  const thead = el('thead');
  const hr = el('tr');
  ['#', '期刊', '类型', '领域', '临/基'].forEach(h => hr.append(el('th', '', h)));
  thead.append(hr);
  const tb = el('tbody');
  let letter = '';
  sortByJournal(list).forEach((a, i) => {
    const L = indexLetter(a.journal);
    if (L !== letter) {
      letter = L;
      const lr = el('tr', 'idx-letter');
      const ltd = el('td', '', L);
      ltd.colSpan = 5;
      lr.append(ltd);
      tb.append(lr);
    }
    const tr = el('tr');
    tr.append(el('td', 'n', String(i + 1)));
    const jd = el('td', 'j');
    fillHighlighted(jd, a.journal, searchQuery());
    tr.append(jd);
    const ts = el('td', 't');
    ts.append(el('span', 'mini s-' + a.studyKey, a.studyZh));
    tr.append(ts);
    const td = el('td', 'd');
    const dot = el('span', 'dot');
    td.append(dot, document.createTextNode(a.domain));
    tr.append(td);
    const tb2 = el('td', 'b');
    tb2.append(el('span', 'mini ' + (a.basic ? 'bas' : 'clin'), a.basic ? '基础' : '临床'));
    tr.append(tb2);
    tr.addEventListener('click', () => openFromIndex(a));
    tb.append(tr);
  });
  t.append(thead, tb);
  wrap.append(t);
  host.append(wrap);
}

function openFromIndex(a) {
  S.jView = 'card';
  if (S.jFilter !== 'pick' && S.jFilter !== 'fav') S.jFilter = 'all';
  syncFavHash();
  renderResearch();
  const node = $(`#researchCards .art[data-id="${CSS.escape(a.id)}"]`);
  if (node) {
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.click();
  }
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
  const byHandle = {};
  for (const p of all) if (p.type === 'x' && p.handle) (byHandle[p.handle] ||= []).push(p);
  for (const [h, arr] of Object.entries(byHandle).sort((a, b) => b[1].length - a[1].length).slice(0, 8)) {
    host.append(chip({ text:'@' + h }, arr.length, S.aFilter === 'h:' + h, () => setAFilter('h:' + h)));
  }

  renderAiSummary();

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
  $('#scrollArea').scrollTo({ top: Math.max(0, $('#builderChips').offsetTop - 96), behavior: 'smooth' });
}

/** 今日 AI 动态总览方框 —— 产品发布 / 新功能 / builder 情绪，用大白话 */
function renderAiSummary() {
  const host = $('#aiSummary');
  if (!host) return;
  const bd = S.bd;
  const has = bd.loaded && (bd.headline || bd.bullets.length || bd.sentiment);
  if (!has) { host.hidden = true; host.replaceChildren(); return; }

  host.hidden = false;
  host.replaceChildren();

  const head = el('div', 'aisum-head');
  head.append(el('span', 'aisum-ico', '✨'));
  head.append(el('span', 'aisum-title', '今日 AI 动态'));
  if (bd.date) head.append(el('span', 'aisum-date', fmtDate(bd.date)));
  host.append(head);

  if (bd.headline) host.append(el('p', 'aisum-headline', bd.headline));

  if (bd.bullets.length) {
    const ul = el('ul', 'aisum-list');
    for (const b of bd.bullets) ul.append(el('li', '', b));
    host.append(ul);
  }

  if (bd.sentiment) {
    const srow = el('div', 'aisum-senti');
    srow.append(el('span', 'aisum-senti-lab', '情绪'));
    srow.append(el('span', 'aisum-senti-txt', bd.sentiment));
    host.append(srow);
  }
}

function postCard(p) {
  const c = el('article', 'card post');
  const top = el('div', 'post-top');
  const av = el('div', 'avatar', initials(p.name));
  const who = el('div', 'who');
  who.append(el('div', 'nm', p.title || p.name));
  who.append(el('div', 'hd', (p.handle ? '@' + p.handle + ' · ' : '') + p.kind));
  top.append(av, who, el('span', 'post-time', relTime(p.date)));

  const txt = el('p', 'post-text clamp');
  txt.textContent = p.text;

  // 一句话中文总结（每日 LLM 生成）—— 放在英文原文之前，先看懂再看原文
  const zh = S.bd.byId.get(p.url || p.id) || '';
  let zhNode = null;
  if (zh) {
    zhNode = el('div', 'post-zh');
    zhNode.append(el('span', 'post-zh-lab', '一句话'));
    zhNode.append(el('span', 'post-zh-txt', zh));
  }

  const foot = el('div', 'post-foot');
  if (p.type === 'x') {
    // ♥ / 💬 render as colour glyphs; the retweet arrow does not on Windows, so use RT.
    foot.append(el('span', 'm', '♥ ' + p.likes), el('span', 'm', 'RT ' + p.rt),
                el('span', 'm', '💬 ' + p.replies));
  }
  if (p.url) {
    const a = el('a', 'go', '查看原文 ↗');
    a.href = p.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    foot.append(a);
  }
  c.append(top);
  if (zhNode) c.append(zhNode);
  c.append(txt, foot);

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
    host.append(emptyBox('📡', '资讯暂时取不到', '上游 feed 波动，稍后重试。', '重新加载', () => refresh(true)));
    return;
  }
  if (!list.length) {
    host.append(emptyBox('🌙', '这个筛选下暂时没有动态', '换个筛选，或稍后再来看看。', null, null));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const p of list) frag.append(postCard(p));
  host.append(frag);
}

/* ---------------- glossary ---------------- */
function openGlossary() {
  $('#glossSheet').hidden = false;
  $('#glossSearch').value = '';
  renderGlossary('');
  setTimeout(() => $('#glossSearch').focus(), 320);
}
function closeGlossary() { $('#glossSheet').hidden = true; }
function glossLetter(en) {
  const ch = String(en || '').trim().charAt(0);
  if (!ch) return '#';
  return /[A-Za-z]/.test(ch) ? ch.toUpperCase() : ch;
}

function renderGlossary(q) {
  const host = $('#glossList');
  const key = q.trim().toLowerCase();
  const list = (key ? S.gloss.filter(g => (g.en + g.zh + g.def).toLowerCase().includes(key)) : S.gloss.slice())
    .sort((a, b) => String(a.en || '').localeCompare(String(b.en || ''), 'en', { sensitivity: 'base' }));
  host.replaceChildren();
  if (!list.length) { host.append(emptyBox('🔍', '没有匹配的术语', '换个关键词试试。', null, null)); return; }
  const frag = document.createDocumentFragment();
  let letter = '';
  for (const g of list) {
    const L = glossLetter(g.en);
    if (L !== letter) {
      letter = L;
      frag.append(el('div', 'gl-letter', L));
    }
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
  const seg = $('#segmented');
  if (seg) seg.dataset.i = tab === 'research' ? '0' : '1';
  $('#panel-research').hidden = tab !== 'research';
  $('#panel-builders').hidden = tab !== 'builders';
  $('#scrollArea').scrollTop = 0;
  $('#brandSub').textContent = tab === 'research' ? '科研雷达 · 临床顶刊每日速递' : '科研雷达 · AI Builder 一手动态';
  if (tab === 'builders' && !S.ai.loaded) loadBuilders(false);
  if (tab === 'builders' && !S.bd.loaded) loadBuilderDigest();
}

/* ---------------- refresh ---------------- */
async function refresh(force = true) {
  const btn = $('#refreshBtn');
  btn.classList.add('spin');
  toast('正在拉取最新数据…', 1600);
  try {
    await Promise.all([loadResearch(true), loadBuilders(true), loadWeek(true)]);
    await loadDigest();                       // 让「重新生成」后新生成的 digest 立刻生效
    await loadBuilderDigest();                // 同上：AI Builder 总览 + 每条动态的一句话也立即生效
    const ok = (S.jr.all.length ? 1 : 0) + (S.ai.all.length ? 1 : 0);
    toast(ok === 2 ? '已更新到最新' : ok === 1 ? '部分数据已更新' : '暂时取不到数据，稍后重试');
  } catch { toast('刷新失败，请检查网络'); }
  finally { btn.classList.remove('spin'); stampFoot(); }
}
function stampFoot() { $('#footTime').textContent = '更新于 ' + relTime(new Date()); }

/* ---------------- 远程触发 GitHub Actions 重新生成 ----------------
   前端点「🔁 重新生成」→ POST 到 Cloudflare Worker → 它用 PAT 调两个
   workflow_dispatch。GitHub 跑完（约 1–2 分钟）后再点 🔄 就能看到新数据。 */
async function triggerRegenerate() {
  const btn = $('#regenBtn');
  if (!WORKER_URL || WORKER_URL.includes('REPLACE-ME')) {
    toast('未配置 Worker 地址，无法远程触发');
    return;
  }
  btn.classList.add('spin');
  toast('正在请求 GitHub 重新生成今日数据…', 2600);
  try {
    const r = await fetch(WORKER_URL, { method: 'POST', mode: 'cors', cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.ok) {
      toast('已触发 ✅ GitHub 正在重新生成，约 1–2 分钟后点 🔄 刷新', 3800);
    } else {
      const fails = data.failed || (data.results || []).filter(x => !x.ok) || [];
      const names = fails.map(f => f.workflow).join('、');
      toast('触发失败：' + (names ? names + ' ' : '') + (data.error || ('HTTP ' + r.status)), 4000);
    }
  } catch {
    toast('触发失败：检查网络或 Worker 地址', 3800);
  } finally {
    btn.classList.remove('spin');
  }
}

/* ---------------- favorites markdown download ----------------
   Cloudflare Email Routing cannot send without a custom domain.
   The 收藏 view writes a local .md file instead of calling
   /api/favorites or the Worker /favorites route. */
function favDoiToken(a) {
  let s = String(a?.doi || '').trim();
  s = s.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  if (!/^10\.\d{4,9}\/\S+$/i.test(s)) return '';
  return s;
}
function favFileDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function oneLine(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}
function favoritesMarkdown(articles, now = new Date()) {
  const date = favFileDate(now);
  const lines = ['# Radar for Meds 收藏', '', `${date} · ${articles.length} 篇`, ''];
  articles.forEach((a, i) => {
    const title = oneLine(favTitle(a)) || '未命名';
    const titleEn = oneLine(a.title || '');
    const doi = favDoiToken(a);
    lines.push('---', '', `## ${i + 1}. ${title}`, '');
    if (titleEn && titleEn !== title) lines.push(titleEn, '');
    lines.push(doi ? `https://doi.org/${doi}` : '（没有 DOI）', '');
    lines.push(favAbstract(a) || '（没有摘要）', '');
  });
  return lines.join('\n').trim() + '\n';
}
function favoritesFilename(now = new Date()) {
  return `radar-favorites-${favFileDate(now)}.md`;
}
function downloadFavoritesMarkdown() {
  const articles = favoriteArticles();
  if (!articles.length) { toast('还没有收藏，先点文章上的小红心'); return; }
  const filename = favoritesFilename();
  const blob = new Blob([favoritesMarkdown(articles)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast('已下载 ' + filename, 2800);
}

/* ---------------- 机翻标题 + 划词翻译 ----------------
   The journal list is a 30-day pool. Machine titles cover that same window,
   tagged 机翻 under the English title. 今日精选 is also translated when a
   pick's date falls just outside the cutoff. An editorial titleZh replaces 机翻.
   normTitle / the cutoff match functions/_lib/mt.js. */
const MT_LS = 'rr.mt.v1';
const SEL_SS = 'rr.selzh.v1';
const MT_DAYS = 30;
const SEL_MAX = 1500;

function normTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/[‐‑–—−]/g, '-')
    .replace(/[‘’′]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .replace(/[.。\s]+$/g, '')
    .trim();
}
function mtCutoff() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - (MT_DAYS - 1));
  return d.toISOString().slice(0, 10);
}
function mtId(a) {
  return String(a?.doi || a?.id || '').trim().toLowerCase();
}
function mtFeatured(a) {
  // An editorial Chinese title already replaces 机翻. A curated pick with no
  // titleZh is still an ordinary paper and should be translated.
  return !!(a?.digest && String(a.digest.titleZh || '').trim());
}
function machineTitleWanted(a, cutoff, pickIds) {
  if (!a?.title || !a.date) return false;
  if (mtFeatured(a)) return false;
  if (String(a.date) >= cutoff) return true;
  const id = mtId(a);
  return !!(id && pickIds && pickIds.has(id));
}
function mtEligible(a) {
  const pickIds = new Set();
  for (const p of S.jr.picks || []) {
    const id = mtId(p);
    if (id) pickIds.add(id);
  }
  return machineTitleWanted(a, mtCutoff(), pickIds);
}
function mtLists() {
  return [S.jr.all, S.jr.picks, S.week && S.week.items];
}
function findArticleById(id) {
  const key = String(id || '');
  for (const list of mtLists()) {
    const hit = (list || []).find(a => a.id === key || mtId(a) === key.toLowerCase());
    if (hit) return hit;
  }
  return null;
}
function indexTitleSeed(data) {
  S.mt.byDoi = new Map();
  S.mt.byNorm = new Map();
  for (const it of data?.items || []) {
    const zh = String(it?.zh || '').trim();
    if (!zh) continue;
    const norm = normTitle(it.en || '');
    const rec = { zh, norm };
    if (it.doi) S.mt.byDoi.set(String(it.doi).toLowerCase(), rec);
    if (norm) S.mt.byNorm.set(norm, rec);
  }
}
function readLocalMt() {
  S.mt.local = new Map();
  try {
    const raw = JSON.parse(localStorage.getItem(MT_LS) || '[]');
    if (!Array.isArray(raw)) return;
    for (const row of raw) {
      if (!row?.zh) continue;
      if (row.id) S.mt.local.set(String(row.id).toLowerCase(), row);
      if (row.norm) S.mt.local.set('t:' + row.norm, row);
    }
  } catch { /* private mode */ }
}
function rememberMt(a, zh) {
  const id = mtId(a);
  const norm = normTitle(a.title);
  const row = { id, norm, zh };
  if (id) S.mt.local.set(id, row);
  if (norm) S.mt.local.set('t:' + norm, row);
  const list = [];
  const seen = new Set();
  for (const [k, v] of S.mt.local) {
    if (String(k).startsWith('t:')) continue;
    const key = v.id || v.norm;
    if (!key || !v.zh || seen.has(key)) continue;
    seen.add(key);
    list.push({ id: v.id || '', norm: v.norm || '', zh: v.zh });
  }
  for (const [k, v] of S.mt.local) {
    if (!String(k).startsWith('t:') || v.id || !v.norm || seen.has(v.norm)) continue;
    seen.add(v.norm);
    list.push({ id: '', norm: v.norm, zh: v.zh });
  }
  try { localStorage.setItem(MT_LS, JSON.stringify(list.slice(0, 400))); }
  catch { /* quota */ }
}
function lookupMt(a) {
  const id = mtId(a);
  const norm = normTitle(a.title);
  let zh = '';
  const doiHit = id && S.mt.byDoi.get(id);
  if (doiHit && (!doiHit.norm || doiHit.norm === norm)) zh = doiHit.zh;
  else {
    const normHit = norm && S.mt.byNorm.get(norm);
    if (normHit) zh = normHit.zh;
    else {
      const local = (id && S.mt.local.get(id)) || (norm && S.mt.local.get('t:' + norm));
      if (local && local.zh && (!local.norm || local.norm === norm)) zh = local.zh;
    }
  }
  if (!zh) return '';
  return preserveTitleContrast(a.title, stripTitleMeta(zh));
}
function applyCachedMt(a) {
  if (!mtEligible(a)) return false;
  const zh = lookupMt(a);
  if (!zh) return false;
  a.mtZh = stripTitleMeta(zh);
  return true;
}
function applyAllCachedMt() {
  for (const list of mtLists()) for (const a of list || []) applyCachedMt(a);
}
function machineTitleNode(a) {
  if (!a?.mtZh || !mtEligible(a)) return null;
  const p = el('p', 'art-zh');
  const t = el('span', 'art-zh-txt');
  fillHighlighted(t, stripTitleMeta(a.mtZh), searchQuery());
  p.append(t, el('span', 'art-zh-tag', '机翻'));
  return p;
}
function patchMachineTitles() {
  for (const card of document.querySelectorAll('#researchCards .card.art')) {
    const a = findArticleById(card.dataset.id || '');
    if (!a) continue;
    let line = card.querySelector('.art-zh');
    if (!a.mtZh || !mtEligible(a)) { if (line) line.remove(); continue; }
    if (!line) {
      line = machineTitleNode(a);
      const h3 = card.querySelector('.art-title');
      if (line && h3) h3.after(line);
      continue;
    }
    const t = line.querySelector('.art-zh-txt');
    if (t) fillHighlighted(t, stripTitleMeta(a.mtZh), searchQuery());
  }
}
async function loadTitleSeed() {
  if (S.mt.seeded) return;
  readLocalMt();
  try {
    const data = await fetchJSON('data/title-zh.json', 12000);
    indexTitleSeed(data);
  } catch (e) { console.warn('[mt] seed', e); }
  S.mt.seeded = true;
  if (!(S.jr.all && S.jr.all.length)) return;
  if (document.querySelector('.card.art.open')) {
    applyAllCachedMt();
    patchMachineTitles();
    queueMachineTitles();
  } else renderResearch();
}
function queueMachineTitles() {
  if (!S.mt.seeded || S.mt.stop) return;
  if (queueMachineTitles.running) { queueMachineTitles.dirty = true; return; }
  const need = [];
  const seen = new Set();
  for (const list of [S.jr.picks, S.jr.all, S.week && S.week.items]) {
    for (const a of list || []) {
      if (!mtEligible(a) || a.mtZh) continue;
      const id = mtId(a);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      need.push(a);
    }
  }
  if (!need.length) return;
  queueMachineTitles.running = true;
  queueMachineTitles.dirty = false;
  queueMachineTitles.passes = (queueMachineTitles.passes || 0) + 1;
  (async () => {
    let failed = false;
    try {
      for (let i = 0; i < need.length; i += 10) {
        if (S.mt.stop) break;
        const batch = need.slice(i, i + 10).filter(a => mtEligible(a) && !a.mtZh);
        if (!batch.length) continue;
        let applied = false;
        for (let attempt = 0; attempt < 2 && !applied && !S.mt.stop; attempt++) {
          if (attempt) await sleep(500 * attempt);
          let res, data = {};
          try {
            res = await fetch('/api/translate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                mode: 'titles',
                items: batch.map(a => ({ id: mtId(a), text: a.title })),
              }),
            });
            data = await res.json().catch(() => ({}));
          } catch (e) {
            console.warn('[mt] titles', e);
            continue;
          }
          if (data.error === 'quota' || res.status === 429) { S.mt.stop = 'quota'; break; }
          if (data.error === 'ai_unconfigured' || res.status === 503) { S.mt.stop = 'unconfigured'; break; }
          const items = (data.items || []).filter(item => item && item.zh);
          if (!res.ok || !items.length) continue;
          for (const item of items) {
            const id = String(item.id || '').toLowerCase();
            const src = batch.find(a => mtId(a) === id);
            const zh = preserveTitleContrast((src && src.title) || '', stripTitleMeta(item.zh));
            if (!zh) continue;
            for (const list of mtLists()) {
              for (const other of list || []) {
                if (mtId(other) !== id) continue;
                other.mtZh = zh;
                rememberMt(other, zh);
              }
            }
          }
          applied = true;
          patchMachineTitles();
        }
        if (!applied && !S.mt.stop) failed = true;
      }
    } finally {
      queueMachineTitles.running = false;
      const again = queueMachineTitles.dirty || failed;
      if (!S.mt.stop && again && queueMachineTitles.passes < 3) queueMachineTitles();
    }
  })();
}

let mtPopToken = 0;
let mtPopText = '';
function selCacheMap() {
  if (selCacheMap.m) return selCacheMap.m;
  const m = new Map();
  try {
    const arr = JSON.parse(sessionStorage.getItem(SEL_SS) || '[]');
    if (Array.isArray(arr)) for (const row of arr) if (row && row[0] && row[1]) m.set(row[0], row[1]);
  } catch { /* private mode */ }
  selCacheMap.m = m;
  return m;
}
function rememberSel(text, zh) {
  const m = selCacheMap();
  const key = text.toLowerCase();
  m.delete(key);
  m.set(key, zh);
  const arr = [...m.entries()].slice(-40);
  selCacheMap.m = new Map(arr);
  try { sessionStorage.setItem(SEL_SS, JSON.stringify(arr)); } catch { /* quota */ }
}
function hideMtPop() {
  mtPopToken++;
  mtPopText = '';
  const pop = $('#mtPop');
  if (!pop) return;
  pop.hidden = true;
  pop.classList.remove('is-warn');
  pop.replaceChildren();
}
function placeMtPop(rect) {
  const pop = $('#mtPop');
  if (!pop || pop.hidden || !rect) return;
  const margin = 8;
  const w = pop.offsetWidth || 220;
  const h = pop.offsetHeight || 40;
  const below = rect.top < window.innerHeight * 0.62;
  let top = below ? rect.bottom + margin : rect.top - h - margin;
  if (top < 8) top = rect.bottom + margin;
  if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - margin);
  let left = rect.left;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  pop.style.top = Math.round(top) + 'px';
  pop.style.left = Math.round(left) + 'px';
}
function fillMtPop(text, warn) {
  const pop = $('#mtPop');
  if (!pop) return;
  pop.classList.toggle('is-warn', !!warn);
  pop.replaceChildren(el('span', 'mt-pop-tag', '机翻'), el('span', 'mt-pop-txt', text));
  pop.hidden = false;
}
function looksEnglish(text) {
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  return latin >= 2 && latin >= cjk;
}
function readMtSelection() {
  const sel = window.getSelection && window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const text = String(sel).replace(/\s+/g, ' ').trim();
  const node = sel.anchorNode;
  const hostEl = node && (node.nodeType === 1 ? node : node.parentElement);
  if (!hostEl || !hostEl.closest) return { dismiss: true };
  if (hostEl.closest('#mtPop')) return null;
  if (hostEl.closest('button, a, input, textarea, .sheet')) return { dismiss: true };
  const host = hostEl.closest('.art-title, .art-zh-txt, .rawtitle-txt, .sec-txt, .art-abstract, .search-snip');
  if (!host || text.length < 2 || (text.length <= SEL_MAX && !looksEnglish(text))) return { dismiss: true };
  let rect = null;
  try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch { rect = null; }
  if (!rect || (!rect.width && !rect.height)) return null;
  return { text, rect };
}
function scheduleMtPop() {
  clearTimeout(scheduleMtPop.t);
  scheduleMtPop.t = setTimeout(syncMtPop, 420);
}
async function syncMtPop() {
  const cur = readMtSelection();
  if (!cur) return;
  if (cur.dismiss) { hideMtPop(); return; }
  if (cur.text === mtPopText && $('#mtPop') && !$('#mtPop').hidden) {
    placeMtPop(cur.rect);
    return;
  }
  mtPopText = cur.text;
  const token = ++mtPopToken;
  const rect = cur.rect;
  if (cur.text.length > SEL_MAX) {
    fillMtPop('选中的文字太长了（最多 1500 字），请缩短后再试。', true);
    placeMtPop(rect);
    return;
  }
  const cached = selCacheMap().get(cur.text.toLowerCase());
  if (cached) {
    fillMtPop(cached, false);
    placeMtPop(rect);
    return;
  }
  fillMtPop('翻译中…', false);
  placeMtPop(rect);
  try {
    const res = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'selection', text: cur.text }),
    });
    const data = await res.json().catch(() => ({}));
    if (token !== mtPopToken) return;
    if (data.error === 'quota' || res.status === 429) {
      fillMtPop(data.message || '今天的免费翻译额度用完了，明天会恢复。', true);
    } else if (data.error === 'too_long') {
      fillMtPop(data.message || '选中的文字太长了（最多 1500 字），请缩短后再试。', true);
    } else if (!res.ok || !data.zh) {
      fillMtPop(data.message || '翻译失败，请再选一次试试。', true);
    } else {
      rememberSel(cur.text, data.zh);
      fillMtPop(data.zh, false);
    }
    placeMtPop(rect);
  } catch {
    if (token !== mtPopToken) return;
    fillMtPop('翻译失败，请再选一次试试。', true);
    placeMtPop(rect);
  }
}

/* ---------------- share: citation file + image card ---------------- */
const JOURNAL_ZH = {
  'Lancet': '《柳叶刀》',
  'Lancet Oncol': '《柳叶刀·肿瘤学》',
  'Lancet Neurol': '《柳叶刀·神经病学》',
  'Lancet Infect Dis': '《柳叶刀·传染病》',
  'Lancet Respir Med': '《柳叶刀·呼吸医学》',
  'Lancet Diabetes Endo': '《柳叶刀·糖尿病与内分泌学》',
  'Lancet Gastro Hepat': '《柳叶刀·胃肠病学和肝病学》',
  'Lancet Haematol': '《柳叶刀·血液学》',
  'Lancet Psychiatry': '《柳叶刀·精神病学》',
  'Lancet Public Health': '《柳叶刀·公共卫生》',
  'Lancet Glob Health': '《柳叶刀·全球健康》',
  'Lancet Digit Health': '《柳叶刀·数字健康》',
  'Lancet Child Adolesc': '《柳叶刀·儿童与青少年健康》',
  'Lancet Rheumatol': '《柳叶刀·风湿病学》',
  'Lancet HIV': '《柳叶刀·HIV》',
  'Lancet Microbe': '《柳叶刀·微生物》',
  'EClinicalMedicine': '《e临床医药》',
  'Lancet Planet Health': '《柳叶刀·星球健康》',
  'Lancet Healthy Longev': '《柳叶刀·健康长寿》',
  'JACC': '《美国心脏病学会杂志》',
  'JACC Interv': '《JACC 介入》',
  'JACC Heart Fail': '《JACC 心力衰竭》',
  'JACC Imaging': '《JACC 影像》',
  'JACC Clin EP': '《JACC 临床电生理》',
  'JACC Basic Transl': '《JACC 基础与转化》',
  'JACC CardioOncol': '《JACC 心脏肿瘤》',
  'JACC Adv': '《JACC 进展》',
  'Circulation': '《循环》',
  'Chest': '《胸》',
  'Ophthalmology': '《眼科学》',
  'Ophthalmol Retina': '《眼科学·视网膜》',
  'Am J Ophthalmol': '《美国眼科杂志》',
  'JAMA Ophthalmol': '《美国医学会眼科杂志》',
  'Br J Ophthalmol': '《英国眼科杂志》',
  'Prog Retin Eye Res': '《视网膜与眼研究进展》',
  'IOVS': '《眼科研究与视觉科学》',
  'Surv Ophthalmol': '《眼科学综述》',
  'Eye': '《眼》',
  'Ann Oncol': '《肿瘤学年鉴》',
  'J Hepatol': '《肝脏病学杂志》',
  'Kidney Int': '《肾脏国际》',
  'JAAD': '《美国皮肤病学会杂志》',
  'Eur Urol': '《欧洲泌尿学》',
  'J Vasc Surg': '《血管外科杂志》',
  'Eur J Vasc Endovasc': '《欧洲血管与腔内血管外科杂志》',
  'J Vasc Surg Venous': '《血管外科杂志·静脉与淋巴》',
  'J Endovasc Ther': '《腔内治疗杂志》',
  'Ann Vasc Surg': '《血管外科年鉴》',
  'Semin Vasc Surg': '《血管外科研讨》',
  'Vascular': '《血管》',
  'Vasc Endovasc Surg': '《血管与腔内外科》',
  'Cell': '《细胞》',
  'Nature': '《自然》',
  'Science': '《科学》',
  'NEJM': '《新英格兰医学杂志》',
  'BMJ': '《英国医学杂志》',
  'Nat Genet': '《自然·遗传学》',
  'Nat Immunol': '《自然·免疫学》',
  'Cell Stem Cell': '《细胞·干细胞》',
  'Sci Transl Med': '《科学·转化医学》',
  'Sci Adv': '《科学进展》',
  'Cell Rep': '《细胞报告》',
  'Cell Host Microbe': '《细胞·宿主与微生物》',
  'Cell Syst': '《细胞系统》',
  'Nat Biomed Eng': '《自然·生物医学工程》',
  'Nat Biotechnol': '《自然·生物技术》',
  'Nat Neurosci': '《自然·神经科学》',
  'Neuron': '《神经元》',
};

function shareButton(a) {
  const b = el('button', 'share-btn');
  b.type = 'button';
  b.setAttribute('aria-label', '分享');
  b.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 4.5v9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M8.2 8.2L12 4.4l3.8 3.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 12.5V18a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 18v-5.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  b.addEventListener('click', ev => {
    ev.preventDefault();
    ev.stopPropagation();
    openShareSheet(a);
  });
  return b;
}

function journalZhName(a) {
  return JOURNAL_ZH[a?.journal] || JOURNAL_ZH[journalRow(a)?.short] || '';
}
function fileStem(a) {
  return 'radar-' + String(a?.doi || a?.pmid || a?.id || 'article').replace(/[^\w.-]+/g, '_').slice(0, 80);
}
function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
/** Chinese slot must contain Han text. An echo of the English sentence is not a translation. */
function quoteZhOk(zh) {
  const z = String(zh || '').trim();
  const han = (z.match(/[\u4e00-\u9fff]/g) || []).length;
  if (han < 2) return false;
  const latin = (z.match(/[A-Za-z]/g) || []).length;
  return !(latin > 24 && latin > han * 3);
}
function exactQuote(en, blobs) {
  const needle = String(en || '').replace(/\s+/g, ' ').trim();
  if (!needle) return '';
  const hay = (Array.isArray(blobs) ? blobs : [blobs]).map(b => String(b || '').replace(/\s+/g, ' ')).join('\n');
  const parts = needle.split(' … ');
  for (const part of parts) {
    const core = part.replace(/…/g, '').replace(/\s+/g, ' ').trim();
    if (!core || !hay.includes(core)) return '';
  }
  return needle;
}
const QUOTE_LS = 'rr.quotes.v15';
function quoteKey(a, abs) {
  let h = 5381;
  const s = String(abs || '').slice(0, 4000);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (a?.id || a?.doi || '') + ':' + (h >>> 0).toString(16);
}
function readQuoteCache(key) {
  try {
    const arr = JSON.parse(localStorage.getItem(QUOTE_LS) || '[]');
    const hit = Array.isArray(arr) ? arr.find(row => row && row.key === key) : null;
    return hit?.quotes || null;
  } catch { return null; }
}
function writeQuoteCache(key, quotes) {
  try {
    const prev = JSON.parse(localStorage.getItem(QUOTE_LS) || '[]');
    const next = (Array.isArray(prev) ? prev : []).filter(row => row && row.key !== key);
    next.push({ key, quotes });
    localStorage.setItem(QUOTE_LS, JSON.stringify(next.slice(-80)));
  } catch { /* private mode or quota */ }
}
async function fetchQuotes(a) {
  const abs = favAbstract(a);
  if (!abs) return { error: '这篇没有英文摘要，做不了摘句卡片。' };
  const key = quoteKey(a, abs);
  const cached = readQuoteCache(key);
  if (cached?.length) return { quotes: cached };
  let res;
  try {
    res = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'quotes',
        id: a.id || a.doi || '',
        doi: a.doi || '',
        abstract: abs.slice(0, 12000),
        sections: a.sections || undefined,
      }),
    });
  } catch {
    return { error: '摘句翻译失败，请再试一次。' };
  }
  const data = await res.json().catch(() => ({}));
  if (data.error === 'quota' || res.status === 429) {
    return { error: data.message || '今天的免费翻译额度用完了，明天会恢复。' };
  }
  if (!res.ok || !Array.isArray(data.quotes)) {
    return { error: data.message || '摘句翻译失败，请再试一次。' };
  }
  const quotes = [];
  for (const q of data.quotes) {
    const blobs = [abs];
    if (q?.sentence) blobs.push(q.sentence);
    if (Array.isArray(q?.sentences)) blobs.push(...q.sentences);
    const en = exactQuote(q?.en, blobs);
    const zh = String(q?.zh || '').trim();
    if (en && zh && quoteZhOk(zh)) quotes.push({ en, zh, role: q?.role || '', source: q?.source || 'abstract', sentence: q?.sentence || '' });
  }
  if (!quotes.length) return { error: '没有从摘要里抽出可用的原句。' };
  const out = quotes.slice(0, 4);
  writeQuoteCache(key, out);
  return { quotes: out };
}
async function ensureCardTitle(a) {
  const editorial = stripTitleMeta(a?.digest && a.digest.titleZh);
  if (editorial) return editorial;
  const cached = stripTitleMeta(a.mtZh || lookupMt(a));
  if (cached) return cached;
  const res = await fetch('/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'titles', items: [{ id: a.id || a.doi || a.title, text: a.title }] }),
  });
  const data = await res.json().catch(() => ({}));
  const zh = preserveTitleContrast(a.title, stripTitleMeta(data.items && data.items[0] && data.items[0].zh));
  if (zh) {
    rememberMt(a, zh);
    if (mtEligible(a)) { a.mtZh = zh; patchMachineTitles(); }
    return zh;
  }
  if (data.error === 'quota' || res.status === 429) {
    throw new Error(data.message || '今天的免费翻译额度用完了，明天会恢复。');
  }
  throw new Error(data.message || '标题翻译失败，请再试一次。');
}
function cardSpec(a, titleZh, quotes, target) {
  const names = window.RRCite.authorList(a);
  const jzh = journalZhName(a);
  return {
    title_zh: titleZh,
    title_en: a.title || '',
    quotes,
    journal: a.journal || '',
    journal_en: a.journal || '',
    journal_zh: jzh,
    date: String(a.date || '').slice(0, 10),
    type: 'Article',
    type_line: '研究论文',
    article_no: [a.volume ? 'Vol ' + a.volume : '', a.issue ? 'Issue ' + a.issue : '', a.pages ? String(a.pages).replace(/(\d)-(\d)/g, '$1–$2') : ''].filter(Boolean).join(', '),
    doi: a.doi || '',
    authors: window.RRCite.etAl(names),
    url: target.url,
    qr_note: '链接直达 ' + target.name + ' 全文',
    qr_sub: a.oa ? (a.licenseLabel ? '开放获取（' + a.licenseLabel + '）' : '开放获取') : '访问以机构订阅为准',
    published_online: !!a.publishedOnline,
    corner_fill: '#111111',
    labels: false,
  };
}
function shareChoice(strong, sub) {
  const b = el('button', 'share-choice');
  b.type = 'button';
  b.append(el('strong', '', strong), el('span', '', sub));
  return b;
}
function openShareSheet(a) {
  hideMtPop();
  const sheet = $('#shareSheet');
  const body = $('#shareBody');
  const title = $('#shareTitle');
  if (!sheet || !body || !title || !window.RRCite) return;
  title.textContent = '分享';
  body.replaceChildren();
  const citeBtn = shareChoice('导出文献', '下载 RIS、BibTeX，或复制一条 Vancouver 引用');
  const imgBtn = shareChoice('分享图片', '生成卡片，用系统分享发到微信、邮件或其他应用');
  citeBtn.addEventListener('click', () => showCiteChoices(a));
  imgBtn.addEventListener('click', () => showShareImage(a));
  body.append(citeBtn, imgBtn);
  sheet.hidden = false;
}
function showCiteChoices(a) {
  const body = $('#shareBody');
  const title = $('#shareTitle');
  title.textContent = '导出文献';
  body.replaceChildren();
  const ris = shareChoice('下载 RIS', 'EndNote、Zotero、Mendeley');
  const bib = shareChoice('下载 BibTeX', 'LaTeX 与多数文献库');
  const van = shareChoice('复制 Vancouver 引用', '纯文本，可粘贴到邮件或微信');
  ris.addEventListener('click', () => {
    downloadBlob(fileStem(a) + '.ris', new Blob([window.RRCite.ris(a)], { type: 'application/x-research-info-systems' }));
    toast('已下载 RIS');
  });
  bib.addEventListener('click', () => {
    downloadBlob(fileStem(a) + '.bib', new Blob([window.RRCite.bibtex(a)], { type: 'application/x-bibtex' }));
    toast('已下载 BibTeX');
  });
  van.addEventListener('click', async () => {
    const text = window.RRCite.vancouver(a);
    try {
      await navigator.clipboard.writeText(text);
      toast('引用已复制');
    } catch {
      downloadBlob(fileStem(a) + '.txt', new Blob([text], { type: 'text/plain;charset=utf-8' }));
      toast('剪贴板不可用，已下载文本');
    }
  });
  body.append(ris, bib, van);
}
let shareGen = 0;
async function showShareImage(a) {
  const gen = ++shareGen;
  const body = $('#shareBody');
  const title = $('#shareTitle');
  title.textContent = '分享图片';
  body.replaceChildren(el('p', 'share-status', '正在确认全文链接，并挑选值得读的原文…'));
  try {
    if (a.doi && !a.pii) {
      if (a.pii === '') a.pii = undefined;
      try { await loadPII([a]); } catch { /* DOI remains available */ }
    }
    if (gen !== shareGen) return;
    const target = window.RRCite.shareTarget({
      pii: a.pii,
      platforms: articlePlatforms(a),
      doi: a.doi,
      pmid: a.pmid,
    });
    if (!target) throw new Error('这篇文章没有可分享的链接。');
    const [titleZh, quoteRes, pub] = await Promise.all([ensureCardTitle(a), fetchQuotes(a), publisherRecord(a)]);
    if (gen !== shareGen) return;
    if (quoteRes.error) throw new Error(quoteRes.error);
    if (pub) {
      a.oa = pub.oa;
      a.volume = reliableVolume(a.volume, pub.volume);
      if (pub.issue) a.issue = String(pub.issue);
      const have = reliablePages(a.pages);
      const next = reliablePages(pub.pages);
      a.pages = have && next && have !== next ? '' : (have || next);
      a.licenseLabel = pub.licenseLabel || '';
      a.publishedOnline = !!pub.publishedOnline;
    }
    body.replaceChildren(el('p', 'share-status', '正在排版…'));
    const canvas = await window.RRCard.render(cardSpec(a, titleZh, quoteRes.quotes, target));
    if (gen !== shareGen) return;
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('图片生成失败'))), 'image/png');
    });
    const file = new File([blob], fileStem(a) + '.png', { type: 'image/png' });
    paintShareResult(body, canvas, file, target.name);
  } catch (err) {
    if (gen !== shareGen) return;
    body.replaceChildren(el('p', 'share-status is-warn', err.message || '图片生成失败，请再试一次。'));
  }
}
function paintShareResult(body, canvas, file, platform) {
  body.replaceChildren();
  const img = document.createElement('img');
  img.className = 'share-preview';
  img.alt = '分享卡片';
  img.src = canvas.toDataURL('image/png');
  const note = el('p', 'share-note', '二维码指向 ' + platform + '。iPhone 上点「系统分享」，微信、邮件以及已安装且接收图片的应用会出现在系统面板里。微信内置浏览器通常不支持文件分享，请长按图片保存。');
  const row = el('div', 'share-row');
  const share = shareChoice('系统分享', '微信 / 邮件 / 其他应用');
  const save = shareChoice('保存图片', '下载 PNG，或长按预览图');
  share.addEventListener('click', async () => {
    const payload = { files: [file], title: file.name };
    if (navigator.canShare && navigator.canShare(payload)) {
      try { await navigator.share(payload); return; }
      catch (err) { if (err && err.name === 'AbortError') return; }
    }
    downloadBlob(file.name, file);
    toast('这台浏览器不能直接分享文件，已改为下载');
  });
  save.addEventListener('click', () => {
    downloadBlob(file.name, file);
    toast('已下载图片');
  });
  row.append(share, save);
  body.append(img, note, row);
}
function closeShareSheet() {
  shareGen++;
  const sheet = $('#shareSheet');
  if (sheet) sheet.hidden = true;
}

/* ---------------- boot ---------------- */
async function boot() {
  window.__rr = S;                 // debug/QA hook
  S.fullTextLink = fullTextLink;
  S.articlePlatforms = articlePlatforms;
  S.seen = readSeen();
  S.fav = readFav();
  if (location.hash === '#fav') S.jFilter = 'fav';
  const seedP = loadTitleSeed();

  const c = readCache();
  if (c.week?.data?.items?.length) {
    S.week = { items: c.week.data.items, loaded: true, loading: false, error: '' };
  }
  if (c.jr?.data?.all?.length) {
    const d = c.jr.data;
    d.picks = d.picks?.length ? d.picks : curate(d.all);
    S.jr = { ...d, loaded: true };
    renderResearch();
    loadPII(S.jr.picks);
  }
  if (c.ai?.data?.all?.length) { S.ai = { ...c.ai.data, loaded: true }; renderBuilders(); }

  try {
    const [cfg, gloss] = await Promise.all([
      fetchJSON('data/journals.config.json', 15000),
      fetchJSON('data/glossary.json', 15000).catch(() => []),
    ]);
    S.cfg = cfg || [];
    S.gloss = gloss || [];
  } catch (e) { console.warn('[boot] config load failed:', e); S.cfg = []; S.gloss = []; }

  renderResearch();
  renderBuilders();

  loadWeek(false);
  await loadResearch(false);
  await loadDigest();                    // maps 创新/看点 onto S.jr.all, then re-renders
  await seedP;                           // 机翻标题种子；不挡首屏，到了再补一行中文
  await loadBuilderDigest();             // 今日 AI 动态总览 + 每条动态的中文一句话
  if (S.tab === 'builders') await loadBuilders(false);
  stampFoot();

  setTimeout(() => { if (!S.ai.loaded) loadBuilders(false); }, 1200);
  setTimeout(() => {
    // The first load already paged Europe PMC. Don't page it again immediately.
    if (Date.now() - jrLiveAt < 2 * 60e3) loadBuilders(true);
    else { loadResearch(true); loadBuilders(true); }
  }, 2500);
}

/* ---------------- 正文字号 / 加粗 ----------------
   Slider is 100–150% of today's size. 100% is the minimum and the default.
   Only --read copy grows. Badges, chips, tabs, and the share-card image stay put.
   rr.text.v1 stores the percent (legacy md = 110, lg = 120). rr.bold.v1 is "1" when bold. */
const TEXT_KEY = 'rr.text.v1';
const BOLD_KEY = 'rr.bold.v1';
function textPercent(raw) {
  if (raw === 'md') return 110;
  if (raw === 'lg') return 120;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 100) return 100;
  if (n > 150) return 150;
  return n;
}
function boldOn(raw) {
  return raw === '1';
}
function applyTextSize(raw) {
  const pct = textPercent(raw);
  const root = document.documentElement;
  if (pct === 100) root.style.removeProperty('--read');
  else root.style.setProperty('--read', (pct / 100).toFixed(2));
  try {
    if (pct === 100) localStorage.removeItem(TEXT_KEY);
    else localStorage.setItem(TEXT_KEY, String(pct));
  } catch { /* private mode */ }
  const range = $('#typeRange');
  const out = $('#typeOut');
  if (range) {
    range.value = String(pct);
    range.setAttribute('aria-valuenow', String(pct));
    range.setAttribute('aria-valuetext', pct + '%');
  }
  if (out) out.textContent = pct + '%';
  return pct;
}
function applyBold(on) {
  const root = document.documentElement;
  if (on) root.setAttribute('data-bold', '');
  else root.removeAttribute('data-bold');
  try {
    if (on) localStorage.setItem(BOLD_KEY, '1');
    else localStorage.removeItem(BOLD_KEY);
  } catch { /* private mode */ }
  const btn = $('#boldBtn');
  if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  return on;
}
function setTypeOpen(open) {
  const pop = $('#typePop');
  const btn = $('#typeBtn');
  if (!pop || !btn) return;
  pop.hidden = !open;
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

/* ---------------- wire up ---------------- */
$$('.seg').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
try { applyTextSize(localStorage.getItem(TEXT_KEY)); } catch { applyTextSize(100); }
try { applyBold(boldOn(localStorage.getItem(BOLD_KEY))); } catch { applyBold(false); }
const typeBtn = $('#typeBtn');
if (typeBtn) typeBtn.addEventListener('click', () => {
  const pop = $('#typePop');
  setTypeOpen(!pop || pop.hidden);
});
const typeRange = $('#typeRange');
if (typeRange) typeRange.addEventListener('input', e => applyTextSize(e.target.value));
const boldBtn = $('#boldBtn');
if (boldBtn) boldBtn.addEventListener('click', () => {
  applyBold(!document.documentElement.hasAttribute('data-bold'));
});
$('#refreshBtn').addEventListener('click', () => refresh(true));
$('#regenBtn').addEventListener('click', triggerRegenerate);
$('#glossSearch').addEventListener('input', e => renderGlossary(e.target.value));
const researchSearch = $('#researchSearch');
if (researchSearch) researchSearch.addEventListener('input', e => setSearchQuery(e.target.value));
const researchSearchClear = $('#researchSearchClear');
if (researchSearchClear) researchSearchClear.addEventListener('click', () => {
  if (researchSearch) { researchSearch.value = ''; researchSearch.focus(); }
  setSearchQuery('');
});
$('#glossSheet').addEventListener('click', e => { if (e.target.closest('[data-close]')) closeGlossary(); });
const downloadFavBtn = $('#downloadFavBtn');
if (downloadFavBtn) downloadFavBtn.addEventListener('click', () => downloadFavoritesMarkdown());
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  setTypeOpen(false);
  hideMtPop();
  closeShareSheet();
  closeGlossary();
});
const shareSheetEl = $('#shareSheet');
if (shareSheetEl) shareSheetEl.addEventListener('click', e => {
  if (e.target.closest('[data-close]')) closeShareSheet();
});
document.addEventListener('selectionchange', scheduleMtPop);
document.addEventListener('pointerdown', e => {
  const t = e.target;
  if (!(t instanceof Element)) return;
  if (!t.closest('#typeBtn, #typePop')) setTypeOpen(false);
  if (t.closest('#mtPop, .art-title, .art-zh, .rawtitle-txt, .sec-txt, .art-abstract, .search-snip')) return;
  hideMtPop();
});
const mtPop = $('#mtPop');
if (mtPop) {
  // Keep the popup up when the finger lands on it. iOS otherwise clears the
  // selection and selectionchange would race the read.
  mtPop.addEventListener('pointerdown', e => e.preventDefault());
  mtPop.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
}
const scrollArea = $('#scrollArea');
if (scrollArea) scrollArea.addEventListener('scroll', () => {
  setTypeOpen(false);
  hideMtPop();
}, { passive: true });
window.addEventListener('hashchange', () => {
  const on = location.hash === '#fav';
  if (on && S.jFilter !== 'fav') setJFilter('fav');
  else if (!on && S.jFilter === 'fav') setJFilter('pick');
});

$$('.viewtog button').forEach(b => b.addEventListener('click', () => {
  S.jView = b.dataset.view;
  $$('.viewtog button').forEach(x => {
    const on = x.dataset.view === S.jView;
    x.classList.toggle('is-active', on);
    x.setAttribute('aria-pressed', String(on));
  });
  renderResearch();
}));

const markAll = $('#markAllRead');
if (markAll) markAll.addEventListener('click', () => {
  S.jr.all.forEach(a => S.seen.add(a.id));
  writeSeen();
  toast('已把 ' + S.jr.all.length + ' 篇标为已读');
  renderResearch();
});

/* ---------------- 版本更新 ---------------- */
function markUpdateReady() {
  const dot = $('#verDot'), lab = $('#verLabel'), b = $('#verBtn');
  if (dot) dot.hidden = false;
  if (lab) lab.textContent = '发现新版本 · 点此更新';
  if (b) b.classList.add('has-update');
}

/** 强制拉最新版本：注销 SW + 清空所有缓存 + 带 cache-busting 重新加载 */
async function forceUpdate() {
  const b = $('#verBtn');
  if (b) b.classList.add('spin');
  toast('正在检查新版本…', 1600);
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.update().catch(() => {})));
      await Promise.all(regs.map(r => r.unregister().catch(() => {})));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k).catch(() => {})));
    }
  } catch { /* 忽略 —— 下面照样硬刷新 */ }
  const u = new URL(location.href);
  u.searchParams.set('_u', Date.now().toString(36));
  location.replace(u.toString());
}

(function wireVersion() {
  const b = $('#verBtn'), lab = $('#verLabel');
  if (lab) lab.textContent = '版本 ' + APP_VERSION;
  if (b) b.addEventListener('click', forceUpdate);

  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(reg => {
      const watch = w => w && w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) markUpdateReady();
      });
      watch(reg.installing);
      reg.addEventListener('updatefound', () => watch(reg.installing));
      setInterval(() => reg.update().catch(() => {}), 30 * 60e3);   // 每 30 分钟问一次
    }).catch(() => {});
  });
})();

boot();
})();
