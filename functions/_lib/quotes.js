/**
 * Pick three abstract sentences for the share card.
 * The English that leaves this module is always a sentence from the abstract.
 * A model paraphrase is dropped and replaced by a heuristic pick.
 */

export const ABSTRACT_MAX = 14000;

export const QUOTE_SYSTEM = `You choose quotations from one medical abstract for a Chinese physician.
You will receive a numbered list of sentences. The number in brackets is the index.
Pick the 3 sentences that are the most clinically meaningful and the most likely to start a discussion.
Prefer, in this order: an interpretation or conclusion (sentences that start with Interpretation, These findings, Our results suggest, or that state what the result means), then a key finding in plain language.
A plain-language finding is better than a sentence dense with confidence intervals, sample sizes, or p values.
Never choose a sentence about trial registration, an NCT number, ClinicalTrials.gov, funding, ethics approval, accrual or follow-up status, or copyright, if any other sentence exists.
Prefer a sentence under 220 characters. Do not stitch clauses together to make one shorter.
Return JSON only, no markdown: {"quotes":[{"i":0,"zh":"..."},{"i":1,"zh":"..."},{"i":2,"zh":"..."}]}
Rules:
1. i must be an index from the list. Do not invent, merge, shorten, or rewrite a sentence.
2. zh is a Simplified Chinese translation of that exact sentence.
3. Keep drug names, gene and protein names, trial names, and acronyms in English.
4. Drug names may appear as placeholders like [D1]. Copy every placeholder into zh unchanged.
5. Translate faithfully. Do not add or omit facts.
6. If fewer than 3 sentences are under 220 characters, fill the remaining slots with the next most meaningful sentences, still copied verbatim.`;

const ABBREV = /(?:et al|Figs?|vs|Dr|Mr|Mrs|Ms|Prof|e\.g|i\.e|U\.S|No|Vol|Jr|Sr|St|approx|ca|al)$/i;
const HINT = /patient|risk|mortality|death|outcome|significant|associat|treatment|therapy|reduc|increas|improv|therefore|thus|we found|demonstrat|suggest|benefit|hazard|survival|disease|failure|conclus|trial|effect|among|compared/i;
const FINDING = /therefore|thus|conclus|we found|these findings|in summary|suggest|demonstrat|indicates that/i;
const INTERP = /^(interpretation\b|these findings\b|our results\b|our findings\b|we conclude\b|in conclusion\b|taken together\b|collectively\b)/i;
const INTERP_BODY = /\b(these findings|our results suggest|we conclude|indicates that|adds substantial evidence|remains investigational|requires .{0,48}validation)\b/i;
const RESULT = /\b(detected|reduced|increased|fewer|more likely|associated|response rate|survival|mortality|showed|enabled|avoided|no increase|non-inferior|deaths? occurred|adverse events occurred)\b/i;

function isDesign(s) {
  return /^(?:this (?:single-arm|randomised|randomized|multicentre|multicenter|phase|open-label|study|trial)|[A-Za-z0-9-]{2,} is a )\b/i.test(s)
    || /\b(randomly allocated|randomly assigned|was conducted|were identified by|was analysed in|was analyzed in|safety was assessed|protocol-permitted|eligible patients were|we aimed to|was defined as)\b/i.test(s)
    || /\b(?:primary|secondary) endpoints? (?:of|was the|were the)\b/i.test(s)
    || /\bprespecified secondary\b/i.test(s)
    || /\bsecondary outcome was\b/i.test(s);
}
const METHODS_LEAD = /^(between \d|women aged|the median age|patients were|participants were|we randomly|randomly allocated|eligible |inclusion |exclusion |methods\b|this (?:study|trial) (?:is|was) registered)/i;
export const PREFER_LEN = 220;

/** Registration, funding, ethics, accrual status, and copyright lines. */
export function isBoilerplate(s) {
  const t = String(s || '');
  if (/\bNCT\s*\d{5,}\b/i.test(t)) return true;
  if (/clinicaltrials\.gov/i.test(t)) return true;
  if (/\b(is|was|were|been)\s+registered\b/i.test(t)) return true;
  if (/\btrial registration\b/i.test(t)) return true;
  if (/\b(funded by|funding was|sources? of funding|financial support|was supported by|supported by (?:a |the )?(?:grant|fund)|grants? from)\b/i.test(t)) return true;
  if (/\b(ethics committees?|ethical approval|ethics approval|institutional review board|\bIRB\b|informed consent was)\b/i.test(t)) return true;
  if (/\b(closed to accrual|open to accrual|closed to enrolment|closed to enrollment|accrual is|accrual was)\b/i.test(t)) return true;
  if (/\bfollow-?up is (?:ongoing|continuing|complete|completed)\b/i.test(t)) return true;
  if (/\b(copyright|all rights reserved)\b/i.test(t) || /©/.test(t)) return true;
  if (/supplementary materials/i.test(t)) return true;
  return false;
}

