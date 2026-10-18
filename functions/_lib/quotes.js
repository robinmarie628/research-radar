/**
 * Pick 3 or 4 share-card sentences a clinician would stop for.
 * English is always a contiguous excerpt of one source sentence.
 * A model paraphrase is dropped and replaced by a heuristic pick.
 */

export const ABSTRACT_MAX = 14000;
export const QUOTE_MIN = 3;
export const QUOTE_MAX = 4;

export const QUOTE_ROLES = ['background', 'finding', 'mechanism', 'significance'];

export const QUOTE_SYSTEM = `You choose quotations for a Chinese physician who is deciding whether to open the paper.
You will receive a numbered list of sentences from the abstract, and from the Results or Discussion when the full text is open access. The number in brackets is the index.
Pick 3 sentences, or 4 only when a fourth adds a different angle. Exactly one sentence must state the paper's main result in its true direction, and that sentence must be first or second in the array:
- a trial: overall efficacy on the primary endpoint, in words (weight loss, glycaemic control, faster symptom relief, fewer events). Not a confidence-interval dump, and not an adverse-event sentence.
- an observational study: the overall association, in words (lower odds of the outcomes, or no difference).
- basic research: the headline discovery ("we identify", "loss of X causes Y").
The other sentences are why a reader would stop: a challenge to an assumption, a surprising subgroup or safety finding, a memorable mechanism. No two sentences may make the same point.
Do not return only adverse events for a treatment that worked, and do not return only benefits when the main result was null or harmful.
Good main result: "retatrutide resulted in substantial improvements in bodyweight and glycaemic control"; "symptom relief was faster than placebo"; "vaccination was associated with lower odds of all included adverse pregnancy outcomes"; "loss of Gimap6 causes atherosclerosis in the absence of hyperlipidemia".
Good extra angle: "dysesthesia and hypotension were more frequent than with placebo"; "the reduction was more pronounced at younger ages"; "benefits extend beyond cancer prevention"; "OXER1-deficient animals developed intestinal barrier failure".
Bad: two sentences that both say the benefit was stronger at a younger age; "X remains a major cause of mortality"; "was generally well tolerated"; "these results support the use of X"; "we aimed to assess efficacy and safety"; a sentence that is only percentages and confidence intervals when a worded result exists.
Never choose trial registration, an NCT number, ClinicalTrials.gov, funding, ethics, accrual, copyright, or a methods sentence about eligibility, randomisation, or sample size.
Prefer a sentence under 280 characters. Do not stitch clauses together. Do not shorten the sentence yourself.
Return JSON only, no markdown:
{"quotes":[{"i":2,"zh":"..."},{"i":5,"zh":"..."},{"i":8,"zh":"..."}]}
Rules:
1. 3 quotes, or 4 if the fourth is a different angle. No role labels. The main-result sentence is first or second.
2. No two quotes may make the same point. If a sentence repeats an earlier claim, choose a different angle.
3. i must be an index from the list. Do not invent, merge, or rewrite a sentence.
4. zh is a Simplified Chinese translation of that exact sentence.
5. Keep drug names, gene and protein names, trial names, and acronyms in English.
6. Drug names may appear as placeholders like [D1]. Copy every placeholder into zh unchanged.
7. Translate faithfully. Do not add or omit facts.`;

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
    || /^[A-Za-z0-9-]{2,} was a\b/i.test(s) && /\b(trial|study)\b/i.test(s)
    || /\b(randomly allocated|randomly assigned|was conducted|were identified by|was analysed in|was analyzed in|safety was assessed|protocol-permitted|eligible patients were|we aimed to|was defined as)\b/i.test(s)
    || /\b(?:primary|secondary) endpoints? (?:of|was the|were the)\b/i.test(s)
    || /\bprespecified secondary\b/i.test(s)
    || /\bsecondary outcome was\b/i.test(s)
    || /\bas (?:primary|secondary) outcomes?\b/i.test(s);
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

