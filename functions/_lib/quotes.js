/**
 * Share-card quotes in Robin's order:
 * a clinical paradox, the finding restated as a contrast, then the broader significance.
 * A fourth quote is added only for a striking secondary finding.
 * Each quote is a full or nearly full sentence from the abstract or the open-access full text.
 */

export const ABSTRACT_MAX = 14000;
export const QUOTE_MIN = 3;
export const QUOTE_MAX = 4;
export const EXCERPT_WORDS = 48;

export const QUOTE_ROLES = ['background', 'finding', 'significance', 'secondary'];

export const QUOTE_SYSTEM = `You choose quotations for a Chinese physician. The card has three sentences, in this order. Add a fourth only when the paper has a striking secondary finding that the three sentences do not already say.
You will receive a numbered list of sentences from the abstract and, when the full text is open access, from the Introduction and Discussion. The number in brackets is the index. Prefer a Discussion sentence over an abstract sentence when both make the same point.
The gold standard is these three sentences from a Cell paper, in this order:
1. "…with many events occurring in individuals with normal blood lipid or low-density lipoprotein (LDL) levels due to non-lipid vascular risk factors."
2. "Thus, GIMAP6 functions as a distinct cardiovascular disease determinant that protects the endothelial structural integrity and controls the threshold for macrophage response to lipid, rather than systemic lipid levels themselves."
3. "More broadly, GIMAP6 reveals how immune-regulatory failure can couple endothelial dysfunction, foam-cell formation, and inflammation into a self-reinforcing cascade that culminates in lethal ischemic cardiovascular disease."
Match that shape. A leading … is allowed when the sentence opens with a generic clause. Do not cut a sentence down to a fragment. About 20 to 40 words is the right length.
1. background — the problem as a clinical paradox or a sharp gap. Prefer "normal LDL", "not eliminated", "remain scant", "unexpectedly", "paradoxically", "in contrast". Do not pick "To evaluate…", "X is a leading cause of death" with nothing after it, or a bare objective.
2. finding — the main result restated as a contrast: "rather than", "distinct", "independent of", "in the absence of". For a trial, the overall benefit in words. Not an adverse-event sentence and not a confidence-interval dump when a worded result exists.
3. significance — the big-picture sentence, ideally opening "More broadly" or carrying "beyond" / "first". Not "These results show that X might be effective."
4. secondary — one striking extra finding (an unexpected safety signal or a subgroup). Omit it when the three sentences already contain that point. Do not add a fourth just to fill the card.
Never choose "We aimed to assess the efficacy and safety…", "We investigated the efficacy and safety…", "Nationwide, population based matched case-control study.", "Safety was assessed…", trial registration, an NCT number, funding, ethics, or copyright.
Do not stitch clauses from different sentences. Do not shorten a sentence that is already about 20 to 40 words. Keep "Thus," and "More broadly,".
Return JSON only, no markdown:
{"quotes":[{"role":"background","i":0,"zh":"..."},{"role":"finding","i":4,"zh":"..."},{"role":"significance","i":8,"zh":"..."}]}
Rules:
1. i must be an index from the list. Do not invent, merge, or rewrite a sentence.
2. zh is a Simplified Chinese translation of that exact sentence. If you would drop a lead-in clause, still translate the full sentence; the server trims.
3. Keep drug names, gene and protein names, trial names, and acronyms in English.
4. Drug names may appear as placeholders like [D1]. Copy every placeholder into zh unchanged.
5. Translate faithfully. Do not add or omit facts.`;

