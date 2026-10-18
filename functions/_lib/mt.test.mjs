import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TITLE_SYSTEM, DEFAULT_OVERRIDES, maskDrugs, restoreDrugs, applyGlossary, stripTitleStop,
  parseTranslationArray, isDrugToken, normTitle, titleZhCutoff, TITLE_ZH_DAYS, isAcronym,
  extractAiText, preserveTitleContrast, exactTitleZh, settleTitleZh, sha256Hex,
} from './mt.js';
import { handleTranslate, __setMtResources } from '../api/translate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const glossary = JSON.parse(fs.readFileSync(path.join(root, 'data/glossary.json'), 'utf8'));
const overrides = JSON.parse(fs.readFileSync(path.join(root, 'data/mt-overrides.json'), 'utf8'));

test('system prompt keeps the tested placeholder and JSON rules', () => {
  assert.match(TITLE_SYSTEM, /\[D1\]/);
  assert.match(TITLE_SYSTEM, /JSON array of Chinese translations/);
  assert.match(TITLE_SYSTEM, /iliac = 髂/);
  assert.match(TITLE_SYSTEM, /delayed treatment initiation/);
  assert.match(TITLE_SYSTEM, /延迟治疗启动/);
});

test('15-day cutoff matches the journal pool: today minus 15 days', () => {
  assert.equal(TITLE_ZH_DAYS, 15);
  assert.equal(titleZhCutoff(new Date('2026-10-18T01:58:00Z')), '2026-10-03');
  assert.equal(titleZhCutoff(new Date('2026-10-18T23:00:00Z')), '2026-10-03');
});

test('machine titles follow the 15-day pool; a favorite outside it still wants one', () => {
  const src = fs.readFileSync(path.join(root, 'assets/app.js'), 'utf8');
  const start = src.indexOf('function mtId');
  const end = src.indexOf('function mtLists');
  const { machineTitleWanted } = new Function(src.slice(start, end) + '\nreturn { machineTitleWanted };')();
  const cutoff = '2026-10-03';
  const resolve = {
    title: '8 weeks versus 12 weeks of sofosbuvir-velpatasvir for treatment-naive, non-cirrhotic, chronic hepatitis C (RESOLVE): a multicentre, open-label, non-inferiority, randomised controlled trial in India.',
    date: '2026-09-30',
    doi: '10.1016/s0140-6736(26)01380-2',
  };
  const survodutide = {
    title: 'Survodutide Once Weekly in Adults with Obesity and Type 2 Diabetes.',
    date: '2026-10-01',
    doi: '10.1056/nejmoa2607219',
  };
  const neuron = {
    title: 'Toward an automated science of the mind.',
    date: '2026-10-01',
    doi: '10.1016/j.neuron.2026.09.012',
  };
  assert.equal(machineTitleWanted(resolve, cutoff, new Set()), false);
  assert.equal(machineTitleWanted(survodutide, cutoff, new Set()), false);
  assert.equal(machineTitleWanted(neuron, cutoff, new Set()), false);
  assert.equal(machineTitleWanted(neuron, cutoff, new Set([neuron.doi])), true);
  assert.equal(machineTitleWanted({ title: 'In window.', date: '2026-10-08', doi: '10.1/new' }, cutoff, new Set()), true);
  assert.equal(machineTitleWanted({ title: 'Boundary.', date: '2026-10-03', doi: '10.1/edge' }, cutoff, new Set()), true);
  assert.equal(machineTitleWanted({ title: 'Day before.', date: '2026-10-02', doi: '10.1/old' }, cutoff, new Set()), false);
  assert.equal(machineTitleWanted({ title: 'Old paper.', date: '2026-09-01', doi: '10.1000/old' }, cutoff, new Set()), false);
  assert.equal(machineTitleWanted({ ...neuron, digest: { titleZh: '已有编辑标题' } }, cutoff, new Set([neuron.doi])), false);
  assert.equal(machineTitleWanted({ title: '', date: '2026-10-08', doi: '10.1/x' }, cutoff, new Set()), false);

  const queue = src.slice(src.indexOf('function queueMachineTitles'), src.indexOf('let mtPopToken'));
  assert.ok(queue.indexOf('favoriteArticles()') < queue.indexOf('S.jr.all'));
  assert.ok(queue.indexOf('S.jr.picks') < queue.indexOf('S.jr.all'));
});

