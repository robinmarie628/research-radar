/* QA harness for 科研雷达 — headless Edge via puppeteer-core.
 * Run:  NODE_PATH="C:/Users/Robin/.workbuddy/binaries/node/workspace/node_modules" \
 *       C:/Users/Robin/.workbuddy/binaries/node/versions/22.22.2/node.exe scripts/qa.js
 * Env:  QA_BASE (default http://127.0.0.1:8777/index.html)
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
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
  page.on('requestfailed', r => {
    const u = r.url();
    if (/ERR_ABORTED/.test(r.failure()?.errorText || '') && !/europepmc|githubusercontent/.test(u)) return;
    errors.push('REQFAIL ' + u.slice(0, 110) + ' :: ' + (r.failure()?.errorText || ''));
  });

  const report = { base: BASE, errors, shots: [], checks: {} };
  const shot = async (name, opts = {}) => {
    const f = path.join(SHOT, name + '.png');
    await page.screenshot({ path: f, ...opts });
    report.shots.push(f);
    return f;
  };

  console.log('→ loading', BASE);
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // wait for real data, not a wall-clock guess
  await page.waitForFunction(
    () => window.__rr && window.__rr.jr && window.__rr.jr.loaded && window.__rr.jr.all.length > 0,
    { timeout: 60000, polling: 500 }
  ).catch(() => {});
  await sleep(900);

  // ---- state ----
  report.state = await page.evaluate(() => ({
    journals: window.__rr.jr.all.length,
    jrError: window.__rr.jr.error,
    updated: window.__rr.jr.updated,
    dirs: Object.fromEntries(Object.entries(window.__rr.jr.byKey).map(([k, v]) => [k, v.length])),
    cfg: window.__rr.cfg.length,
    gloss: window.__rr.gloss.length,
    builders: window.__rr.ai.all.length,
    aiError: window.__rr.ai.error,
    cards: document.querySelectorAll('#researchCards .art').length,
    head: document.querySelector('#researchHead')?.textContent,
    litDate: document.querySelector('#litDate')?.textContent,
  }));
  console.log('  state:', JSON.stringify(report.state));

  // ---- 1. horizontal overflow ----
  const overflow = async label => page.evaluate(() => {
    const bad = [];
    // An element inside an `overflow:hidden` ancestor is visually clipped and cannot
    // cause document-level scroll — skip it (otherwise decorative glows false-positive).
    const clipped = el => {
      let n = el.parentElement;
      while (n && n !== document.documentElement) {
        const cs = getComputedStyle(n);
        if (cs.overflowX === 'hidden' || cs.overflowX === 'clip' || cs.overflowX === 'auto') return true;
        n = n.parentElement;
      }
      return false;
    };
    document.querySelectorAll('body *').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > innerWidth + 1.5 || r.left < -1.5)) {
        const cs = getComputedStyle(el);
        if (cs.position === 'fixed' || clipped(el) || el.closest('[data-close]')) return;
        bad.push({ tag: el.tagName, cls: String(el.className).slice(0, 50),
                   left: Math.round(r.left), right: Math.round(r.right) });
      }
    });
    return { docW: document.documentElement.scrollWidth, win: innerWidth,
             scrolls: document.documentElement.scrollWidth > innerWidth + 1, bad };
  });
  report.checks.overflowResearch = await overflow();
  await shot('01-research');

  // ---- 2. interactions ----
  // expand the first article card
  await page.click('#researchCards .art');
  await sleep(500);
  report.checks.expanded = await page.evaluate(() => {
    const c = document.querySelector('#researchCards .art.open');
    return {
      open: !!c,
      abstractChars: (c?.querySelector('.art-abstract')?.textContent || '').length,
      abstractScrollable: (() => {
        const p = c?.querySelector('.art-abstract');
        return p ? p.scrollHeight > p.clientHeight : null;
      })(),
      links: [...(c?.querySelectorAll('.art-links .lnk') || [])].map(a => a.textContent.trim()),
      hasRawTag: /<[a-z/][^>]*>/i.test(c?.querySelector('.art-title')?.textContent || ''),
    };
  });
  console.log('  expanded:', JSON.stringify(report.checks.expanded));
  await shot('02-research-expanded');

  // filter chips
  const chipCount = await page.evaluate(() => document.querySelectorAll('#researchChips .chip').length);
  report.checks.chipCount = chipCount;
  // click the 心力衰竭 chip (index 3 = first DIR after 顶刊速递/全部/专业词汇)
  await page.evaluate(() => {
    const cs = [...document.querySelectorAll('#researchChips .chip')];
    const t = cs.find(c => c.textContent.includes('心力衰竭'));
    if (t) t.click();
  });
  await sleep(600);
  report.checks.afterFilter = await page.evaluate(() => ({
    head: document.querySelector('#researchHead')?.textContent,
    cards: document.querySelectorAll('#researchCards .art').length,
    active: document.querySelector('#researchChips .chip[aria-pressed="true"]')?.textContent,
    allMatch: [...document.querySelectorAll('#researchCards .badge.dir')]
      .every(b => b.textContent.includes('心力衰竭')),
  }));
  console.log('  filter:', JSON.stringify(report.checks.afterFilter));
  await shot('03-research-filtered');

  // back to 顶刊速递
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('#researchChips .chip')].find(c => c.textContent.includes('顶刊速递'));
    if (t) t.click();
  });
  await sleep(500);
  report.checks.topFilter = await page.evaluate(() => ({
    head: document.querySelector('#researchHead')?.textContent,
    cards: document.querySelectorAll('#researchCards .art').length,
  }));

  // glossary sheet
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('#researchChips .chip')].find(c => c.textContent.includes('专业词汇'));
    if (t) t.click();
  });
  await sleep(600);
  report.checks.glossary = await page.evaluate(() => ({
    open: !document.querySelector('#glossSheet').hidden,
    rows: document.querySelectorAll('#glossList .gl').length,
  }));
  await shot('04-glossary');

  // glossary search
  await page.click('#glossSearch');
  await page.type('#glossSearch', 'pulmonary', { delay: 25 });
  await sleep(500);
  report.checks.glossarySearch = await page.evaluate(() => ({
    rows: document.querySelectorAll('#glossList .gl').length,
    first: document.querySelector('#glossList .gl-en')?.textContent,
  }));
  await shot('05-glossary-search');
  await page.keyboard.press('Escape');
  await sleep(400);

  // ---- 3. builders tab ----
  await page.evaluate(() => document.querySelector('.seg[data-tab="builders"]').click());
  await page.waitForFunction(() => window.__rr.ai.loaded, { timeout: 45000, polling: 500 }).catch(() => {});
  await sleep(900);
  report.checks.builders = await page.evaluate(() => ({
    posts: document.querySelectorAll('#builderCards .post').length,
    chips: [...document.querySelectorAll('#builderChips .chip')].map(c => c.textContent.trim()).slice(0, 6),
    head: document.querySelector('#builderHead')?.textContent,
    aiDate: document.querySelector('#aiDate')?.textContent,
    anyAvatarBg: !!document.querySelector('#builderCards .avatar')?.style.background,
  }));
  console.log('  builders:', JSON.stringify(report.checks.builders));
  report.checks.overflowBuilders = await overflow();
  await shot('06-builders');

  // builder type filter
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('#builderChips .chip')].find(c => c.textContent.includes('X 动态'));
    if (t) t.click();
  });
  await sleep(500);
  report.checks.builderFilter = await page.evaluate(() => ({
    head: document.querySelector('#builderHead')?.textContent,
    posts: document.querySelectorAll('#builderCards .post').length,
  }));
  await shot('07-builders-x');

  // ---- 4. narrow width ----
  await page.setViewport({ width: 320, height: 720, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.evaluate(() => document.querySelector('.seg[data-tab="research"]').click());
  await sleep(700);
  report.checks.overflow320 = await overflow();
  await shot('08-narrow320');

  // ---- 5. service worker + offline ----
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await sleep(2600);
  report.checks.sw = await page.evaluate(async () => ({
    supported: 'serviceWorker' in navigator,
    controller: !!navigator.serviceWorker.controller,
    regs: (await navigator.serviceWorker.getRegistrations()).length,
  }));
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 40000 }).catch(e => errors.push('OFFLINE_RELOAD ' + e.message));
  await sleep(1800);
  report.checks.offline = await page.evaluate(() => ({
    shellPainted: !!document.querySelector('.phone'),
    title: document.querySelector('#brandTitle')?.textContent,
    cachedCards: document.querySelectorAll('#researchCards .art').length,
  }));
  console.log('  offline:', JSON.stringify(report.checks.offline));
  await shot('09-offline');
  await page.setOfflineMode(false);

  report.errors = errors;
  await browser.close();

  const out = path.join(SHOT, 'report.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('\n=== SUMMARY ===');
  console.log('errors      :', errors.length ? errors : 'none');
  console.log('overflow>0  :', (report.checks.overflowResearch.bad.length + report.checks.overflowBuilders.bad.length + report.checks.overflow320.bad.length) ? 'YES' : 'no');
  console.log('shots       :', report.shots.length, '->', SHOT);
  console.log('report      :', out);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
