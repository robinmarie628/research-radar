import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  splitSentences, findVerbatim, pickHeuristic, resolveQuotePicks, parseQuoteResponse,
  isDenseMethods, isBoilerplate,
} from './quotes.js';
import { handleTranslate, __setMtResources } from '../api/translate.js';

const require = createRequire(import.meta.url);
const cite = require('../../assets/cite.js');

const ABSTRACT = 'Patients with heart failure had a higher risk of readmission. Methods included a cohort of 400 adults followed for two years. Thus, early review of volume status reduced mortality compared with usual care. A further sentence about laboratory methods is not the point of the paper.';

test('sentences keep abbreviations and decimals together', () => {
  const parts = splitSentences('Smith et al. reported a risk of 0.05. The trial then stopped early.');
  assert.equal(parts.length, 2);
  assert.match(parts[0], /et al\. reported/);
  assert.match(parts[0], /0\.05/);
});

test('a paraphrased sentence is rejected and a real one is kept', () => {
  const sentences = splitSentences(ABSTRACT);
  assert.equal(findVerbatim('Patients had more readmissions.', sentences), '');
  assert.equal(findVerbatim(sentences[2], sentences), sentences[2]);
  const picks = resolveQuotePicks(ABSTRACT, [
    { i: 99, en: 'Patients had more readmissions.', zh: '不该采用' },
    { i: 2, en: 'early review somehow helped', zh: '因此，早期评估容量状态降低了死亡率。' },
  ]);
  assert.equal(picks.length, 3);
  for (const p of picks) assert.ok(ABSTRACT.includes(p.en), p.en);
  assert.equal(picks.some(p => p.en === sentences[2] && /死亡率/.test(p.zh)), true);
  assert.equal(picks.some(p => /不该采用/.test(p.zh)), false);
});

test('heuristic picks are verbatim and prefer a short clinical sentence', () => {
  const sentences = splitSentences(ABSTRACT);
  const picked = pickHeuristic(sentences, 3);
  assert.equal(picked.length, 3);
  for (const s of picked) assert.ok(sentences.includes(s));
});

test('heuristic skips a methods sentence packed with confidence intervals', () => {
  const finding = 'Patients who received the higher dose had fewer ischemic events than those on standard care.';
  const second = 'The primary endpoint was reduced compared with standard care in this screened population.';
  const third = 'Therefore these findings support using the higher dose for similar patients.';
  const methods = 'Women were enrolled and randomly assigned across 140 sites (hazard ratio 0.81, 95% CI 0.74-0.89; p<0.001) with a median follow-up of 4.6 years in the modified full analysis set.';
  assert.equal(isDenseMethods(methods), true);
  assert.equal(isDenseMethods(finding), false);
  const abstract = [finding, second, third, methods].join(' ');
  const picked = pickHeuristic(splitSentences(abstract), 3);
  assert.equal(picked.length, 3);
  assert.equal(picked.some(s => /95% CI/.test(s)), false);
  for (const s of picked) assert.ok(s.length <= 220, s);
});

test('a long methods pick is replaced by a shorter finding', () => {
  const finding = 'Patients who received the higher dose had fewer ischemic events than those on standard care.';
  const second = 'Therefore these findings support using the higher dose for similar patients after screening.';
  const methods = 'Between 2018 and 2022 the trial randomly assigned 8421 adults and reported a hazard ratio of 0.81 (95% CI 0.74-0.89; p<0.001) across 140 sites in the modified full analysis set.';
  const abstract = [finding, methods, second].join(' ');
  const sentences = splitSentences(abstract);
  const picks = resolveQuotePicks(abstract, [{ i: sentences.findIndex(s => /95% CI/.test(s)), zh: '不该用这句方法学' }]);
  assert.equal(picks.some(p => /95% CI/.test(p.en)), false);
  assert.equal(picks.some(p => /不该用这句方法学/.test(p.zh)), false);
  assert.equal(picks.some(p => p.en === finding), true);
  for (const p of picks) assert.ok(abstract.includes(p.en));
});

test('registration, funding, ethics, and copyright lines are never quoted', () => {
  const interp = 'These findings suggest that tomosynthesis screening avoids about a quarter of invasive interval cancers.';
  const second = 'Our results suggest the trial adds evidence for tomosynthesis in breast cancer screening programmes.';
  const plain = 'Women screened with tomosynthesis had fewer interval cancers than women screened with digital mammography.';
  const reg = 'The study is registered on ClinicalTrials.gov (NCT03377036) and is closed to accrual but follow-up is ongoing.';
  const fund = 'This trial was funded by the German Cancer Aid and the authors report no other support.';
  const ethics = 'The ethics committee approved the protocol and written informed consent was obtained from every participant.';
  const copy = 'Copyright 2026 the authors, all rights reserved, and reuse requires permission from the publisher.';
  for (const s of [reg, fund, ethics, copy]) assert.equal(isBoilerplate(s), true, s);
  assert.equal(isBoilerplate(interp), false);
  assert.equal(isBoilerplate('Median follow-up was 24 months in both groups.'), false);
  const abstract = [plain, reg, fund, ethics, copy, interp, second].join(' ');
  const picked = pickHeuristic(splitSentences(abstract), 3);
  assert.equal(picked.length, 3);
  for (const s of picked) assert.equal(isBoilerplate(s), false, s);
  assert.equal(picked.includes(interp), true);
  assert.equal(picked.includes(second), true);
  const sentences = splitSentences(abstract);
  const forced = resolveQuotePicks(abstract, [
    { i: sentences.findIndex(s => /NCT03377036/.test(s)), zh: '注册信息' },
  ]);
  assert.equal(forced.some(p => /NCT|注册信息|funded by|ethics committee|Copyright/.test(p.en + p.zh)), false);
  assert.equal(forced.some(p => p.en === interp), true);
});