const DULL = /\b(major cause of|leading cause of|remain(?:s|ed)? scant|currently under investigation|we (?:aimed|investigated|sought) to|we investigated|was generally well tolerated|these results support the use|these results show that|might be effective for the treatment|generally consistent with other|may address an unmet need|provided faster times to symptom relief|support the use of|should be considered for)\b/i;
const CONTRAST = /\b(despite|in the absence of|independently of|even (?:in|among|without)|did not|failed to|unexpected(?:ly)?|surpris(?:e|ing|ingly)|contrary to|paradox|rather than|whereas|without hyperlipidemia|no longer|not only|beyond)\b/i;
const NOVEL = /\b(we identify|we report that|previously un(?:recognized|known)|novel|first orally|orphan|unanticipated)\b/i;
const CLASS_IDEA = /\b((?:dual|triple) agonist|agonist of|receptor antagonist|receptor agonist)\b/i;
const SUBGROUP = /\b(more pronounced|particularly among|younger ages|earlier ages|only among|subgroup)\b/i;
const SAFETY = /\b(adverse events?|discontinu|hypotension|dysesthesia|severe or serious)\b/i;
const STOP = new Set(['with', 'that', 'this', 'from', 'were', 'was', 'were', 'have', 'been', 'into', 'than', 'then', 'them', 'they', 'their', 'which', 'while', 'after', 'before', 'between', 'among', 'within', 'without', 'other', 'more', 'most', 'such', 'only', 'also', 'both', 'each', 'over', 'under', 'about']);

function strikingGap(s) {
  return /\bmore than \d+/i.test(s) && /\b(faster|slower|median times?|compared with|than placebo)\b/i.test(s);
}

function memorableMechanism(s) {
  if (!isMechanism(s)) return false;
  return /\b(receptor|cascade|hydrolase|mediated|lipid-influx|lipid[- ]uptake|OXER|CD36|phosphorylat|G-protein)\b/i.test(s);
}

function safetyNote(s) {
  return SAFETY.test(s) && !/\b(safety was assessed|safety analyses included)\b/i.test(s);
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

/** True when two lines would tell the reader the same fact. Shared drug or gene names do not count. */
export function samePoint(a, b) {
  if (!a || !b) return false;
  if (redundant(a, b)) return true;
  const A = normClaim(a);
  const B = normClaim(b);
  const both = (re) => re.test(A) && re.test(B);
  if (both(/\bagegradient\b/)) return true;
  if (both(/\briskdown\b/) && both(/\bpregout\b/)) return true;
  if (both(/\bnotvia\b/) && both(/\bhyperlipidemia\b/)) return true;
  if (both(/\bbodyweight\b/) && both(/\b(improv|reduction|percentage|placebo)\b/)) return true;
  if (both(/\bsymptom relief\b/) && both(/\b(faster|placebo)\b/)) return true;
  return false;
}

function splitClauses(src) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')' && depth) depth--;
    else if ((c === ',' || c === ';') && depth === 0 && src[i + 1] === ' ') {
      parts.push(src.slice(start, i).trim());
      start = i + 2;
    }
  }
  const tail = src.slice(start).trim();
  if (tail) parts.push(tail);
  return parts.filter(Boolean);
}

/** A contiguous clause that does not repeat a point already chosen. */
function distinctClause(sentence, kept) {
  const src = normSpace(sentence).replace(/[.。]+\s*$/, '');
  const segs = splitClauses(src);
  if (segs.length < 2) return '';
  const cands = [];
  for (let i = 0; i < segs.length; i++) {
    for (let j = i; j < segs.length; j++) {
      const chunk = segs.slice(i, j + 1).join(', ').replace(/[,:;]\s*$/, '').trim();
      const n = wordCount(chunk);
      if (n < 8 || n > EXCERPT_WORDS) continue;
      if (!src.includes(chunk)) continue;
      if (chunk === src) continue;
      if (kept.some(k => samePoint(chunk, k))) continue;
      if (interestScore(chunk) < 6) continue;
      cands.push(chunk);
    }
  }
  if (!cands.length) return '';
  const tight = cands.filter(c => !cands.some(o => o !== c && c.includes(o)));
  const pool = tight.length ? tight : cands;
  pool.sort((a, b) => interestScore(b) - interestScore(a) || wordCount(a) - wordCount(b));
  return pool[0];
}

