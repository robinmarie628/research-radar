import test from 'node:test';
import assert from 'node:assert/strict';

function quoteCore(en) {
  return String(en || '').replace(/…/g, '').replace(/\s+/g, ' ').trim();
}
function wordCountOk(en) {
  const n = quoteCore(en).split(/\s+/).filter(Boolean).length;
  return n > 0 && n <= 25;
}
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  splitSentences, findVerbatim, pickHeuristic, resolveQuotePicks, parseQuoteResponse,
  isDenseMethods, isBoilerplate, excerptQuote,
} from './quotes.js';
import { handleTranslate, __setMtResources } from '../api/translate.js';
import { extractPassages } from './fulltext.js';

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
  assert.ok(picks.length >= 1 && picks.length <= 4);
  for (const p of picks) {
    const core = p.en.replace(/…/g, '').trim();
    assert.ok(ABSTRACT.includes(core), p.en);
    assert.ok(wordCountOk(p.en), p.en);
    assert.equal(p.en.includes('...'), false);
  }
  assert.equal(picks.some(p => /early review of volume status reduced mortality/.test(p.en)), true);
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
  assert.equal(picks.some(p => quoteCore(p.en) && finding.includes(quoteCore(p.en))), true);
  for (const p of picks) assert.ok(abstract.includes(quoteCore(p.en)), p.en);
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
  assert.equal(picked.includes(plain), true);
  const sentences = splitSentences(abstract);
  const forced = resolveQuotePicks(abstract, [
    { i: sentences.findIndex(s => /NCT03377036/.test(s)), zh: '注册信息' },
  ]);
  assert.equal(forced.some(p => /NCT|注册信息|funded by|ethics committee|Copyright/.test(p.en + p.zh)), false);
  assert.equal(forced.some(p => /fewer interval cancers/.test(p.en)), true);
});

test('a dull mortality sentence loses to a result that breaks the usual assumption', () => {
  const bg = 'Controlling hyperlipidemia has reduced but not eliminated atherosclerotic disease as a major cause of death.';
  const finding = 'Loss of GIMAP6 caused inflammatory vasculopathy and accelerated atherosclerosis in the absence of hyperlipidemia.';
  const cascade = 'GIMAP6 loss precipitates a mitochondrial ROS-PPARγ-CD36 lipid-influx cascade that lowers the threshold for foam-cell formation.';
  const meaning = 'GIMAP6 restrains lethal vascular disease independently of systemic hyperlipidemia.';
  const methods = 'Mice were examined and randomly assigned across 12 cages with a hazard ratio of 0.80 (95% CI 0.70-0.90; p<0.001) in the modified full analysis set.';
  const reg = 'The study is registered on ClinicalTrials.gov (NCT03377036).';
  const picks = resolveQuotePicks([bg, methods, finding, cascade, reg, meaning].join(' '), []);
  const blob = picks.map(p => p.en).join(' ');
  assert.match(picks[0].en, /in the absence of hyperlipidemia/);
  assert.match(blob, /lipid-influx cascade|CD36/);
  assert.equal((blob.match(/hyperlipidemia/gi) || []).length, 1);
  assert.doesNotMatch(blob, /major cause of death|NCT|95% CI/);
  for (const p of picks) {
    assert.ok(wordCountOk(p.en), p.en);
    assert.equal(p.en.includes('...'), false);
  }
});

test('textbook background and a support-the-use conclusion are not the hooks', () => {
  const bg = 'In hereditary angioedema, oral on-demand treatments that provide rapid relief remain scant.';
  const aim = 'We investigated the efficacy and safety of deucrictibant for on-demand treatment of attacks.';
  const census = 'The primary efficacy analysis included 88 participants with paired treated attacks.';
  const gap = 'Onset of symptom relief occurred significantly faster with deucrictibant than placebo, with median times of 1.28 h (95% CI 1.05 to 1.52) and more than 12 h (p<0.0001).';
  const short = 'Oral deucrictibant provided faster times to symptom relief than placebo and was generally well tolerated.';
  const meaning = 'These results support the use of deucrictibant as potentially the first orally administered antagonist and may address an unmet need for convenient treatment.';
  const picks = resolveQuotePicks([bg, aim, census, gap, short, meaning].join(' '), []);
  const blob = picks.map(p => p.en).join(' ');
  assert.match(blob, /more than 12 h/);
  assert.match(blob, /first orally administered/);
  assert.doesNotMatch(blob, /remain scant|generally well tolerated|These results support the use/);
  assert.ok(picks.length >= 2 && picks.length <= 4);
  for (const p of picks) assert.ok(wordCountOk(p.en), p.en);
});

