/* Render assets/icon.svg -> PNG app icons via headless Edge.
 * Run: NODE_PATH=".../node_modules" node scripts/make_icons.js
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = path.join(__dirname, '..');
const SRC = 'file:///' + path.join(ROOT, 'assets', 'icon.svg').replace(/\\/g, '/');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    args: ['--no-first-run', '--disable-gpu', '--hide-scrollbars'],
  });
  for (const size of [192, 512, 180]) {
    const page = await browser.newPage();
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.goto(SRC, { waitUntil: 'networkidle0' });
    await page.evaluate(s => {
      const svg = document.querySelector('svg');
      svg.setAttribute('width', s); svg.setAttribute('height', s);
      svg.style.display = 'block';
      document.documentElement.style.margin = '0';
      document.documentElement.style.background = 'transparent';
      if (document.body) document.body.style.margin = '0';   // absent for a raw .svg
    }, size);
    const out = path.join(ROOT, 'assets', `icon-${size}.png`);
    await page.screenshot({ path: out, omitBackground: true });
    const kb = (fs.statSync(out).size / 1024).toFixed(1);
    console.log(`  icon-${size}.png  ${kb} KB`);
    await page.close();
  }
  await browser.close();
  console.log('done');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
