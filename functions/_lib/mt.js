/**
 * Title / selection translation helpers shared by the Pages Function,
 * the seed script, and node:test. No network, no Workers globals.
 *
 * Drug tokens are swapped for [D1]… before the model sees them and restored
 * afterwards. Qwen otherwise invents a different Chinese drug name.
 */

export const MT_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
export const TITLE_BATCH = 10;
export const TITLE_ZH_DAYS = 15;
export const SELECTION_MAX = 1500;
export const TITLE_MAX = 500;

/** Verbatim system prompt from the qwen3 title test (cf_prompt_v3). */
export const TITLE_SYSTEM = `You are a professional medical translator for a Chinese clinical-research news site. Translate English journal article titles into Simplified Chinese for Chinese physicians.
Rules:
1. Keep drug names, gene/protein names, trial and study names, registries, organizations and acronyms in English exactly as written (e.g. niraparib, KDM5A, NECTIN4, LINK-HF2, SIERRA, KDIGO, EGFR, ECMO, PCI, MASH, CAR T, HIV-1, HCV).
2. Use standard Chinese medical terminology: phase 1/2/3 -> Ⅰ期/Ⅱ期/Ⅲ期 (phase IIIb -> Ⅲb期), unresectable -> 不可切除, locally advanced -> 局部晚期, cohort study -> 队列研究, randomised controlled trial -> 随机对照试验, meta-analysis -> Meta分析, first-in-human -> 首次人体, open-label -> 开放标签, single-arm -> 单臂, multicentre -> 多中心, relapsed or refractory -> 复发或难治性, propensity-matched -> 倾向性评分匹配.
3. Translate faithfully and completely; do not add, omit or explain anything. Keep the colon structure of the title, including the clause after the colon. Never drop a contrast in that clause (delayed, prompt, early, late, or immediate treatment or initiation): delayed treatment initiation → 延迟治疗启动, prompt → 及时, early → 早期, late → 晚期.
4. Drug names have been replaced by placeholders like [D1], [D2]. Copy every placeholder into the translation exactly once, unchanged, in the grammatically right position. Any other drug names (INN names such as pembrolizumab, osimertinib, trastuzumab deruxtecan, tirzepatide, semaglutide; names ending in -mab, -nib, -parib, -vir, -cept, -tide, -stat) must stay in English exactly as written. Never replace them with a Chinese drug name, and never drop them.
5. Do not add any qualifier, population or detail that is not in the English title (no extra disease subtype, organ or study design that the title does not state). Keep anatomy exact (iliac = 髂, femoral = 股).
6. Common terms: mpox = 猴痘 (not smallpox), fenestrated = 开窗, post hoc analysis = 事后分析, multinational = 多国, neuronal ensembles = 神经元集群.
7. Output only the translation(s), nothing else.
You will receive a JSON array of titles. Reply with a JSON array of Chinese translations, same length and order, and nothing else.`;

export const SELECTION_SYSTEM = `You are a medical translator. Translate the selected English text into Simplified Chinese for a physician.
Rules:
1. Keep drug names, gene and protein names, trial names, and acronyms in English exactly as written.
2. Drug names may appear as placeholders like [D1]. Copy every placeholder into the translation unchanged, in the grammatically right position. Never replace a drug name with a Chinese drug name.
3. Translate faithfully. Do not add, omit, or explain.
4. Output only the translation.`;

/** Used when data/mt-overrides.json cannot be fetched. Keep in sync with that file. */
export const DEFAULT_OVERRIDES = [
  {
    en: 'common iliac',
    zh: '髂总动脉',
    bad: [
      { from: '狭窄共同髂动脉', to: '狭窄的髂总动脉' },
      { from: '共同髂动脉', to: '髂总动脉' },
      { from: '共同髂', to: '髂总动脉' },
    ],
  },
  {
    en: 'post-thrombotic syndrome',
    alts: ['post thrombotic syndrome'],
    zh: '血栓后综合征',
    bad: ['深静脉血栓后综合征', '深静脉血栓综合征', '血栓后综合症'],
  },
  {
    en: 'ticagrelor',
    zh: 'ticagrelor',
    bad: ['替格瑞洛', '替卡格雷'],
  },
  {
    en: 'Management of Neovascular Age-Related Macular Degeneration in Routine US Clinical Practice: Impact of Delayed Treatment Initiation',
    zh: '美国常规临床实践中新生血管性年龄相关性黄斑变性的管理：延迟治疗启动的影响',
    exact: true,
  },
];

