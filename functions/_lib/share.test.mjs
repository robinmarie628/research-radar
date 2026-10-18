import test from 'node:test';
import assert from 'node:assert/strict';

function piecesOf(en) {
  return String(en || '').split(' … ').map(part => part.replace(/…/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
}
function quoteCore(en) {
  return piecesOf(en)[0] || '';
}
function wordCountOk(en) {
  const parts = piecesOf(en);
  return parts.length > 0 && parts.every(part => {
    const n = part.split(/\s+/).filter(Boolean).length;
    return n >= 1 && n <= 48;
  });
}
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  splitSentences, findVerbatim, pickHeuristic, resolveQuotePicks, parseQuoteResponse,
  isDenseMethods, isBoilerplate, excerptQuote,
} from './quotes.js';
import { handleTranslate, __setMtResources } from '../api/translate.js';
import { extractPassages, extractHtmlPassages, openAccessPassages } from './fulltext.js';
import { isTranslatedZh } from './mt.js';

const require = createRequire(import.meta.url);
const cite = require('../../assets/cite.js');

const ABSTRACT = 'Patients with heart failure had a higher risk of readmission. Methods included a cohort of 400 adults followed for two years. Thus, early review of volume status reduced mortality compared with usual care. A further sentence about laboratory methods is not the point of the paper.';

test('a lowercase acronym still starts a new sentence', () => {
  const parts = splitSentences('Replay of SWA induces sleep. dFBNs generate SWA throughout the cycle despite antagonism with dopaminergic neurons.');
  assert.equal(parts.length, 2);
  assert.match(parts[0], /induces sleep/);
  assert.match(parts[1], /^dFBNs generate/);
});

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
    for (const core of piecesOf(p.en)) assert.ok(ABSTRACT.includes(core), p.en);
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
  assert.equal(picks.some(p => piecesOf(p.en).some(core => finding.includes(core))), true);
  for (const p of picks) for (const core of piecesOf(p.en)) assert.ok(abstract.includes(core), p.en);
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

test('the gold card keeps the paradox, the contrast, and the broader sentence', () => {
  const abstract = 'Controlling hyperlipidemia has reduced but not eliminated atherosclerotic cardiovascular disease as a major cause of human mortality. Thus, GIMAP6 is a crucial safeguard for vascular integrity independently of systemic hyperlipidemia.';
  const paradox = 'Despite advances in lipid-lowering therapy, atherosclerotic cardiovascular disease (ASCVD) remains a leading cause of death worldwide, with many events occurring in individuals with normal blood lipid or low-density lipoprotein (LDL) levels due to non-lipid vascular risk factors.';
  const reframe = 'Thus, GIMAP6 functions as a distinct cardiovascular disease determinant that protects the endothelial structural integrity and controls the threshold for macrophage response to lipid, rather than systemic lipid levels themselves.';
  const broad = 'More broadly, GIMAP6 reveals how immune-regulatory failure can couple endothelial dysfunction, foam-cell formation, and inflammation into a self-reinforcing cascade that culminates in lethal ischemic cardiovascular disease.';
  const aim = 'We investigated the efficacy and safety of GIMAP6 loss in mice fed a standard diet.';
  const picks = resolveQuotePicks([abstract, aim, paradox, reframe, broad].join(' '), []);
  assert.equal(picks.length, 3);
  assert.equal(picks.map(p => p.role).join(','), 'background,finding,significance');
  assert.match(picks[0].en, /^…with many events occurring/);
  assert.match(picks[0].en, /non-lipid vascular risk factors/);
  assert.match(picks[1].en, /^Thus, GIMAP6 functions as a distinct/);
  assert.match(picks[1].en, /rather than systemic lipid levels themselves/);
  assert.match(picks[2].en, /^More broadly, GIMAP6 reveals/);
  assert.match(picks[2].en, /self-reinforcing cascade/);
  assert.equal(picks.some(p => p.role === 'studied' || /We investigated/.test(p.en)), false);
  for (const p of picks) {
    assert.ok(wordCountOk(p.en), p.en);
    assert.equal(p.en.includes('...'), false);
  }
});

test('a trial card skips the aim sentence and prefers a worded result over the confidence interval', () => {
  const bg = 'In hereditary angioedema, oral on-demand treatments that provide rapid relief remain scant.';
  const aim = 'We investigated the efficacy and safety of deucrictibant for on-demand treatment of attacks.';
  const census = 'The primary efficacy analysis included 88 participants with paired treated attacks.';
  const gap = 'Onset of symptom relief occurred significantly faster with deucrictibant than placebo, with median times of 1.28 h (95% CI 1.05 to 1.52) and more than 12 h (p<0.0001).';
  const short = 'Oral deucrictibant provided faster times to symptom relief than placebo and was generally well tolerated.';
  const meaning = 'These results support the use of deucrictibant as potentially the first orally administered antagonist and may address an unmet need for convenient treatment.';
  const picks = resolveQuotePicks([bg, aim, census, gap, short, meaning].join(' '), []);
  const blob = picks.map(p => p.en).join(' ');
  assert.match(picks.find(p => p.role === 'background').en, /remain scant/);
  assert.match(picks.find(p => p.role === 'finding').en, /faster times to symptom relief/);
  assert.match(picks.find(p => p.role === 'significance').en, /first orally administered/);
  assert.doesNotMatch(blob, /We investigated|95% CI|primary efficacy analysis/);
  assert.equal(picks.some(p => p.role === 'studied'), false);
  assert.ok(picks.length >= 3 && picks.length <= 4);
  for (const p of picks) assert.ok(wordCountOk(p.en), p.en);
});

test('a model pick of a census sentence is replaced by the surprising line', () => {
  const bg = 'Oral treatments that stop an attack quickly remain scant.';
  const plain = 'Symptom relief was significantly faster with the study drug than placebo.';
  const clutter = 'Onset of symptom relief occurred significantly faster with the study drug than placebo, with median times of 1.28 h (95% CI 1.05 to 1.52) and more than 12 h (5.82 to more than 12) (p<0.0001).';
  const meaning = 'These results support the use of the study drug as an oral treatment for attacks.';
  const picks = resolveQuotePicks([bg, clutter, plain, meaning].join(' '), [
    { i: 99, zh: '不该用背景' },
  ]);
  const blob = picks.map(p => p.en).join(' ');
  assert.match(blob, /more than 12 h|significantly faster/);
  assert.match(picks.find(p => p.role === 'background').en, /remain scant/);
  assert.match(blob, /significantly faster/);
  assert.doesNotMatch(blob, /95% CI/);
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

test('publisher HTML keeps Introduction and Discussion and drops the reference list', () => {
  const html = `<article><h2>Introduction</h2><p>Despite advances in therapy, many events still occur in people with normal risk markers because the usual explanation is incomplete and leaves a clinical paradox unresolved for the reader.</p><h2>Methods</h2><p>Participants were enrolled at twelve hospitals and followed with a protocol that is not a quotation.</p><h2>Discussion</h2><p>Thus, the gene functions as a distinct determinant of the disease rather than a marker of the exposure itself in this cohort of adults.</p><h2>References</h2><p>Smith et al. reported something else entirely in another journal last year.</p></article>`;
  const text = extractHtmlPassages(html);
  assert.match(text, /clinical paradox unresolved/);
  assert.match(text, /rather than a marker/);
  assert.doesNotMatch(text, /Participants were enrolled|Smith et al/);
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
  for (const q of data.quotes) for (const core of piecesOf(q.en)) assert.ok(abstract.includes(core), q.en);
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

test('the share card keeps a delayed-treatment subtitle that would otherwise wrap past two lines', () => {
  const src = readFileSync(new URL('../../assets/share-card.js', import.meta.url), 'utf8');
  const start = src.indexOf('function contrastTitleTail');
  const end = src.indexOf('function textInk');
  const { chooseTitleZh } = new Function(src.slice(start, end) + '\nreturn { chooseTitleZh };')();
  const amd = '美国常规临床实践中新生血管性年龄相关性黄斑变性的管理：延迟治疗启动的影响';
  assert.equal(chooseTitleZh(amd, 3, 2), amd);
  assert.match(chooseTitleZh(amd, 4, 2), /延迟治疗/);
  const design = '中国多药耐药热带念珠菌的区域扩展和适应性进化：一项回顾性多中心基因组研究';
  assert.equal(chooseTitleZh(design, 3, 2), '中国多药耐药热带念珠菌的区域扩展和适应性进化');
  assert.equal(chooseTitleZh(amd, 2, 1), amd);
});

test('the client puts a dropped delayed-treatment clause back onto a cached title', () => {
  const src = readFileSync(new URL('../../assets/app.js', import.meta.url), 'utf8');
  const start = src.indexOf('function stripTitleStop');
  const end = src.indexOf('/* ---------------- abstract section headings');
  const { preserveTitleContrast } = new Function(src.slice(start, end) + '\nreturn { preserveTitleContrast };')();
  const en = 'Management of Neovascular Age-Related Macular Degeneration in Routine US Clinical Practice: Impact of Delayed Treatment Initiation.';
  const short = '美国常规临床实践中新生血管性年龄相关性黄斑变性的管理';
  const full = '美国常规临床实践中新生血管性年龄相关性黄斑变性的管理：延迟治疗启动的影响';
  assert.equal(preserveTitleContrast(en, short), full);
  assert.equal(preserveTitleContrast(en, full), full);
  assert.equal(
    preserveTitleContrast('Initial sepsis care: early versus late treatment initiation', '脓毒症治疗'),
    '脓毒症治疗：早期与晚期开始治疗',
  );
});

test('the share-card title drops a trailing Chinese full stop', () => {
  const src = readFileSync(new URL('../../assets/app.js', import.meta.url), 'utf8');
  const start = src.indexOf('function stripTitleStop');
  const end = src.indexOf('function stripTitleMeta');
  const { stripTitleStop, stripTitleMeta } = new Function(
    src.slice(start, end) + src.slice(end, src.indexOf('/* ---------------- abstract section headings')) + '\nreturn { stripTitleStop, stripTitleMeta };',
  )();
  const eye = '非动脉性前部缺血性视神经病变中的前层高反射线。';
  assert.equal(stripTitleStop(eye), '非动脉性前部缺血性视神经病变中的前层高反射线');
  assert.equal(stripTitleMeta(eye), '非动脉性前部缺血性视神经病变中的前层高反射线');
  assert.equal(stripTitleMeta('前层高反射线（ASCVD）。'), '前层高反射线（ASCVD）');
});

test('an open-access flag is true only for Y or a Creative Commons license', () => {
  const src = readFileSync(new URL('../../assets/app.js', import.meta.url), 'utf8');
  const start = src.indexOf('function isOpenAccessFlag');
  const end = src.indexOf('async function publisherRecord');
  const { isOpenAccessFlag, licenseIsOpen, licenseName, publishedOnline, reliableVolume, reliablePages } = new Function(
    src.slice(start, end) + '\nreturn { isOpenAccessFlag, licenseIsOpen, licenseName, publishedOnline, reliableVolume, reliablePages };',
  )();
  assert.equal(isOpenAccessFlag('Y'), true);
  assert.equal(isOpenAccessFlag('N'), false);
  assert.equal(isOpenAccessFlag(''), false);
  assert.equal(isOpenAccessFlag(true), true);
  assert.equal(licenseIsOpen([{ URL: 'http://creativecommons.org/licenses/by-nc/4.0/' }]), true);
  assert.equal(licenseIsOpen([{ URL: 'https://doi.org/10.1136/bmj-2026-100739' }]), false);
  assert.equal(licenseName([{ URL: 'http://creativecommons.org/licenses/by-nc-nd/4.0/' }]), 'CC BY-NC-ND 4.0');
  assert.equal(licenseName([{ URL: 'https://creativecommons.org/licenses/by/4.0' }]), 'CC BY 4.0');
  assert.equal(publishedOnline({ 'published-online': { 'date-parts': [[2026, 10, 7]] } }), true);
  assert.equal(publishedOnline({
    'published-print': { 'date-parts': [[2026, 10]] },
    created: { 'date-parts': [[2026, 10, 8]] },
  }), true);
  assert.equal(publishedOnline({ 'published-print': { 'date-parts': [[2026, 10, 15]] } }), false);
  assert.equal(reliableVolume('395', '395'), '395');
  assert.equal(reliableVolume('395', '380'), '');
  assert.equal(reliableVolume('395'), '395');
  assert.equal(reliableVolume(''), '');
  assert.equal(reliablePages('e100739'), 'e100739');
  assert.equal(reliablePages('1455-1472'), '1455-1472');
  assert.equal(reliablePages('6792-6809.e21'), '6792-6809.e21');
  assert.equal(reliablePages('S0140-6736(26)01296-1'), '');
});

test('a weaker model hint does not replace the contrast sentence', () => {
  const reframe = 'Thus, GIMAP6 functions as a distinct cardiovascular disease determinant that protects the endothelial structural integrity and controls the threshold for macrophage response to lipid, rather than systemic lipid levels themselves.';
  const human = 'Human hypomorphic GIMAP6 variants, including the V65I allele, are associated with altered monocyte redox balance and early ASCVD.';
  const broad = 'More broadly, GIMAP6 reveals how immune-regulatory failure can couple endothelial dysfunction, foam-cell formation, and inflammation into a self-reinforcing cascade that culminates in lethal ischemic cardiovascular disease.';
  const picks = resolveQuotePicks([human, reframe, broad].join(' '), [
    { i: 0, role: 'finding', zh: '不该当主结果' },
  ]);
  assert.match(picks.find(p => p.role === 'finding').en, /rather than systemic lipid levels themselves/);
  assert.equal(picks.some(p => /不该当主结果/.test(p.zh)), false);
});

test('the main result and the beyond-cancer sentence are different quotes', () => {
  const lower = 'After adjustment for confounders, quadrivalent human papillomavirus vaccination was associated with lower odds of all included adverse pregnancy outcomes.';
  const ages = 'Risk reduction was generally more pronounced among women vaccinated at younger ages.';
  const again = 'Quadrivalent human papillomavirus vaccination before pregnancy was associated with a lower risk of adverse pregnancy outcomes, particularly among women vaccinated at earlier ages, extending benefits of human papillomavirus vaccination beyond cancer prevention.';
  const aim = 'To evaluate the association between quadrivalent human papillomavirus vaccination before pregnancy and subsequent risk of adverse pregnancy outcomes.';
  const picks = resolveQuotePicks([aim, lower, ages, again].join(' '), []);
  const found = picks.find(p => p.role === 'finding');
  assert.match(found.en, /lower odds of all included adverse pregnancy outcomes/);
  assert.doesNotMatch(found.en, /beyond cancer|younger ages/);
  assert.match(picks.find(p => p.role === 'significance').en, /beyond cancer prevention/);
  assert.equal(picks.some(p => /To evaluate/.test(p.en)), false);
  const ageLines = picks.filter(p => /younger ages|earlier ages|more pronounced/i.test(p.en));
  assert.ok(ageLines.length <= 1);
  for (const p of picks) assert.ok(wordCountOk(p.en), p.en);
});

test('a trial card keeps the worded benefit and can add a striking adverse event beside it', () => {
  const agonist = 'Retatrutide is an agonist of GIP, GLP-1, and glucagon receptors, and is currently under investigation for the treatment of obesity and type 2 diabetes.';
  const weight = 'For the treatment regimen estimand, the mean percentage change from baseline in bodyweight at week 80 was -18.8% with retatrutide 12 mg and -5.1% with placebo.';
  const gi = 'Gastrointestinal adverse events were more common in the retatrutide groups than in the placebo group.';
  const hypo = 'Hypotension and dysesthesia were more frequent with retatrutide than with placebo.';
  const efficacy = 'Treatment with retatrutide resulted in substantial improvements in bodyweight and was associated with improvements in glycaemic control in participants with obesity and type 2 diabetes, with a safety profile generally consistent with other molecules with GLP-1 receptor agonism.';
  const hedged = 'These results show that retatrutide might be effective for the treatment of obesity.';
  const picks = resolveQuotePicks([agonist, weight, gi, hypo, efficacy, hedged].join(' '), [
    { i: 2, zh: '不良反应' },
    { i: 3, zh: '低血压' },
  ]);
  const found = picks.find(p => p.role === 'finding');
  assert.match(found.en, /substantial improvements in bodyweight/);
  assert.match(found.en, /glycaemic control/);
  assert.match(picks.find(p => p.role === 'background').en, /currently under investigation/);
  assert.equal(picks.filter(p => /substantial improvements in bodyweight/i.test(p.en)).length, 1);
  assert.equal(picks.some(p => /might be effective/.test(p.en)), false);
  const adverse = picks.find(p => p.role === 'secondary');
  assert.match(adverse.en, /Hypotension and dysesthesia were more frequent/);
  assert.doesNotMatch(adverse.en, /\[5%\]|12 mg group/);
  for (const p of picks) assert.ok(wordCountOk(p.en), p.en);
});

test('the sleep-pressure abstract yields three separate sentences', () => {
  const abs = [
    'Changes in oscillatory neural dynamics reflect—but may not necessarily determine—transitions between sleep stages and variations in sleep pressure.',
    'Here we show that sleep-control neurons innervating the dorsal fan-shaped body of Drosophila (dFBNs) produce slow-wave activity (SWA) that is causally linked to sleep.',
    'The oscillations rely on interhemispheric competition of two half-centers connected by inhibitory glutamatergic synapses.',
    'dFBN-restricted interference with glutamate release disrupts SWA and baseline as well as rebound sleep, whereas the optogenetic replay of SWA induces sleep.',
    'dFBNs generate SWA throughout the sleep-wake cycle (despite mutual antagonism with arousing dopaminergic neurons) and adjust its power to sleep need via sleep history-dependent increases in excitability and homeostatic synaptic depression.',
    'The oscillatory format permits a continuous encoding of sleep pressure but requires mechanisms that convert the amplitude-modulated signal into binary sleep-wake states.',
  ].join(' ');
  const picks = resolveQuotePicks(abs, []);
  assert.equal(picks.length, 3);
  const blob = picks.map(p => p.en).join('\n');
  assert.match(blob, /optogenetic replay of SWA induces sleep/);
  assert.match(blob, /despite mutual antagonism/);
  assert.equal(picks.some(p => /replay of SWA induces sleep\.\s+dFBNs/.test(p.en)), false);
  for (const p of picks) {
    assert.equal((p.en.match(/\. /g) || []).length <= 1, true, p.en);
    assert.ok(wordCountOk(p.en), p.en);
  }
});

test('the Neuron mind abstract is only two sentences, so the card does not invent a third', () => {
  const abstract = 'Artificial intelligence is starting to automate scientific discovery, raising the prospect of an automated science of the mind. We chart this field around four challenges: representing experiments, generating synthetic behavior, synthesizing models, and closing the loop to discover psychological theories.';
  assert.equal(splitSentences(abstract).length, 2);
  const picks = resolveQuotePicks(abstract, []);
  assert.equal(picks.length, 2);
  for (const p of picks) {
    for (const core of piecesOf(p.en)) assert.ok(abstract.includes(core), p.en);
  }
});

test('a paywalled journal article is not quoted from its arXiv preprint', async () => {
  const doi = '10.1016/j.neuron.2026.09.012';
  const calls = [];
  const fetchImpl = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes('europepmc')) {
      return {
        ok: true,
        json: async () => ({ resultList: { result: [{ doi, isOpenAccess: 'N' }] } }),
        text: async () => '',
      };
    }
    if (href.includes('unpaywall')) {
      return {
        ok: true,
        json: async () => ({
          is_oa: true,
          oa_status: 'green',
          journal_is_oa: false,
          oa_locations: [{
            host_type: 'repository',
            version: 'submittedVersion',
            url: 'https://arxiv.org/pdf/2603.20988',
            license: 'cc-by',
          }],
        }),
        text: async () => '',
      };
    }
    throw new Error('unexpected fetch ' + href);
  };
  const oa = await openAccessPassages(doi, fetchImpl);
  assert.equal(oa.status, 'closed');
  assert.equal(oa.text, '');
  assert.equal(calls.some(href => /arxiv|sciencedirect|cell\.com/i.test(href)), false);
});

test('a short abstract with no gold-style sentence still returns quotes', () => {
  const abstract = 'Methods We conducted a prospective cohort study. Results Antidepressant treatment was associated with QTc prolongation and early major adverse cardiovascular events. Conclusions Clinicians should monitor electrocardiograms when initiating treatment.';
  const picks = resolveQuotePicks(abstract, []);
  assert.ok(picks.length >= 2 && picks.length <= 4);
  assert.match(picks.map(p => p.en).join(' '), /associated with QTc prolongation/);
  assert.match(picks.map(p => p.en).join(' '), /Clinicians should monitor electrocardiograms/);
  assert.equal(picks.some(p => /We conducted a prospective cohort study/.test(p.en)), false);
  for (const p of picks) {
    for (const core of piecesOf(p.en)) assert.ok(abstract.includes(core), p.en);
    assert.ok(wordCountOk(p.en), p.en);
  }
});

test('a structured QTc abstract is quoted from the worded result, not the aim or the interval', () => {
  const aim = 'To compare the effect of specific antidepressants with placebo on heart rate corrected QT interval (QTc) during the first eight weeks of treatment for major depressive disorder in adults, and to investigate whether antidepressant use is associated with early major cardiovascular adverse events (MACE).';
  const method = 'The primary outcome was changes in QTc Fridericia (QTcF) associated with specific antidepressants and placebo after taking into account modifiable and non-modifiable risk factors.';
  const interval = 'Compared with placebo, escitalopram and amitriptyline were associated with increased QTc intervals (8.7 milliseconds (ms), 95% credibility interval (CrI) 1.6 to 15.8, and 5.3 ms, 0.8 to 9.8, respectively).';
  const differed = 'The effect of specific antidepressants on QTc interval differed between adults with depression.';
  const mace = 'No evidence associated antidepressant use with early MACE and non-suicidal sudden death.';
  const decision = 'To support shared decision making and taking into account the trade-off between benefits and harms, individual modifiable and non-modifiable risk factors should be considered when choosing antidepressants.';
  const abstract = [aim, method, interval, differed, mace, decision].join(' ');
  const picks = resolveQuotePicks(abstract, []);
  const blob = picks.map(p => p.en).join(' ');
  assert.match(blob, /QTc interval differed between adults with depression/);
  assert.match(blob, /No evidence associated antidepressant use with early MACE/);
  assert.match(blob, /should be considered when choosing antidepressants/);
  assert.doesNotMatch(blob, /To compare the effect|95% credibility|primary outcome was/);
  for (const p of picks) for (const core of piecesOf(p.en)) assert.ok(abstract.includes(core), p.en);
});

test('an echoed English sentence is not a Chinese translation', () => {
  const en = 'To support shared decision making and taking into account the trade-off between benefits and harms, individual modifiable and non-modifiable risk factors should be considered when choosing antidepressants.';
  assert.equal(isTranslatedZh(en, en), false);
  assert.equal(isTranslatedZh(en, '为了支持共同决策并权衡益处与危害，选择抗抑郁药时应考虑个体可改变和不可改变的风险因素。'), true);
  assert.equal(isTranslatedZh('The effect differed.', '特定抗抑郁药对QTc间期的影响在抑郁症成人中有所不同。'), true);
});

test('quotes mode translates a line again when the model copies the English', async () => {
  __setMtResources({ glossary: [], overrides: [] });
  const finding = 'The effect of specific antidepressants on QTc interval differed between adults with depression.';
  const meaning = 'To support shared decision making and taking into account the trade-off between benefits and harms, individual modifiable and non-modifiable risk factors should be considered when choosing antidepressants.';
  const abstract = finding + ' ' + meaning;
  let calls = 0;
  const env = {
    AI: {
      async run(_model, payload) {
        calls++;
        const user = payload.messages[1].content.replace(/^\/no_think\n/, '');
        if (user.includes('[0]')) {
          return { response: JSON.stringify({ quotes: [
            { role: 'finding', i: 0, zh: '特定抗抑郁药对QTc间期的影响在抑郁症成人中有所不同。' },
            { role: 'significance', i: 1, zh: meaning },
          ] }) };
        }
        const arr = JSON.parse(user);
        if (calls === 2) return { response: JSON.stringify(arr) };
        return { response: JSON.stringify(arr.map(() => '为了支持共同决策并权衡益处与危害，选择抗抑郁药时应考虑个体可改变和不可改变的风险因素。')) };
      },
    },
  };
  const res = await handleTranslate(new Request('https://research-radar-f5j.pages.dev/api/translate', {
    method: 'POST',
    headers: { Origin: 'https://research-radar-f5j.pages.dev', 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'quotes', doi: '10.1/test', id: 'qtc', abstract }),
  }), env);
  assert.equal(res.status, 200);
  const data = await res.json();
  const line = data.quotes.find(q => /shared decision/.test(q.en));
  assert.ok(line);
  assert.match(line.zh, /共同决策/);
  assert.equal(line.zh.includes('shared decision'), false);
  assert.ok(calls >= 3);
});

test('quotes mode translates a plain abstract instead of returning 502', async () => {
  __setMtResources({ glossary: [], overrides: [] });
  const abstract = 'Methods We conducted a prospective cohort study. Results Antidepressant treatment was associated with QTc prolongation and early major adverse cardiovascular events. Conclusions Clinicians should monitor electrocardiograms when initiating treatment.';
  const env = {
    AI: {
      async run(_model, payload) {
        const user = payload.messages[1].content.replace(/^\/no_think\n/, '');
        if (user.includes('[0]')) return { response: '{"quotes":[]}' };
        const arr = JSON.parse(user);
        return { response: JSON.stringify(arr.map(() => '译文：抗抑郁治疗与QTc延长及早期主要心血管不良事件相关，开始治疗时应监测心电图。')) };
      },
    },
  };
  const res = await handleTranslate(new Request('https://research-radar-f5j.pages.dev/api/translate', {
    method: 'POST',
    headers: { Origin: 'https://research-radar-f5j.pages.dev', 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'quotes', doi: '10.1/test', id: 'test', abstract }),
  }), env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.quotes.length >= 2);
  assert.match(data.quotes.map(q => q.en).join(' '), /associated with QTc prolongation/);
  assert.match(data.quotes.map(q => q.zh).join(' '), /译文：/);
  assert.equal(data.quotes.every(q => q.en && q.zh), true);
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

test('a vertical pan scrolls the abstract and is not a tap that closes the card', () => {
  const src = readFileSync(new URL('../../assets/app.js', import.meta.url), 'utf8');
  const start = src.indexOf('function cardGestureMoved');
  const end = src.indexOf('function articleCard');
  const { cardGestureMoved, abstractPan } = new Function(
    src.slice(start, end) + '\nreturn { cardGestureMoved, abstractPan };',
  )();
  const origin = { x: 40, y: 200 };
  assert.equal(cardGestureMoved(origin, 42, 204), false);
  assert.equal(cardGestureMoved(origin, 40, 230), true);
  assert.equal(cardGestureMoved(null, 40, 230), false);

  const el = { scrollHeight: 480, clientHeight: 168, scrollTop: 0 };
  assert.equal(abstractPan(el, 12), false);
  assert.equal(el.scrollTop, 0);
  assert.equal(abstractPan(el, -20), true);
  assert.equal(el.scrollTop, 20);
  el.scrollTop = 480 - 168;
  assert.equal(abstractPan(el, -8), false);
  assert.equal(abstractPan(el, 15), true);
  assert.equal(el.scrollTop, 480 - 168 - 15);
  assert.equal(abstractPan({ scrollHeight: 100, clientHeight: 168, scrollTop: 0 }, -10), false);

  const css = readFileSync(new URL('../../assets/styles.css', import.meta.url), 'utf8');
  const sec = css.slice(css.indexOf('.sec-txt{'), css.indexOf('.sec-methods'));
  assert.match(sec, /overflow-y:auto/);
  assert.match(sec, /touch-action:pan-y/);
  assert.match(sec, /overscroll-behavior:contain/);
  const abs = css.slice(css.indexOf('.art-abstract{'), css.indexOf('.art-abstract::-webkit-scrollbar'));
  assert.match(abs, /touch-action:pan-y/);
  assert.match(abs, /overscroll-behavior:contain/);
});

test('text size slider stays between 100 and 150 and bold is a light step', () => {
  const src = readFileSync(new URL('../../assets/app.js', import.meta.url), 'utf8');
  const start = src.indexOf('function textPercent');
  const end = src.indexOf('function applyTextSize');
  const { textPercent, boldOn } = new Function(src.slice(start, end) + '\nreturn { textPercent, boldOn };')();
  assert.equal(textPercent(null), 100);
  assert.equal(textPercent('sm'), 100);
  assert.equal(textPercent('90'), 100);
  assert.equal(textPercent('md'), 110);
  assert.equal(textPercent('lg'), 120);
  assert.equal(textPercent('115'), 115);
  assert.equal(textPercent('140'), 140);
  assert.equal(textPercent('150'), 150);
  assert.equal(textPercent('180'), 150);
  assert.equal(boldOn(null), false);
  assert.equal(boldOn('0'), false);
  assert.equal(boldOn('1'), true);

  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="typeRange"[^>]*min="100"[^>]*max="150"/);
  assert.match(html, /id="boldBtn"/);
  assert.match(html, /rr\.bold\.v1/);
  assert.doesNotMatch(html, /data-step="md"/);

  const css = readFileSync(new URL('../../assets/styles.css', import.meta.url), 'utf8');
  assert.match(css, /html\{--read:1\}/);
  assert.doesNotMatch(css, /data-text="md"/);
  assert.match(css, /\.art-title\{[^}]*calc\(14px \* var\(--read\)\)/);
  assert.match(css, /\.sec-txt\{[^}]*calc\(12\.5px \* var\(--read\)\)/);
  const bold = css.slice(css.indexOf('html[data-bold]'), css.indexOf('html,body{height:100%}'));
  assert.match(bold, /\.sec-txt/);
  assert.match(bold, /font-weight:600/);
  assert.doesNotMatch(bold, /font-weight:800/);
  assert.doesNotMatch(bold, /\.art-title/);
  assert.doesNotMatch(bold, /\.sec-lab/);
  assert.doesNotMatch(bold, /\.chip/);
  assert.doesNotMatch(bold, /\.seg/);
  assert.doesNotMatch(bold, /\.badge/);
  const lab = css.slice(css.indexOf('.sec-lab{'), css.indexOf('.sec-txt{'));
  assert.match(lab, /font-size:10px/);
  assert.doesNotMatch(lab, /var\(--read\)/);
  const chip = css.slice(css.indexOf('.chip{'), css.indexOf('.chip .cnt'));
  assert.match(chip, /font-size:12\.5px/);
  assert.doesNotMatch(chip, /var\(--read\)/);
  const seg = css.slice(css.indexOf('.seg{'), css.indexOf('.seg.is-active'));
  assert.match(seg, /font-size:14px/);
  assert.doesNotMatch(seg, /var\(--read\)/);
});

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
