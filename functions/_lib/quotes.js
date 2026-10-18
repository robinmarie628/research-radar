/**
 * Pick three abstract sentences for the share card.
 * The English that leaves this module is always a sentence from the abstract.
 * A model paraphrase is dropped and replaced by a heuristic pick.
 */

export const ABSTRACT_MAX = 14000;

export const QUOTE_SYSTEM = `You choose quotations from one medical abstract for a Chinese physician.
You will receive a numbered list of sentences. The number in brackets is the index.
Pick the 3 sentences that are the most clinically meaningful and the most likely to start a discussion.
Return JSON only, no markdown: {"quotes":[{"i":0,"zh":"..."},{"i":1,"zh":"..."},{"i":2,"zh":"..."}]}
Rules:
1. i must be an index from the list. Do not invent, merge, shorten, or rewrite a sentence.
2. zh is a Simplified Chinese translation of that exact sentence.
3. Keep drug names, gene and protein names, trial names, and acronyms in English.
4. Drug names may appear as placeholders like [D1]. Copy every placeholder into zh unchanged.
5. Translate faithfully. Do not add or omit facts.`;

const ABBREV = /(?:et al|Figs?|vs|Dr|Mr|Mrs|Ms|Prof|e\.g|i\.e|U\.S|No|Vol|Jr|Sr|St|approx|ca|al)$/i;
const HINT = /patient|risk|mortality|death|outcome|significant|associat|treatment|therapy|reduc|increas|improv|therefore|thus|we found|demonstrat|suggest|benefit|hazard|survival|disease|failure|conclus|trial|effect|among|compared/i;

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
    if (HINT.test(s)) sc += 4;
    const len = s.length;
    if (len >= 70 && len <= 260) sc += 3;
    else if (len > 340) sc -= 3;
    else if (len < 45) sc -= 2;
    if (sentences.length > 1) sc += (i / (sentences.length - 1)) * 2;
    return { s, i, sc, len };
  }).sort((a, b) => b.sc - a.sc || a.len - b.len);

  const picked = [];
  const take = (gap) => {
    for (const row of rows) {
      if (picked.length >= n) return;
      if (picked.some(p => p.i === row.i)) continue;
      if (gap && sentences.length >= n + 2 && picked.some(p => Math.abs(p.i - row.i) < gap)) continue;
      picked.push(row);
    }
  };
  take(2);
  take(0);
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