/** INN stems. Longer stems are listed for readability; matching is endsWith. */
const DRUG_STEMS = [
  'glutide', 'gliflozin', 'gliptin', 'tegravir', 'citabine', 'vedotin',
  'virine', 'sartan', 'statin', 'platin', 'prazole', 'setron', 'rubicin',
  'xaban', 'parin', 'taxel', 'navir', 'buvir', 'clovir', 'previr', 'zomib',
  'siran', 'dotin', 'leukin', 'feron', 'plase', 'parib', 'tinib', 'tibant',
  'tirom', 'tecan', 'dipine', 'cept', 'grelor', 'grel', 'mab', 'nib', 'olol', 'bart',
  'tide', 'pril', 'vir',
];

const DRUG_STOP = new Set([
  'peptide', 'neuropeptide', 'intercept', 'concept', 'precept', 'exception',
  'elixir', 'april', 'viral', 'virus', 'liver', 'river', 'delivery', 'every',
  'silver', 'survivor', 'behavior', 'behaviour', 'ensemble', 'receptor',
  'polymer', 'transfer', 'hemostat', 'thermostat', 'except', 'accept',
]);

const TOKEN_RE = /[A-Za-z][A-Za-z-]{4,}[A-Za-z]/g;

export function normTitle(s) {
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

/** Chinese titles do not take a closing full stop. Quotes keep theirs. */
export function stripTitleStop(text) {
  const s = String(text || '').trim();
  if (!/[\u4e00-\u9fff]/.test(s)) return s;
  return s.replace(/(?:\s*[.。])+\s*$/g, '').trim();
}

/**
 * Timing words that must survive when a model shortens the clause after a colon.
 * `zh` are acceptable renderings; `gloss` is the word used to rebuild a dropped clause.
 */
const TITLE_TIMING = [
  { re: /\bdelayed\b/i, zh: ['延迟', '推迟', '延后'], gloss: '延迟' },
  { re: /\bprompt\b/i, zh: ['及时', '即刻'], gloss: '及时' },
  { re: /\bearly(?![- ]onset)\b/i, zh: ['早期', '提早', '提前'], gloss: '早期' },
  { re: /\blate\b/i, zh: ['晚期'], gloss: '晚期' },
  { re: /\bimmediate\b/i, zh: ['立即', '即刻', '及时'], gloss: '立即' },
];

function titleColonTail(en) {
  const s = String(en || '').replace(/\s+/g, ' ').trim();
  const idx = s.search(/[：:]/);
  if (idx < 2) return '';
  return s.slice(idx + 1).trim().replace(/[.。\s]+$/g, '');
}

function timingHits(tail) {
  return TITLE_TIMING.filter(t => t.re.test(tail));
}

function timingCovered(text, hit) {
  return hit.zh.some(w => String(text || '').includes(w));
}

/** Chinese for a dropped "delayed / prompt / early / late initiation" clause. */
export function contrastGloss(tail) {
  const src = String(tail || '').trim();
  const hits = timingHits(src);
  if (!hits.length) return '';
  if (!/\b(treatment|therapy|initiation|initiating)\b/i.test(src)) return '';
  const initiation = /\binitiat/i.test(src);
  const treatment = /\b(treatment|therapy)\b/i.test(src);
  let core = '';
  if (hits.length === 1 && hits[0].gloss === '延迟' && treatment && initiation) core = '延迟治疗启动';
  else if (hits.length === 1 && treatment && initiation) core = hits[0].gloss + '开始治疗';
  else if (treatment && initiation) core = hits.map(h => h.gloss).join('与') + '开始治疗';
  else if (initiation) core = hits.map(h => h.gloss).join('与') + '启动';
  else if (treatment) core = hits.map(h => h.gloss).join('与') + '治疗';
  else core = hits.map(h => h.gloss).join('与');
  return /^\s*impact\s+of\s+/i.test(src) ? core + '的影响' : core;
}

/**
 * Put a shortened colon clause back. A translation that already says 延迟 / 及时 /
 * 早期 / 晚期 in that clause is left as the model wrote it.
 */
export function preserveTitleContrast(en, zh) {
  const out = stripTitleStop(zh);
  if (!out || !/[\u4e00-\u9fff]/.test(out)) return out;
  const tail = titleColonTail(en);
  const gloss = contrastGloss(tail);
  if (!gloss) return out;
  const hits = timingHits(tail);
  const idx = Math.max(out.lastIndexOf('：'), out.lastIndexOf(':'));
  const scope = idx >= 0 ? out.slice(idx + 1) : out;
  if (hits.every(h => timingCovered(scope, h))) return out;
  if (idx >= 0) return stripTitleStop(out.slice(0, idx) + '：' + gloss);
  return stripTitleStop(out + '：' + gloss);
}

/** Whole-title glossary hit. Used when a known paper must not keep a shortened cache entry. */
export function exactTitleZh(en, overrides = DEFAULT_OVERRIDES) {
  const key = normTitle(en);
  if (!key) return '';
  for (const o of overrides || []) {
    if (!o || !o.exact || !o.zh) continue;
    const phrases = [o.en, ...(o.alts || [])].filter(Boolean);
    if (phrases.some(p => normTitle(p) === key)) return stripTitleStop(o.zh);
  }
  return '';
}

export function settleTitleZh(en, zh, glossary, overrides) {
  const exact = exactTitleZh(en, overrides);
  if (exact) return exact;
  return preserveTitleContrast(en, applyGlossary(en, zh, glossary, overrides));
}

/** Same lower bound as the journal pool: today minus TITLE_ZH_DAYS (UTC).
 *  2026-10-18 with 15 days → 2026-10-03. A paper dated the day before is out. */
export function titleZhCutoff(now = new Date()) {
  const d = new Date(now.getTime());
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - TITLE_ZH_DAYS);
  return d.toISOString().slice(0, 10);
}

