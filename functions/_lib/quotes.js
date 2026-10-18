/**
 * Pick share-card sentences: background, finding, mechanism when the abstract
 * states one, then significance. English is always a sentence from the abstract.
 * A model paraphrase is dropped and replaced by a heuristic pick.
 */

export const ABSTRACT_MAX = 14000;

export const QUOTE_ROLES = ['background', 'finding', 'mechanism', 'significance'];

export const QUOTE_SYSTEM = `You choose quotations from one medical abstract for a Chinese physician.
You will receive a numbered list of sentences. The number in brackets is the index.
Return one sentence for each role, in this order:
1. background — why the study was done: the problem, the gap, or what was still unknown. Not the methods.
2. finding — the key new result, stated in words. What the study actually found. One sentence.
3. mechanism — only when a sentence explains how or why the result happens: a pathway, molecule, cell type, "via", "mediated", cascade, redox, or signalling. Omit this role when the abstract does not state a mechanism. It must be a different sentence from the finding.
4. significance — what that result means: the interpretation, implication, or conclusion.
Never choose a sentence about trial registration, an NCT number, ClinicalTrials.gov, funding, ethics approval, accrual or follow-up status, or copyright.
Do not pick a methods sentence (eligibility, randomisation, sample size, statistics) for any role when another sentence exists.
Background is the problem or gap that existed before the study (a treatment remains scant, a disease is not eliminated, something is still unknown). A sentence that starts with "These results", "These findings", or "Thus", or that says the results support a use, is significance even when it mentions an unmet need.
For the finding, prefer a sentence that states the result in words. Do not pick a sentence dominated by numbers, confidence intervals, or p-values unless it is the only sentence that states the result.
Do not return a set that is only conclusions or only numbers. The four roles should differ: gap, result, mechanism when present, and meaning.
Prefer a sentence under 280 characters. Do not stitch clauses together.
Return JSON only, no markdown. Include mechanism only when you have a real mechanism sentence:
{"quotes":[{"role":"background","i":0,"zh":"..."},{"role":"finding","i":1,"zh":"..."},{"role":"mechanism","i":3,"zh":"..."},{"role":"significance","i":2,"zh":"..."}]}
Rules:
1. role order is background, finding, mechanism (optional), significance. At most one sentence per role.
2. i must be an index from the list. Do not invent, merge, shorten, or rewrite a sentence.
3. zh is a Simplified Chinese translation of that exact sentence.
4. Keep drug names, gene and protein names, trial names, and acronyms in English.
5. Drug names may appear as placeholders like [D1]. Copy every placeholder into zh unchanged.
6. Translate faithfully. Do not add or omit facts.`;

const ABBREV = /(?:et al|Figs?|vs|Dr|Mr|Mrs|Ms|Prof|e\.g|i\.e|U\.S|No|Vol|Jr|Sr|St|approx|ca|al)$/i;
const HINT = /patient|risk|mortality|death|outcome|significant|associat|treatment|therapy|reduc|increas|improv|therefore|thus|we found|demonstrat|suggest|benefit|hazard|survival|disease|failure|conclus|trial|effect|among|compared/i;
const FINDING = /therefore|thus|conclus|we found|these findings|in summary|suggest|demonstrat|indicates that/i;
const INTERP = /^(interpretation\b|these (?:results|findings|data|observations)\b|our results\b|our findings\b|we conclude\b|in conclusion\b|taken together\b|collectively\b|thus\b|therefore\b)/i;
const INTERP_BODY = /\b(these findings|these results support|these data support|support the use of|may address an unmet|our results suggest|we conclude|indicates that|adds substantial evidence|remains investigational|requires .{0,48}validation)\b/i;
const PROBLEM = /\b(not eliminated|unknown|unclear|poorly understood|little is known|remains (?:unclear|unknown|elusive)|despite|the gap|have been limited|remain(?:s|ed)? (?:scant|limited|elusive))\b/i;
const CENSUS = /\b(were assessed for eligibility|were randomly allocated|were male|were female|median age|included \d+ participants|of these,? \d+)\b/i;
const RESULT = /\b(detected|reduced|increased|improved|fewer|more likely|associated|caused|accelerated|response rate|survival|mortality|showed|enabled|avoided|no increase|non-inferior|deaths? occurred|adverse events occurred)\b/i;

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

function sentenceFrom(q, sentences) {
  const i = Number(q?.i);
  if (Number.isInteger(i) && i >= 0 && i < sentences.length) return sentences[i];
  return findVerbatim(q?.en, sentences);
}