const ABBREV = /(?:et al|Figs?|vs|Dr|Mr|Mrs|Ms|Prof|e\.g|i\.e|U\.S|No|Vol|Jr|Sr|St|approx|ca|al)$/i;
const HINT = /patient|risk|mortality|death|outcome|significant|associat|treatment|therapy|reduc|increas|improv|therefore|thus|we found|demonstrat|suggest|benefit|hazard|survival|disease|failure|conclus|trial|effect|among|compared/i;
const RESULT = /\b(detected|reduced|increased|improved|fewer|more likely|associated|caused|accelerated|response rate|survival|mortality|showed|enabled|avoided|no increase|non-inferior|deaths? occurred|adverse events occurred)\b/i;
const CONTRAST = /\b(despite|in the absence of|independently of|even (?:in|among|without)|unexpected(?:ly)?|surpris(?:e|ing|ingly)|contrary to|paradox|rather than|whereas|in contrast|without hyperlipidemia|not only|beyond)\b/i;
const SAFETY = /\b(adverse events?|discontinu|hypotension|dysesthesia|severe or serious)\b/i;
const SUBGROUP = /\b(more pronounced|particularly among|younger ages|earlier ages|only among|subgroup)\b/i;
const STOP = new Set(['with', 'that', 'this', 'from', 'were', 'was', 'have', 'been', 'into', 'than', 'then', 'them', 'they', 'their', 'which', 'while', 'after', 'before', 'between', 'among', 'within', 'without', 'other', 'more', 'most', 'such', 'only', 'also', 'both', 'each', 'over', 'under', 'about']);
const METHODS_LEAD = /^(between \d|women aged|the median age|patients were|participants were|we randomly|randomly allocated|eligible |inclusion |exclusion |methods\b|this (?:study|trial) (?:is|was) registered)/i;
const CENSUS = /\b(were assessed for eligibility|were randomly allocated|were male|were female|median age|included \d+ participants|of these,? \d+)\b/i;
const FORMULA_LEAD = /^(?:here,\s+we\s+(?:report|show|found|find|demonstrate|identified|identify)\s+that|in this study,?(?:\s+we(?:\s+\w+){0,5})?|we\s+(?:report|show|found|find|demonstrate|identified|identify)\s+that),?\s+/i;

function isDesign(s) {
  return /^(?:this (?:single-arm|randomised|randomized|multicentre|multicenter|phase|open-label|study|trial)|[A-Za-z0-9-]{2,} is a )\b/i.test(s)
    || /^[A-Za-z0-9-]{2,} was a\b/i.test(s) && /\b(trial|study)\b/i.test(s)
    || /\b(randomly allocated|randomly assigned|was conducted|were identified by|was analysed in|was analyzed in|safety was assessed|protocol-permitted|eligible patients were|we aimed to|was defined as)\b/i.test(s)
    || /\b(?:primary|secondary) endpoints? (?:of|was the|were the)\b/i.test(s)
    || /\bprespecified secondary\b/i.test(s)
    || /\bsecondary outcome was\b/i.test(s)
    || /\bas (?:primary|secondary) outcomes?\b/i.test(s);
}

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

function wordCount(s) {
  return normSpace(s).split(/\s+/).filter(Boolean).length;
}

function contentWords(s) {
  return new Set(
    normSpace(s).toLowerCase().split(/[^a-z0-9+]+/).filter(w => w.length > 3 && !STOP.has(w)),
  );
}

function redundant(a, b) {
  const A = contentWords(a);
  const B = contentWords(b);
  if (A.size < 4 || B.size < 4) return false;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size) >= 0.62;
}

function normClaim(s) {
  return normSpace(s).toLowerCase()
    .replace(/…/g, ' ')
    .replace(/\b(younger|earlier)\s+ages?\b/g, ' agegradient ')
    .replace(/\b(more pronounced|particularly among|especially among)\b/g, ' subgroupmark ')
    .replace(/\b(lower odds|lower risk|reduced risk|risk reduction)\b/g, ' riskdown ')
    .replace(/\badverse pregnancy outcomes\b/g, ' pregout ')
    .replace(/\b(in the absence of|independently of)\b/g, ' notvia ')
    .replace(/\bhyperlipidaemia\b/g, 'hyperlipidemia')
    .replace(/\bbody\s*weight\b/g, ' bodyweight ')
    .replace(/\bglycaemic\b/g, 'glycemic');
}