export function isDrugToken(raw) {
  const tok = String(raw || '').replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
  if (tok.length < 6) return false;
  if (!/^[A-Za-z][A-Za-z-]*[A-Za-z]$/.test(tok)) return false;
  const low = tok.toLowerCase();
  if (DRUG_STOP.has(low)) return false;
  if (/peptide$/.test(low)) return false;
  return DRUG_STEMS.some(stem => low.endsWith(stem) && low.length >= stem.length + 2);
}

/** Replace drug tokens with [D1]… Same spelling (any case) shares one placeholder. */
export function maskDrugs(text) {
  const drugs = [];
  const seen = new Map();
  const masked = String(text || '').replace(TOKEN_RE, (tok) => {
    if (!isDrugToken(tok)) return tok;
    const key = tok.toLowerCase();
    let ph = seen.get(key);
    if (!ph) {
      ph = `[D${seen.size + 1}]`;
      seen.set(key, ph);
      drugs.push({ ph, tok });
    }
    return ph;
  });
  return { text: masked, drugs };
}

export function restoreDrugs(text, drugs) {
  let out = String(text || '');
  (drugs || []).forEach(({ ph, tok }, i) => {
    const n = i + 1;
    const variants = [ph, `［D${n}］`, `【D${n}】`, `(D${n})`, `（D${n}）`];
    for (const v of variants) out = out.split(v).join(tok);
  });
  return out;
}

export function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phraseRe(phrase, flags) {
  const body = escapeReg(phrase).replace(/\\ /g, '\\s+');
  return new RegExp(`(^|[^A-Za-z0-9])(${body})(?=$|[^A-Za-z0-9])`, flags);
}

export function isAcronym(term) {
  const t = String(term || '').trim();
  if (!t || /\s/.test(t)) return false;
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length < 2 || t.length > 12) return false;
  const upper = letters.replace(/[^A-Z]/g, '').length;
  return upper / letters.length >= 0.8;
}

function sourceHas(src, phrase) {
  return phraseRe(phrase, 'i').test(src);
}

