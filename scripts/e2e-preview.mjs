// Plays both sample lessons in a real browser (three.js served from node_modules) and checks the flow.
// Usage: pnpm e2e [outDir]   — screenshots go to outDir (default: ./e2e-shots)
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
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

async function open(browser, lesson) {
  const dir = join(root, 'content', 'lessons', lesson, '1.0');
  execFileSync('pnpm', ['-s', 'dls', 'preview', dir], { cwd: root, stdio: 'ignore' });
  const page = await (await browser.newContext({ viewport: { width: 1300, height: 900 }, reducedMotion: 'reduce' })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/cdn\.jsdelivr\.net\/npm\/three@0\.160\.0\//, r => {
    const rel = r.request().url().split('three@0.160.0/')[1];
    r.fulfill({ body: readFileSync(join(threeDir, rel)), contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' } });
  });
  await page.goto(pathToFileURL(join(dir, 'preview.html')).href);
  return { page, errors };
}
const events = page => page.evaluate(() => window.__player.events.map(e => e.type));

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  // 哥哥：珊瑚礁周长面积
  {
    const { page, errors } = await open(browser, 'L-PA');
    await page.click('#next');
    await page.waitForSelector('#stage canvas', { timeout: 15000 });
    await page.waitForTimeout(2500);
    await page.click('[data-act="walk"]');
    await page.waitForFunction(() => window.__player.events.some(e => e.type === 'action_done' && e.action === 'walk'), null, { timeout: 40000 });
    await page.click('[data-act="fill"]');
    await page.waitForFunction(() => window.__player.events.some(e => e.type === 'action_done' && e.action === 'fill'), null, { timeout: 40000 });
    const pv = await page.textContent('#pv'), sv = await page.textContent('#sv');
    pv === '20' && sv === '24' ? ok(`L-PA 卷尺 ${pv} 米、样方 ${sv} 个`) : fail(`L-PA 读数应为 20/24，实际 ${pv}/${sv}`);
    await page.screenshot({ path: join(shots, 'L-PA-demo.png') });
    await page.click('[data-act="focus"]');
    await page.waitForTimeout(1200);
    (await page.$('.pending-card')) ? ok('L-PA 螳螂虾未到位时只显示洞口和说明') : fail('缺少待到位提示');
    await page.screenshot({ path: join(shots, 'L-PA-burrow.png') });
    await page.selectOption('#lang', 'cycle');
    for (let i = 0; i < 5; i++) await page.click('[data-hs="fence"]');
    const langs = await page.evaluate(() => window.__player.events.filter(e => e.type === 'hotspot' && e.id === 'fence').map(e => e.lang));
    JSON.stringify(langs.slice(-5)) === '["zh","en","en","en","zh"]' ? ok('语言循环 中→英×3→中') : fail('语言循环错误：' + langs.join(','));
    await page.click('#next');
    const c1 = page.locator('[data-ch="c1"]');
    await c1.locator('[data-f="P"]').fill('16'); await c1.locator('[data-u="P"]').selectOption('米');
    await c1.locator('[data-f="S"]').fill('15'); await c1.locator('[data-u="S"]').selectOption('米');
    await c1.locator('[data-chk]').click();
    (await c1.locator('.fb').textContent()).includes('单位再看一看') ? ok('单位错误单独指出') : fail('单位错误没有指出');
    await c1.locator('[data-u="S"]').selectOption('平方米'); await c1.locator('[data-chk]').click();
    (await c1.locator('.fb').textContent()) === '数和单位都对上了。' ? ok('c1 判对') : fail('c1 判断错误');
    await page.click('#next');
    await page.click('[data-q="wish"] [data-a="机器人"]');
    await page.click('#done');
    const wish = await page.evaluate(() => window.__player.events.find(e => e.type === 'next_lesson_wish'));
    wish?.answer === '机器人' && wish.source === '孩子自述' ? ok('下一课心愿记录为孩子自述') : fail('心愿没有记录');
    await page.screenshot({ path: join(shots, 'L-PA-end.png') });
    errors.length ? fail('页面错误：' + errors.join(' | ')) : ok('L-PA 无页面错误');
  }
  // 妹妹：积木乘法
  {
    const { page, errors } = await open(browser, 'L-ARR');
    (await page.$eval('#lang', e => e.value)) === 'cycle' ? ok('L-ARR 默认 1 中 3 英循环（按她的设置）') : fail('L-ARR 语言设置未生效');
    await page.click('#next');
    await page.waitForSelector('#stage canvas', { timeout: 15000 });
    await page.waitForTimeout(2000);
    await page.click('[data-act="reveal"]');
    await page.waitForFunction(() => window.__player.events.some(e => e.type === 'action_done' && e.action === 'reveal'), null, { timeout: 40000 });
    (await page.textContent('#rv')) === '3' ? ok('L-ARR 摆了 3 行') : fail('L-ARR 行数不对');
    await page.click('[data-act="rotate"]'); await page.waitForTimeout(1500);
    await page.screenshot({ path: join(shots, 'L-ARR-demo.png') });
    await page.click('#next');
    const c2 = page.locator('[data-ch="c2"]');
    await c2.locator('[data-opt="一样多"]').click(); await c2.locator('[data-chk]').click();
    (await c2.locator('.fb').textContent()) === '数和单位都对上了。' ? ok('选择题判对') : fail('选择题判断错误');
    await page.click('#next');
    const opts = await page.$$eval('[data-q="wish"] [data-a]', bs => bs.map(b => b.dataset.a));
    !opts.includes('螳螂虾') && opts.includes('做手工') ? ok('妹妹的心愿选项是她自己的') : fail('妹妹的心愿选项不对：' + opts.join(','));
    await page.fill('[data-q="wish"] .own', '小兔子');
    await page.click('#done');
    const wish = await page.evaluate(() => window.__player.events.find(e => e.type === 'next_lesson_wish'));
    wish?.answer === '小兔子' ? ok('“我自己说一个”被记录') : fail('自述心愿没有记录');
    errors.length ? fail('页面错误：' + errors.join(' | ')) : ok('L-ARR 无页面错误');
  }
} finally { await browser.close(); }