function claimSame(a, b) {
  if (!a || !b) return false;
  const A = normClaim(a);
  const B = normClaim(b);
  const both = (re) => re.test(A) && re.test(B);
  if (both(/\bagegradient\b/) || both(/\bsubgroupmark\b/)) return true;
  if (both(/\briskdown\b/) && both(/\bpregout\b/)) return true;
  if (both(/\bnotvia\b/) && both(/\bhyperlipidemia\b/)) return true;
  if (both(/\bbodyweight\b/) && both(/\b(improv|reduction|percentage|placebo)\b/)) return true;
  if (both(/\bsymptom relief\b/) && both(/\b(faster|placebo)\b/)) return true;
  if (both(/\brather than\b/) && both(/\blipid\b/)) return true;
  if (both(/\bmore broadly\b/)) return true;
  return false;
}

/** True when two lines would tell the reader the same fact. */
export function samePoint(a, b) {
  if (!a || !b) return false;
  if (redundant(a, b)) return true;
  return claimSame(a, b);
}

function isStiff(s) {
  const t = normSpace(s);
  if (/^(?:to (?:evaluate|determine|assess|investigate|compare|examine)\b)/i.test(t)) return true;
  if (/^we (?:aimed|sought) to\b/i.test(t)) return true;
  if (/^in this study, we aimed to\b/i.test(t)) return true;
  if (/^we investigated the (?:efficacy|safety|association)\b/i.test(t)) return true;
  if (/\bmight be effective for the treatment\b/i.test(t)) return true;
  if (/\bthese results show that\b/i.test(t) && /\bmight be effective\b/i.test(t)) return true;
  if (/^(?:nationwide, population[- ]based|this (?:was|is) a ).{0,90}\b(?:case-control|cohort|cross-sectional) study\.?$/i.test(t)) return true;
  if (/^safety (?:was assessed|analyses included)\b/i.test(t)) return true;
  if (/^patients and members of the public were not involved\b/i.test(t)) return true;
  if (/^we acknowledge several limitations\b/i.test(t)) return true;
  return false;
}

function isRunIn(s) {
  return CENSUS.test(s)
    || /\b(completed the (?:study|trial)(?: drug)?|were screened|were randomly assigned|randomly assigned to|were enrolled)\b/i.test(s);
}

function isClutteredResult(s) {
  return /95\s*%|\bCIs?\b|confidence interval|\bp\s*[<=>]|\bp\s*</i.test(s);
}

function numberHeavy(s) {
  const text = String(s || '');
  const digits = (text.match(/\d/g) || []).length;
  const pct = (text.match(/%/g) || []).length;
  return isClutteredResult(s) || digits >= 10 || pct >= 3;
}

function safetyNote(s) {
  return SAFETY.test(s) && !/\b(safety was assessed|safety analyses included)\b/i.test(s);
}

function safetyOnly(s) {
  return safetyNote(s) && !/\b(improv|body\s?weight|glycaem|glycemic|relief|lower odds|lower risk|efficac|non-inferior|rather than)\b/i.test(s);
}

function strikingGap(s) {
  return /\bmore than \d+/i.test(s) && /\b(faster|slower|median times?|compared with|than placebo)\b/i.test(s);
}

function usableSentence(s) {
  return !!s && !isBoilerplate(s) && !isRunIn(s) && !CENSUS.test(s) && !isStiff(s);
}

/** Higher means a clinician is more likely to stop on the sentence. */
export function interestScore(s) {
  if (!s || isBoilerplate(s) || isStiff(s)) return -80;
  if (isRunIn(s) || CENSUS.test(s)) return -70;
  if (isDesign(s) || METHODS_LEAD.test(s)) return -60;
  let q = 0;
  if (isDenseMethods(s) && !CONTRAST.test(s) && !safetyNote(s)) q -= 35;
  if (CONTRAST.test(s) || strikingGap(s)) q += 16;
  if (/\b(thus|more broadly|rather than|unexpectedly|paradoxically|in contrast)\b/i.test(s)) q += 8;
  if (HINT.test(s)) q += 2;
  if (RESULT.test(s) && !isDenseMethods(s)) q += 3;
  if (numberHeavy(s) && !strikingGap(s)) q -= 10;
  if (s.length > 520) q -= 3;
  return q;
}