function isImplication(s) {
  return INTERP.test(s) || INTERP_BODY.test(s) || /^(interpretation|conclusions?|implications?)\b/i.test(s);
}

function isMechanism(s) {
  if (!s || isBoilerplate(s) || isImplication(s) || isDesign(s) || METHODS_LEAD.test(s) || PROBLEM.test(s)) return false;
  if (/\bwe (investigated|aimed|sought|evaluated|assessed)\b/i.test(s)) return false;
  if (/\bmechanistically\b/i.test(s)) return true;
  if (/\b(cascade|pathway|signall?ing|redox|\bROS\b|lipid[- ]uptake|lipid-influx|phosphorylat)\b/i.test(s)) return true;
  if (/\b(?:\w+-)?mediated\s+(?:lipid\s+)?(?:uptake|influx|inflammation|activation|signall?ing|signaling|transport|adhesion)\b/i.test(s)) return true;
  if (/\bmediated\b/i.test(s) && /\b(uptake|influx|cascade|pathway|redox)\b/i.test(s)) return true;
  if (/\bvia\b/i.test(s) && /\b(signall?ing|pathway|receptor|cascade|kinase|redox)\b/i.test(s)) return true;
  if (/\bby (increasing|inducing|activating|inhibiting|blocking|promoting|suppressing|reducing)\b/i.test(s)) return true;
  if (/\bthrough (?:the |a )?[A-Za-z0-9].{0,48}\b(receptor|pathway|kinase|channel)\b/i.test(s)) return true;
  return false;
}

function numberHeavy(s) {
  const text = String(s || '');
  const digits = (text.match(/\d/g) || []).length;
  const pct = (text.match(/%/g) || []).length;
  return isClutteredResult(s) || digits >= 8 || pct >= 3;
}

function wordedResult(s) {
  return !!s && statesEffect(s) && !numberHeavy(s) && !isMechanism(s) && !isRunIn(s)
    && !isBoilerplate(s) && !isDesign(s) && !isImplication(s);
}

function classifySentence(s) {
  if (!s || isBoilerplate(s) || isDesign(s) || METHODS_LEAD.test(s)) return '';
  if (isImplication(s)) return 'significance';
  if (isMechanism(s)) return 'mechanism';
  if (/^(background|objectives?|aims?)\b/i.test(s)) return 'background';
  if (/^(results?|findings?)\b/i.test(s)) return 'finding';
  if (PROBLEM.test(s)) return 'background';
  if (RESULT.test(s) || /\b(we (?:found|find|show|report|demonstrate|identify)|showed that|significantly (?:faster|slower|higher|lower|greater|reduced|increased|improved))\b/i.test(s)) return 'finding';
  if (FINDING.test(s)) return 'significance';
  return '';
}

/** Which structured section contains this sentence, when the sections disagree. */
function sectionRole(s, sections) {
  if (!sections || typeof sections !== 'object') return '';
  const n = normSpace(s);
  if (!n) return '';
  const rows = [
    ['background', sections.objective || sections.background || ''],
    ['finding', sections.results || sections.findings || ''],
    ['significance', sections.conclusion || sections.interpretation || ''],
  ];
  const hits = rows.filter(([, blob]) => blob && normSpace(blob).includes(n));
  return hits.length === 1 ? hits[0][0] : '';
}

function assignRole(q, cand, sections) {
  const explicit = QUOTE_ROLES.includes(q?.role) ? q.role : '';
  if (isMechanism(cand) && !isImplication(cand) && explicit !== 'background' && explicit !== 'significance') return 'mechanism';
  const fromSection = sectionRole(cand, sections);
  let role = explicit || fromSection || classifySentence(cand);
  if (!role) role = classifySentence(cand);
  if (isImplication(cand) && role !== 'significance') role = 'significance';
  if (PROBLEM.test(cand) && !isImplication(cand) && role === 'significance') role = 'background';
  if (role === 'significance' && wordedResult(cand)) role = 'finding';
  if (role === 'finding' && isMechanism(cand)) role = 'mechanism';
  if (role === 'mechanism' && !isMechanism(cand)) role = classifySentence(cand);
  return role;
}