/** Methods prose packed with counts and confidence intervals. */
export function isDenseMethods(s) {
  const text = String(s || '');
  const digits = text.match(/\d/g);
  const digitCount = digits ? digits.length : 0;
  const ci = /confidence interval|\bCIs?\b|95\s*%|hazard ratio|\bodds ratio\b|\bHR\b|\bOR\b|p\s*[<=>]/i.test(text);
  const methods = /\b(randomi[sz]ed|randomly assigned|we enrolled|were enrolled|participants were|patients were|eligible patients|inclusion criteria|exclusion criteria|statistical analysis|cox proportional|intention-to-treat|full analysis set|modified full analysis)\b/i.test(text);
  if (ci && digitCount >= 8) return true;
  if (methods && digitCount >= 6) return true;
  if (digitCount >= 14) return true;
  return false;
}

function sentenceQuality(s) {
  let q = 0;
  if (isBoilerplate(s)) return -20;
  if (s.length <= PREFER_LEN) q += 3;
  else if (s.length > 280) q -= 3;
  if (isDenseMethods(s)) q -= 6;
  else if (isDesign(s) || METHODS_LEAD.test(s)) q -= 4;
  if (INTERP.test(s)) q += 8;
  else if (INTERP_BODY.test(s)) q += 6;
  if (RESULT.test(s) && !isDenseMethods(s)) q += 3;
  if (HINT.test(s)) q += 2;
  if (FINDING.test(s)) q += 2;
  return q;
}

export function normSpace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** Sentences, whitespace collapsed, abbreviations and decimals kept intact. */
export function splitSentences(text) {
  const t = normSpace(text);
  if (!t) return [];
  const out = [];
  let buf = '';
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    buf += ch;
    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '。') continue;
    if (ch === '.' && ABBREV.test(buf.slice(0, -1))) continue;
    if (ch === '.' && /\d$/.test(buf.slice(0, -1)) && /\d/.test(t[i + 1] || '')) continue;
    const next = t[i + 1] || '';
    if (next && next !== ' ') continue;
    const rest = t.slice(i + 1).trimStart();
    if (rest && !/^[\p{Lu}“"‘'(\[]/u.test(rest)) continue;
    const s = buf.trim();
    if (s.length >= 24 && /[A-Za-z\u4e00-\u9fff]/.test(s)) out.push(s);
    buf = '';
    while (t[i + 1] === ' ') i++;
  }
  const tail = buf.trim();
  if (tail.length >= 24 && /[A-Za-z\u4e00-\u9fff]/.test(tail)) out.push(tail);
  return out;
}

export function findVerbatim(candidate, sentences) {
  const n = normSpace(candidate);
  if (!n) return '';
  for (const s of sentences) if (normSpace(s) === n) return s;
  return '';
}

