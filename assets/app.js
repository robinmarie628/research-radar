/* ============================================================
   科研雷达 · Research Radar
   Live data: Europe PMC (journals) + Crossref (PII/ClinicalKey)
              + follow-builders (AI builders)
   Zero build, zero backend, zero API keys.
   ============================================================ */
(() => {
'use strict';

const APP_VERSION = '2026.10.01.4';   // 改动前端资源时同步 bump（并同步 sw.js 的 V）

/* ---------------- endpoints / tuning ---------------- */
const EPMC     = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const CROSSREF = 'https://api.crossref.org/works';
const FEED     = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/';
const DAYS     = 30;        // discovery window — abstracts lag 2–4 days, so never use 1
const MAXJ     = 100;       // Europe PMC cap per request with resultType=core
const CHUNKS   = 3;         // split the ISSN list so one journal can't flood the pool
const CAP_PER_JOURNAL = 8;
const PICK_N   = 8;         // 今日精选 size
const PICK_BASIC    = 4;    // …其中基础 / 分子医学
const PICK_CLINICAL = 4;    // …其中临床研究
const TTL      = 30 * 60e3; // cache freshness
const LS_KEY   = 'rr.cache.v2';
const SEEN_KEY = 'rr.seen.v1';

/* ---------------- 领域 (domain) ---------------- */
const DOMAIN_META = {
  '综合医学':   { ico:'🏥', hue:212 },
  '心血管':     { ico:'❤️', hue:352 },
  '呼吸与重症': { ico:'🌬️', hue:196 },
  '肿瘤':       { ico:'🎗️', hue:330 },
  '神经':       { ico:'🧠', hue:268 },
  '感染':       { ico:'🦠', hue:150 },
  '血液':       { ico:'🩸', hue:0   },
  '内分泌代谢': { ico:'🧪', hue:36  },
  '消化肝病':   { ico:'⚕️', hue:20  },
  '公共卫生':   { ico:'🌍', hue:172 },
  '眼科':       { ico:'👁️', hue:220 },
  '儿科':       { ico:'🧒', hue:44  },
  '精神心理':   { ico:'🧩', hue:288 },
  '风湿免疫':   { ico:'🛡️', hue:186 },
  '肾脏':       { ico:'💧', hue:206 },
  '皮肤':       { ico:'✋', hue:14  },
  '泌尿':       { ico:'🚹', hue:236 },
  '全球健康':   { ico:'🌏', hue:158 },
  '数字医疗':   { ico:'📱', hue:246 },
  '老年医学':   { ico:'🧓', hue:30  },
  '基础医学':   { ico:'🧬', hue:300 },
};
const DOMAIN_ORDER = Object.keys(DOMAIN_META);
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
  ai: { all: [], updated: null, loaded: false, error: null },
  digest: { date: null, items: [], byDoi: new Map(), loaded: false },
  bd: { date: null, headline: '', bullets: [], sentiment: '', byId: new Map(), loaded: false },
  jFilter: 'pick',
  jView: 'card',
  aFilter: 'all',
  seen: new Set(),
  tab: 'research',
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
function hueOf(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
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

/* ---------------- Europe PMC ---------------- */
function epmcURLs(issns) {
  const hi = iso(new Date());
  const lo = iso(new Date(Date.now() - DAYS * 864e5));
  const step = Math.ceil(issns.length / CHUNKS);
  const urls = [];
  for (let i = 0; i < issns.length; i += step) {
    const slice = issns.slice(i, i + step);
    const q = `(${slice.map(x => `ISSN:"${x}"`).join(' OR ')}) AND SRC:MED `
            + `AND HAS_ABSTRACT:Y AND FIRST_PDATE:[${lo} TO ${hi}]`;
    urls.push(EPMC + '?' + new URLSearchParams({
      query: q, format: 'json', pageSize: String(MAXJ),
      resultType: 'core', sort: 'P_PDATE_D desc',
    }).toString());
  }
  return urls;
}

function mapArticle(r) {
  const j = r.journalInfo?.journal || {};
  const issn = j.issn || j.essn || '';
  const meta = S.cfg.find(c => c.issn === issn) || null;
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
    domain: meta?.domain || '综合医学',
    imp: meta?.if ?? 0,
    basic: isBasic,
    studyKey: study.key, studyZh: study.zh, studyRank: study.rank,
    stars: starTier(meta?.if ?? 0),
    date,
    ts: date ? Date.parse(date) : 0,
    year: r.pubYear || (date ? date.slice(0, 4) : ''),
    authors: cleanText(r.authorString || '').split(',')[0] || '',
    pmid: r.pmid || '',
    doi: r.doi || '',
    oa: !!r.isOpenAccess,
    pii: undefined,
  };
}

function balanceByJournal(items) {
  const per = {};
  return items.filter(a => (per[a.journal] = (per[a.journal] || 0) + 1) <= CAP_PER_JOURNAL);
}

/** 今日精选：8 篇 = 4 篇临床 + 4 篇基础/分子医学。
 *  · 基础名额一刊一篇 —— 否则一本刊（如 Cell）能占满，出现两篇几乎雷同的论文
 *  · 临床名额优先覆盖不同领域
 *  · 某一边候选不足时，用另一边补足总数 */
function curate(items, n = PICK_N) {
  const rank = a => a.studyRank * 1000 + (a.imp || 0) + (a.structured ? 40 : 0);
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
  // 1) 基础 / 分子医学：目标 4 篇，一刊一篇
  for (const it of pool) {
    if (cnt(true) >= PICK_BASIC) break;
    if (it.basic) add(it, 1);
  }
  // 2) 临床研究：目标 4 篇，优先覆盖不同领域
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
  return picked.slice(0, n).sort((a, b) => rank(b) - rank(a));
}

/** 文章列表 + 精选的指纹。后台重新校验时用它判断「数据有没有真的变」，
 *  没变就不重渲染 —— 否则会把用户正在读的卡片关掉。 */
function jrSignature() {
  return S.jr.all.map(x => x.id).join('|') + '#' + S.jr.picks.map(x => x.id).join('|');
}

async function loadResearch(force) {
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
      loaded: true, error: null,
    };
    writeCache('jr', { all: items, byKey, picks: S.jr.picks, updated: S.jr.updated });
    loadPII(S.jr.picks);
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
                 updated: snap.updated, loaded: true, error: 'snapshot' };
      } else {
        S.jr = { ...S.jr, loaded: true, error: e.message };
      }
    }
  }
  applyDigest();
  const sig = jrSignature();
  const prev = S.jr._sig;
  S.jr._sig = sig;
  if (sig === prev && S.jr.loaded) return;   // 数据没变，保持界面原样
  renderResearch();
}