test('normTitle ignores case, trailing period, and space', () => {
  assert.equal(normTitle('  Hello   World. '), 'hello world');
  assert.equal(normTitle('HbA 1c.'), normTitle('hba 1c'));
});

test('drug tokens are masked and restored; ordinary words are not', () => {
  const src = 'First-line durvalumab and tremelimumab plus ticagrelor, niraparib, and resmetirom in a neuropeptide study of peptide signaling';
  const { text, drugs } = maskDrugs(src);
  assert.match(text, /\[D1\]/);
  assert.doesNotMatch(text, /durvalumab|tremelimumab|ticagrelor|niraparib|resmetirom/);
  assert.match(text, /neuropeptide/);
  assert.match(text, /peptide/);
  const names = drugs.map(d => d.tok);
  assert.deepEqual(names, ['durvalumab', 'tremelimumab', 'ticagrelor', 'niraparib', 'resmetirom']);
  assert.equal(restoreDrugs(text, drugs), src);
  const echoed = text.replace('[D1]', '度伐利尤单抗');
  const back = restoreDrugs(echoed, drugs);
  assert.match(back, /度伐利尤单抗/);
  assert.match(back, /tremelimumab/);
  assert.doesNotMatch(back, /\[D/);
});

test('repeated drugs share one placeholder', () => {
  const { text, drugs } = maskDrugs('nivolumab then nivolumab');
  assert.equal(text, '[D1] then [D1]');
  assert.equal(drugs.length, 1);
});

test('INN stems from the brief are recognized', () => {
  for (const name of ['pembrolizumab', 'osimertinib', 'niraparib', 'ticagrelor', 'rilpivirine', 'mipitecan', 'semaglutide', 'bevacizumab', 'prasugrel', 'cabotegravir', 'sofetabart', 'deucrictibant', 'vedotin', 'cangrelor']) {
    assert.equal(isDrugToken(name), true, name);
  }
  for (const word of ['peptide', 'neuropeptide', 'ischemia', 'iliac', 'syndrome', 'ensemble', 'multicenter', 'intercept', 'PCI', 'behavior', 'except', 'accept']) {
    assert.equal(isDrugToken(word), false, word);
  }
});

test('a Chinese title drops a trailing full stop and keeps an interior one', () => {
  assert.equal(stripTitleStop('非动脉性前部缺血性视神经病变中的前层高反射线。'), '非动脉性前部缺血性视神经病变中的前层高反射线');
  assert.equal(stripTitleStop('前层高反射线.'), '前层高反射线');
  assert.equal(stripTitleStop('前层高反射线。 '), '前层高反射线');
  assert.equal(stripTitleStop('中间。保留'), '中间。保留');
  assert.equal(stripTitleStop('Study.'), 'Study.');
});

test('glossary overrides fix the three known title failures', () => {
  const iliac = applyGlossary(
    'Early Outcomes of Physician-Modified Endurant Limbs vs Iliac Branch Devices in Narrow Common Iliac Arteries: A Retrospective Cohort Pilot Study',
    '狭窄共同髂动脉中医生改良Endurant肢体与髂支装置的早期结果：一项回顾性队列试点研究',
    glossary, overrides,
  );
  assert.match(iliac, /狭窄的髂总动脉/);
  assert.doesNotMatch(iliac, /共同髂/);

  const pts = applyGlossary(
    'Post thrombotic syndrome after thrombotic venous thoracic outlet syndrome',
    '血栓性静脉胸廓出口综合征后深静脉血栓综合征',
    glossary, overrides,
  );
  assert.match(pts, /血栓后综合征/);
  assert.doesNotMatch(pts, /深静脉血栓综合征/);

  const tica = applyGlossary(
    'Ticagrelor Monotherapy or Aspirin Plus Prasugrel After Percutaneous Coronary Intervention: A Network Meta-Analysis',
    '经皮冠状动脉介入治疗后替卡格雷单药治疗或阿司匹林联合普拉格雷：网络Meta分析',
    glossary, overrides,
  );
  assert.match(tica, /ticagrelor/);
  assert.doesNotMatch(tica, /替卡格雷/);
});

test('glossary.json rewrites leftover English phrases but not acronyms or drug names', () => {
  const hf = applyGlossary(
    'Heart Failure predicts contralateral limb progression',
    'Heart Failure预测对侧肢体进展',
    glossary, overrides,
  );
  assert.match(hf, /心力衰竭/);
  assert.doesNotMatch(hf, /Heart Failure/);

  const pci = applyGlossary(
    'Preventive PCI of vulnerable plaques',
    '预防性PCI治疗易损斑块',
    glossary, overrides,
  );
  assert.equal(pci, '预防性PCI治疗易损斑块');
  assert.equal(isAcronym('PCI'), true);
  assert.equal(isAcronym('LDL-C'), true);
});

test('JSON array parser drops think tags and fences', () => {
  const raw = '<think>secret</think>\n```json\n["甲","乙"]\n```';
  assert.deepEqual(parseTranslationArray(raw, 2), ['甲', '乙']);
  assert.throws(() => parseTranslationArray('["甲"]', 2));
});

test('extractAiText reads Workers AI and chat-completions shapes', () => {
  assert.equal(extractAiText({ response: '甲' }), '甲');
  assert.equal(extractAiText({ choices: [{ message: { content: '乙' } }] }), '乙');
});

test('default overrides match the data file', () => {
  assert.equal(overrides.length, DEFAULT_OVERRIDES.length);
  assert.deepEqual(overrides.map(o => o.en), DEFAULT_OVERRIDES.map(o => o.en));
});

test('handler masks drugs, restores them, and caches nothing without the Cache API', async () => {
  __setMtResources({ glossary, overrides });
  const calls = [];
  const env = {
    AI: {
      async run(model, input) {
        calls.push({ model, input });
        const user = input.messages[1].content.replace(/^\/no_think\n/, '');
        const arr = JSON.parse(user);
        assert.equal(input.temperature, 0.1);
        assert.equal(input.messages[0].content, TITLE_SYSTEM);
        assert.doesNotMatch(arr[0], /durvalumab/);
        assert.match(arr[0], /\[D1\]/);
        return { response: JSON.stringify(arr.map(t => `译${t}。`)) };
      },
    },
  };
  const req = new Request('https://research-radar-f5j.pages.dev/api/translate', {
    method: 'POST',
    headers: { Origin: 'https://research-radar-f5j.pages.dev', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'titles',
      items: [{ id: '10.1/abc', text: 'First-line durvalumab in liver cancer' }],
    }),
  });
  const res = await handleTranslate(req, env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.items[0].id, '10.1/abc');
  assert.match(data.items[0].zh, /durvalumab/);
  assert.doesNotMatch(data.items[0].zh, /\[D1\]/);
  assert.equal(data.items[0].zh.endsWith('。'), false);
  assert.equal(data.items[0].zh.endsWith('.'), false);
  assert.equal(calls.length, 1);
  assert.match(calls[0].model, /qwen3-30b-a3b-fp8/);
});