function safetyOnly(s) {
  return safetyNote(s) && !/\b(improv|body\s?weight|glycaem|glycemic|relief|lower odds|lower risk|efficac|non-inferior)\b/i.test(s);
}

/**
 * How well a sentence states the paper's overall result.
 * Trials: worded primary efficacy, not an adverse-event line and not a CI dump.
 * Basic papers: the headline discovery.
 */
export function headlineScore(s) {
  if (!s || isBoilerplate(s) || isDesign(s) || isRunIn(s) || METHODS_LEAD.test(s)) return -80;
  if (safetyOnly(s)) return -40;
  if (/\bwe (?:aimed|investigated|sought) to\b/i.test(s)) return -30;
  const concrete = /\b(substantial(?:ly)? improvements?|lower odds of all|in the absence of|we identify|we report that)\b/i.test(s);
  if (DULL.test(s) && !concrete && !strikingGap(s)) return -8;
  let q = 0;
  if (/\bsubstantial(?:ly)? improvements?\b/i.test(s) && /\b(body\s?weight|glycaem|glycemic|weight)\b/i.test(s)) q += 30;
  if (/\blower odds of all\b/i.test(s) || /\bassociated with lower odds of all\b/i.test(s)) q += 28;
  if (/\b(did not (?:reduce|improve|differ)|no significant (?:difference|benefit)|no between[- ]group difference|failed to)\b/i.test(s)) q += 26;
  if (strikingGap(s) || (/\bsignificantly faster\b/i.test(s) && /\b(placebo|than)\b/i.test(s))) q += 24;
  if (/\bwe (?:identify|report that)\b/i.test(s)) q += 22;
  if (/\b(in the absence of|independently of)\b/i.test(s) && /\bhyperlipid/i.test(s)) q += 18;
  if (/\bnon-inferior\b/i.test(s) && !isClutteredResult(s)) q += 16;
  if (!numberHeavy(s) && !isClutteredResult(s) && statesEffect(s)) q += 8;
  if (numberHeavy(s) && !strikingGap(s) && !concrete) q -= 16;
  if (isClutteredResult(s) && !strikingGap(s) && !concrete) q -= 12;
  return q;
}