/* ---------------- Crossref PII → ClinicalKey deep link ----------------
   Europe PMC exposes no PII, so it comes from Crossref's alternative-id.
   `filter=doi:a,doi:b` batches ~20 DOIs per request.                      */
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
    if (a && a.pii) addCkLink(node, a);
  });
}
function addCkLink(node, a) {
  const links = node.querySelector('.art-links');
  if (!links || links.querySelector('.lnk.ck') || !a.pii) return;
  const ck = el('a', 'lnk ck', 'ClinicalKey ↗');
  ck.href = 'https://www.clinicalkey.com/#!/content/playContent/1-s2.0-' + a.pii;
  ck.target = '_blank'; ck.rel = 'noopener noreferrer';
  links.prepend(ck);
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
  if (!S.digest.loaded) return;
  const ageDays = S.digest.date ? (Date.now() - Date.parse(S.digest.date)) / 864e5 : 999;
  if (ageDays > 5) return;                       // stale — trust live curation instead
  const byDoi = new Map(S.jr.all.map(a => [a.doi.toLowerCase(), a]));
  const picked = [];
  for (const d of S.digest.items) {
    const a = byDoi.get(String(d.doi || '').toLowerCase());
    if (a) { a.digest = d; picked.push(a); }
  }
  if (picked.length >= 3) S.jr.picks = picked;
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
    chip({ ico:'🧬', text:'基础/分子' }, (S.jr.byKey.basic || []).length, S.jFilter === 'basic', () => setJFilter('basic'), '', 'basic'),
    chip({ ico:'📚', text:'专业词汇' }, S.gloss.length, false, openGlossary),
  );
  for (const d of DOMAIN_ORDER) {
    const n = (S.jr.byKey[d] || []).length;
    if (!n) continue;
    host.append(chip({ ico: dm(d).ico, text: d, hue: dm(d).hue }, n, S.jFilter === d, () => setJFilter(d)));
  }

  $('#litDate').textContent = S.jr.updated ? fmtDate(S.jr.updated) : '—';
  // derive the banner counts from the config so they can never drift from reality
  const nClin = S.cfg.filter(c => !c.basic).length;
  const nBas  = S.cfg.filter(c => c.basic).length;
  const eClin = $('#jClin'), eBas = $('#jBasic');
  if (eClin) eClin.textContent = nClin || '—';
  if (eBas)  eBas.textContent  = nBas  || '—';

  const list = filteredArticles();
  const isPick = S.jFilter === 'pick';
  $('#researchHead').textContent = headLabel(list.length, isPick);
  $('#researchSub').textContent = isPick
    ? `每日精选 ${PICK_N} 篇 · ${PICK_CLINICAL} 篇临床 + ${PICK_BASIC} 篇基础/分子 · 点卡片展开摘要`
    : '点卡片任意位置展开摘要（摘要较长可在框内滚动）';

  if (S.jView === 'index') renderIndexTable($('#researchCards'), list);
  else renderArticleList($('#researchCards'), list, isPick);
}