function scoreRole(s, role) {
  if (isBoilerplate(s)) return -50;
  let q = 0;
  if (s.length <= 320) q += 2;
  else if (s.length > 480) q -= 2;
  if (isDesign(s) || METHODS_LEAD.test(s)) q -= 8;
  if (CENSUS.test(s)) q -= 8;
  if (role === 'background') {
    if (PROBLEM.test(s)) q += 8;
    if (/^(background|objectives?|aims?)\b/i.test(s)) q += 8;
    if (isImplication(s)) q -= 12;
    if (/\bwe (investigated|aimed|sought|evaluated)\b/i.test(s)) q += 1;
    if (isDenseMethods(s)) q -= 6;
  } else if (role === 'finding') {
    if (/^(results?|findings?)\b/i.test(s)) q += 8;
    if (RESULT.test(s) || /\b(we found|we show|we report|showed that)\b/i.test(s)) q += 6;
    if (/\b(significantly|compared with|than placebo|than usual|faster|slower|greater|lower risk|higher rate)\b/i.test(s)) q += 5;
    if (/\b(primary (?:end ?point|efficacy|outcome)|symptom relief|percentage change)\b/i.test(s)) q += 4;
    if (statesEffect(s) && !isClutteredResult(s)) q += 4;
    if (isClutteredResult(s)) q -= 4;
    if (isRunIn(s)) q -= 8;
    if (/\b(not eliminated|despite|unknown|unclear)\b/i.test(s)) q -= 5;
    if (INTERP.test(s)) q -= 3;
    if (isDenseMethods(s) && !RESULT.test(s)) q -= 8;
  } else if (role === 'mechanism') {
    if (!isMechanism(s)) return -40;
    if (/\bmechanistically\b/i.test(s)) q += 8;
    if (/\b(cascade|pathway|signall?ing|lipid[- ]uptake|lipid-influx|redox)\b/i.test(s)) q += 6;
    if (/\bmediated\b/i.test(s)) q += 4;
    if (numberHeavy(s)) q -= 4;
    if (isImplication(s)) q -= 12;
  } else {
    if (isImplication(s) || /^(interpretation|conclusions?|implications?)\b/i.test(s)) q += 10;
    if (FINDING.test(s)) q += 4;
    if (PROBLEM.test(s) && !isImplication(s)) q -= 6;
    if (isDenseMethods(s)) q -= 6;
    if (isMechanism(s)) q -= 4;
  }
  return q;
}

function sectionText(sections, role) {
  if (!sections || typeof sections !== 'object') return '';
  if (role === 'background') return sections.objective || sections.background || '';
  if (role === 'finding') return sections.results || sections.findings || '';
  return sections.conclusion || sections.interpretation || '';
}

/** Sentences that belong to a role. Structured sections win when they exist. */
function candidatesFor(role, sentences, sections) {
  const blob = normSpace(sectionText(sections, role));
  if (blob) {
    const fromSection = sentences.filter(s => blob.includes(normSpace(s)) && !isBoilerplate(s));
    if (fromSection.length) return fromSection;
  }
  const tagged = sentences.filter(s => classifySentence(s) === role);
  return tagged.length ? tagged : sentences.filter(s => !isBoilerplate(s));
}

function statesEffect(s) {
  return RESULT.test(s)
    || /\b(we (?:found|find|show|report|demonstrate|identify)|showed that|resulted in|improv)\b/i.test(s)
    || /\b(significantly|than placebo|compared with placebo|than usual|faster|slower|reduced|increased|fewer|symptom relief|lower risk|higher rate|percentage change|treatment difference)\b/i.test(s);
}

/** Confidence intervals and p-values, not the result itself. */
function isClutteredResult(s) {
  return /95\s*%|\bCIs?\b|confidence interval|\bp\s*[<=>]|\bp\s*</i.test(s);
}

function isRunIn(s) {
  return CENSUS.test(s)
    || /\b(completed the (?:study|trial)(?: drug)?|were screened|were randomly assigned|randomly assigned to|were enrolled)\b/i.test(s);
}

function plainResult(s) {
  return statesEffect(s) && !isClutteredResult(s) && !isRunIn(s) && !isBoilerplate(s) && !isDesign(s);
}

function highest(pool, role) {
  let best = '';
  let bestSc = -1e9;
  for (const s of pool) {
    const sc = scoreRole(s, role);
    if (sc > bestSc) { bestSc = sc; best = s; }
  }
  if (!best) return '';
  if (role === 'mechanism') return bestSc > 0 ? best : '';
  if (bestSc > -5 || (role === 'finding' && statesEffect(best) && !isRunIn(best))) return best;
  return '';
}