function badPairs(override) {
  return (override.bad || []).map(b => (
    typeof b === 'string' ? { from: b, to: override.zh } : { from: b.from, to: b.to }
  )).filter(b => b.from && b.to)
    .sort((a, b) => b.from.length - a.from.length);
}

/**
 * Post-edit a model translation.
 * - Small overrides fix known failures (common iliac, post-thrombotic syndrome,
 *   ticagrelor stays English) when that English phrase is in the source.
 * - glossary.json phrases replace leftover English. Acronyms (PCI, ECMO) and
 *   drug tokens are not expanded into Chinese.
 */
export function applyGlossary(en, zh, glossary = [], overrides = DEFAULT_OVERRIDES) {
  let out = String(zh || '');
  const src = String(en || '');
  if (!out) return out;

  for (const o of overrides || []) {
    const phrases = [o.en, ...(o.alts || [])].filter(Boolean);
    if (!phrases.some(p => sourceHas(src, p))) continue;
    for (const { from, to } of badPairs(o)) {
      if (out.includes(from)) out = out.split(from).join(to);
    }
    if (o.zh && String(o.zh).toLowerCase() !== String(o.en || '').toLowerCase()) {
      for (const p of phrases) {
        if (sourceHas(out, p)) out = out.replace(phraseRe(p, 'gi'), (_, pre) => pre + o.zh);
      }
    }
  }

  for (const g of glossary || []) {
    const term = String(g?.en || '').trim();
    const zhTerm = String(g?.zh || '').trim();
    if (!term || !zhTerm || term.length < 3) continue;
    if (isAcronym(term) || isDrugToken(term)) continue;
    if (!sourceHas(src, term) || out.includes(zhTerm)) continue;
    if (!sourceHas(out, term)) continue;
    out = out.replace(phraseRe(term, 'gi'), (_, pre) => pre + zhTerm);
  }
  return out.trim();
}

export function extractAiText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result.response === 'string') return result.response;
  const choice = result.choices && result.choices[0];
  if (!choice) return '';
  if (typeof choice.text === 'string') return choice.text;
  const msg = choice.message || choice.delta || {};
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map(p => (typeof p === 'string' ? p : p?.text || '')).join('');
  }
  return '';
}

/**
 * A share-card line counts as Chinese only when it is actually translated.
 * An echo of the English sentence, or a Latin paragraph with no Han characters, does not.
 */
export function isTranslatedZh(en, zh) {
  const z = String(zh || '').replace(/\s+/g, ' ').trim();
  if (!z) return false;
  const han = (z.match(/[\u4e00-\u9fff]/g) || []).length;
  if (han < 2) return false;
  const latin = (z.match(/[A-Za-z]/g) || []).length;
  if (latin > 24 && latin > han * 3) return false;
  const fold = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
  const src = fold(en);
  const out = fold(z);
  if (src && out && (out === src || (src.includes(out) && out.length > 40))) return false;
  return true;
}

export function parseTranslationArray(raw, n) {
  let s = String(raw || '');
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/^\uFEFF/, '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  if (a < 0 || b <= a) {
    const err = new Error('no_json_array');
    err.code = 'bad_model';
    throw err;
  }
  let arr;
  try { arr = JSON.parse(s.slice(a, b + 1)); }
  catch {
    const err = new Error('bad_json');
    err.code = 'bad_model';
    throw err;
  }
  if (!Array.isArray(arr) || arr.length !== n) {
    const err = new Error('len_mismatch');
    err.code = 'bad_model';
    throw err;
  }
  return arr.map(x => String(x ?? '').trim());
}

export function isQuotaError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  const status = Number(err?.status || err?.code || 0);
  if (status === 429) return true;
  return /quota|neuron|rate limit|limit exceeded|daily limit|capacity|billing|5006/.test(msg);
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Mask, leave the caller to translate `text`, then restore + glossary. */
export function finishTranslation(english, translated, glossary, overrides) {
  const { drugs } = maskDrugs(english);
  const restored = restoreDrugs(translated, drugs);
  return applyGlossary(english, restored, glossary, overrides);
}