export function pickHeuristic(sentences, n = 3) {
  const ranked = sentences
    .map((s, i) => ({ s, i, sc: interestScore(s) }))
    .filter(row => row.sc > -40)
    .sort((a, b) => b.sc - a.sc || a.i - b.i);
  const picked = [];
  for (const row of ranked) {
    if (picked.length >= n) break;
    if (picked.some(p => redundant(p.s, row.s))) continue;
    picked.push(row);
  }
  if (picked.length < Math.min(n, ranked.length)) {
    for (const row of ranked) {
      if (picked.length >= n) break;
      if (picked.some(p => p.i === row.i)) continue;
      picked.push(row);
    }
  }
  return picked.sort((a, b) => a.i - b.i).slice(0, n).map(p => p.s);
}

function sentenceFrom(q, sentences) {
  const i = Number(q?.i);
  if (Number.isInteger(i) && i >= 0 && i < sentences.length) return sentences[i];
  return findVerbatim(q?.en, sentences);
}

function paradoxClause(src) {
  const at = src.search(/,\s+with many events occurring\b/i);
  if (at < 0) return '';
  const clause = src.slice(at).replace(/^,\s+/, '').replace(/[.。]+\s*$/, '').trim();
  if (wordCount(clause) < 12 || wordCount(clause) > EXCERPT_WORDS) return '';
  return src.includes(clause) ? clause : '';
}

function breadthClause(src) {
  const at = src.search(/\b(?:extending benefits|extend(?:s|ing)? the benefits|far beyond|benefits of \w+ vaccination beyond)\b/i);
  if (at < 12) return '';
  let clause = src.slice(at).replace(/[.。]+\s*$/, '').trim();
  clause = clause.replace(/^(?:and|or)\s+/i, '');
  if (wordCount(clause) < 8 || wordCount(clause) > EXCERPT_WORDS) return '';
  return src.includes(clause) ? clause : '';
}

function markOmissions(src, chunk) {
  const at = src.indexOf(chunk);
  if (at < 0) return src;
  const lead = at > 0;
  const trail = at + chunk.length < src.replace(/[.。]+\s*$/, '').length && at + chunk.length < src.length;
  let out = chunk.replace(/^[,:;]\s*/, '').replace(/[,:;]\s*$/, '');
  if (!out || !src.includes(out)) return src;
  if (lead) out = '…' + out;
  if (trail && at + chunk.length < src.replace(/[.。]+\s*$/, '').length) out += '…';
  const core = out.replace(/…/g, '').trim();
  if (!src.includes(core)) return src;
  return out;
}

function finishExcerpt(src, chunk) {
  const bare = src.replace(/[.。]+\s*$/, '');
  const core = chunk.replace(/[,:;]\s*$/, '').trim();
  if (!core || !bare.includes(core)) return normSpace(src);
  const at = bare.indexOf(core);
  const ends = at + core.length >= bare.length;
  let out = markOmissions(bare, core);
  if (ends && /[.。]/.test(src) && !out.endsWith('…')) out += src.match(/[.。]/)[0];
  return out;
}

function tidyStart(chunk) {
  let out = String(chunk || '').trim().replace(/^(?:and|or|but)\s+/i, '');
  const broken = out.match(/^[^,]{0,48}\),\s*/);
  if (broken) out = out.slice(broken[0].length);
  return out.trim();
}

function tidyEnd(chunk) {
  const dangling = /\s+(?:and|or|but|that|which|who|whose|including|with|of|to|for|in|by|via|than|as|from|into|about)\s*$/i;
  let out = String(chunk || '').replace(/[,:;]\s*$/, '').trim();
  while (dangling.test(out) && wordCount(out) > 12) out = out.replace(dangling, '').replace(/[,:;]\s*$/, '').trim();
  return out;
}