function bestFor(role, sentences, sections, used) {
  if (role === 'mechanism') {
    return highest(sentences.filter(s => !used.has(s) && isMechanism(s)), 'mechanism');
  }
  const pool = candidatesFor(role, sentences, sections).filter(s => !used.has(s) && !isBoilerplate(s) && !isMechanism(s));
  let rows = pool;
  if (role === 'finding') {
    const worded = sentences.filter(s => !used.has(s) && wordedResult(s));
    if (worded.length) {
      const blob = normSpace(sectionText(sections, 'finding'));
      const inResults = blob ? worded.filter(s => blob.includes(normSpace(s))) : [];
      rows = inResults.length ? inResults : worded;
    } else {
      const effects = pool.filter(s => statesEffect(s) && !isRunIn(s));
      if (effects.length) rows = effects;
    }
  }
  const hasWorded = role === 'finding' && rows.some(s => wordedResult(s) || (plainResult(s) && !numberHeavy(s)));
  const filtered = [];
  for (const s of rows) {
    if (role !== 'finding' && role !== 'mechanism' && isDenseMethods(s) && pool.some(o => !isDenseMethods(o))) continue;
    if (role === 'finding' && hasWorded && (numberHeavy(s) || isClutteredResult(s))) continue;
    if (role === 'finding' && isRunIn(s) && rows.some(o => statesEffect(o) && !isRunIn(o))) continue;
    filtered.push(s);
  }
  const best = highest(filtered.length ? filtered : rows, role);
  if (best) return best;
  if (role === 'mechanism') return '';
  return sentences.find(s => !used.has(s) && !isBoilerplate(s) && !isDenseMethods(s) && !isDesign(s) && !isMechanism(s)) || '';
}

export const EXCERPT_WORDS = 25;

const LEAD_IN = /^(?:here,\s+we\s+(?:report|show|found|find|demonstrate|identified|identify)\s+that|in this study,?(?:\s+we(?:\s+\w+){0,3})?|we\s+(?:report|show|found|find|demonstrate|identified|identify)\s+that|mechanistically|notably|importantly|thus|therefore|hence|collectively|taken together|in conclusion),?\s+/i;

function wordCount(s) {
  return normSpace(s).split(/\s+/).filter(Boolean).length;
}

/** A contiguous slice of `sentence`. Omissions are marked with …. */
export function excerptQuote(sentence, role) {
  const src = normSpace(sentence).replace(/[.。]+\s*$/, '');
  if (!src) return '';
  let body = src;
  const lead = body.match(LEAD_IN);
  if (lead && lead[0].length < body.length - 12) body = body.slice(lead[0].length);
  body = body.replace(/\s*\((?:[^()]|\([^()]*\))*(?:95\s*%|\bCIs?\b|\bp\s*[<=>]|\bp\s*<|\bSE\b|\bIQR\b)[^)]*\)\s*$/i, '').trim();
  const cuts = [
    /,\s+with\s+(?:median|mean)\b/i,
    /,\s+respectively\b/i,
    /,\s+with a safety profile\b/i,
    /,\s+culminating\b/i,
    /,\s+and may address\b/i,
  ];
  for (const re of cuts) {
    const at = body.search(re);
    if (at >= 24) body = body.slice(0, at).trim();
  }
  body = body.replace(/[,:;]\s*$/, '').trim();
  let chunk = body;
  if (wordCount(chunk) > EXCERPT_WORDS) chunk = focusExcerpt(body, role);
  chunk = tidyEnd(chunk);
  if (!chunk || !src.includes(chunk)) return normSpace(sentence);
  const marked = markOmissions(src, chunk);
  if (marked === src) return normSpace(sentence);
  return marked;
}

function tidyEnd(chunk) {
  const dangling = /\s+(?:and|or|but|that|which|who|whose|including|with|of|to|for|in|by|via|than|as|from|into|about|induces|causing|independently|respectively)\s*$/i;
  let out = String(chunk || '').replace(/\s+\d+\s*[-–]\s*\d+$/, '').replace(/[,:;]\s*$/, '').trim();
  while (dangling.test(out) && wordCount(out) > 8) out = out.replace(dangling, '').replace(/[,:;]\s*$/, '').trim();
  return out;
}