function headLabel(n, isPick) {
  if (S.jFilter === 'pick')   return `今日精选 ${n} 篇`;
  if (S.jFilter === 'all')    return `最新推送 ${n} 篇`;
  if (S.jFilter === 'unread') return `未读 ${n} 篇`;
  if (S.jFilter === 'basic')  return `基础/分子医学 ${n} 篇`;
  return `${S.jFilter} ${n} 篇`;
}

function filteredArticles() {
  const k = S.jFilter;
  if (k === 'pick')   return S.jr.picks;
  if (k === 'all')    return S.jr.all;
  if (k === 'unread') return S.jr.all.filter(a => !S.seen.has(a.id));
  if (k === 'basic')  return S.jr.byKey.basic || [];
  return S.jr.byKey[k] || [];
}

function setJFilter(k) {
  S.jFilter = k;
  renderResearch();
  const sc = $('#scrollArea');
  sc.scrollTo({ top: Math.max(0, $('#researchChips').offsetTop - 96), behavior: 'smooth' });
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
  const titleZh = (a.digest && a.digest.titleZh) || '';
  titleWrap.append(el('h3', 'art-title', titleZh || a.title));
  top.append(caret, titleWrap);

  const badges = el('div', 'art-badges');
  const db = el('span', 'badge dom', a.domain);
  db.style.background = `hsl(${dm(a.domain).hue} 72% 44%)`;
  badges.append(db);
  badges.append(el('span', 'badge study s-' + a.studyKey, a.studyZh));
  badges.append(el('span', 'badge ' + (a.basic ? 'bas' : 'clin'), a.basic ? '基础' : '临床'));
  badges.append(el('span', 'badge jr', a.journal));
  badges.append(starsNode(a.stars));
  if (a.year) badges.append(el('span', 'yr', a.year));

  c.append(top, badges);

  let body = null;
  c.addEventListener('click', ev => {
    // 忽略链接和按钮 —— 否则点「查看英文摘要」会冒泡到这里，把整张卡片折叠掉
    if (ev.target.closest('a, button, input, select, textarea')) return;
    const open = c.classList.toggle('open');
    if (!open) { if (body) body.remove(); return; }

    if (!body) body = buildArticleBody(a, c);
    c.append(body);
    markSeen(a);
    if (a.pii === undefined) loadPII([a]).then(() => { if (a.pii) addCkLink(c, a); });
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
  enTitle.append(el('span', 'rawtitle-txt', a.title));
  box.append(enTitle);

  if (a.structured && a.sections) {
    for (const k of ['objective', 'methods', 'results', 'conclusion', 'other']) {
      const txt = a.sections[k];
      if (!txt) continue;
      const row = el('div', 'sec sec-' + k);
      row.append(el('span', 'sec-lab', SEC_LABEL[k] || '其他'));
      row.append(el('p', 'sec-txt', txt));
      box.append(row);
    }
  } else if (a.abstract) {
    box.append(el('p', 'art-abstract', a.abstract));
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
  if (a.pii)  links.append(link('https://www.clinicalkey.com/#!/content/playContent/1-s2.0-' + a.pii, 'ClinicalKey', 'ck'));
  if (a.doi)  links.append(link('https://doi.org/' + a.doi, 'DOI 全文', a.pii ? 'alt' : ''));
  if (a.pmid) links.append(link('https://pubmed.ncbi.nlm.nih.gov/' + a.pmid + '/', 'PubMed', 'alt'));
  body.append(links);
  return body;
}

function renderArticleList(host, list, isPick) {
  host.replaceChildren();
  if (!S.jr.loaded) return;
  if (S.jr.error && !list.length) {
    host.append(emptyBox('📡', '数据暂时取不到',
      '网络或接口波动，稍后重试。', '重新加载', () => refresh(true)));
    return;
  }
  if (!list.length) {
    const msg = S.jFilter === 'unread'
      ? ['✅', '都读完了', '这一轮的新文章你都看过了，等明天的更新吧。']
      : ['🔍', '这里今天还没有新文章', '摘要入库通常滞后 2–4 天。换个筛选看看。'];
    host.append(emptyBox(msg[0], msg[1], msg[2], null, null));
    return;
  }
  const frag = document.createDocumentFragment();
  list.forEach((a, i) => frag.append(articleCard(a, isPick, i + 1)));
  host.append(frag);
}

/** 窄索引表 — # / 期刊 / 类型 / 领域 / 临床或基础 */
function renderIndexTable(host, list) {
  host.replaceChildren();
  if (!list.length) {
    host.append(emptyBox('🔍', '这里今天还没有新文章', '换个筛选看看。', null, null));
    return;
  }
  const wrap = el('div', 'idxwrap');
  const t = el('table', 'idx');
  const thead = el('thead');
  const hr = el('tr');
  ['#', '期刊', '类型', '领域', '临/基'].forEach(h => hr.append(el('th', '', h)));
  thead.append(hr);
  const tb = el('tbody');
  list.forEach((a, i) => {
    const tr = el('tr');
    tr.append(el('td', 'n', String(i + 1)));
    tr.append(el('td', 'j', a.journal));
    const ts = el('td', 't');
    ts.append(el('span', 'mini s-' + a.studyKey, a.studyZh));
    tr.append(ts);
    const td = el('td', 'd');
    const dot = el('span', 'dot');
    dot.style.background = `hsl(${dm(a.domain).hue} 72% 46%)`;
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
  S.jFilter = S.jFilter === 'pick' ? 'pick' : 'all';
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
  const h = hueOf(p.handle || p.name || 'x');
  av.style.background = `linear-gradient(140deg, hsl(${h} 68% 58%), hsl(${(h + 38) % 360} 66% 46%))`;
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
function renderGlossary(q) {
  const host = $('#glossList');
  const key = q.trim().toLowerCase();
  const list = key ? S.gloss.filter(g => (g.en + g.zh + g.def).toLowerCase().includes(key)) : S.gloss;
  host.replaceChildren();
  if (!list.length) { host.append(emptyBox('🔍', '没有匹配的术语', '换个关键词试试。', null, null)); return; }
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
  const seg = $('#segmented');
  if (seg) seg.dataset.i = tab === 'research' ? '0' : '1';
  $('#panel-research').hidden = tab !== 'research';
  $('#panel-builders').hidden = tab !== 'builders';
  $('#scrollArea').scrollTop = 0;
  $('#brandSub').textContent = tab === 'research' ? '临床顶刊 + 基础医学 · 每日速递' : 'AI Builder · 一手动态';
  if (tab === 'builders' && !S.ai.loaded) loadBuilders(false);
  if (tab === 'builders' && !S.bd.loaded) loadBuilderDigest();
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
  } catch { toast('刷新失败，请检查网络'); }
  finally { btn.classList.remove('spin'); stampFoot(); }
}
function stampFoot() { $('#footTime').textContent = '更新于 ' + relTime(new Date()); }

/* ---------------- boot ---------------- */
async function boot() {
  window.__rr = S;                 // debug/QA hook
  S.seen = readSeen();

  const c = readCache();
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

  await loadResearch(false);
  await loadDigest();                    // maps 创新/看点 onto S.jr.all, then re-renders
  await loadBuilderDigest();             // 今日 AI 动态总览 + 每条动态的中文一句话
  if (S.tab === 'builders') await loadBuilders(false);
  stampFoot();

  setTimeout(() => { if (!S.ai.loaded) loadBuilders(false); }, 1200);
  setTimeout(() => { loadResearch(true); loadBuilders(true); }, 2500);
}

/* ---------------- wire up ---------------- */
$$('.seg').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
$('#refreshBtn').addEventListener('click', () => refresh(true));
$('#glossSearch').addEventListener('input', e => renderGlossary(e.target.value));
$('#glossSheet').addEventListener('click', e => { if (e.target.closest('[data-close]')) closeGlossary(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeGlossary(); });

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