/** Higher means a clinician is more likely to open the paper. */
export function interestScore(s) {
  if (!s || isBoilerplate(s)) return -80;
  if (isRunIn(s) || CENSUS.test(s)) return -70;
  if (isDesign(s) || METHODS_LEAD.test(s)) return -60;
  let q = 0;
  const contrast = CONTRAST.test(s) || strikingGap(s);
  const mechanism = memorableMechanism(s);
  const novel = NOVEL.test(s) || CLASS_IDEA.test(s);
  const safety = safetyNote(s);
  const subgroup = SUBGROUP.test(s);
  const dull = DULL.test(s);
  const punch = contrast || mechanism || safety;
  if (isDenseMethods(s) && !punch) q -= 35;
  if (contrast) q += 16;
  if (mechanism) q += 14;
  if (novel && !/\bwe (?:investigated|aimed|sought)\b/i.test(s)) q += 11;
  if (safety) q += 12;
  if (subgroup) q += 10;
  if (/\b(?:deficient|knockout|knock-out)\b/i.test(s)) q += 8;
  if (statesEffect(s) && !numberHeavy(s) && !dull) q += 6;
  if (/\bwe (?:investigated|aimed|sought)\b/i.test(s) && !punch) q -= 22;
  if (/\bdied\b/i.test(s) && /\bunrelated\b/i.test(s)) q -= 10;
  if (dull && !punch && !novel && !subgroup && !/\bfirst orally\b/i.test(s)) q -= 18;
  else if (dull && !/\bfirst orally\b/i.test(s)) q -= 6;
  if (numberHeavy(s) && !punch) q -= 10;
  if (/\bprimary (?:end ?point|outcome|efficacy analysis)\b/i.test(s) && !contrast) q -= 8;
  if (/\bmay be the most effective\b/i.test(s)) q -= 12;
  if (s.length > 520) q -= 3;
  return q;
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
export function excerptQuote(sentence, role, focus) {
  const src = normSpace(sentence).replace(/[.。]+\s*$/, '');
  if (!src) return '';
  const hint = normSpace(focus || '').replace(/[.。]+\s*$/, '');
  if (hint && src.includes(hint) && wordCount(hint) >= 8 && wordCount(hint) <= EXCERPT_WORDS) {
    return markOmissions(src, hint);
  }
  let body = src;
  const lead = body.match(LEAD_IN);
  if (lead && lead[0].length < body.length - 12) body = body.slice(lead[0].length);
  const framed = body.match(/^these results support the use of .+? as (?:potentially )?(?:the )?/i);
  if (framed && framed[0].length < body.length - 24) body = body.slice(framed[0].length);
  body = body.replace(/\s*\((?:[^()]|\([^()]*\))*(?:95\s*%|\bCIs?\b|\bp\s*[<=>]|\bp\s*<|\bSE\b|\bIQR\b)[^)]*\)\s*$/i, '').trim();
  const colon = body.indexOf(': ');
  if (colon >= 24) {
    const head = body.slice(0, colon).trim();
    if (wordCount(head) >= 8 && wordCount(head) <= EXCERPT_WORDS) body = head;
  }
  const parenRe = /\s+\(([^)]{0,500})\)/g;
  let paren;
  while ((paren = parenRe.exec(body))) {
    const inner = paren[1];
    const stat = /%|\bCI\b|\bp\s*[<=>]/.test(inner) || (inner.match(/\d/g) || []).length >= 2;
    if (!stat) continue;
    const after = body.slice(paren.index + paren[0].length);
    if (/\bmore than \d+/i.test(after)) continue;
    const head = body.slice(0, paren.index).trim().replace(/[,:;]\s*$/, '');
    const headWords = wordCount(head);
    const headHasPoint = headWords >= 8 && headWords <= EXCERPT_WORDS
      && /\b(placebo|dysesthesia|hypotension|discontinuation|more than \d+)/i.test(head);
    if (headHasPoint) { body = head; break; }
    if (/\bplacebo\b/i.test(after)) continue;
    if (headWords >= 8 && headWords <= EXCERPT_WORDS) body = head;
    break;
  }
  const cuts = [
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
  const opened = tidyStart(chunk);
  if (opened && src.includes(opened) && wordCount(opened) >= 8) chunk = opened;
  if (!chunk || !src.includes(chunk)) return normSpace(sentence);
  const marked = markOmissions(src, chunk);
  if (marked === src) return normSpace(sentence);
  return marked;
}

function tidyStart(chunk) {
  let out = String(chunk || '').trim().replace(/^(?:and|or|but)\s+/i, '');
  const broken = out.match(/^[^,]{0,48}\),\s*/);
  if (broken) out = out.slice(broken[0].length);
  out = out.replace(/^(?:which|that)\s+/i, '');
  return out.trim();
}

function tidyEnd(chunk) {
  const dangling = /\s+(?:and|or|but|that|which|who|whose|including|with|of|to|for|in|by|via|than|as|from|into|about|induces|causing|independently|respectively)\s*$/i;
  let out = String(chunk || '').replace(/\s+\d+\s*[-–]\s*\d+$/, '').replace(/[,:;]\s*$/, '').trim();
  while (dangling.test(out) && wordCount(out) > 8) out = out.replace(dangling, '').replace(/[,:;]\s*$/, '').trim();
  return out;
}

const INTEREST_ANCHOR = /\b(in the absence of|independently of|despite|even (?:in|among)|did not|failed to|more than \d+|adverse event|discontinu|hypotension|dysesthesia|more pronounced|beyond|receptor|cascade|mediated|hydrolase|lipid-influx|lipid uptake|we identify|we report that|quench|first orally|than placebo|placebo group|G-protein|substantial improvements|glycaemic|glycemic|body\s?weight|lower odds|symptom relief)\b/i;