export function pickHeuristic(sentences, n = 3) {
  const rows = sentences.map((s, i) => {
    let sc = 0;
    if (isBoilerplate(s)) sc -= 20;
    if (HINT.test(s)) sc += 4;
    if (INTERP.test(s)) sc += 8;
    else if (INTERP_BODY.test(s)) sc += 6;
    if (FINDING.test(s)) sc += 3;
    if (RESULT.test(s) && !isDenseMethods(s)) sc += 3;
    const len = s.length;
    if (len <= PREFER_LEN && len >= 60) sc += 4;
    else if (len <= PREFER_LEN) sc += 2;
    else if (len <= 280) sc -= 1;
    else sc -= 4;
    if (isDenseMethods(s)) sc -= 8;
    if (isDesign(s) || METHODS_LEAD.test(s)) sc -= 6;
    if (sentences.length > 1) sc += (i / (sentences.length - 1)) * 2;
    return { s, i, sc, len };
  }).sort((a, b) => b.sc - a.sc || a.len - b.len);

  const plain = (row) => !isBoilerplate(row.s) && !isDenseMethods(row.s) && !isDesign(row.s);
  const passes = [
    (row) => plain(row) && row.len <= 320 && (INTERP.test(row.s) || INTERP_BODY.test(row.s) || FINDING.test(row.s)),
    (row) => plain(row) && row.len <= PREFER_LEN && (RESULT.test(row.s) || HINT.test(row.s)),
    (row) => plain(row) && row.len <= PREFER_LEN,
    (row) => !isBoilerplate(row.s) && !isDesign(row.s) && (RESULT.test(row.s) || FINDING.test(row.s)),
    (row) => !isBoilerplate(row.s) && !isDesign(row.s),
    () => true,
  ];
  const picked = [];
  const take = (ok) => {
    for (const row of rows) {
      if (picked.length >= n) return;
      if (!ok(row)) continue;
      if (picked.some(p => p.i === row.i)) continue;
      picked.push(row);
    }
  };
  for (const ok of passes.slice(0, 5)) {
    take(ok);
    if (picked.length >= n) break;
  }
  if (!picked.length) take(passes[5]);
  return picked.sort((a, b) => a.i - b.i).slice(0, n).map(p => p.s);
}

/**
 * modelQuotes: [{i, en, zh}]. A valid index wins, because that sentence is
 * copied from the abstract. Otherwise the English must match a sentence
 * exactly. Missing slots are filled heuristically, with zh left blank.
 */
export function resolveQuotePicks(abstract, modelQuotes) {
  const sentences = splitSentences(abstract);
  const used = new Set();
  const out = [];
  for (const q of modelQuotes || []) {
    const i = Number(q?.i);
    let en = '';
    if (Number.isInteger(i) && i >= 0 && i < sentences.length) en = sentences[i];
    else en = findVerbatim(q?.en, sentences);
    if (!en || used.has(en)) continue;
    used.add(en);
    out.push({ en, zh: normSpace(q?.zh || '') });
    if (out.length === 3) break;
  }
  if (out.length < 3) {
    for (const en of pickHeuristic(sentences, 3)) {
      if (out.length >= 3) break;
      if (used.has(en)) continue;
      used.add(en);
      out.push({ en, zh: '' });
    }
  }
  const spare = sentences.some(s => !isBoilerplate(s) && !isDenseMethods(s));
  if (spare || sentences.some(s => !isBoilerplate(s))) {
    const kept = out.filter(p => !isBoilerplate(p.en) && !(spare && isDenseMethods(p.en)));
    out.length = 0;
    for (const p of kept) out.push(p);
    const taken = new Set(out.map(p => p.en));
    for (const en of pickHeuristic(sentences, 3)) {
      if (out.length >= 3) break;
      if (taken.has(en)) continue;
      taken.add(en);
      out.push({ en, zh: '' });
    }
  }
  let guard = 0;
  while (guard++ < out.length) {
    let worst = 0;
    for (let i = 1; i < out.length; i++) {
      if (sentenceQuality(out[i].en) < sentenceQuality(out[worst].en)) worst = i;
    }
    const taken = new Set(out.map(p => p.en));
    const alt = pickHeuristic(sentences.filter(s => !taken.has(s)), 1)[0];
    if (!alt || sentenceQuality(alt) <= sentenceQuality(out[worst].en)) break;
    out[worst] = { en: alt, zh: '' };
  }
  out.sort((a, b) => sentences.indexOf(a.en) - sentences.indexOf(b.en));
  return out.slice(0, 3);
}

export function parseQuoteResponse(raw) {
  let s = String(raw || '');
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/^\uFEFF/, '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  const slice = a >= 0 && b > a ? s.slice(a, b + 1) : '';
  let obj = null;
  if (slice) {
    try { obj = JSON.parse(slice); } catch { obj = null; }
  }
  const arr = Array.isArray(obj) ? obj : (obj && (obj.quotes || obj.picks)) || [];
  if (!Array.isArray(arr)) return [];
  return arr.map(item => {
    if (typeof item === 'string') return { i: NaN, en: item, zh: '' };
    const idx = Number(item?.i);
    return {
      i: Number.isInteger(idx) ? idx : NaN,
      en: String(item?.en || item?.sentence || ''),
      zh: String(item?.zh || item?.translation || ''),
    };
  });
}