function focusWindow(body, role) {
  const key = role === 'finding'
    ? /\b(rather than|in the absence of|independently of|substantial(?:ly)? improvements|lower odds|we identify|significantly faster|reduced risk|distinct)\b/i
    : role === 'significance'
      ? /\b(more broadly|beyond|first orally|reveals how)\b/i
      : role === 'secondary'
        ? /\b(hypotension|dysesthesia|more pronounced|younger|only adverse event)\b/i
        : /\b(despite|paradox|not eliminated|remain(?:s|ed)? (?:scant|limited)|non-lipid|unexpectedly|in contrast)\b/i;
  const tokens = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(body))) tokens.push({ start: m.index, end: m.index + m[0].length });
  const budget = Math.min(EXCERPT_WORDS, 40);
  if (tokens.length <= budget) return body.trim();
  let anchor = 0;
  const flags = new RegExp(key.source, key.flags.includes('g') ? key.flags : key.flags + 'g');
  let hit;
  while ((hit = flags.exec(body))) {
    const at = tokens.findIndex(t => hit.index < t.end && hit.index + hit[0].length > t.start);
    if (at > anchor) anchor = at;
  }
  const nearEnd = anchor >= tokens.length - 8;
  const start = nearEnd ? Math.max(0, tokens.length - budget) : (anchor < budget ? 0 : Math.max(0, anchor - 12));
  const end = Math.min(tokens.length, start + budget);
  return tidyEnd(tidyStart(body.slice(tokens[start].start, tokens[end - 1].end)));
}

/** A contiguous slice of one sentence. A full sentence under the cap is kept. */
export function excerptQuote(sentence, role, focus) {
  const src = normSpace(sentence);
  const bare = src.replace(/[.。]+\s*$/, '');
  if (!bare) return '';
  const hinted = normSpace(focus || '').replace(/[.。]+\s*$/, '');
  if (hinted && bare.includes(hinted) && wordCount(hinted) >= 8 && wordCount(hinted) <= EXCERPT_WORDS) {
    return finishExcerpt(src, hinted);
  }
  if (role === 'background') {
    const clause = paradoxClause(bare);
    if (clause) return finishExcerpt(src, clause);
  }
  if (role === 'secondary') {
    const at = bare.search(/\s+\([^)]*(?:\d|%|\bCI\b)[^)]*\)/);
    if (at >= 24) {
      const head = bare.slice(0, at).replace(/[,:;]\s*$/, '').trim();
      if (wordCount(head) >= 8 && wordCount(head) <= EXCERPT_WORDS && bare.includes(head)) return finishExcerpt(src, head);
    }
  }
  let body = bare;
  const lead = body.match(FORMULA_LEAD);
  if (lead && wordCount(body.slice(lead[0].length)) >= 8) body = body.slice(lead[0].length).trim();
  if (wordCount(body) > EXCERPT_WORDS) body = focusWindow(body, role);
  body = tidyEnd(tidyStart(body));
  if (!body || !bare.includes(body)) return src;
  return finishExcerpt(src, body);
}

function overlapsShown(text, shown) {
  return shown.some(t => samePoint(t, text));
}

function backgroundScore(s) {
  if (!usableSentence(s) || isDenseMethods(s)) return -40;
  if (safetyOnly(s)) return -20;
  let q = 0;
  if (/\b(with many events occurring|normal blood lipid)\b/i.test(s)) q += 48;
  if (/\bnon-lipid\b/i.test(s)) q += 14;
  if (/\bwhereas\b/i.test(s) && /\b(unexplored|unknown|unclear|remains)\b/i.test(s)) q += 30;
  if (/\bcannot be solely explained\b/i.test(s)) q += 18;
  if (/\bharness oxidative\b/i.test(s)) q += 12;
  if (/\bparadoxicall?y\b/i.test(s)) q += 28;
  if (/\b(not eliminated|remain(?:s|ed)? (?:scant|limited|elusive)|incompletely understood|preventive measures remain limited|no effective|currently under investigation|little is known|poorly understood)\b/i.test(s)) q += 18;
  if (/\b(despite|unexpectedly|in contrast)\b/i.test(s)) q += 8;
  if (/\b(leading cause of|major cause of)\b/i.test(s) && !/\b(not eliminated|with many events|remain(?:s|ed)? (?:scant|limited)|despite)\b/i.test(s)) q -= 16;
  if (/\b(rather than|more broadly|first orally|we identify)\b/i.test(s)) q -= 18;
  if (/^thus,/i.test(s) && !/\b(with many events|normal blood lipid|despite)\b/i.test(s)) q -= 12;
  if (/\bwe (?:found|identify|demonstrate)\b/i.test(s)) q -= 10;
  return q;
}

