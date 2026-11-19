/**
 * Title / selection translation helpers shared by the Pages Function,
 * the seed script, and node:test. No network, no Workers globals.
 *
 * Drug tokens are swapped for [D1]… before the model sees them and restored
 * afterwards. The model otherwise invents a different Chinese drug name.
 */

/** Workers AI text model for titles, selection, and share-card quotes.
 *  GLM-4.7-Flash stays on the Workers Free neuron allowance. */
export const MT_MODEL = '@cf/zai-org/glm-4.7-flash';
/** Same completion ceiling the previous model used. On GLM this cap includes
 *  reasoning tokens, so thinking stays off and the budget is the translation. */
export const MT_MAX_TOKENS = 2000;
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

/** Drop GLM reasoning. A closed think block is removed; an unclosed one means
 *  the completion cap was spent before the answer, so nothing after it is kept.
 *  Reasoning text is not a translation. */
export function stripModelThinking(text) {
  let s = String(text || '');
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/<think>[\s\S]*$/gi, '');
  s = s.replace(/<\/think>/gi, '');
  return s.replace(/^\uFEFF/, '').trim();
}

function choiceText(choice) {
  if (!choice) return '';
  if (typeof choice.text === 'string') return choice.text;
  const msg = choice.message || choice.delta || {};
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    const textParts = msg.content.filter(p => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string');
    if (textParts.length) return textParts.map(p => p.text).join('');
    return msg.content.map(p => (typeof p === 'string' ? p : '')).join('');
  }
  return '';
}

/** Native `/ai/run` puts the completion in `response`. A JSON title or quote
 *  can come back already parsed (array or object). An empty string must not
 *  hide `choices[0].message.content`. Reasoning fields are not the answer. */
function responseText(response) {
  if (typeof response === 'string') return response;
  if (Array.isArray(response)) return JSON.stringify(response);
  if (response && typeof response === 'object') return JSON.stringify(response);
  return '';
}

/**
 * Visible answer only. GLM-4.7-Flash's typed output is a chat completion.
 * The binding also returns `{ response }`. `reasoning_content` is never the translation.
 */
export function extractAiText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return stripModelThinking(result);
  if (
    result.result &&
    typeof result.result === 'object' &&
    typeof result.response !== 'string' &&
    !Array.isArray(result.response) &&
    !result.choices
  ) {
    return extractAiText(result.result);
  }
  const direct = responseText(result.response);
  const choice = choiceText(result.choices && result.choices[0]);
  return stripModelThinking(direct.trim() ? direct : choice);
}

/** Workers AI error codes whose numeric value is safe to show. The message
 *  around the code is not shown: it can echo the prompt. */
const PROVIDER_CODES = new Set([
  3003, 3006, 3007, 3008, 3023, 3036, 3039, 3040, 3041, 3042,
  5004, 5005, 5006, 5007, 5016, 5018, 5019, 5028, 5035, 7003,
]);

function providerCode(value) {
  const n = Number(value);
  return PROVIDER_CODES.has(n) ? n : 0;
}

function codesInText(text) {
  const found = [];
  for (const match of String(text || '').slice(0, 180).matchAll(/\b(\d{4})\b/g)) {
    const code = providerCode(match[1]);
    if (code) found.push(code);
  }
  return found;
}

/** Status and allowlisted code only. No message text, prompt, or body. */
export function providerFailure(err) {
  let status = Number(err?.status || err?.statusCode || 0);
  if (!(status >= 400 && status <= 599)) status = 0;
  let code = providerCode(err?.internalCode) || providerCode(err?.code);
  if (!code && Array.isArray(err?.errors)) {
    for (const item of err.errors) {
      code = providerCode(item?.code);
      if (code) break;
    }
  }
  if (!code) code = codesInText(err?.message)[0] || 0;
  return { category: 'provider', status, code };
}

/**
 * Official GLM-4.7-Flash output is a chat completion: `choices[0].message.content`
 * is a string or null, and `finish_reason` is `stop` or `length`. An unclosed
 * think block means the cap was spent before the answer.
 */
export function classifyCompletion(result) {
  const text = extractAiText(result);
  const choice = result?.choices?.[0] || result?.result?.choices?.[0] || null;
  const finish = String(choice?.finish_reason || '');
  const raw = [
    typeof result?.response === 'string' ? result.response : '',
    typeof choice?.message?.content === 'string' ? choice.message.content : '',
  ].join('\n');
  const unclosed = /<think>/i.test(raw) && !/<\/think>/i.test(raw);
  if (text) return { category: 'ok' };
  if (finish === 'length' || unclosed) return { category: 'truncated' };
  return { category: 'empty' };
}