const AMD_EN = 'Management of Neovascular Age-Related Macular Degeneration in Routine US Clinical Practice: Impact of Delayed Treatment Initiation.';
const AMD_ZH = '美国常规临床实践中新生血管性年龄相关性黄斑变性的管理：延迟治疗启动的影响';

test('a shortened title keeps delayed, prompt, early, and late initiation', () => {
  const short = '美国常规临床实践中新生血管性年龄相关性黄斑变性的管理';
  assert.equal(preserveTitleContrast(AMD_EN, short), AMD_ZH);
  assert.equal(preserveTitleContrast(AMD_EN, AMD_ZH), AMD_ZH);
  assert.equal(exactTitleZh(AMD_EN, overrides), AMD_ZH);
  assert.equal(settleTitleZh(AMD_EN, short, glossary, overrides), AMD_ZH);
  assert.equal(preserveTitleContrast(AMD_EN, short + '。'), AMD_ZH);

  const prompt = preserveTitleContrast(
    'Beta blockers in heart failure: Impact of prompt treatment initiation.',
    '心力衰竭中的β受体阻滞剂',
  );
  assert.match(prompt, /及时开始治疗的影响$/);

  const both = preserveTitleContrast(
    'Sepsis care: early versus late treatment initiation',
    '脓毒症治疗',
  );
  assert.equal(both, '脓毒症治疗：早期与晚期开始治疗');

  const design = preserveTitleContrast(
    'Air pollution and asthma admissions: a nationwide population-based cohort study.',
    '空气污染与哮喘入院',
  );
  assert.equal(design, '空气污染与哮喘入院');

  const kept = preserveTitleContrast(
    'Sepsis care: impact of early treatment initiation',
    '脓毒症治疗：提早开始治疗的影响',
  );
  assert.equal(kept, '脓毒症治疗：提早开始治疗的影响');
});