function focusExcerpt(body, role) {
  const key = role === 'mechanism'
    ? /\b(mechanistically|cascade|mediated|pathway|signall?ing|signaling|redox|lipid[- ]uptake|lipid-influx|via|receptor|G-protein|induces|hydrolase)/i
    : role === 'finding'
      ? /\b(causes|caused|reduced|increased|faster|improved|improv|significantly|resulted in|accelerated|associated)/i
      : role === 'background'
        ? /\b(not eliminated|remain|remains|scant|unknown|unclear|despite|limited)/i
        : role === 'significance'
          ? /\b(safeguard|support|effective|suggest|reveal|restrain|should be)/i
          : INTEREST_ANCHOR;
  const tokens = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(body))) tokens.push({ start: m.index, end: m.index + m[0].length });
  if (tokens.length <= EXCERPT_WORDS) return body.trim();
  let anchor = 0;
  const flags = new RegExp(key.source, key.flags.includes('g') ? key.flags : key.flags + 'g');
  let hit;
  while ((hit = flags.exec(body))) {
    const at = tokens.findIndex(t => hit.index < t.end && hit.index + hit[0].length > t.start);
    if (at > anchor) anchor = at;
  }
  const nearEnd = anchor >= tokens.length - 8;
  let start = nearEnd
    ? Math.max(0, tokens.length - EXCERPT_WORDS)
    : (anchor < EXCERPT_WORDS ? 0 : Math.max(0, anchor - 8));
  let end = Math.min(tokens.length, start + EXCERPT_WORDS);
  const closed = closeDanglingTail(body, tokens, end);
  if (closed > end) {
    const shifted = Math.max(0, closed - EXCERPT_WORDS);
    if (shifted <= anchor) {
      end = closed;
      start = shifted;
    }
  }
  return body.slice(tokens[start].start, tokens[end - 1].end).replace(/[,:;]\s*$/, '').trim();
}

