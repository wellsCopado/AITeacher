// Full family flow in a real browser against a real server: pair a Pad, publish and schedule a lesson,
// the child plays it (with a Wi-Fi drop in the middle), the parent reads the record and the child's wish.
// Usage: pnpm e2e:apps [outDir]
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildApp } from '../apps/server/src/app.js';
import { contentHash, REVIEW_CHECKLIST } from '../packages/cli/src/lib.js';
import type { LessonSpec } from '../packages/schema/src/index.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? join(root, 'e2e-shots');
mkdirSync(shots, { recursive: true });
const fail = (m: string) => { console.error('✗ ' + m); process.exitCode = 1; };
const ok = (m: string) => console.log('✓ ' + m);
const check = (cond: unknown, m: string) => (cond ? ok(m) : fail(m));

execFileSync('node', [join(root, 'scripts', 'build-apps.mjs')], { stdio: 'ignore' });
const PIN = '2468';
const app = await buildApp({ root, dbPath: join(mkdtempSync(join(tmpdir(), 'adw-e2e-')), 'db.sqlite'), pin: PIN, serveApps: true });
await app.listen({ host: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

// What `dls publish --server` sends: a frozen lesson with all four reviews.
const sp = JSON.parse(readFileSync(join(root, 'content/lessons/L-PA/1.0/lessonspec.json'), 'utf8')) as LessonSpec;
const frozen: LessonSpec = { ...sp, review_records: Object.entries(REVIEW_CHECKLIST).map(([category, checked]) => ({ category: category as '科学', reviewer: '家长', checked, at: new Date().toISOString() })), published_at: new Date().toISOString() };
frozen.content_hash = contentHash(frozen);

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const parentCtx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const parent = await parentCtx.newPage();
  const padCtx = await browser.newContext({ viewport: { width: 1180, height: 820 }, reducedMotion: 'reduce', hasTouch: true });
  const pad = await padCtx.newPage();
  const errors: string[] = [];
  for (const p of [parent, pad]) p.on('pageerror', (e: Error) => errors.push(e.message));

  // Parent logs in.
  await parent.goto(`${base}/parent/`);
  await parent.fill('#pin', '1111'); await parent.click('.login button');
  await parent.waitForSelector('.toast.bad');
  check((await parent.textContent('.toast'))?.includes('PIN 不对'), '错误 PIN 被拒绝');
  await parent.fill('#pin', PIN); await parent.click('.login button');
  await parent.waitForSelector('.tabs');
  ok('家长 PIN 登录');

  // Pad shows a pairing code, the parent approves it.
  await pad.goto(`${base}/pad/`);
  await pad.waitForFunction(() => /\d{3} \d{3}/.test(document.getElementById('code')?.textContent ?? ''));
  const code = (await pad.textContent('#code'))!.replace(/\s/g, '');
  await pad.screenshot({ path: join(shots, 'pad-pair.png') });
  await parent.click('[data-t="设备与数据"]');
  await parent.fill('#pair [name=code]', code); await parent.fill('#pair [name=label]', '哥哥的 iPad');
  await parent.click('#pair button');
  await pad.waitForSelector('.kidbtn', { timeout: 10000 });
  ok('Pad 配对成功，进入选人');
  check((await parent.textContent('#view'))?.includes('哥哥的 iPad'), '家长端设备列表有这台 Pad');

  // Nothing scheduled yet.
  await pad.click('.kidbtn[data-id="gege"]');
  await pad.waitForSelector('.lead');
  check((await pad.textContent('#list'))?.includes('今天没有安排课'), '没排课时孩子看不到课');

  // Publish (as dls publish --server would) and schedule today.
  const tok = await parent.evaluate(() => sessionStorage.getItem('adw.parent'));
  const pub = await fetch(`${base}/v1/lessons`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: JSON.stringify(frozen) });
  check(pub.status === 201, '课程上传后服务器复核通过');
  await parent.click('[data-t="排课"]');
  await parent.waitForSelector('.day');
  await parent.locator('.day').first().locator('.kidcol[data-c="gege"] input[value="L-PA@1.0"]').check();
  await parent.locator('.day').first().locator('.save').click();
  await parent.waitForFunction(() => document.getElementById('toast')?.textContent?.includes('已保存'));
  await parent.screenshot({ path: join(shots, 'parent-schedule.png') });
  ok('家长排了今天的课');

  await pad.click('#back'); await pad.click('.kidbtn[data-id="gege"]');
  await pad.waitForSelector('.lesson');
  await pad.screenshot({ path: join(shots, 'pad-today.png') });
  check((await pad.textContent('.lesson'))?.includes('今天的课'), '孩子看到今天的课');
  await pad.click('.lesson');
  await pad.waitForSelector('#next');
  check(!(await pad.$('.side')), 'Pad 上不显示家长侧栏');
  await pad.click('#next');
  await pad.waitForSelector('#stage canvas', { timeout: 30000 });
  await pad.waitForTimeout(2000);
  await pad.click('[data-act="walk"]');
  await pad.waitForFunction(() => (window as any).__player.events.some((e: any) => e.type === 'action_done' && e.action === 'walk'), null, { timeout: 60000 });
  await pad.screenshot({ path: join(shots, 'pad-lesson.png') });
  ok('三维场景在 Pad 页面里运行（three.js 来自本机服务器）');

  // Wi-Fi drops: the child keeps going, events wait in the queue.
  await padCtx.setOffline(true);
  await pad.click('#next');
  const c1 = pad.locator('[data-ch="c1"]');
  await c1.locator('[data-f="P"]').fill('16'); await c1.locator('[data-u="P"]').selectOption('米');
  await c1.locator('[data-f="S"]').fill('15'); await c1.locator('[data-u="S"]').selectOption('平方米');
  await c1.locator('[data-chk]').click();
  await pad.click('#next');
  await pad.click('[data-q="wish"] [data-a="机器人"]');
  await pad.click('#done');
  await pad.waitForFunction(() => /条记录等网络恢复后上传/.test(document.getElementById('sync')?.textContent ?? ''));
  ok('断网时记录留在 Pad 上');
  await padCtx.setOffline(false);
  await pad.evaluate(() => dispatchEvent(new Event('online')));
  await pad.waitForFunction(() => (document.getElementById('sync')?.textContent ?? '') === '', null, { timeout: 15000 });
  ok('网络恢复后自动补传');

  // Parent reads the record and sees the wish as the child's own interest.
  await parent.click('[data-t="学习记录"]');
  await parent.waitForSelector('.open');
  await parent.click('.open');
  await parent.waitForSelector('#detail .card');
  const detail = (await parent.textContent('#detail'))!;
  check(detail.includes('第 1 题') && detail.includes('做对了') && detail.includes('拉卷尺围一圈'), '家长看到挑战结果和动手操作');
  check(detail.includes('下一课想学：“机器人”'), '家长看到孩子的下一课心愿');
  await parent.screenshot({ path: join(shots, 'parent-record.png') });
  await parent.click('[data-t="兴趣与心愿"]');
  await parent.waitForSelector('#add');
  const ints = (await parent.textContent('#view'))!;
  check(/机器人 · 下一课心愿 · 孩子自述/.test(ints), '心愿自动记为哥哥自己的兴趣');
  const meimeiCard = await parent.locator('.card:has(h3:text-is("妹妹"))').textContent();
  check(!meimeiCard?.includes('机器人'), '妹妹的兴趣里没有哥哥的心愿');

  // Count on the server: every event exactly once.
  const sessions = await (await fetch(`${base}/v1/sessions`, { headers: { authorization: `Bearer ${tok}` } })).json();
  const local = await pad.evaluate(() => (window as any).__player.events.length);
  check(sessions.length === 1 && sessions[0].events === local, `服务器收到全部 ${local} 条事件，没有重复`);
  check(errors.length === 0, errors.length ? '页面错误：' + errors.join(' | ') : '两个页面都没有报错');
} finally {
  await browser.close();
  await app.close();
}