test('a cached title that dropped delayed treatment is rewritten without calling the model', async () => {
  __setMtResources({ glossary, overrides });
  const key = 'title/' + (await sha256Hex(normTitle(AMD_EN))).slice(0, 32);
  const store = new Map();
  store.set('/api/mt-cache/v1/' + key, JSON.stringify({
    zh: '美国常规临床实践中新生血管性年龄相关性黄斑变性的管理',
  }));
  const previous = globalThis.caches;
  globalThis.caches = {
    default: {
      async match(req) {
        const hit = store.get(new URL(req.url).pathname);
        return hit ? new Response(hit, { headers: { 'Content-Type': 'application/json' } }) : undefined;
      },
      async put(req, res) {
        store.set(new URL(req.url).pathname, await res.text());
      },
    },
  };
  let calls = 0;
  try {
    const res = await handleTranslate(new Request('https://research-radar-f5j.pages.dev/api/translate', {
      method: 'POST',
      headers: { Origin: 'https://research-radar-f5j.pages.dev', 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'titles', items: [{ id: '10.1016/j.oret.2026.09.029', text: AMD_EN }] }),
    }), { AI: { async run() { calls += 1; return { response: '["不该调用"]' }; } } });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.items[0].zh, AMD_ZH);
    assert.equal(data.items[0].cached, false);
    assert.equal(calls, 0);
    assert.equal(JSON.parse(store.get('/api/mt-cache/v1/' + key)).zh, AMD_ZH);
  } finally {
    if (previous === undefined) delete globalThis.caches;
    else globalThis.caches = previous;
  }
});

test('handler reports quota and a missing AI binding', async () => {
  __setMtResources({ glossary, overrides });
  const origin = 'https://research-radar-f5j.pages.dev';
  const post = (env) => handleTranslate(new Request(origin + '/api/translate', {
    method: 'POST',
    headers: { Origin: origin },
    body: JSON.stringify({ mode: 'selection', text: 'Heart failure decompensation' }),
  }), env);

  const missing = await post({});
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).error, 'ai_unconfigured');

  const quota = await post({
    AI: { async run() { const e = new Error('Quota limit exceeded for neurons'); e.status = 429; throw e; } },
  });
  assert.equal(quota.status, 429);
  const body = await quota.json();
  assert.equal(body.error, 'quota');
  assert.match(body.message, /明天会恢复/);
});

test('selection over 1500 characters is rejected before the model', async () => {
  __setMtResources({ glossary, overrides });
  let called = false;
  const res = await handleTranslate(new Request('https://example.pages.dev/api/translate', {
    method: 'POST',
    headers: { Origin: 'https://example.pages.dev' },
    body: JSON.stringify({ mode: 'selection', text: 'a'.repeat(1501) }),
  }), { AI: { async run() { called = true; return { response: '不该调用' }; } } });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'too_long');
  assert.equal(called, false);
});