/** If the window stops on a modifier or function word, keep the short noun phrase that finishes it. */
function closeDanglingTail(body, tokens, end) {
  if (end >= tokens.length) return end;
  const last = body.slice(tokens[end - 1].start, tokens[end - 1].end).replace(/[.,:;]+$/, '');
  const dangling = /^(?:through|via|of|to|for|in|by|with|from|into|the|a|an|and|or|that|which)$/i.test(last)
    || /(?:coupled|mediated|induced|related)$/i.test(last);
  if (!dangling) return end;
  let stop = end;
  const limit = Math.min(tokens.length, end + 6);
  for (let i = end; i < limit; i++) {
    stop = i + 1;
    const raw = body.slice(tokens[i].start, tokens[i].end);
    if (/[,:;]/.test(raw)) break;
  }
  return stop;
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

function tagsOf(s) {
  const out = [];
  if (CONTRAST.test(s) || strikingGap(s)) out.push('contrast');
  if ((NOVEL.test(s) || CLASS_IDEA.test(s)) && !/\bwe (?:investigated|aimed|sought)\b/i.test(s)) out.push('novel');
  if (memorableMechanism(s)) out.push('mechanism');
  if (safetyNote(s)) out.push('safety');
  if (SUBGROUP.test(s)) out.push('subgroup');
  return out;
}

function methodsPenalty(s, sections) {
  const blob = normSpace(sections?.methods || '');
  if (!blob || !blob.includes(normSpace(s))) return 0;
  if (strikingGap(s) || memorableMechanism(s) || safetyNote(s)) return 0;
  return 12;
}

/**
 * Three excerpts, or four when a fourth sentence is also worth opening the paper for.
 * Each English line is a contiguous excerpt. sections may down-rank methods prose.
 */
function shownText(p) {
  return p.focus || p.en;
}

export function resolveQuotePicks(text, modelQuotes, sections) {
  const sentences = splitSentences(text);
  const ranked = sentences
    .map((s, i) => ({ s, i, sc: interestScore(s) - methodsPenalty(s, sections) }))
    .filter(row => row.sc > -40)
    .sort((a, b) => b.sc - a.sc || a.i - b.i);
  const chosen = [];
  const used = new Set();
  const take = (s, zh) => {
    if (!s || used.has(s)) return false;
    const shown = chosen.map(shownText);
    if (shown.some(t => samePoint(t, s))) {
      const clause = distinctClause(s, shown);
      if (!clause) return false;
      chosen.push({ en: s, zh: '', sc: interestScore(s) - methodsPenalty(s, sections), focus: clause });
      used.add(s);
      return true;
    }
    chosen.push({ en: s, zh: zh || '', sc: interestScore(s) - methodsPenalty(s, sections), focus: '' });
    used.add(s);
    return true;
  };
  for (const q of modelQuotes || []) {
    if (chosen.length >= QUOTE_MAX) break;
    const cand = sentenceFrom(q, sentences);
    if (!cand || isBoilerplate(cand)) continue;
    const sc = interestScore(cand) - methodsPenalty(cand, sections);
    if (sc <= -40) continue;
    const better = ranked.some(row => !used.has(row.s) && row.sc >= 8 && row.sc >= sc + 6);
    if (sc < 4 && better) continue;
    if (chosen.length >= QUOTE_MIN && sc < 8 && headlineScore(cand) < 12) continue;
    take(cand, normSpace(q?.zh || ''));
  }
  for (const row of ranked) {
    if (chosen.length >= QUOTE_MAX) break;
    if (row.sc < 4 && headlineScore(row.s) < 12) continue;
    if (chosen.length >= QUOTE_MIN && row.sc < 8 && headlineScore(row.s) < 12) break;
    const mine = tagsOf(row.s);
    const have = new Set(chosen.flatMap(p => tagsOf(shownText(p))));
    const crowded = mine.length > 0 && mine.every(t => have.has(t));
    const alternative = ranked.some(o => !used.has(o.s) && o.s !== row.s && o.sc >= 5 && tagsOf(o.s).some(t => !have.has(t)));
    if (crowded && chosen.length >= 3 && row.sc < 12 && headlineScore(row.s) < 12) continue;
    if (crowded && chosen.length >= 2 && alternative && headlineScore(row.s) < 12) continue;
    take(row.s, '');
  }
  const headline = ranked
    .filter(row => headlineScore(row.s) >= 12)
    .sort((a, b) => headlineScore(b.s) - headlineScore(a.s) || a.i - b.i)[0];
  if (headline && !chosen.some(p => p.en === headline.s)) {
    for (let i = chosen.length - 1; i >= 0; i--) {
      const p = chosen[i];
      if (!samePoint(shownText(p), headline.s) && !samePoint(p.en, headline.s)) continue;
      const others = chosen.filter(x => x !== p).map(shownText).concat(headline.s);
      const clause = distinctClause(p.en, others);
      if (clause) {
        p.focus = clause;
        p.zh = '';
      } else {
        used.delete(p.en);
        chosen.splice(i, 1);
      }
    }
    if (chosen.length >= QUOTE_MAX) {
      let weakest = 0;
      for (let i = 1; i < chosen.length; i++) if (chosen[i].sc < chosen[weakest].sc) weakest = i;
      used.delete(chosen[weakest].en);
      chosen.splice(weakest, 1);
    }
    chosen.push({ en: headline.s, zh: '', sc: headlineScore(headline.s), focus: '' });
    used.add(headline.s);
  }
  if (chosen.length < QUOTE_MIN) {
    for (const row of ranked) {
      if (chosen.length >= QUOTE_MIN) break;
      if (row.sc < 4) continue;
      take(row.s, '');
    }
  }
  let mainEn = '';
  let bestH = -1e9;
  for (const p of chosen) {
    const h = headlineScore(p.en);
    if (h > bestH) { bestH = h; mainEn = p.en; }
  }
  const ordered = chosen
    .map(p => ({ ...p, i: sentences.indexOf(p.en) }))
    .sort((a, b) => a.i - b.i);
  const mainAt = ordered.findIndex(p => p.en === mainEn);
  if (mainAt > 0) {
    const [main] = ordered.splice(mainAt, 1);
    ordered.unshift(main);
  }
  const out = [];
  for (const p of ordered) {
    const en = excerptQuote(p.en, '', p.focus);
    const clash = out.findIndex(q => samePoint(q.en, en));
    if (clash >= 0) {
      if (p.en !== mainEn) continue;
      out.splice(clash, 1);
    }
    out.push({
      role: '',
      en,
      zh: sameWords(en, p.en) ? p.zh : '',
      sentence: p.en,
      main: p.en === mainEn,
    });
  }
  if (out.length > 1) {
    const mi = out.findIndex(q => q.main);
    if (mi > 0) {
      const [main] = out.splice(mi, 1);
      out.unshift(main);
    }
  }
  return out.slice(0, QUOTE_MAX);
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