const FAILURE_CATEGORIES = new Set(['provider', 'empty', 'truncated', 'parse', 'untranslated']);

export function failureLabel(info) {
  const category = FAILURE_CATEGORIES.has(info?.category) ? info.category : 'unknown';
  if (category !== 'provider') return category;
  const status = Number(info.status) >= 400 && Number(info.status) <= 599 ? String(info.status) : '';
  const code = providerCode(info.code) ? String(info.code) : '';
  const bits = [status, code].filter(Boolean);
  return bits.length ? `provider ${bits.join('/')}` : 'provider';
}

/** Sentence the share sheet already prints from `data.message`. */
export function failureSentence(info) {
  return `翻译失败，请再试一次。（${failureLabel(info)}）`;
}

/** GLM-4.7-Flash input. This model has no `reasoning_effort` levels; thinking
 *  defaults on and is switched off with `enable_thinking: false`. One token
 *  cap only: `max_tokens`, the field the Workers AI binding provider sends.
 *  A second `max_completion_tokens` is not sent. */
export function mtRequest(system, user, maxTokens = MT_MAX_TOKENS) {
  const cap = Math.max(1, Math.floor(Number(maxTokens) || MT_MAX_TOKENS));
  return {
    messages: [
      { role: 'system', content: String(system || '') },
      { role: 'user', content: String(user || '') },
    ],
    temperature: 0.1,
    max_tokens: cap,
    chat_template_kwargs: { enable_thinking: false },
  };
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

function badModel(message) {
  const err = new Error(message);
  err.code = 'bad_model';
  return err;
}

function zhField(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
  for (const key of ['zh', 'translation']) {
    if (typeof item[key] === 'string' && item[key].trim()) return item[key].trim();
  }
  return '';
}

/** Arrays of length n, last opening bracket first. A preamble `[0]` must not
 *  swallow the answer array. Object `en` is ignored so a model cannot replace
 *  the excerpt. */
function translationArrays(s, n) {
  const opens = [];
  const closes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '[') opens.push(i);
    else if (s[i] === ']') closes.push(i);
  }
  const found = [];
  let tries = 0;
  for (let oi = opens.length - 1; oi >= 0 && tries < 40; oi--) {
    for (let ci = closes.length - 1; ci >= 0 && tries < 40; ci--) {
      if (closes[ci] <= opens[oi]) break;
      tries++;
      let arr;
      try { arr = JSON.parse(s.slice(opens[oi], closes[ci] + 1)); }
      catch { continue; }
      if (!Array.isArray(arr) || arr.length !== n) continue;
      const items = arr.map(item => {
        if (typeof item === 'string') return item.trim();
        return zhField(item);
      });
      if (items.every(Boolean)) {
        found.push(items);
        break;
      }
    }
  }
  return found;
}

function plainOne(s, source) {
  let t = String(s || '').trim();
  if (!t || !source) return '';
  if (t.startsWith('"') && t.endsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') t = parsed.trim();
    } catch { /* not a JSON string */ }
  }
  if (t.startsWith('{') && t.endsWith('}')) {
    try {
      const zh = zhField(JSON.parse(t));
      if (zh && isTranslatedZh(source, zh)) return zh;
    } catch { /* not one object */ }
    return '';
  }
  const structural = t.replace(/\[D\d+\]/g, '');
  if (/[\[{]/.test(structural)) return '';
  if (t.length > Math.max(String(source).length * 4, 280)) return '';
  if (!isTranslatedZh(source, t)) return '';
  return t;
}

/**
 * JSON array of length n, searching from the last `[` so an echoed list does
 * not invalidate a later array. For one source, a Chinese sentence or a
 * `{zh}` object is enough. Two or more sources stay fail-closed without an
 * array of that length. `en` fields are never returned.
 */
export function parseTranslationArray(raw, n, sources) {
  const s = stripModelThinking(raw).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const lists = translationArrays(s, n);
  const src = Array.isArray(sources) && sources.length === n ? sources : null;
  if (src) {
    const good = lists.find(items => items.every((zh, i) => isTranslatedZh(src[i], zh)));
    if (good) return good;
    const han = lists.find(items => items.every(zh => /[\u4e00-\u9fff]/.test(zh)));
    if (han) return han;
    if (n === 1) {
      const plain = plainOne(s, src[0]);
      if (plain) return [plain];
    }
  } else if (lists.length) {
    return lists[0];
  }
  throw badModel(lists.length ? 'untranslated_array' : 'no_json_array');
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