function findingScore(s) {
  if (!usableSentence(s) || isDesign(s) || METHODS_LEAD.test(s)) return -40;
  if (safetyOnly(s)) return -40;
  if (/\bmore broadly\b/i.test(s)) return -12;
  let q = 0;
  if (/^thus,/i.test(s) && /\b(rather than|distinct|independent)\b/i.test(s)) q += 34;
  if (/\brather than\b/i.test(s)) q += 22;
  if (/\bdistinct\b/i.test(s) && /\b(determinant|pathway|mechanism)\b/i.test(s)) q += 16;
  if (/\b(independently of|independent of)\b/i.test(s)) q += 16;
  if (/\bin the absence of\b/i.test(s)) q += 18;
  if (/\bsubstantial(?:ly)? improvements?\b/i.test(s) && /\b(body\s?weight|glycaem|glycemic|weight)\b/i.test(s)) q += 28;
  if (/\blower odds of all\b/i.test(s)) q += 26;
  if (/\bwe identify\b/i.test(s)) q += 22;
  if (/\b(significantly faster|faster times to symptom relief)\b/i.test(s) && /\b(placebo|than)\b/i.test(s)) q += 16;
  if (/\breduced risk\b/i.test(s) && /\bwe found\b/i.test(s)) q += 14;
  if (/\b(improved|reduced|fewer|increased)\b/i.test(s) && /\b(survival|mortality|risk|events|cancers?)\b/i.test(s)) q += 12;
  if (isClutteredResult(s)) q -= 22;
  if (numberHeavy(s) && !/\bsubstantial(?:ly)? improvements?\b/i.test(s)) q -= 8;
  if (/\b(more broadly|first orally|beyond cancer)\b/i.test(s)) q -= 12;
  return q;
}

function significanceScore(s) {
  if (!usableSentence(s) || isDenseMethods(s)) return -40;
  if (safetyOnly(s)) return -16;
  let q = 0;
  if (/^more broadly\b/i.test(s)) q += 40;
  else if (/\bmore broadly\b/i.test(s)) q += 28;
  if (/\b(beyond cancer|far beyond|first orally|reveals how)\b/i.test(s)) q += 22;
  if (/\bbeyond\b/i.test(s)) q += 8;
  if (/^(?:thus|therefore|collectively|taken together)\b/i.test(s) && !/\brather than\b/i.test(s)) q += 6;
  if (/\b(should change|implications?|suggest that)\b/i.test(s)) q += 8;
  if (/\b(might be effective|may address an unmet)\b/i.test(s) && !/\b(first orally|beyond|more broadly)\b/i.test(s)) q -= 24;
  if (findingScore(s) >= 30 && !/\b(more broadly|beyond|first orally|reveals how)\b/i.test(s)) q -= 18;
  return q;
}

function secondaryScore(s) {
  if (!usableSentence(s)) return -40;
  const striking = safetyNote(s) || (SUBGROUP.test(s) && !/\bbeyond\b/i.test(s));
  if (!striking) return -40;
  if (isDenseMethods(s) && !/\b(hypotension|dysesthesia|only adverse event)\b/i.test(s)) return -30;
  let q = 8;
  if (/\b(hypotension|dysesthesia|only adverse event)\b/i.test(s)) q += 18;
  if (SUBGROUP.test(s)) q += 16;
  if (numberHeavy(s)) {
    const at = String(s).search(/\s+\([^)]*(?:\d|%)/);
    const head = at >= 24 ? String(s).slice(0, at) : '';
    if (!/\b(hypotension|dysesthesia|only adverse event)\b/i.test(head)) q -= 24;
  }
  if (findingScore(s) >= 24) q -= 20;
  return q;
}

function roleScore(s, role) {
  if (role === 'background') return backgroundScore(s);
  if (role === 'finding') return findingScore(s);
  if (role === 'secondary') return secondaryScore(s);
  return significanceScore(s);
}

function roleFloor(role) {
  if (role === 'secondary') return 18;
  return 8;
}

const RESULT_LINE = /\b(associated|differed|compared with|no evidence|did not identify|reduced|increased|improved|fewer|lower odds|faster|resulted in|similar in efficacy|non-inferior|significantly greater)\b/i;
const MEANING_LINE = /\b(should be considered|clinicians should|shared decision|suggest that|these findings|this finding supports|these results establish|in conclusion|together, these results)\b/i;

