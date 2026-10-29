// Plays the sample lessons as `dls preview` files in a real browser (three.js served from node_modules):
// start, the intro, the demo in order with its readouts, then each component at the edges of its parameter range.
// The whole lesson on the tablet (questions, timers, help, wishes, records) is checked by `pnpm e2e:apps`.
// Usage: pnpm e2e [outDir]   — screenshots go to outDir (default: ./e2e-shots)
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Playwright is used from the machine's install (require works from any directory there).
const { chromium } = createRequire(import.meta.url)('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? join(root, 'e2e-shots');
mkdirSync(shots, { recursive: true });
const threeDir = join(root, 'node_modules', 'three');
const fail = m => { console.error('✗ ' + m); process.exitCode = 1; };
const ok = m => console.log('✓ ' + m);
// Software GL is slow (9×9 blocks run ~2 fps) and nothing speaks the intro here, so waits are generous.
const SLOW = 120000;

async function open(browser, html) {
  const page = await (await browser.newContext({ viewport: { width: 1300, height: 900 }, reducedMotion: 'reduce' })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/cdn\.jsdelivr\.net\/npm\/three@0\.160\.0\//, r => {
    const rel = r.request().url().split('three@0.160.0/')[1];
    r.fulfill({ body: readFileSync(join(threeDir, rel)), contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' } });
  });
  await page.goto(pathToFileURL(html).href);
  return { page, errors };
}
const preview = (spec, out) => execFileSync('pnpm', ['-s', 'dls', 'preview', spec, ...(out ? ['--out', out] : [])], { cwd: root, stdio: 'ignore' });
const done = (page, a) => page.waitForFunction(a => window.__player.events.some(e => e.type === 'action_done' && e.action === a), a, { timeout: SLOW });

// 开始上课 → the intro is read in full before the demo unlocks → the 3D stage.
async function toDemo(page) {
  await page.click('#start');
  await page.waitForSelector('#next:not([disabled])', { timeout: SLOW });
  await page.click('#next', { noWaitAfter: true });
  await page.waitForSelector('#stage canvas', { timeout: SLOW });
  await page.waitForTimeout(2000);
}
// The demo goes one thing at a time; do each in turn (actions and “想好了”) until `until` has run, or all of them.
async function demo(page, until) {
  const did = [];
  for (let i = 0; i < 10 && !did.includes(until); i++) {
    if (await page.$('#think')) { await page.click('#think'); continue; }
    const a = await page.$$eval('[data-act]', (bs, did) => bs.find(b => !b.disabled && !did.includes(b.dataset.act))?.dataset.act, did);
    if (!a) break;
    await page.click(`[data-act="${a}"]`, { noWaitAfter: true, timeout: SLOW });
    if (a !== 'focus') await done(page, a);
    did.push(a);
  }
  return did;
}

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  for (const [lesson, readouts] of [['L-PA/1.0', { pv: '20', sv: '24' }], ['L-PA/1.1', {}], ['L-ARR/1.0', { rv: '3' }]]) {
    const dir = join(root, 'content', 'lessons', lesson);
    preview(dir);
    const { page, errors } = await open(browser, join(dir, 'preview.html'));
    await page.waitForSelector('#start', { timeout: 20000 });
    (await page.$('#lang')) ? fail(`${lesson} 还有讲解语言选择`) : ok(`${lesson} 只有“开始上课”，没有语言选择`);
    try {
      await page.click('#next', { trial: true, timeout: 1000 }).then(() => fail(`${lesson} 没点开始就能往下`), () => {});
      await toDemo(page);
      ok(`${lesson} 说明读完才打开三维演示`);
      const did = await demo(page);
      const got = Object.fromEntries(await Promise.all(Object.keys(readouts).map(async k => [k, await page.textContent('#' + k)])));
      JSON.stringify(got) === JSON.stringify(readouts) ? ok(`${lesson} 演示按顺序做完（${did.join(' → ')}）${Object.keys(got).length ? '，读数 ' + Object.values(got).join('/') : ''}`)
        : fail(`${lesson} 读数应为 ${JSON.stringify(readouts)}，实际 ${JSON.stringify(got)}`);
      await page.screenshot({ path: join(shots, `${lesson.replace('/', '@')}-demo.png`) });
      await page.waitForSelector('#next:not([disabled])', { timeout: 20000 });
      await page.click('#next');
      await page.waitForSelector('[data-ch]', { timeout: 20000 });
      ok(`${lesson} 演示做完才能去挑战，挑战题出现`);
    } catch (e) { fail(`${lesson} 流程卡住：${e.message.split('\n')[0]}`); }
    errors.length ? fail(`${lesson} 页面错误：` + errors.join(' | ')) : ok(`${lesson} 无页面错误`);
    await page.close();
  }
} finally { await browser.close(); }

// Component acceptance: render each component at the edges of its parameter range.
{
  const cases = [
    ['L-PA', 'PerimeterArea', { a: 1, b: 1 }, 'fill'], ['L-PA', 'PerimeterArea', { a: 10, b: 10 }, 'fill'], ['L-PA', 'PerimeterArea', { a: 10, b: 1 }, 'fill'],
    ['L-ARR', 'ArrayMultiplier', { rows: 1, cols: 1 }, 'reveal'], ['L-ARR', 'ArrayMultiplier', { rows: 9, cols: 9 }, 'reveal'],
  ];
  const b2 = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  try {
    for (const [lesson, comp, p, act] of cases) {
      const spec = JSON.parse(readFileSync(join(root, 'content/lessons', lesson, '1.0', 'lessonspec.json'), 'utf8'));
      Object.assign(spec.component_params[comp], p);
      const tag = `${comp}-${Object.values(p).join('x')}`;
      const specFile = join(tmpdir(), `${tag}.json`), html = join(tmpdir(), `${tag}.html`);
      writeFileSync(specFile, JSON.stringify(spec));
      preview(specFile, html);
      const { page, errors } = await open(b2, html);
      try {
        await toDemo(page);
        await demo(page, act);
        await page.waitForTimeout(800);
        await (await page.$('#stage')).screenshot({ path: join(shots, `sweep-${tag}.png`) });
        errors.length ? fail(`${tag} 页面错误：${errors.join(' | ')}`) : ok(`${tag} 渲染正常`);
      } catch (e) { fail(`${tag} 卡住：${e.message.split('\n')[0]}`); }
      await page.close();
      rmSync(specFile); rmSync(html);
    }
  } finally { await b2.close(); }
}
