import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TITLE_SYSTEM, SELECTION_SYSTEM, DEFAULT_OVERRIDES, maskDrugs, restoreDrugs, applyGlossary, stripTitleStop,
  parseTranslationArray, isDrugToken, normTitle, titleZhCutoff, TITLE_ZH_DAYS, isAcronym,
  extractAiText, stripModelThinking, mtRequest, MT_MODEL, MT_MAX_TOKENS,
  preserveTitleContrast, exactTitleZh, settleTitleZh, sha256Hex,
} from './mt.js';
import { handleTranslate, __setMtResources } from '../api/translate.js';
import { parseQuoteResponse } from './quotes.js';

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
  assert.throws(() => parseTranslationArray('<think>still going and no answer', 1));
  const quoted = parseQuoteResponse('<think>{"quotes":[{"role":"finding","i":0,"zh":"思考"}]}</think>{"quotes":[{"role":"finding","i":1,"zh":"真正的译文"}]}');
  assert.equal(quoted.length, 1);
  assert.equal(quoted[0].i, 1);
  assert.equal(quoted[0].zh, '真正的译文');
  assert.deepEqual(parseQuoteResponse('<think>{"quotes":[{"role":"finding","i":0,"zh":"未写完"}]}'), []);
});

test('extractAiText reads the GLM chat completion and ignores reasoning', () => {
  assert.equal(extractAiText({ response: '甲' }), '甲');
  assert.equal(extractAiText({ choices: [{ message: { content: '乙' } }] }), '乙');
  assert.equal(extractAiText({
    choices: [{
      message: {
        content: '<think>draft the wording</think>心力衰竭失代偿',
        reasoning_content: 'draft the wording',
      },
      finish_reason: 'stop',
    }],
  }), '心力衰竭失代偿');
  assert.equal(extractAiText({
    result: {
      choices: [{ message: { content: '<think></think>["甲"]' } }],
    },
  }), '["甲"]');
  assert.equal(extractAiText({
    choices: [{
      finish_reason: 'length',
      message: { content: '<think>spent the completion cap', reasoning_content: 'spent the completion cap' },
    }],
  }), '');
  assert.equal(extractAiText({
    choices: [{ message: { content: null, reasoning_content: '只在思考里出现的译文' } }],
  }), '');
  assert.equal(stripModelThinking('</think>译文'), '译文');
  assert.equal(extractAiText({ response: ['心力衰竭的中文译文'] }), '["心力衰竭的中文译文"]');
  assert.equal(
    extractAiText({ response: { quotes: [{ role: 'finding', i: 0, zh: '真正的译文' }] }, tool_calls: [], usage: {} }),
    '{"quotes":[{"role":"finding","i":0,"zh":"真正的译文"}]}',
  );
  assert.equal(extractAiText({
    response: '',
    choices: [{ message: { content: '["丙"]', reasoning_content: 'hidden' } }],
  }), '["丙"]');
});

test('GLM request disables thinking and caps completion tokens', () => {
  const req = mtRequest(TITLE_SYSTEM, '["Heart failure"]', MT_MAX_TOKENS);
  assert.equal(MT_MODEL, '@cf/zai-org/glm-4.7-flash');
  assert.equal(req.temperature, 0.1);
  assert.equal(req.max_tokens, 2000);
  assert.equal('max_completion_tokens' in req, false);
  assert.equal('reasoning_effort' in req, false);
  assert.deepEqual(req.chat_template_kwargs, { enable_thinking: false });
  assert.equal(req.messages[0].content, TITLE_SYSTEM);
  assert.equal(req.messages[1].content, '["Heart failure"]');
  assert.equal(req.messages[1].content.includes('/no_think'), false);
  const short = mtRequest(SELECTION_SYSTEM, 'Heart failure', 50.9);
  assert.equal(short.max_tokens, 50);
  assert.equal('max_completion_tokens' in short, false);
  assert.equal(short.messages[0].content, SELECTION_SYSTEM);
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
        const user = input.messages[1].content;
        const arr = JSON.parse(user);
        assert.equal(input.temperature, 0.1);
        assert.equal(input.max_tokens, 2000);
        assert.equal('max_completion_tokens' in input, false);
        assert.equal('reasoning_effort' in input, false);
        assert.deepEqual(input.chat_template_kwargs, { enable_thinking: false });
        assert.equal(input.messages[0].content, TITLE_SYSTEM);
        assert.equal(user.includes('/no_think'), false);
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
  assert.equal(calls[0].model, MT_MODEL);
  assert.equal(calls[0].model.includes('qwen'), false);
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

function glmChoice(content, extra = {}) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [{
      index: 0,
      finish_reason: extra.finish_reason || 'stop',
      message: {
        role: 'assistant',
        content,
        refusal: null,
        reasoning_content: extra.reasoning_content || '',
      },
    }],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 12,
      total_tokens: 32,
      completion_tokens_details: { reasoning_tokens: extra.reasoning_tokens || 0 },
    },
  };
}