/** Ordinary result and conclusion lines, used only when the gold scores all miss. */
function plainScore(s, index = 0, total = 1) {
  if (!usableSentence(s) || isDesign(s) || METHODS_LEAD.test(s) || isRunIn(s)) return -40;
  if (/\b(primary|secondary) (?:outcomes?|end ?points?) (?:was|were)\b/i.test(s)) return -20;
  if (isDenseMethods(s) && !CONTRAST.test(s)) return -30;
  let q = 0;
  if (RESULT_LINE.test(s)) q += 8;
  if (MEANING_LINE.test(s)) q += 8;
  if (/^we (?:introduce|identify|demonstrate|benchmark)\b/i.test(s)) q += 6;
  if (CONTRAST.test(s) && !numberHeavy(s)) q += 4;
  if (index === 0) q += 4;
  if (total > 1 && index >= total - 2) q += 4;
  if (numberHeavy(s)) q -= 6;
  if (/\b(meta-regression|eligibility criteria|were identified through|were analysed using|were analyzed using|were harmonised|were harmonized|we conducted a)\b/i.test(s)) q -= 12;
  return q;
}

function packPlain(role, sentence, indexed, modelQuotes) {
  if (!sentence) return null;
  const excerpt = excerptQuote(sentence, role);
  if (!excerpt) return null;
  const zh = modelZhFor(modelQuotes, indexed, sentence, role);
  return {
    role,
    en: excerpt,
    zh: zh && sameWords(excerpt, sentence) ? zh : '',
    sentence,
  };
}

/**
 * When no sentence clears the gold floor, still quote a worded result and a conclusion.
 * Methods, confidence-interval dumps, and "To compare…" aims stay out.
 */
function plainFallback(sentences, indexed, modelQuotes) {
  const total = sentences.length;
  const ranked = sentences
    .map((s, index) => ({ s, sc: plainScore(s, index, total) }))
    .filter(row => row.sc >= 4)
    .sort((a, b) => b.sc - a.sc || a.s.length - b.s.length);
  const findingLike = (s) => RESULT_LINE.test(s) && !numberHeavy(s);
  const meaningLike = (s) => MEANING_LINE.test(s);
  const shown = [];
  const take = (pred) => {
    const row = ranked.find(r => pred(r.s) && !shown.some(t => samePoint(t, r.s)));
    if (!row) return '';
    shown.push(row.s);
    return row.s;
  };
  const finding = take(s => findingLike(s) && !meaningLike(s) && !/\bno evidence\b/i.test(s))
    || take(s => /^we (?:introduce|identify)\b/i.test(s))
    || take(s => findingLike(s) && !meaningLike(s))
    || take(s => !meaningLike(s) && !/^we\b/i.test(s))
    || take(() => true);
  const extra = take(s => findingLike(s) && !meaningLike(s) && !/^we\b/i.test(s));
  const significance = take(s => meaningLike(s));
  const background = take(s => !findingLike(s) && !meaningLike(s));
  const secondRole = extra && (safetyNote(extra) || SUBGROUP.test(extra)) ? 'secondary' : 'finding';
  const picks = [
    packPlain('background', background, indexed, modelQuotes),
    packPlain('finding', finding, indexed, modelQuotes),
    packPlain(secondRole, extra, indexed, modelQuotes),
    packPlain('significance', significance, indexed, modelQuotes),
  ].filter(Boolean);
  if (picks.length) return picks;
  const rescued = pickHeuristic(sentences, 3);
  return rescued.map((sentence, i) => packPlain(i === 0 ? 'background' : i === rescued.length - 1 ? 'significance' : 'finding', sentence, indexed, modelQuotes)).filter(Boolean);
}

function hintSentence(modelQuotes, sentences, role) {
  const q = (modelQuotes || []).find(m => m && m.role === role);
  if (!q) return '';
  const s = sentenceFrom(q, sentences);
  return s && !isBoilerplate(s) && !isStiff(s) ? s : '';
}

