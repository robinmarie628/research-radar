/**
 * Build data/title-zh.json from the reviewed qwen3 preview table.
 *
 *   node scripts/seed_title_zh.mjs \
 *     --preview /path/to/cf_preview.md \
 *     --snapshot data/snapshot-journals.json
 *
 * The preview markdown is the source of the 122 translations. DOIs come from
 * the journal snapshot when the English title matches. Glossary overrides run
 * on the way in, so the committed cache already says 髂总动脉 / 血栓后综合征
 * and leaves ticagrelor in English.
 */
import fs from 'node:fs';
import path from 'node:path';
import { normTitle, applyGlossary, maskDrugs } from '../functions/_lib/mt.js';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}

const previewPath = arg('--preview', '');
const snapshotPath = arg('--snapshot', 'data/snapshot-journals.json');
const outPath = arg('--out', 'data/title-zh.json');
if (!previewPath) {
  console.error('pass --preview path/to/cf_preview.md');
  process.exit(1);
}

const glossary = JSON.parse(fs.readFileSync('data/glossary.json', 'utf8'));
const overrides = JSON.parse(fs.readFileSync('data/mt-overrides.json', 'utf8'));
const preview = fs.readFileSync(previewPath, 'utf8');
const snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));

function parseRows(md) {
  const rows = [];
  let enCol = -1;
  let zhCol = -1;
  for (const line of md.split(/\r?\n/)) {
    if (!line.startsWith('|')) { enCol = -1; zhCol = -1; continue; }
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (!cells.length) continue;
    if (cells.some(c => c === 'English')) {
      enCol = cells.indexOf('English');
      zhCol = cells.findIndex(c => /Workers AI Qwen3/.test(c));
      continue;
    }
    if (enCol < 0 || cells.every(c => /^-+$/.test(c))) continue;
    const en = cells[enCol] || '';
    const zh = cells[zhCol] || '';
    if (!en || !zh || en === 'English') continue;
    rows.push({ en, zh });
  }
  return rows;
}

const articles = [...(snap.items || []), ...(snap.picks || [])];
const byNorm = new Map();
for (const a of articles) {
  const key = normTitle(a.title);
  if (key && !byNorm.has(key)) byNorm.set(key, a);
}

const rows = parseRows(preview);
const items = [];
const unmatched = [];
let changed = 0;
for (const row of rows) {
  const zh = applyGlossary(row.en, row.zh, glossary, overrides);
  if (zh !== row.zh) changed++;
  const hit = byNorm.get(normTitle(row.en));
  if (!hit) unmatched.push(row.en);
  items.push({
    doi: hit ? String(hit.doi || hit.id || '').toLowerCase() : '',
    en: hit?.title || row.en,
    zh,
  });
}

const masked = new Map();
for (const a of articles) {
  for (const d of maskDrugs(a.title).drugs) {
    masked.set(d.tok.toLowerCase(), (masked.get(d.tok.toLowerCase()) || 0) + 1);
  }
}

const payload = {
  model: '@cf/qwen/qwen3-30b-a3b-fp8',
  seededAt: '2026-10-18',
  source: 'Workers AI qwen3 title batch reviewed in the 2026-10-18 preview. Glossary overrides applied.',
  items,
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(payload, null, 1) + '\n');

console.log(`rows ${rows.length}  matched ${items.filter(i => i.doi).length}  unmatched ${unmatched.length}  glossary edits ${changed}`);
console.log('masked tokens:', [...masked.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, n]) => `${k}×${n}`).join(', ') || '(none)');
if (unmatched.length) {
  console.log('unmatched:');
  for (const t of unmatched) console.log(' - ' + t);
}
