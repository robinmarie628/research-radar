/**
 * Open-access Introduction and Discussion for share-card quotes.
 * Europe PMC full text when the journal article is in PMC; otherwise the
 * publisher's open-access HTML. A stored passage covers papers whose HTML
 * is blocked from the Worker. Closed papers return an empty string.
 */

import { OA_PASSAGES } from './oa-passages.js';

const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest';
const UNPAYWALL = 'https://api.unpaywall.org/v2/';
const MAIL = 'research-radar@example.com';
export const PASSAGE_MAX = 16000;
const XML_MAX = 800000;
const HTML_MAX = 2000000;

const KEEP_TITLE = /^(introduction|discussion|main)$/i;
const DROP_TITLE = /^(methods?|materials(?: and methods)?|results?|references|acknowledg|ethics|data availability|code availability|supplementary|author|competing|funding|peer review|article info|graphical abstract|highlights|summary|abstract)$/i;
const SECTION_RANK = { introduction: 0, discussion: 1, main: 2, results: 3, result: 3, findings: 3 };

const HEADERS = {
  'User-Agent': 'ResearchRadar/1.0 (mailto:' + MAIL + ')',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => {
      const c = Number(n);
      return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ' ';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      const c = parseInt(n, 16);
      return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ' ';
    });
}

/** Drop citation clusters (" . 1, 2, 3 Next") so they do not glue two sentences. */
export function stripCites(s) {
  return String(s || '')
    .replace(/(?<=[.,;])\s+(?:\d{1,3}\s*,\s*)*\d{1,3}(?=\s+[A-Z])/g, '')
    .replace(/(?<=[.,;])\s+(?:\d{1,2}\s+){1,8}(?=[A-Za-z])/g, ' ')
    .replace(/\s+\[\d+(?:\s*[,\-–]\s*\d+)*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function plainXml(s) {
  let t = String(s || '');
  t = t.replace(/<xref\b[^>]*>[\s\S]*?<\/xref>/gi, ' ');
  t = t.replace(/<(?:fig|table-wrap|table|graphic|media|caption|fn)\b[\s\S]*?<\/(?:fig|table-wrap|table|caption|fn)>/gi, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = decodeEntities(t);
  return t.replace(/\s+/g, ' ').trim();
}

function plainHtml(s) {
  let t = String(s || '');
  t = t.replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, ' ');
  t = t.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = decodeEntities(t);
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * Introduction and Discussion from JATS, then Results if room remains.
 * Reference lists inside <back> are ignored.
 */
export function extractPassages(xml) {
  const raw = String(xml || '');
  if (!raw) return '';
  const back = raw.search(/<back[\s>]/i);
  const body = back > 0 ? raw.slice(0, back) : raw;
  const re = /<sec\b[^>]*disp-level="1"[^>]*>\s*<title>([^<]{0,80})<\/title>/gi;
  const marks = [];
  let m;
  while ((m = re.exec(body))) {
    marks.push({
      title: m[1].replace(/<[^>]+>/g, '').trim(),
      at: m.index,
      content: m.index + m[0].length,
    });
  }
  const parts = [];
  for (let i = 0; i < marks.length; i++) {
    const title = marks[i].title;
    const key = title.toLowerCase();
    if (!(key in SECTION_RANK) && !/^(introduction|discussion|results?|findings?)$/i.test(title)) continue;
    const end = i + 1 < marks.length ? marks[i + 1].at : body.length;
    const text = stripCites(plainXml(body.slice(marks[i].content, end)));
    if (text.length > 40) parts.push({ key, text });
  }
  parts.sort((a, b) => (SECTION_RANK[a.key] ?? 9) - (SECTION_RANK[b.key] ?? 9));
  let out = '';
  for (const part of parts) {
    if (!out) { out = part.text; continue; }
    if (out.length >= PASSAGE_MAX) break;
    out += '\n\n' + part.text;
  }
  return out.slice(0, PASSAGE_MAX);
}

function parasOf(html) {
  const out = [];
  const re = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(html))) {
    const text = stripCites(plainHtml(m[1]));
    if (text.length > 80) out.push(text);
  }
  return out;
}

const SIGNAL = /\b(thus|more broadly|rather than|unexpectedly|paradoxically|in contrast|we identify|beyond|independently of|in the absence of)\b/i;

function pickParas(title, paras) {
  if (/^introduction$/i.test(title)) return paras.slice(0, 4);
  if (/^main$/i.test(title)) {
    const head = paras.slice(0, 3);
    const tail = paras.slice(-6);
    const signal = paras.filter(p => SIGNAL.test(p));
    const uniq = [];
    for (const p of [...head, ...tail, ...signal]) if (!uniq.includes(p)) uniq.push(p);
    return uniq.slice(0, 14);
  }
  const head = paras.slice(0, 3);
  const signal = paras.filter(p => SIGNAL.test(p));
  const uniq = [];
  for (const p of [...head, ...signal]) if (!uniq.includes(p)) uniq.push(p);
  return uniq.slice(0, 10);
}

/** Introduction, Discussion, or the opening and close of a Nature-style Main section. */
export function extractHtmlPassages(html) {
  let raw = String(html || '');
  if (!raw || /just a moment/i.test(raw.slice(0, 800))) return '';
  raw = raw
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(?:figure|figcaption|table|svg|aside|nav|footer)\b[\s\S]*?<\/(?:figure|figcaption|table|svg|aside|nav|footer)>/gi, ' ');
  const chunks = raw.split(/<h2\b[^>]*>/i).slice(1);
  const kept = [];
  for (const chunk of chunks) {
    const end = chunk.search(/<\/h2>/i);
    if (end < 0) continue;
    const title = plainHtml(chunk.slice(0, end));
    if (!title || DROP_TITLE.test(title) || !KEEP_TITLE.test(title)) continue;
    const body = chunk.slice(end);
    const stop = body.search(/<h2\b/i);
    const slice = stop > 0 ? body.slice(0, stop) : body;
    kept.push(...pickParas(title, parasOf(slice)));
  }
  if (!kept.length) return '';
  const uniq = [];
  for (const p of kept) if (!uniq.includes(p)) uniq.push(p);
  return uniq.join('\n\n').slice(0, PASSAGE_MAX);
}

function storedPassage(doi) {
  const text = OA_PASSAGES[String(doi || '').trim().toLowerCase()];
  return text ? String(text) : '';
}

async function epmcPassages(doi, fetchImpl) {
  const q = encodeURIComponent('DOI:"' + doi + '"');
  let hit;
  try {
    const res = await fetchImpl(
      EPMC + '/search?query=' + q + '&format=json&resultType=core&pageSize=1',
      { signal: AbortSignal.timeout(3500), headers: HEADERS },
    );
    if (!res.ok) return { status: 'error', text: '' };
    const data = await res.json();
    hit = data?.resultList?.result?.[0];
  } catch {
    return { status: 'error', text: '' };
  }
  if (!hit || String(hit.isOpenAccess || '').toUpperCase() !== 'Y' || !hit.pmcid) {
    return { status: 'closed', text: '' };
  }
  const journalDoi = String(hit.doi || '').toLowerCase();
  if (journalDoi && journalDoi !== doi.toLowerCase()) return { status: 'closed', text: '' };
  try {
    const res = await fetchImpl(
      EPMC + '/' + encodeURIComponent(hit.pmcid) + '/fullTextXML',
      { signal: AbortSignal.timeout(4000), headers: HEADERS },
    );
    if (!res.ok) return { status: 'error', text: '' };
    const xml = await res.text();
    if (!xml || xml.length > XML_MAX) return { status: 'error', text: '' };
    const text = extractPassages(xml);
    return text ? { status: 'text', text } : { status: 'closed', text: '' };
  } catch {
    return { status: 'error', text: '' };
  }
}

function publisherUrls(doi, info) {
  const urls = [];
  const id = doi.toLowerCase();
  if (id.startsWith('10.1038/')) urls.push('https://www.nature.com/articles/' + id.slice('10.1038/'.length));
  if (id.startsWith('10.1136/')) urls.push('https://www.bmj.com/content/' + id.slice('10.1136/'.length));
  const pii = info?.pii || '';
  if (pii && /cell/i.test(id)) {
    urls.push('https://www.cell.com/cell/fulltext/' + encodeURIComponent(pii) + '?rss=yes');
    urls.push('https://www.cell.com/cell/fulltext/' + encodeURIComponent(pii));
  }
  if (pii && /s0140-6736/i.test(pii)) {
    const flat = pii.replace(/[()]/g, '');
    urls.push('https://www.thelancet.com/journals/lancet/article/PII' + flat + '/fulltext');
  }
  for (const loc of info?.locations || []) urls.push(loc);
  return [...new Set(urls)].slice(0, 4);
}

async function oaInfo(doi, fetchImpl) {
  const info = { oa: false, pii: '', locations: [] };
  try {
    const res = await fetchImpl(
      UNPAYWALL + encodeURIComponent(doi) + '?email=' + encodeURIComponent(MAIL),
      { signal: AbortSignal.timeout(2500), headers: HEADERS },
    );
    if (res.ok) {
      const data = await res.json();
      info.oa = !!data?.is_oa;
      for (const loc of data?.oa_locations || []) {
        if (loc?.version && loc.version !== 'publishedVersion') continue;
        if (/biorxiv|medrxiv|10\.64898/i.test(loc.url || '')) continue;
        if (loc.host_type === 'publisher' && loc.url) info.locations.push(loc.url);
      }
    }
  } catch { /* publisher HTML is optional */ }
  if (!/10\.1016\/(?:j\.cell|s0140-6736)/i.test(doi)) return info;
  try {
    const res = await fetchImpl(
      'https://api.elsevier.com/content/article/doi/' + encodeURIComponent(doi),
      { signal: AbortSignal.timeout(3000), headers: { ...HEADERS, Accept: 'text/xml' } },
    );
    if (!res.ok) return info;
    const xml = await res.text();
    if (!/<openaccessArticle>true<\/openaccessArticle>/i.test(xml)) return info;
    info.oa = true;
    const m = xml.match(/<pii>([^<]+)<\/pii>/i);
    if (m) info.pii = m[1];
  } catch { /* metadata is optional */ }
  return info;
}

async function publisherPassages(doi, fetchImpl) {
  const info = await oaInfo(doi, fetchImpl);
  if (!info.oa) return '';
  for (const url of publisherUrls(doi, info)) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000), headers: HEADERS });
      if (!res.ok) continue;
      const html = await res.text();
      if (!html || html.length > HTML_MAX) continue;
      const text = extractHtmlPassages(html);
      if (text) return text;
    } catch { /* try the next location */ }
  }
  return '';
}