// Component acceptance: render each component at the edges of its parameter range.
{
  const { writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const cases = [
    ['L-PA', 'PerimeterArea', { a: 1, b: 1 }], ['L-PA', 'PerimeterArea', { a: 10, b: 10 }], ['L-PA', 'PerimeterArea', { a: 10, b: 1 }],
    ['L-ARR', 'ArrayMultiplier', { rows: 1, cols: 1 }], ['L-ARR', 'ArrayMultiplier', { rows: 9, cols: 9 }],
  ];
  const b2 = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  try {
    for (const [lesson, comp, p] of cases) {
      const spec = JSON.parse(readFileSync(join(root, 'content/lessons', lesson, '1.0', 'lessonspec.json'), 'utf8'));
      Object.assign(spec.component_params[comp], p);
      const tag = `${comp}-${Object.values(p).join('x')}`;
      const specFile = join(tmpdir(), `${tag}.json`), html = join(tmpdir(), `${tag}.html`);
      writeFileSync(specFile, JSON.stringify(spec));
      execFileSync('pnpm', ['-s', 'dls', 'preview', specFile, '--out', html], { cwd: root, stdio: 'ignore' });
      const page = await (await b2.newContext({ viewport: { width: 1300, height: 900 }, reducedMotion: 'reduce' })).newPage();
      const errs = []; page.on('pageerror', e => errs.push(e.message));
      await page.route(/cdn\.jsdelivr\.net\/npm\/three@0\.160\.0\//, r => r.fulfill({ body: readFileSync(join(threeDir, r.request().url().split('three@0.160.0/')[1])), contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' } }));
      await page.goto(pathToFileURL(html).href);
      // Software GL in CI is slow (9×9 blocks run ~2 fps), so allow generous time; real iPads are checked in M3.
      await page.click('#next', { noWaitAfter: true, timeout: 120000 }); await page.waitForSelector('#stage canvas', { timeout: 120000 }); await page.waitForTimeout(2000);
      const act = comp === 'PerimeterArea' ? 'fill' : 'reveal';
      await page.click(`[data-act="${act}"]`, { noWaitAfter: true, timeout: 120000 });
      await page.waitForFunction(a => window.__player.events.some(e => e.type === 'action_done' && e.action === a), act, { timeout: 120000 });
      await page.waitForTimeout(800);
      await (await page.$('#stage')).screenshot({ path: join(shots, `sweep-${tag}.png`) });
      errs.length ? fail(`${tag} 页面错误：${errs.join(' | ')}`) : ok(`${tag} 渲染正常`);
      rmSync(specFile); rmSync(html);
    }
  } finally { await b2.close(); }
}
