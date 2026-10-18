/**
 * Open-access Results/Discussion text from Europe PMC, capped for a Worker.
 * Closed papers and failed lookups return an empty string so quotes stay on the abstract.
 */

const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest';
export const PASSAGE_MAX = 9000;
const XML_MAX = 800000;

const TOP_SECTION = /^(results?|discussion|findings?)$/i;

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

function plainXml(s) {
  let t = String(s || '');
  t = t.replace(/<xref\b[^>]*>[\s\S]*?<\/xref>/gi, ' ');
  t = t.replace(/<(?:fig|table-wrap|table|graphic|media|caption|fn)\b[\s\S]*?<\/(?:fig|table-wrap|table|caption|fn)>/gi, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = decodeEntities(t);
  return t.replace(/\s+/g, ' ').trim();
}

/** Results and Discussion prose from a JATS full-text XML string. */
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
    if (!TOP_SECTION.test(marks[i].title)) continue;
    const end = i + 1 < marks.length ? marks[i + 1].at : body.length;
    const text = plainXml(body.slice(marks[i].content, end));
    if (text.length > 40) parts.push(text);
  }
  return parts.join('\n\n').slice(0, PASSAGE_MAX);
}

/**
 * @param {string} doi
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ status: 'none'|'closed'|'text'|'error', text: string }>}
 */
export async function openAccessPassages(doi, fetchImpl = fetch) {
  const id = String(doi || '').trim();
  if (!/^10\.\d{4,}\/\S+/.test(id)) return { status: 'none', text: '' };
  const q = encodeURIComponent('DOI:"' + id + '"');
  let hit;
  try {
    const res = await fetchImpl(
      EPMC + '/search?query=' + q + '&format=json&resultType=core&pageSize=1',
      { signal: AbortSignal.timeout(3500) },
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
  try {
    const res = await fetchImpl(
      EPMC + '/' + encodeURIComponent(hit.pmcid) + '/fullTextXML',
      { signal: AbortSignal.timeout(4000) },
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