test('quote JSON parser reads indexes', () => {
  const parsed = parseQuoteResponse('```json\n{"quotes":[{"i":1,"zh":"甲"}]}\n```');
  assert.deepEqual(parsed, [{ i: 1, en: '', zh: '甲' }]);
});

test('quotes mode drops a fake sentence and restores a drug placeholder', async () => {
  __setMtResources({ glossary: [], overrides: [] });
  const abstract = 'First-line durvalumab improved survival in this trial of lung cancer patients. Methods included a prospective cohort and a prespecified analysis. Therefore the findings should change practice for unresectable disease.';
  const sentences = splitSentences(abstract);
  let calls = 0;
  const env = {
    AI: {
      async run(_model, payload) {
        calls++;
        const user = payload.messages[1].content;
        if (user.includes('[0]')) {
          return { response: JSON.stringify({ quotes: [
            { i: 0, zh: '一线 [D1] 改善了生存。' },
            { i: 5, en: 'This sentence was invented by the model.', zh: '编造' },
          ] }) };
        }
        return { response: JSON.stringify(['方法是常规的。', '因此这些发现应当改变不可切除疾病的实践。']) };
      },
    },
  };
  const res = await handleTranslate(new Request('https://research-radar-f5j.pages.dev/api/translate', {
    method: 'POST',
    headers: { Origin: 'https://research-radar-f5j.pages.dev', 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'quotes', id: '10.1/test', abstract }),
  }), env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.quotes.length, 3);
  for (const q of data.quotes) assert.ok(abstract.includes(q.en), q.en);
  const first = data.quotes.find(q => q.en === sentences[0]);
  assert.ok(first);
  assert.match(first.zh, /durvalumab/);
  assert.doesNotMatch(first.zh, /\[D1\]/);
  assert.equal(data.quotes.some(q => /编造|invented/.test(q.en + q.zh)), false);
  assert.ok(calls >= 1);
});

const sample = {
  title: 'Immunoregulatory gene GIMAP6 suppresses lethal disease',
  journal: 'Cell',
  year: '2026',
  date: '2026-10-08',
  volume: '189',
  issue: '21',
  pages: '6792-6809',
  doi: '10.1016/j.cell.2026.09.032',
  pmid: '123456',
  authorCite: ['Xiang C', 'Arusha K', 'Springer D', 'Li M'],
};

test('RIS, BibTeX, and Vancouver use the metadata we have', () => {
  const ris = cite.ris(sample);
  assert.match(ris, /^TY {2}- JOUR/m);
  assert.match(ris, /AU {2}- Xiang, C/);
  assert.match(ris, /DO {2}- 10\.1016\/j\.cell\.2026\.09\.032/);
  assert.match(ris, /VL {2}- 189/);
  assert.match(ris, /SP {2}- 6792/);
  assert.match(ris, /EP {2}- 6809/);
  assert.match(ris, /ER {2}- /);

  const bib = cite.bibtex(sample);
  assert.match(bib, /^@article\{xiang2026immunoregulatory,/);
  assert.match(bib, /doi = \{10\.1016\/j\.cell\.2026\.09\.032\}/);
  assert.match(bib, /pages = \{6792--6809\}/);

  const van = cite.vancouver(sample);
  assert.match(van, /^Xiang C, Arusha K, Springer D, et al\./);
  assert.match(van, /Cell\. 2026;189\(21\):6792-6809\./);
  assert.match(van, /doi:10\.1016\/j\.cell\.2026\.09\.032\./);
});

test('the share link follows ClinicalKey, then ScienceDirect, then DOI', () => {
  const ck = cite.shareTarget({ pii: 'S0092867426011347', platforms: ['ck', 'sd'], doi: '10.1/x' });
  assert.equal(ck.name, 'ClinicalKey');
  assert.match(ck.url, /clinicalkey\.com\/#!\/content\/playContent\/1-s2\.0-S0092867426011347$/);
  const sd = cite.shareTarget({ pii: 'S0092867426011347', platforms: ['sd'], doi: '10.1/x' });
  assert.equal(sd.name, 'ScienceDirect');
  assert.match(sd.url, /sciencedirect\.com\/science\/article\/pii\/S0092867426011347$/);
  const doi = cite.shareTarget({ pii: 'S0092867426011347', platforms: [], doi: '10.1016/j.cell.2026.09.032' });
  assert.equal(doi.name, 'DOI');
  assert.equal(doi.url, 'https://doi.org/10.1016/j.cell.2026.09.032');
});
