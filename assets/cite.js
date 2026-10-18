/* Citation export. Classic script (window.RRCite) and CommonJS for node:test.
   RIS opens in EndNote, Zotero, and Mendeley. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.RRCite = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function clean(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function authorList(a) {
    const list = Array.isArray(a?.authorCite) ? a.authorCite.map(clean).filter(Boolean) : [];
    if (list.length) return list;
    const one = clean(a?.authors);
    return one ? [one] : [];
  }

  /** "Xiang C" → { family: "Xiang", given: "C" }. Already "Xiang, C" stays split. */
  function splitAuthor(name) {
    const s = clean(name).replace(/\.$/, '');
    if (s.includes(',')) {
      const [family, given] = s.split(/\s*,\s*/);
      return { family: family || s, given: clean(given).replace(/\./g, '') };
    }
    const bits = s.split(/\s+/);
    if (bits.length === 1) return { family: bits[0], given: '' };
    const given = bits[bits.length - 1].replace(/\./g, '');
    const family = bits.slice(0, -1).join(' ');
    if (given.length <= 4 && /^[A-Z]+$/i.test(given)) return { family, given };
    return { family: bits[bits.length - 1], given: bits.slice(0, -1).join(' ') };
  }

  function etAl(names) {
    if (!names.length) return '';
    if (names.length <= 3) return names.join(', ');
    return names.slice(0, 3).join(', ') + ', et al.';
  }

  function yearOf(a) {
    const y = clean(a?.year) || (clean(a?.date).match(/^(\d{4})/) || [])[1] || '';
    return y;
  }

  function pageEnds(pages) {
    const p = clean(pages);
    const m = p.match(/^(.+?)\s*[-–—]\s*(.+)$/);
    if (!m) return { sp: p, ep: '' };
    return { sp: m[1].trim(), ep: m[2].trim() };
  }

  function risAuthor(name) {
    const { family, given } = splitAuthor(name);
    return given ? family + ', ' + given : family;
  }

  function ris(a) {
    const lines = ['TY  - JOUR'];
    for (const name of authorList(a)) lines.push('AU  - ' + risAuthor(name));
    if (a?.title) lines.push('TI  - ' + clean(a.title));
    if (a?.journal) lines.push('T2  - ' + clean(a.journal));
    const y = yearOf(a);
    if (y) lines.push('PY  - ' + y);
    const date = clean(a?.date).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) lines.push('DA  - ' + date.replace(/-/g, '/'));
    if (a?.volume) lines.push('VL  - ' + clean(a.volume));
    if (a?.issue) lines.push('IS  - ' + clean(a.issue));
    const pg = pageEnds(a?.pages);
    if (pg.sp) lines.push('SP  - ' + pg.sp);
    if (pg.ep) lines.push('EP  - ' + pg.ep);
    if (a?.doi) lines.push('DO  - ' + clean(a.doi));
    if (a?.pmid) lines.push('AN  - ' + clean(a.pmid));
    if (a?.doi) lines.push('UR  - https://doi.org/' + clean(a.doi));
    lines.push('ER  - ');
    return lines.join('\n') + '\n';
  }

  function bibEscape(s) {
    return clean(s).replace(/[{}\\]/g, '');
  }

  function bibKey(a) {
    const names = authorList(a);
    const family = (names[0] ? splitAuthor(names[0]).family : 'article').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const y = yearOf(a) || 'nd';
    const word = (clean(a?.title).toLowerCase().match(/[a-z0-9]+/) || ['ref'])[0];
    return (family || 'article') + y + word;
  }

  function bibtex(a) {
    const authors = authorList(a).map(name => {
      const { family, given } = splitAuthor(name);
      return given ? family + ', ' + given : family;
    }).join(' and ');
    const fields = [];
    if (authors) fields.push('  author = {' + bibEscape(authors) + '}');
    if (a?.title) fields.push('  title = {' + bibEscape(a.title) + '}');
    if (a?.journal) fields.push('  journal = {' + bibEscape(a.journal) + '}');
    const y = yearOf(a);
    if (y) fields.push('  year = {' + y + '}');
    if (a?.volume) fields.push('  volume = {' + bibEscape(a.volume) + '}');
    if (a?.issue) fields.push('  number = {' + bibEscape(a.issue) + '}');
    if (a?.pages) fields.push('  pages = {' + bibEscape(a.pages).replace(/\s*[–—-]+\s*/g, '--') + '}');
    if (a?.doi) fields.push('  doi = {' + bibEscape(a.doi) + '}');
    if (a?.pmid) fields.push('  pmid = {' + bibEscape(a.pmid) + '}');
    return '@article{' + bibKey(a) + ',\n' + fields.join(',\n') + '\n}\n';
  }

  function vancouver(a) {
    const bits = [];
    const who = etAl(authorList(a));
    if (who) bits.push(who);
    if (a?.title) bits.push(clean(a.title).replace(/\.$/, ''));
    const tail = [];
    const y = yearOf(a);
    let loc = clean(a?.journal);
    if (y || a?.volume || a?.issue || a?.pages) {
      const vol = clean(a?.volume);
      const issue = clean(a?.issue);
      const pages = clean(a?.pages);
      let cite = y || '';
      if (vol) cite += (cite ? ';' : '') + vol;
      if (issue) cite += '(' + issue + ')';
      if (pages) cite += (vol || issue ? ':' : (cite ? ';' : '')) + pages;
      if (loc && cite) loc = loc + '. ' + cite;
      else loc = loc || cite;
    }
    if (loc) bits.push(loc);
    let text = bits.join('. ');
    if (text && !/[.!?]$/.test(text)) text += '.';
    if (a?.doi) text += ' doi:' + clean(a.doi) + '.';
    else if (a?.pmid) text += ' PMID:' + clean(a.pmid) + '.';
    return text;
  }

  /** Same order as the on-page full-text button: ClinicalKey, else ScienceDirect, else DOI. */
  function shareTarget(a) {
    const pii = clean(a?.pii);
    const plats = Array.isArray(a?.platforms) ? a.platforms : [];
    if (pii && plats.includes('ck')) {
      return {
        url: 'https://www.clinicalkey.com/#!/content/playContent/1-s2.0-' + pii,
        name: 'ClinicalKey',
      };
    }
    if (pii && plats.includes('sd')) {
      return {
        url: 'https://www.sciencedirect.com/science/article/pii/' + pii,
        name: 'ScienceDirect',
      };
    }
    if (a?.doi) return { url: 'https://doi.org/' + clean(a.doi), name: 'DOI' };
    if (a?.pmid) return { url: 'https://pubmed.ncbi.nlm.nih.gov/' + clean(a.pmid) + '/', name: 'PubMed' };
    return null;
  }

  return { ris, bibtex, vancouver, shareTarget, authorList, etAl, splitAuthor };
});
