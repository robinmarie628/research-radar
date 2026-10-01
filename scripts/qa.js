/* QA harness for 科研雷达 — headless Edge via puppeteer-core.
 * Run:  NODE_PATH="C:/Users/Robin/.workbuddy/binaries/node/workspace/node_modules" \
 *       C:/Users/Robin/.workbuddy/binaries/node/versions/22.22.2/node.exe scripts/qa.js
 * Env:  QA_BASE (default http://127.0.0.1:8777/index.html), QA_SHOTS
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const BASE = process.env.QA_BASE || 'http://127.0.0.1:8777/index.html';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SHOT = process.env.QA_SHOTS || path.join(process.env.TEMP || '/tmp', 'rr-shots');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(SHOT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars'],
    defaultViewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  });
  const page = await browser.newPage();

  const errors = [];
  const warnings = [];
  page.on('console', m => {
    if (m.type() !== 'error') return;
    // "Failed to load resource" carries no URL and always duplicates a requestfailed
    // event, which the handler below classifies properly by host. Skip it here.
    if (/Failed to load resource/i.test(m.text())) return;
    if (/crossref/i.test(m.text())) warnings.push('CONSOLE ' + m.text().slice(0, 160));
    else errors.push('CONSOLE ' + m.text());
  });
  page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
  page.on('requestfailed', r => {
    const u = r.url(), t = r.failure()?.errorText || '';
    if (/ERR_INTERNET_DISCONNECTED/.test(t) && /beacon|analytics|gtag/.test(u)) return; // host gateway beacon
    if (/ERR_ABORTED/.test(t) && /europepmc|crossref|githubusercontent/.test(u)) return;
    if (/crossref/i.test(u)) { warnings.push('REQFAIL ' + u.slice(0, 90) + ' :: ' + t); return; }
    errors.push('REQFAIL ' + u.slice(0, 110) + ' :: ' + t);
  });

  const report = { base: BASE, errors, shots: [], checks: {} };
  const shot = async (name, opts = {}) => {
    const f = path.join(SHOT, name + '.png');
    await page.screenshot({ path: f, ...opts });
    report.shots.push(f);
    return f;
  };
  const overflow = () => page.evaluate(() => {
    const clipped = el => {
      let n = el.parentElement;
      while (n && n !== document.documentElement) {
        const cs = getComputedStyle(n);
        if (cs.overflowX === 'hidden' || cs.overflowX === 'clip' || cs.overflow === 'hidden') return true;
        n = n.parentElement;
      }
      return false;
    };
    const bad = [];
    document.querySelectorAll('body *').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > innerWidth + 1.5 || r.left < -1.5)) {
        const cs = getComputedStyle(el);
        if (cs.position === 'fixed' || clipped(el)) return;
        bad.push({ tag: el.tagName, cls: String(el.className).slice(0, 50),
                   left: Math.round(r.left), right: Math.round(r.right) });
      }
    });
    return { docW: document.documentElement.scrollWidth, win: innerWidth, bad };
  });

  console.log('→ loading', BASE);
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(
    () => window.__rr && window.__rr.jr && window.__rr.jr.loaded && window.__rr.jr.all.length > 0,
    { timeout: 90000, polling: 500 }).catch(() => {});
  await sleep(1200);

  /* ---- state ---- */
  report.state = await page.evaluate(() => ({
    journals: window.__rr.jr.all.length,
    picks: window.__rr.jr.picks.length,
    picksBasic: window.__rr.jr.picks.filter(p => p.basic).length,
    picksClinical: window.__rr.jr.picks.filter(p => !p.basic).length,
    err: window.__rr.jr.error,
    updated: window.__rr.jr.updated,
    domains: Object.fromEntries(Object.entries(window.__rr.jr.byKey)
      .filter(([k]) => k !== 'basic' && k !== 'clinical').map(([k, v]) => [k, v.length])),
    basic: (window.__rr.jr.byKey.basic || []).length,
    clinical: (window.__rr.jr.byKey.clinical || []).length,
    structured: window.__rr.jr.all.filter(a => a.structured).length,
    studies: Object.fromEntries(Object.entries(
      window.__rr.jr.all.reduce((m, a) => (m[a.studyZh] = (m[a.studyZh] || 0) + 1, m), {}))),
    cfg: window.__rr.cfg.length,
    gloss: window.__rr.gloss.length,
    cards: document.querySelectorAll('#researchCards .art').length,
    head: document.querySelector('#researchHead')?.textContent,
    sub: document.querySelector('#researchSub')?.textContent,
    litDate: document.querySelector('#litDate')?.textContent,
    verLabel: document.querySelector('#verLabel')?.textContent,
    verBtn: !!document.querySelector('#verBtn'),
    topPick: !!document.querySelector('#researchCards .art.top-pick'),
    ribbon: document.querySelector('.pick-ribbon')?.textContent,
    digestLoaded: window.__rr.digest.loaded,
    digestDate: window.__rr.digest.date,
    digestItems: window.__rr.digest.items.length,
    chips: [...document.querySelectorAll('#researchChips .chip')].map(c => c.textContent.trim()),
  }));
  console.log('  state:', JSON.stringify(report.state).slice(0, 900));

  report.checks.overflowResearch = await overflow();
  await shot('01-research-picks');

  /* ---- expand the top pick: structured sections ---- */
  await page.click('#researchCards .art');
  await sleep(700);
  report.checks.expanded = await page.evaluate(() => {
    const c = document.querySelector('#researchCards .art.open');
    const secs = [...(c?.querySelectorAll('.sec') || [])].map(s => ({
      lab: s.querySelector('.sec-lab')?.textContent,
      chars: (s.querySelector('.sec-txt')?.textContent || '').length,
    }));
    return {
      open: !!c,
      sections: secs,
      editorNote: [...(c?.querySelectorAll('.editor-note .en-row') || [])].map(r => ({
        lab: r.querySelector('.en-lab')?.textContent,
        chars: (r.querySelector('.en-txt')?.textContent || '').length,
      })),
      abstractFallback: (c?.querySelector('.art-abstract')?.textContent || '').length,
      rawToggle: !!c?.querySelector('.rawtoggle'),
      rawBoxHidden: c?.querySelector('.rawbox')?.hidden === true,
      links: [...(c?.querySelectorAll('.art-links .lnk') || [])].map(a => a.textContent.trim()),
      ckHref: c?.querySelector('.lnk.ck')?.getAttribute('href') || null,
      badges: [...(c?.querySelectorAll('.art-badges .badge') || [])].map(b => b.textContent.trim()),
      hasRawTag: /<[a-z/][^>]*>/i.test(c?.querySelector('.art-title')?.textContent || ''),
    };
  });
  console.log('  expanded:', JSON.stringify(report.checks.expanded).slice(0, 700));
  report.checks.titleZh = await page.evaluate(() => {
    const c = document.querySelector('#researchCards .art.open');
    const t = c?.querySelector('.art-title')?.textContent || '';
    return { text: t.slice(0, 60), isChinese: /[一-龥]/.test(t) };
  });
  console.log('  title:', JSON.stringify(report.checks.titleZh));
  await shot('02-research-expanded');

  /* ---- 点「查看英文原标题与摘要」不能把卡片折叠掉 ---- */
  await page.evaluate(() => {
    const t = document.querySelector('#researchCards .art.open .rawtoggle');
    if (t) t.click();
  });
  await sleep(700);
  report.checks.rawToggle = await page.evaluate(() => {
    const c = document.querySelector('#researchCards .art.open');
    return {
      cardStillOpen: !!c,
      rawVisible: c ? c.querySelector('.rawbox')?.hidden === false : null,
      hasEnTitle: !!c?.querySelector('.rawtitle .rawtitle-txt'),
      enTitleChars: (c?.querySelector('.rawtitle .rawtitle-txt')?.textContent || '').length,
      label: c?.querySelector('.rawtoggle')?.textContent,
    };
  });
  console.log('  raw toggle:', JSON.stringify(report.checks.rawToggle));
  await shot('02b-raw-expanded');

  /* ---- 未读 tracking ---- */
  report.checks.unread = await page.evaluate(() => {
    const c = [...document.querySelectorAll('#researchChips .chip')].find(x => x.dataset.k === 'unread');
    return { label: c?.textContent.trim() };
  });

  /* ---- domain filter ---- */
  await page.evaluate(() => {
    const c = [...document.querySelectorAll('#researchChips .chip')]
      .find(x => x.textContent.includes('心血管'));
    if (c) c.click();
  });
  await sleep(700);
  report.checks.domainFilter = await page.evaluate(() => ({
    head: document.querySelector('#researchHead')?.textContent,
    cards: document.querySelectorAll('#researchCards .art').length,
    allMatch: [...document.querySelectorAll('#researchCards .badge.dom')]
      .every(b => b.textContent.includes('心血管')),
  }));
  console.log('  domain filter:', JSON.stringify(report.checks.domainFilter));
  await shot('03-research-domain');

  /* ---- 基础/分子 filter ---- */
  await page.evaluate(() => {
    const c = [...document.querySelectorAll('#researchChips .chip')]
      .find(x => x.textContent.includes('基础/分子'));
    if (c) c.click();
  });
  await sleep(700);
  report.checks.basicFilter = await page.evaluate(() => ({
    head: document.querySelector('#researchHead')?.textContent,
    cards: document.querySelectorAll('#researchCards .art').length,
    allBasic: [...document.querySelectorAll('#researchCards .badge.bas')].length ===
              document.querySelectorAll('#researchCards .art').length,
  }));
  console.log('  basic filter:', JSON.stringify(report.checks.basicFilter));

  /* ---- index table view ---- */
  await page.evaluate(() => {
    const c = [...document.querySelectorAll('#researchChips .chip')]
      .find(x => x.textContent.includes('全部'));
    if (c) c.click();
  });
  await sleep(500);
  await page.evaluate(() => document.querySelector('.viewtog button[data-view="index"]').click());
  await sleep(800);
  report.checks.indexTable = await page.evaluate(() => {
    const t = document.querySelector('table.idx');
    return {
      exists: !!t,
      headers: [...(t?.querySelectorAll('th') || [])].map(x => x.textContent),
      rows: t?.querySelectorAll('tbody tr').length,
      firstRow: [...(t?.querySelector('tbody tr')?.querySelectorAll('td') || [])].map(x => x.textContent.trim()),
    };
  });
  console.log('  index table:', JSON.stringify(report.checks.indexTable));
  report.checks.overflowIndex = await overflow();
  await shot('04-index-table');

  /* ---- back to cards + mark all read ---- */
  await page.evaluate(() => document.querySelector('.viewtog button[data-view="card"]').click());
  await sleep(500);
  await page.evaluate(() => document.querySelector('#markAllRead').click());
  await sleep(600);
  report.checks.markAll = await page.evaluate(() => {
    const c = [...document.querySelectorAll('#researchChips .chip')].find(x => x.dataset.k === 'unread');
    return { unreadLabel: c?.textContent.trim() };
  });
  await shot('05-marked-read');

  /* ---- glossary ---- */
  await page.evaluate(() => {
    const c = [...document.querySelectorAll('#researchChips .chip')]
      .find(x => x.textContent.includes('专业词汇'));
    if (c) c.click();
  });
  await sleep(600);
  report.checks.glossary = await page.evaluate(() => ({
    open: !document.querySelector('#glossSheet').hidden,
    rows: document.querySelectorAll('#glossList .gl').length,
  }));
  await shot('06-glossary');
  await page.keyboard.press('Escape');
  await sleep(400);

  /* ---- builders tab ---- */
  await page.evaluate(() => document.querySelector('.seg[data-tab="builders"]').click());
  await page.waitForFunction(() => window.__rr.ai.loaded, { timeout: 45000, polling: 500 }).catch(() => {});
  await sleep(900);
  report.checks.builders = await page.evaluate(() => {
    const box = document.querySelector('#aiSummary');
    return {
      posts: document.querySelectorAll('#builderCards .post').length,
      head: document.querySelector('#builderHead')?.textContent,
      aiDate: document.querySelector('#aiDate')?.textContent,
      summaryBoxVisible: !!box && !box.hidden,
      headline: box?.querySelector('.aisum-headline')?.textContent?.slice(0, 46),
      bullets: box?.querySelectorAll('.aisum-list li').length,
      sentiment: box?.querySelector('.aisum-senti-txt')?.textContent?.slice(0, 40),
      postsWithZh: document.querySelectorAll('#builderCards .post-zh').length,
      firstZh: document.querySelector('#builderCards .post-zh .post-zh-txt')?.textContent?.slice(0, 40),
    };
  });
  console.log('  builders:', JSON.stringify(report.checks.builders));
  report.checks.overflowBuilders = await overflow();
  await shot('07-builders');

  /* ---- narrow ---- */
  await page.setViewport({ width: 320, height: 720, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.evaluate(() => document.querySelector('.seg[data-tab="research"]').click());
  await sleep(800);
  report.checks.overflow320 = await overflow();
  await shot('08-narrow320');
  await page.evaluate(() => document.querySelector('.viewtog button[data-view="index"]').click());
  await sleep(600);
  report.checks.overflow320index = await overflow();
  await shot('09-narrow320-index');

  /* ---- SW / offline ---- */
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.evaluate(() => document.querySelector('.viewtog button[data-view="card"]').click());
  await sleep(2600);
  report.checks.sw = await page.evaluate(async () => ({
    supported: 'serviceWorker' in navigator,
    controller: !!navigator.serviceWorker.controller,
  }));
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 40000 })
    .catch(e => errors.push('OFFLINE_RELOAD ' + e.message));
  await sleep(2000);
  report.checks.offline = await page.evaluate(() => ({
    shellPainted: !!document.querySelector('.phone'),
    title: document.querySelector('#brandTitle')?.textContent,
    cachedCards: document.querySelectorAll('#researchCards .art').length,
  }));
  console.log('  offline:', JSON.stringify(report.checks.offline));
  await shot('10-offline');
  await page.setOfflineMode(false);

  report.errors = errors;
  report.warnings = warnings;
  await browser.close();

  const out = path.join(SHOT, 'report.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  const of = report.checks.overflowResearch.bad.length + report.checks.overflowBuilders.bad.length +
             report.checks.overflow320.bad.length + (report.checks.overflowIndex?.bad.length || 0) +
             (report.checks.overflow320index?.bad.length || 0);
  console.log('\n=== SUMMARY ===');
  console.log('errors     :', errors.length ? errors : 'none');
  console.log('warnings   :', warnings.length ? `${warnings.length} (crossref, fallback path)` : 'none');
  console.log('overflow   :', of ? 'YES' : 'no');
  console.log('shots      :', report.shots.length, '->', SHOT);
  console.log('report     :', out);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