/**
 * Fresh Introduction/Discussion, ignoring the stored file.
 * @param {string} doi
 * @param {typeof fetch} [fetchImpl]
 */
export async function fetchFreshPassages(doi, fetchImpl = fetch) {
  const id = String(doi || '').trim();
  if (!/^10\.\d{4,}\/\S+/.test(id)) return '';
  const epmc = await epmcPassages(id, fetchImpl);
  if (epmc.status === 'text' && epmc.text) return epmc.text;
  return publisherPassages(id, fetchImpl);
}

/**
 * @param {string} doi
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ status: 'none'|'closed'|'text'|'error', text: string, via?: string }>}
 */
export async function openAccessPassages(doi, fetchImpl = fetch) {
  const id = String(doi || '').trim();
  if (!/^10\.\d{4,}\/\S+/.test(id)) return { status: 'none', text: '' };
  const epmc = await epmcPassages(id, fetchImpl);
  if (epmc.status === 'text' && epmc.text) return { ...epmc, via: 'pmc' };
  const stored = storedPassage(id);
  if (stored) return { status: 'text', text: stored, via: 'stored' };
  if (epmc.status === 'error') {
    const live = await publisherPassages(id, fetchImpl);
    return live ? { status: 'text', text: live, via: 'publisher' } : { status: 'error', text: '' };
  }
  const live = await publisherPassages(id, fetchImpl);
  return live ? { status: 'text', text: live, via: 'publisher' } : { status: 'closed', text: '' };
}