test('titles, selection, and quotes all call GLM with thinking off', async () => {
  __setMtResources({ glossary: [], overrides: [] });
  const origin = 'https://research-radar-f5j.pages.dev';
  const seen = [];
  const env = {
    AI: {
      async run(model, input) {
        seen.push({ model, input, mode: input.messages[0].content.slice(0, 24) });
        const user = input.messages[1].content;
        assert.equal(model, MT_MODEL);
        assert.equal(input.chat_template_kwargs.enable_thinking, false);
        assert.equal(input.max_tokens, MT_MAX_TOKENS);
        assert.equal('max_completion_tokens' in input, false);
        assert.equal('reasoning_effort' in input, false);
        assert.equal(user.includes('/no_think'), false);
        if (user.startsWith('[')) {
          const arr = JSON.parse(user);
          return glmChoice(JSON.stringify(arr.map(() => '心力衰竭的中文译文')));
        }
        if (user.includes('[0]')) {
          return glmChoice(JSON.stringify({
            quotes: [{ role: 'finding', i: 0, zh: '早期复查容量状态比常规护理降低了死亡率。' }],
          }));
        }
        return glmChoice('<think>pick the medical term</think>心力衰竭失代偿');
      },
    },
  };
  const post = (body) => handleTranslate(new Request(origin + '/api/translate', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env);

  const titles = await post({ mode: 'titles', items: [{ id: '10.1/a', text: 'Heart failure decompensation' }] });
  assert.equal(titles.status, 200);
  const titleBody = await titles.json();
  assert.equal(titleBody.items[0].zh, '心力衰竭的中文译文');
  assert.equal(titleBody.items[0].cached, false);

  const selection = await post({ mode: 'selection', text: 'Heart failure decompensation' });
  assert.equal(selection.status, 200);
  const selBody = await selection.json();
  assert.equal(selBody.zh, '心力衰竭失代偿');
  assert.equal(selBody.zh.includes('pick the medical'), false);
  assert.equal(selBody.zh.includes('<think>'), false);

  const quoteAbstract = 'Thus, early review of volume status reduced mortality compared with usual care among adults with heart failure.';
  const quotes = await post({
    mode: 'quotes',
    doi: '10.1/glm',
    abstract: quoteAbstract,
  });
  assert.equal(quotes.status, 200);
  const quoteBody = await quotes.json();
  assert.ok(quoteBody.quotes.length >= 1);
  for (const q of quoteBody.quotes) {
    assert.equal(quoteAbstract.includes(q.en.replace(/^…\s*/, '').replace(/\s*…$/, '').split(' … ')[0]), true);
    assert.equal(q.zh.includes('<think>'), false);
    assert.equal(q.zh.includes('pick the medical'), false);
    assert.match(q.zh, /[\u4e00-\u9fff]/);
  }
  assert.equal(seen.length >= 3, true);
  assert.equal(seen.every(call => call.model === '@cf/zai-org/glm-4.7-flash'), true);
});

test('share quotes and titles accept a parsed JSON response instead of the generic failure', async () => {
  __setMtResources({ glossary: [], overrides: [] });
  const origin = 'https://research-radar-f5j.pages.dev';
  const abstract = 'Thus, early review of volume status reduced mortality compared with usual care among adults with heart failure.';
  const env = {
    AI: {
      async run(_model, input) {
        const user = input.messages[1].content;
        assert.equal(input.max_tokens, 2000);
        assert.equal('max_completion_tokens' in input, false);
        assert.equal('reasoning_effort' in input, false);
        assert.equal(input.chat_template_kwargs.enable_thinking, false);
        if (user.includes('[0]')) {
          return {
            response: { quotes: [{ role: 'finding', i: 0, zh: '早期复查容量状态比常规护理降低了心衰成人的死亡率。' }] },
            tool_calls: [],
            usage: { prompt_tokens: 40, completion_tokens: 30, total_tokens: 70 },
          };
        }
        const arr = JSON.parse(user);
        return { response: arr.map(() => '心力衰竭的中文译文') };
      },
    },
  };
  const post = (body) => handleTranslate(new Request(origin + '/api/translate', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env);

  const titles = await post({
    mode: 'titles',
    items: [{ id: '10.1/share', text: 'Heart failure decompensation' }],
  });
  assert.equal(titles.status, 200);
  const titleBody = await titles.json();
  assert.equal(titleBody.items[0].zh, '心力衰竭的中文译文');

  const quotes = await post({ mode: 'quotes', doi: '10.1/share', abstract });
  const quoteBody = await quotes.json();
  assert.equal(quotes.status, 200, quoteBody.message || quotes.status);
  assert.equal(quoteBody.message, undefined);
  assert.ok(quoteBody.quotes.some(q => /死亡率/.test(q.zh)));
  assert.equal(quoteBody.quotes.every(q => abstract.includes(q.en.replace(/^…\s*/, '').split(' … ')[0])), true);
});

test('a reasoning-only GLM completion is not cached as a translation', async () => {
  __setMtResources({ glossary: [], overrides: [] });
  const origin = 'https://research-radar-f5j.pages.dev';
  const store = new Map();
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
  try {
    const res = await handleTranslate(new Request(origin + '/api/translate', {
      method: 'POST',
      headers: { Origin: origin },
      body: JSON.stringify({ mode: 'selection', text: 'Heart failure decompensation' }),
    }), {
      AI: {
        async run() {
          return glmChoice(null, {
            finish_reason: 'length',
            reasoning_content: 'The user wants a translation of heart failure.',
            reasoning_tokens: 1800,
          });
        },
      },
    });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, 'ai_failed');
    assert.equal(store.size, 0);
  } finally {
    if (previous === undefined) delete globalThis.caches;
    else globalThis.caches = previous;
  }
});

test('active translation files do not call the retiring Qwen model', () => {
  const retired = '@cf/qwen/qwen3-30b-a3b-fp8';
  for (const rel of ['functions/_lib/mt.js', 'functions/api/translate.js', 'functions/_lib/quotes.js']) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.equal(src.includes(retired), false, rel);
    assert.equal(src.includes('/no_think'), false, rel);
  }
  assert.match(fs.readFileSync(path.join(root, 'functions/_lib/mt.js'), 'utf8'), /@cf\/zai-org\/glm-4\.7-flash/);
  const seed = fs.readFileSync(path.join(root, 'data/title-zh.json'), 'utf8');
  assert.match(seed, /qwen3-30b-a3b-fp8/);
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

test('今日精选 takes last-week papers before the older 15-day pool', () => {
  const src = fs.readFileSync(path.join(root, 'assets/app.js'), 'utf8');
  const start = src.indexOf('function pickRank');
  const end = src.indexOf('function keywordList');
  const { curate, curatePools } = new Function(`
    function articleTier(a) {
      return a && (a.tier === 'flagship' || a.tier === 'sub') ? a.tier : 'specialty';
    }
    const PICK_N = 8, PICK_BASIC = 4, PICK_CLINICAL = 4;
    ${src.slice(start, end)}
    return { curate, curatePools };
  `)();
  const paper = (doi, journal, basic, imp, date) => ({
    id: doi, doi, title: doi, journal, basic, tier: 'flagship', studyRank: 6, imp, date, structured: true,
  });
  const week = [
    paper('10.w/c1', 'NEJM', false, 40, '2026-10-18'),
    paper('10.w/c2', 'BMJ', false, 30, '2026-10-17'),
    paper('10.w/c3', 'JAMA', false, 20, '2026-10-16'),
    paper('10.w/c4', 'Lancet', false, 10, '2026-10-15'),
    paper('10.w/b1', 'Nature', true, 40, '2026-10-18'),
    paper('10.w/b2', 'Cell', true, 30, '2026-10-17'),
    paper('10.w/b3', 'Science', true, 20, '2026-10-16'),
    paper('10.w/b4', 'Neuron', true, 10, '2026-10-15'),
  ];
  const older = [
    paper('10.old/angio', 'Lancet', false, 98, '2026-10-08'),
    paper('10.old/c2', 'Ann Oncol', false, 80, '2026-10-07'),
    paper('10.old/c3', 'Chest', false, 70, '2026-10-06'),
    paper('10.old/c4', 'Blood', false, 60, '2026-10-05'),
    paper('10.old/cell', 'Cell', true, 90, '2026-10-09'),
    paper('10.old/b2', 'Nat Genet', true, 80, '2026-10-08'),
    paper('10.old/b3', 'Nat Neurosci', true, 70, '2026-10-07'),
    paper('10.old/b4', 'Sci Adv', true, 60, '2026-10-06'),
  ];
  const picks = curatePools([week, older]);
  assert.equal(picks.length, 8);
  assert.equal(picks.filter(p => p.basic).length, 4);
  assert.equal(picks.filter(p => !p.basic).length, 4);
  const ids = new Set(picks.map(p => p.doi));
  for (const a of week) assert.equal(ids.has(a.doi), true, a.doi);
  assert.equal(ids.has('10.old/angio'), false);
  assert.equal(ids.has('10.old/cell'), false);

  const thin = curatePools([[week[0], week[4]], older]);
  const thinIds = thin.map(p => p.doi);
  assert.equal(thinIds.includes('10.w/c1'), true);
  assert.equal(thinIds.includes('10.w/b1'), true);
  assert.equal(thinIds.includes('10.old/angio'), true);
  assert.equal(thin.filter(p => !p.basic).length, 4);
  assert.equal(thin[0].doi.startsWith('10.w/'), true);
  assert.ok(thin.findIndex(p => p.doi === '10.old/angio') > thin.findIndex(p => p.doi === '10.w/c1'));

  const dup = curatePools([[week[0]], [week[0], ...older]]);
  assert.equal(dup.filter(p => p.doi === '10.w/c1').length, 1);

  const solo = curate(week);
  assert.equal(solo.length, 8);
  assert.match(src, /function freshPickPools/);
  assert.match(src, /curatePools\(freshPickPools\(\)\)/);
  assert.match(src, /S\.week\.loading && !weekReady/);
});

test('journal filter narrows the current list and can be cleared', () => {
  const src = fs.readFileSync(path.join(root, 'assets/app.js'), 'utf8');
  const start = src.indexOf('function journalName');
  const end = src.indexOf('function openJournalSheet');
  const { applyJournal, journalChoices } = new Function(`
    const S = { cfg: [{ short: 'NEJM', title: 'NEJM', issn: '0028-4793' }] };
    ${src.slice(start, end)}
    return { applyJournal, journalChoices };
  `)();
  const list = [
    { journal: 'Lancet', title: 'A' },
    { journal: 'Nature', title: 'B' },
    { journal: 'Lancet', title: 'C' },
    { journal: '  ', title: 'D' },
  ];
  assert.equal(applyJournal(list, '').length, 4);
  assert.deepEqual(applyJournal(list, 'Lancet').map(a => a.title), ['A', 'C']);
  assert.equal(applyJournal(list, 'NEJM').length, 0);
  const choices = journalChoices(
    [{ journal: 'Lancet' }, { journal: 'Lancet' }, { journal: 'Nature' }],
    'nejm',
  );
  assert.equal(choices.length, 1);
  assert.equal(choices[0].name, 'NEJM');
  assert.equal(choices[0].n, 0);
  assert.match(src, /id="journalSheet"|journalSheet/);
});

test('publication date sort toggles newest and oldest without dropping a tied row', () => {
  const src = fs.readFileSync(path.join(root, 'assets/app.js'), 'utf8');
  const start = src.indexOf('function pubDateKey');
  const end = src.indexOf('function filteredArticles');
  const { sortByPubDate } = new Function(
    src.slice(start, end) + '\nreturn { sortByPubDate };',
  )();
  const list = [
    { title: 'a', date: '2026-10-10' },
    { title: 'b', date: '2026-10-17' },
    { title: 'c', date: '2026-10-10' },
    { title: 'd', date: '' },
    { title: 'e', date: '2026-10-04' },
  ];
  assert.deepEqual(sortByPubDate(list, 'new').map(a => a.title), ['b', 'a', 'c', 'e', 'd']);
  assert.deepEqual(sortByPubDate(list, 'old').map(a => a.title), ['e', 'a', 'c', 'b', 'd']);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const tools = html.slice(html.indexOf('id="markAllRead"'), html.indexOf('class="viewtog"'));
  assert.match(tools, /id="dateSortBtn"/);
  const css = fs.readFileSync(path.join(root, 'assets/styles.css'), 'utf8');
  const ghost = css.slice(css.indexOf('.ghost-btn{'), css.indexOf('.date-sort{'));
  const top = css.slice(css.indexOf('.to-top{'), css.indexOf('.to-top[hidden]'));
  assert.equal(ghost.includes('--read'), false);
  assert.equal(top.includes('--read'), false);
  assert.match(top, /safe-area-inset-bottom|var\(--safe-b\)/);
  assert.match(src, /rr\.sort\.v1/);
  assert.match(src, /scrollTo\(\{ top: 0/);
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