function focusExcerpt(body, role) {
  const key = role === 'mechanism'
    ? /\b(mechanistically|cascade|mediated|pathway|signall?ing|signaling|redox|lipid[- ]uptake|lipid-influx|\bvia\b)/i
    : role === 'finding'
      ? /\b(causes|caused|reduced|increased|faster|improved|improv|significantly|resulted in|accelerated|associated)/i
      : role === 'background'
        ? /\b(not eliminated|remain|remains|scant|unknown|unclear|despite|limited)/i
        : /\b(safeguard|support|effective|suggest|reveal|restrain|should be)/i;
  const tokens = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(body))) tokens.push({ start: m.index, end: m.index + m[0].length });
  if (tokens.length <= EXCERPT_WORDS) return body.trim();
  let anchor = 0;
  const hit = key.exec(body);
  if (hit) {
    const at = tokens.findIndex(t => hit.index < t.end && hit.index + hit[0].length > t.start);
    if (at >= 0) anchor = at;
  }
  const start = anchor < EXCERPT_WORDS ? 0 : Math.max(0, anchor - 8);
  const end = Math.min(tokens.length, start + EXCERPT_WORDS);
  return body.slice(tokens[start].start, tokens[end - 1].end).replace(/[,:;]\s*$/, '').trim();
}

function markOmissions(src, chunk) {
  const at = src.indexOf(chunk);
  if (at < 0) return src;
  const lead = at > 0;
  const trail = at + chunk.length < src.length;
  let out = chunk.replace(/^[,:;]\s*/, '').replace(/[,:;]\s*$/, '');
  if (!out || !src.includes(out)) return src;
  if (lead) out = '…' + out;
  if (trail) out += '…';
  const core = out.replace(/…/g, '').trim();
  if (!src.includes(core)) return src;
  return out;
}

function sameWords(excerpt, sentence) {
  const core = normSpace(excerpt).replace(/…/g, '').replace(/[.。]+$/, '').trim();
  const full = normSpace(sentence).replace(/[.。]+$/, '').trim();
  return core === full;
}

/**
 * Background, finding, mechanism only when the abstract states one, then significance.
 * Each English line is a contiguous excerpt of one abstract sentence.
 * sections, when present, are {objective, methods, results, conclusion}.
 */
export function resolveQuotePicks(abstract, modelQuotes, sections) {
  const sentences = splitSentences(abstract);
  const used = new Set();
  const chosen = {};
  for (const q of modelQuotes || []) {
    const cand = sentenceFrom(q, sentences);
    if (!cand || used.has(cand) || isBoilerplate(cand)) continue;
    if (isDenseMethods(cand) && !isMechanism(cand) && sentences.some(s => !isDenseMethods(s) && !isBoilerplate(s))) continue;
    let role = assignRole(q, cand, sections);
    if (role === 'finding' && wordedResult(cand)) {
      const blob = normSpace(sectionText(sections, 'finding'));
      const inResults = blob && blob.includes(normSpace(cand));
      if (!inResults && sentences.some(s => s !== cand && blob && blob.includes(normSpace(s)) && wordedResult(s))) {
        role = 'significance';
      }
    }
    if (!role || chosen[role]) continue;
    if (role === 'mechanism' && !isMechanism(cand)) continue;
    if (role === 'finding' && (CENSUS.test(cand) || isRunIn(cand)) && sentences.some(s => s !== cand && statesEffect(s) && !isRunIn(s))) continue;
    if (role === 'finding' && numberHeavy(cand) && sentences.some(s => s !== cand && wordedResult(s))) continue;
    if (role === 'background' && /\bwe (investigated|aimed|sought)\b/i.test(cand)) {
      const better = candidatesFor('background', sentences, sections).some(s => PROBLEM.test(s));
      if (better) continue;
    }
    chosen[role] = { role, en: cand, zh: normSpace(q?.zh || '') };
    used.add(cand);
  }
  for (const role of QUOTE_ROLES) {
    if (chosen[role]) continue;
    const en = bestFor(role, sentences, sections, used);
    if (!en) continue;
    chosen[role] = { role, en, zh: '' };
    used.add(en);
  }
  return QUOTE_ROLES.filter(role => chosen[role]).map(role => {
    const full = chosen[role].en;
    const en = excerptQuote(full, role);
    return { role, en, zh: sameWords(en, full) ? chosen[role].zh : '' };
  });
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
    const role = QUOTE_ROLES.includes(item?.role) ? item.role : '';
    return {
      i: Number.isInteger(idx) ? idx : NaN,
      role,
      en: String(item?.en || item?.sentence || ''),
      zh: String(item?.zh || item?.translation || ''),
    };
  });
}