test('a model pick of a census sentence is replaced by the surprising line', () => {
  const bg = 'Oral treatments that stop an attack quickly remain scant.';
  const plain = 'Symptom relief was significantly faster with the study drug than placebo.';
  const clutter = 'Onset of symptom relief occurred significantly faster with the study drug than placebo, with median times of 1.28 h (95% CI 1.05 to 1.52) and more than 12 h (5.82 to more than 12) (p<0.0001).';
  const meaning = 'These results support the use of the study drug as an oral treatment for attacks.';
  const picks = resolveQuotePicks([bg, clutter, plain, meaning].join(' '), [
    { i: 0, zh: '不该用背景' },
  ]);
  const blob = picks.map(p => p.en).join(' ');
  assert.match(blob, /more than 12 h|significantly faster/);
  assert.doesNotMatch(blob, /remain scant|These results support the use/);
  assert.equal(picks.some(p => /不该用背景/.test(p.zh)), false);
});

test('a mechanism window keeps a trailing receptor phrase inside the word budget', () => {
  const sentence = 'At wounds, where oxidative stress and NADP + are high, 5-oxo-eicosatetraenoic acid (5-oxoETE) production by DHRS7 rapidly alerts antimicrobial white blood cells through the G-protein-coupled receptor OXER1.';
  const excerpt = excerptQuote(sentence, 'mechanism');
  assert.match(excerpt, /receptor OXER1/);
  assert.doesNotMatch(excerpt, /G-protein-coupled…$/);
  assert.ok(sentence.includes(quoteCore(excerpt)), excerpt);
  assert.ok(wordCountOk(excerpt), excerpt);
});

test('omission marks are a single ellipsis character', () => {
  const sentence = 'Here, we report that loss of Gimap6 in mice causes inflammatory vasculopathy and accelerated atherosclerosis in the absence of hyperlipidemia and without any change in circulating cholesterol.';
  const excerpt = excerptQuote(sentence, '');
  assert.match(excerpt, /^…/);
  assert.equal(excerpt.includes('...'), false);
  assert.match(excerpt, /in the absence of hyperlipidemia/);
  assert.ok(wordCountOk(excerpt), excerpt);
});

test('open-access full text keeps Results and Discussion only', () => {
  const xml = `<article><body>
    <sec disp-level="1"><title>Methods</title><p>Participants were enrolled.</p></sec>
    <sec disp-level="1"><title>Results</title><p>Loss of the gene caused disease in the absence of the usual risk factor.</p></sec>
    <sec disp-level="1"><title>Discussion</title><p>The finding challenges the assumption that the risk factor is required.</p></sec>
    </body><back><sec disp-level="1"><title>Results</title><p>This reference list is not the paper.</p></sec></back></article>`;
  const text = extractPassages(xml);
  assert.match(text, /in the absence of the usual risk factor/);
  assert.match(text, /challenges the assumption/);
  assert.doesNotMatch(text, /Participants were enrolled|reference list/);
});

test('quote JSON parser reads indexes', () => {
  const parsed = parseQuoteResponse('```json\n{"quotes":[{"i":1,"zh":"甲"}]}\n```');
  assert.deepEqual(parsed, [{ i: 1, role: '', en: '', zh: '甲' }]);
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
  assert.ok(data.quotes.length >= 1 && data.quotes.length <= 4);
  for (const q of data.quotes) assert.ok(abstract.includes(quoteCore(q.en)), q.en);
  const first = data.quotes.find(q => quoteCore(q.en) && sentences[0].includes(quoteCore(q.en)) && /durvalumab/i.test(q.en));
  assert.ok(first);
  assert.match(first.zh, /durvalumab/);
  assert.doesNotMatch(first.zh, /\[D1\]/);
  assert.equal(data.quotes.some(q => /编造|invented/.test(q.en + q.zh)), false);
  assert.ok(calls >= 1);
});

test('a trial-design subtitle is removed and a scientific subtitle stays', () => {
  const src = readFileSync(new URL('../../assets/share-card.js', import.meta.url), 'utf8');
  const start = src.indexOf('function isDesignSubtitle');
  const end = src.indexOf('function cwrap');
  const { trimDesignSubtitle } = new Function(src.slice(start, end) + '\nreturn { trimDesignSubtitle };')();
  const lancet = 'Oral deucrictibant for on-demand treatment of hereditary angioedema attacks: a phase 3, multicentre, randomised, double-blind, placebo-controlled crossover trial.';
  assert.equal(trimDesignSubtitle(lancet), 'Oral deucrictibant for on-demand treatment of hereditary angioedema attacks');
  const resolve = '8 weeks versus 12 weeks of sofosbuvir-velpatasvir for treatment-naive, non-cirrhotic, chronic hepatitis C (RESOLVE): a multicentre, open-label, non-inferiority, randomised controlled trial in India.';
  assert.match(trimDesignSubtitle(resolve), /\(RESOLVE\)$/);
  assert.doesNotMatch(trimDesignSubtitle(resolve), /randomised/);
  const kept = "Nutritional interventions' effects on human milk composition: three trials in resource-limited settings.";
  assert.equal(trimDesignSubtitle(kept), kept);
  assert.equal(trimDesignSubtitle('Immunoregulatory gene GIMAP6 suppresses lethal disease.'), 'Immunoregulatory gene GIMAP6 suppresses lethal disease.');
  const hpv = 'Quadrivalent human papillomavirus vaccination before pregnancy and pregnancy outcomes: nationwide, population based case-control study.';
  assert.equal(trimDesignSubtitle(hpv), 'Quadrivalent human papillomavirus vaccination before pregnancy and pregnancy outcomes');
  const cohort = 'Air pollution and asthma admissions: a nationwide population-based cohort study.';
  assert.equal(trimDesignSubtitle(cohort), 'Air pollution and asthma admissions');
  const review = 'Vitamin D and fracture risk: systematic review and meta-analysis.';
  assert.equal(trimDesignSubtitle(review), 'Vitamin D and fracture risk');
});