function clauseFor(sentence, shown, role) {
  const bare = normSpace(sentence).replace(/[.。]+\s*$/, '');
  if (role === 'background') {
    const clause = paradoxClause(bare);
    if (clause && !overlapsShown(clause, shown)) return clause;
  }
  if (role === 'significance') {
    const clause = breadthClause(bare);
    if (clause && overlapsShown(sentence, shown) && !overlapsShown(clause, shown)) return clause;
  }
  if (!overlapsShown(sentence, shown)) return '';
  return '';
}

function candidateExcerpt(sentence, role, shown) {
  const focus = clauseFor(sentence, shown, role);
  if (overlapsShown(sentence, shown) && !focus) return null;
  const excerpt = excerptQuote(sentence, role, focus);
  if (!excerpt || overlapsShown(excerpt, shown)) return null;
  return { sentence, excerpt };
}

function pickRole(sentences, role, shown, hint) {
  const floor = roleFloor(role);
  const ranked = sentences
    .map(s => ({ s, sc: roleScore(s, role) }))
    .filter(row => row.sc >= floor)
    .sort((a, b) => b.sc - a.sc || a.s.length - b.s.length);
  if (hint && ranked.length) {
    const hinted = ranked.find(row => row.s === hint);
    if (hinted && hinted.sc + 2 >= ranked[0].sc) ranked.unshift(hinted);
  }
  const seen = new Set();
  for (const row of ranked) {
    if (seen.has(row.s)) continue;
    seen.add(row.s);
    const got = candidateExcerpt(row.s, role, shown);
    if (got) return got;
  }
  return null;
}

function sameWords(excerpt, sentence) {
  const core = normSpace(excerpt).replace(/…/g, '').replace(/[.。]+$/, '').trim();
  const full = normSpace(sentence).replace(/[.。]+$/, '').trim();
  return core === full;
}

function modelZhFor(modelQuotes, sentences, sentence, role) {
  const rows = modelQuotes || [];
  const exact = rows.find(q => q && q.role === role && sentenceFrom(q, sentences) === sentence);
  const loose = exact || rows.find(q => q && !q.role && sentenceFrom(q, sentences) === sentence);
  return loose ? normSpace(loose.zh || '') : '';
}

/** Keep the sentences each role needs when a long open-access text is capped. */
export function selectQuotePool(text) {
  const all = splitSentences(text).filter(s => !isBoilerplate(s) && !isStiff(s));
  if (all.length <= 70) return all;
  const keep = new Set();
  for (const role of QUOTE_ROLES) {
    const ranked = all
      .map(s => ({ s, sc: roleScore(s, role) }))
      .sort((a, b) => b.sc - a.sc);
    let n = 0;
    for (const row of ranked) {
      if (row.sc < roleFloor(role) || n >= 4) break;
      keep.add(row.s);
      n++;
    }
  }
  const ranked = all.map(s => ({ s, sc: interestScore(s) })).sort((a, b) => b.sc - a.sc);
  for (const row of ranked) {
    if (keep.size >= 48) break;
    if (row.sc >= 8 || keep.size < 24) keep.add(row.s);
  }
  return all.filter(s => keep.has(s)).slice(0, 56);
}

/**
 * Paradox, then the finding as a contrast, then the broader significance.
 * A fourth block is returned only for a striking secondary finding.
 */
export function resolveQuotePicks(text, modelQuotes) {
  const sentences = splitSentences(text).filter(s => !isBoilerplate(s));
  const indexed = splitSentences(text);
  const shown = [];
  const take = (role) => {
    const got = pickRole(sentences, role, shown, hintSentence(modelQuotes, indexed, role));
    if (!got) return null;
    shown.push(got.excerpt);
    const zh = modelZhFor(modelQuotes, indexed, got.sentence, role);
    return {
      role,
      en: got.excerpt,
      zh: zh && sameWords(got.excerpt, got.sentence) ? zh : '',
      sentence: got.sentence,
    };
  };
  const finding = take('finding');
  const significance = take('significance');
  const background = take('background');
  const secondary = take('secondary');
  const picked = [background, finding, secondary, significance].filter(Boolean);
  if (picked.length) return picked;
  return plainFallback(sentences, indexed, modelQuotes);
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