test('the journal pool drops dates older than 15 days and keeps a favorite locally', () => {
  const src = fs.readFileSync(path.join(root, 'assets/app.js'), 'utf8');
  assert.match(src, /const DAYS\s+=\s+15;/);
  const cutStart = src.indexOf('function poolCutoff');
  const cutEnd = src.indexOf('function epmcWindow');
  const { poolCutoff, withinPool } = new Function(
    'const DAYS = 15;\n' + src.slice(cutStart, cutEnd) + '\nreturn { poolCutoff, withinPool };',
  )();
  assert.equal(poolCutoff(new Date('2026-10-18T15:00:00Z')), '2026-10-03');
  const realNow = new Date();
  const lo = poolCutoff(realNow);
  const kept = withinPool([
    { title: 'before', date: '2026-10-02' },
    { title: 'edge', date: lo },
    { title: 'blank', date: '' },
  ]);
  assert.deepEqual(kept.map(a => a.title), ['edge']);

  const start = src.indexOf('function favKey');
  const end = src.indexOf('function toggleFav');
  const { favoriteArticles, S } = new Function(`
    function stripTitleMeta(s) { return String(s || '').trim(); }
    const DIGEST_FIELDS = [['background','背景'],['methods','怎么做'],['innovation','创新点'],['takeaway','看点'],['future','未来方向']];
    function writeFav() {}
    const S = { fav: { order: [], items: {} }, jr: { all: [], picks: [] }, week: { items: [] } };
    ${src.slice(start, end)}
    return { favoriteArticles, S };
  `)();

  const doi = '10.1016/s0140-6736(26)01380-2';
  const aged = {
    id: doi,
    doi,
    title: 'RESOLVE trial title.',
    date: '2026-09-30',
    abstract: '',
    structured: true,
    sections: { objective: 'Aim.', methods: 'We randomised.', results: 'Non-inferior.', conclusion: 'Eight weeks worked.' },
    journal: 'Lancet',
    domain: '感染',
    studyKey: 'rct',
    studyZh: '随机对照试验',
    basic: false,
    authors: 'Goel A',
    authorCite: ['Goel A', 'Smith J'],
    volume: '406',
    pages: '10-20',
    mtZh: '缩短疗程仍然有效',
    digest: { background: '背景句', takeaway: '看点句' },
    keywords: ['HCV'],
    platforms: ['ck'],
    pii: 'S123',
  };
  S.jr.all = [aged];
  S.fav.order = [doi];
  const live = favoriteArticles();
  assert.equal(live.length, 1);
  assert.equal(live[0], aged);
  assert.equal(S.fav.items[doi].sections.results, 'Non-inferior.');
  assert.equal(S.fav.items[doi].mtZh, '缩短疗程仍然有效');
  assert.equal(S.fav.items[doi].digest.background, '背景句');
  assert.equal(S.fav.items[doi].authorCite[0], 'Goel A');
  assert.equal(S.fav.items[doi].abstract, '');

  S.jr.all = [];
  S.jr.picks = [];
  const stored = favoriteArticles();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].title, 'RESOLVE trial title.');
  assert.equal(stored[0].date, '2026-09-30');
  assert.equal(stored[0].sections.conclusion, 'Eight weeks worked.');
  assert.match(stored[0].abstract, /Non-inferior/);
  assert.equal(stored[0].digest.takeaway, '看点句');
  assert.equal(stored[0].mtZh, '缩短疗程仍然有效');
  assert.equal(stored[0].authors, 'Goel A');
  assert.equal(stored[0].pii, 'S123');
  assert.equal(S.jr.all.length, 0);

  S.fav.items[doi] = { id: doi, doi, title: 'Legacy title', abstract: 'Plain abstract.', date: '2026-09-01', journal: 'BMJ' };
  const legacy = favoriteArticles()[0];
  assert.equal(legacy.title, 'Legacy title');
  assert.equal(legacy.abstract, 'Plain abstract.');
  assert.equal(legacy.journal, 'BMJ');
});

test('shipped journal snapshot stays inside the 15-day window it was built for', () => {
  const snap = JSON.parse(fs.readFileSync(path.join(root, 'data/snapshot-journals.json'), 'utf8'));
  assert.equal(snap.windowDays, 15);
  const gen = String(snap.generatedAt || '').slice(0, 10);
  const lo = titleZhCutoff(new Date(gen + 'T00:00:00Z'));
  const rows = [...(snap.items || []), ...(snap.picks || [])];
  assert.ok(rows.length > 0);
  for (const a of rows) {
    assert.ok(a.date >= lo, `${a.doi || a.id} ${a.date} is older than ${lo}`);
  }
});