test('an open-access flag is true only for Y or a Creative Commons license', () => {
  const src = readFileSync(new URL('../../assets/app.js', import.meta.url), 'utf8');
  const start = src.indexOf('function isOpenAccessFlag');
  const end = src.indexOf('async function publisherRecord');
  const { isOpenAccessFlag, licenseIsOpen, reliableVolume, reliablePages } = new Function(
    src.slice(start, end) + '\nreturn { isOpenAccessFlag, licenseIsOpen, reliableVolume, reliablePages };',
  )();
  assert.equal(isOpenAccessFlag('Y'), true);
  assert.equal(isOpenAccessFlag('N'), false);
  assert.equal(isOpenAccessFlag(''), false);
  assert.equal(isOpenAccessFlag(true), true);
  assert.equal(licenseIsOpen([{ URL: 'http://creativecommons.org/licenses/by-nc/4.0/' }]), true);
  assert.equal(licenseIsOpen([{ URL: 'https://doi.org/10.1136/bmj-2026-100739' }]), false);
  assert.equal(reliableVolume('395', '395'), '395');
  assert.equal(reliableVolume('395', '380'), '');
  assert.equal(reliableVolume('395'), '395');
  assert.equal(reliableVolume(''), '');
  assert.equal(reliablePages('e100739'), 'e100739');
  assert.equal(reliablePages('1455-1472'), '1455-1472');
  assert.equal(reliablePages('6792-6809.e21'), '6792-6809.e21');
  assert.equal(reliablePages('S0140-6736(26)01296-1'), '');
});

test('the main result is first and a repeated younger-age claim is not quoted twice', () => {
  const lower = 'After adjustment for confounders, quadrivalent human papillomavirus vaccination was associated with lower odds of all included adverse pregnancy outcomes.';
  const ages = 'Risk reduction was generally more pronounced among women vaccinated at younger ages.';
  const again = 'Quadrivalent human papillomavirus vaccination before pregnancy was associated with a lower risk of adverse pregnancy outcomes, particularly among women vaccinated at earlier ages, extending benefits of human papillomavirus vaccination beyond cancer prevention.';
  const picks = resolveQuotePicks([lower, ages, again].join(' '), []);
  assert.match(picks[0].en, /lower odds of all included adverse pregnancy outcomes/);
  const ageLines = picks.filter(p => /younger ages|earlier ages|more pronounced|particularly among/i.test(p.en));
  assert.equal(ageLines.length, 1);
  assert.match(picks.map(p => p.en).join(' '), /beyond cancer prevention/);
  for (const p of picks) assert.ok(wordCountOk(p.en), p.en);
});

test('a trial card keeps one worded efficacy line ahead of adverse events', () => {
  const agonist = 'Retatrutide is an agonist of GIP, GLP-1, and glucagon receptors, and is currently under investigation for the treatment of obesity and type 2 diabetes.';
  const weight = 'For the treatment regimen estimand, the mean percentage change from baseline in bodyweight at week 80 was -18.8% with retatrutide 12 mg and -5.1% with placebo.';
  const gi = 'Gastrointestinal adverse events were more common in the retatrutide groups than in the placebo group.';
  const hypo = 'Hypotension and dysesthesia were more frequent with retatrutide than with placebo.';
  const efficacy = 'Treatment with retatrutide resulted in substantial improvements in bodyweight and was associated with improvements in glycaemic control in participants with obesity and type 2 diabetes, with a safety profile generally consistent with other molecules with GLP-1 receptor agonism.';
  const picks = resolveQuotePicks([agonist, weight, gi, hypo, efficacy].join(' '), [
    { i: 2, zh: '不良反应' },
    { i: 3, zh: '低血压' },
  ]);
  assert.match(picks[0].en, /substantial improvements in bodyweight/);
  assert.match(picks[0].en, /glycaemic control/);
  assert.match(picks.map(p => p.en).join(' '), /[Hh]ypotension|adverse events/);
  assert.equal(picks.filter(p => /bodyweight/i.test(p.en)).length, 1);
  for (const p of picks) assert.ok(wordCountOk(p.en), p.en);
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
