import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TITLE_SYSTEM, DEFAULT_OVERRIDES, maskDrugs, restoreDrugs, applyGlossary,
  parseTranslationArray, isDrugToken, normTitle, titleZhCutoff, isAcronym,
  extractAiText,
} from './mt.js';
import { handleTranslate, __setMtResources } from '../api/translate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const glossary = JSON.parse(fs.readFileSync(path.join(root, 'data/glossary.json'), 'utf8'));
const overrides = JSON.parse(fs.readFileSync(path.join(root, 'data/mt-overrides.json'), 'utf8'));

test('system prompt keeps the tested placeholder and JSON rules', () => {
  assert.match(TITLE_SYSTEM, /\[D1\]/);
  assert.match(TITLE_SYSTEM, /JSON array of Chinese translations/);
  assert.match(TITLE_SYSTEM, /iliac = 髂/);
});

test('15-day cutoff is an inclusive UTC window', () => {
  assert.equal(titleZhCutoff(new Date('2026-10-18T01:58:00Z')), '2026-10-04');
  assert.equal(titleZhCutoff(new Date('2026-10-18T23:00:00Z')), '2026-10-04');
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
        return { response: JSON.stringify(arr.map(t => `译${t}`)) };
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
  assert.equal(calls.length, 1);
  assert.match(calls[0].model, /qwen3-30b-a3b-fp8/);
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
