// Full family flow in a real browser against a real server: pair a Pad, publish and schedule a lesson,
// the child plays it (with a Wi-Fi drop in the middle), the parent reads the record and the child's wish.
// Usage: pnpm e2e:apps [outDir]
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildApp } from '../apps/server/src/app.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? join(root, 'e2e-shots');
mkdirSync(shots, { recursive: true });
const fail = (m: string) => { console.error('✗ ' + m); process.exitCode = 1; };
const ok = (m: string) => console.log('✓ ' + m);
const check = (cond: unknown, m: string) => (cond ? ok(m) : fail(m));

execFileSync('node', [join(root, 'scripts', 'build-apps.mjs')], { stdio: 'ignore' });
const PIN = '2468';
// Stand-in for the Mac's voice: a short silent WAV per line, and a list of what was asked for.
const said: string[] = [];
function wav(seconds: number) {
  const n = Math.round(22050 * seconds), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(22050, 24); b.writeUInt32LE(44100, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
}
const tts = { voices: { zh: 'Tingting', en: 'Samantha' }, make: async (text: string, lang: string) => { said.push(`${lang}:${text}`); return wav(0.3); } };
const app = await buildApp({ root, dbPath: join(mkdtempSync(join(tmpdir(), 'adw-e2e-')), 'db.sqlite'), pin: PIN, serveApps: true, tts });
await app.listen({ host: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;


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
  await pad.goto(`${base}/pad/?adw_time=1`);
  await pad.waitForFunction(() => /\d{3} \d{3}/.test(document.getElementById('code')?.textContent ?? ''));
  const code = (await pad.textContent('#code'))!.replace(/\s/g, '');
  await pad.screenshot({ path: join(shots, 'pad-pair.png') });
  await parent.click('[data-t="设备与数据"]');
  await parent.waitForSelector('.tablet .qr svg');
  check((await parent.textContent('.tablet'))?.includes(`:${new URL(base).port}/app/`) ?? false, '「设备与数据」有平板 App 的下载二维码和地址');
  await parent.fill('#pair [name=code]', code); await parent.fill('#pair [name=label]', '哥哥的 iPad');
  await parent.click('#pair button');
  await pad.waitForSelector('.kidbtn', { timeout: 10000 });
  ok('Pad 配对成功，进入选人');
  check((await parent.textContent('#view'))?.includes('哥哥的 iPad'), '家长端设备列表有这台 Pad');
  check(await parent.locator('#voices select[data-lang="zh"]').count() === 1 && await parent.locator('#voices [data-try="en"]').count() === 1, '家长端「朗读声音」可以选中文、英文声音并试听');

  // Nothing scheduled yet.
  await pad.click('#stest');
  await pad.waitForFunction(() => /用的是/.test(document.getElementById('sres')?.textContent ?? ''), null, { timeout: 15000 });
  check((await pad.textContent('#sres'))?.includes('服务器 Mac 的语音') && said.includes('zh:你好，声音正常。'), '首页“声音测试”用服务器语音读出“你好，声音正常”');
  check(await pad.locator('.fsbtn').isVisible(), 'Pad 右上角有全屏开关');
  await pad.click('.kidbtn[data-id="gege"]');
  check(await pad.evaluate(() => !!document.fullscreenElement), '在浏览器里点按钮就自动进入全屏');
  await pad.waitForSelector('.lead');
  check((await pad.textContent('#list'))?.includes('今天没有安排课'), '没排课时孩子看不到课');

  // The sample lessons wait in 课程库; the parent previews, ticks all four reviews and publishes with one click.
  const tok = await parent.evaluate(() => sessionStorage.getItem('adw.parent'));
  // A real photo of the animal (a 1×1 stand-in file here) with its credit and licence.
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const up = (body: object) => fetch(`${base}/v1/organisms/M-peacock-mantis-shrimp/media`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: JSON.stringify(body) });
  check((await up({ mime: 'image/png', data: PNG, credit: '测试', license: 'CC0' })).status === 400, '没确认是实拍的素材不能加');
  check((await up({ mime: 'image/png', data: PNG, credit: '测试拍摄者', license: 'CC0', real: true, caption: '洞口的孔雀螳螂虾', length_cm: 16 })).ok, '家长加了一张螳螂虾实拍照片');
  await parent.click('[data-t="课程库"]');
  await parent.waitForSelector('.draft[data-k="L-PA@1.0"]');
  check(await parent.locator('.draft').count() === 3, '三节样课在课程库等审核');
  check((await parent.textContent('.draft[data-k="L-PA@1.1"] .replaces'))?.includes('L-PA@1.0 的新版本') ?? false, '螳螂虾新版写明它替换哪一版');
  const card = parent.locator('.draft[data-k="L-PA@1.0"]');
  const [pv] = await Promise.all([parentCtx.waitForEvent('page'), card.locator('a.btn').click()]);
  await pv.waitForSelector('#start', { timeout: 20000 });
  check((await pv.textContent('h1'))?.includes('螳螂虾'), '家长端能预览待审核的课');
  await pv.close();

  // Nobody touches the lesson: every step runs out of time and moves on by itself, the last one ends it.
  const auto = await parentCtx.newPage();
  auto.on('pageerror', (e: Error) => errors.push(e.message));
  await auto.goto(`${base}/pad/preview.html?adw_time=60#key=L-PA%401.0&t=${encodeURIComponent(tok!)}`);
  await auto.click('#start');
  await auto.waitForSelector('#next');
  check(await auto.locator('#next').isDisabled(), '说明没听完，「开始演示」是锁着的');
  check(!(await auto.$('#lang')) && !(await auto.$('[data-zh]')), '没有讲解语言选择，也没有纯中文按钮');
  await auto.waitForFunction(() => /今天的探索结束了/.test(document.body.textContent ?? ''), null, { timeout: 60000 });
  const autoEv = await auto.evaluate(() => (window as any).__player.events.map((e: any) => e.type + ':' + (e.step ?? e.task ?? e.challenge ?? '')));
  check(autoEv.filter((e: string) => e.startsWith('step_timeout')).length === 4, '四步都到时自动往下走，最后一步到时结束');
  check(autoEv.includes('intro_heard:') && autoEv.some((e: string) => e.startsWith('task_timeout')) && autoEv.some((e: string) => e.startsWith('question_timeout')), '说明读完才往下；演示里没做的事到时自动做；题目到时换下一题');
  await auto.close();
  await card.locator('input[type=checkbox]').first().check();
  await card.locator('.approve').click();
  await parent.waitForFunction(() => /还有没勾的/.test(document.getElementById('toast')?.textContent ?? ''));
  ok('没勾完四类审核不能发布');
  for (const c of await card.locator('input[type=checkbox]').all()) await c.check();
  await card.locator('.approve').click();
  await parent.waitForFunction(() => document.getElementById('toast')?.textContent?.includes('已发布'));
  check(await parent.locator('.draft').count() === 2, '审核通过后发布，课程库里还剩螳螂虾新版和妹妹那节等审核');
  // Right after publishing: one tap to put it on today.
  await parent.waitForSelector('#jp .when');
  await parent.click('#jp .when[data-n="0"]');
  await parent.waitForFunction(() => document.getElementById('toast')?.textContent?.includes('已排到今天'));
  ok('发布后点“今天就上”就排好了');
  await parent.click('[data-t="排课"]');
  await parent.waitForSelector('.todaykid');
  const todayText = await parent.textContent('.todaykid[data-c="gege"]');
  check(todayText?.includes('珊瑚礁') && todayText.includes('你排的'), '「排课」最上面的“今天”显示哥哥今天的课');
  check(await parent.isChecked('#auto'), '自动排课默认打开');
  await parent.locator('.daypick[data-c="gege"]').first().selectOption('__none');
  await parent.waitForFunction(() => document.getElementById('toast')?.textContent?.includes('已改好'));
  check(await parent.locator('.daypick[data-c="gege"]').first().inputValue() === '__none', '一周日历里选“这天不上”马上生效');
  await parent.screenshot({ path: join(shots, 'parent-schedule.png') });

  await pad.click('#back'); await pad.click('.kidbtn[data-id="gege"]');
  await pad.waitForSelector('.lesson');
  await pad.screenshot({ path: join(shots, 'pad-today.png') });
  check((await pad.textContent('.lesson'))?.includes('今天的课'), '孩子看到今天的课');
  await pad.click('.lesson');
  await pad.waitForSelector('#start');
  check((await pad.textContent('#body'))?.includes('开始上课'), '先点一下“开始上课”，同时打开声音');
  // Keep every subtitle line that appears, so the check doesn't depend on timing.
  await pad.evaluate(() => { const w = window as any, cap = document.getElementById('cap')!; w.__caps = []; new MutationObserver(() => w.__caps.push(cap.textContent)).observe(cap, { childList: true, characterData: true, subtree: true }); });
  await pad.click('#start');
  await pad.waitForSelector('#next');
  await pad.waitForTimeout(500);
  check(said.some(t => t.startsWith('zh:') && t.includes('潜到珊瑚礁海底')), '点“开始上课”后，用服务器 Mac 的语音朗读说明');
  check(!(await pad.$('.side')), 'Pad 上不显示家长侧栏');
  check(await pad.locator('.step').first().isDisabled(), '孩子不能点上面的步骤跳着走');
  await pad.waitForFunction(() => (window as any).__caps.length > 0);
  check(await pad.evaluate(() => (window as any).__caps.some((t: string) => t.includes('潜到珊瑚礁海底'))), '说明自动出字幕朗读');
  await pad.waitForSelector('#next:not([disabled])', { timeout: 30000 });
  await pad.click('#next');
  await pad.waitForSelector('#stage canvas', { timeout: 30000 });
  await pad.waitForTimeout(2000);
  await pad.click('[data-act="walk"]');
  await pad.waitForFunction(() => (window as any).__player.events.some((e: any) => e.type === 'action_done' && e.action === 'walk'), null, { timeout: 60000 });
  await pad.screenshot({ path: join(shots, 'pad-lesson.png') });
  ok('三维场景在 Pad 页面里运行（three.js 来自本机服务器）');
  check(await pad.locator('#next').isDisabled(), '演示的几件事没做完，不能去挑战');
  for (let k = 0; k < 10 && await pad.locator('#next').isDisabled(); k++) {
    const b = pad.locator('#body .pulse:not([disabled]):not(#next), #think').first();
    if (await b.count()) await b.click().catch(() => undefined);
    await pad.waitForTimeout(800);
  }
  check(await pad.locator('#next').isEnabled(), '跟着引导一件件做完，「去挑战」才打开');
  await pad.waitForSelector('.orgbar');
  await pad.waitForFunction(() => (window as any).__player.scene?.organismState?.() != null, null, { timeout: 15000 });
  check(['emerge', 'walk', 'idle'].includes((await pad.evaluate(() => (window as any).__player.scene.organismState().mode))), '点「看看螳螂虾的洞」：立体螳螂虾（照片做的可动模型）从洞里出来');
  await pad.click('[data-org="anatomy"]', { force: true });
  await pad.waitForFunction(() => (window as any).__player.scene.organismState().exploded && [...document.querySelectorAll('.organlab')].some(l => !(l as HTMLElement).hidden));
  const labs = await pad.$$eval('.organlab:not([hidden])', ls => ls.map(l => l.textContent));
  check(labs.includes('复眼') && labs.some(l => l?.includes('捕肢')) && labs.includes('尾扇'), `拆开看身体：标出 ${labs.join('、')}`);
  await pad.screenshot({ path: join(shots, 'pad-anatomy.png') });
  await pad.click('[data-org="anatomy"]', { force: true });
  await pad.click('[data-org="photos"]', { force: true });
  await pad.waitForSelector('.observe img');
  await pad.waitForTimeout(500);
  check(said.some(t => t.includes('孔雀螳螂虾的洞口') || t.startsWith('en:This is the burrow')), '点螳螂虾的洞，讲解读出声');
  const obs = (await pad.textContent('.observe'))!;
  check(obs.includes('身长约 16 厘米') && obs.includes('AI 写实图') && obs.includes('1/4'), '点螳螂虾的洞打开观察窗：自带 3 张写实图加家长传的 1 张，标明来源和身长对比');
  await pad.waitForFunction(() => (document.querySelector('.observe img') as HTMLImageElement)?.naturalWidth > 100);
  ok('写实图从本机服务器加载成功');
  await pad.screenshot({ path: join(shots, 'pad-observe.png') });

  // Wi-Fi drops: the child keeps going, events wait in the queue.
  await padCtx.setOffline(true);
  await pad.click('#next');
  const c1 = pad.locator('[data-ch="c1"]');
  await c1.locator('[data-f="P"]').fill('16'); await c1.locator('[data-u="P"]').selectOption('米');
  await c1.locator('[data-f="S"]').fill('15'); await c1.locator('[data-u="S"]').selectOption('平方米');
  await c1.locator('[data-chk]').click();
  check((await c1.locator('.fb.good').textContent())?.includes('一次就做对了'), '做对了：具体地夸（一次就做对，先想清楚再写）');
  check(await pad.locator('[data-ch="c2"]').isHidden(), '一题一题来：第 1 题没做，看不到第 2 题');
  await c1.locator('[data-go]').click();
  // c2: three misses. Each one praises something real and gives a reason to go on; then the Pad shows how, and the child does a similar one alone.
  const c2 = pad.locator('[data-ch="c2"]');
  await c2.locator('[data-f="a"]').fill('4'); await c2.locator('[data-u="a"]').selectOption('米');
  await c2.locator('[data-chk]').click();
  check((await c2.locator('.fb.try').textContent())?.startsWith('长完全做对了'), '答错先夸做对的部分：“长完全做对了”');
  check(await c2.locator('[data-go]').isHidden(), '答错了不能直接跳到下一题');
  await c2.locator('[data-chk]').click();
  check((await c2.locator('.fb.try').textContent())?.includes('提示：'), '第 2 次错自动给提示');
  await c2.locator('[data-chk]').click();
  await c2.locator('.worked li').first().waitFor();
  await c2.locator('.twin [data-tchk]').waitFor({ timeout: 30000 });
  const steps = await c2.locator('.worked li').allTextContents();
  check(steps.length === 4 && steps[3].includes('16 个样方') && await c2.locator('.ans.shown').count() === 1, `错 3 次：分步演示 ${steps.length} 步，最后把答案填进框里`);
  check((await c2.locator('.twin [data-tprompt]').textContent())?.includes('12 米'), '演示完出一道同类题（卷尺换成 12 米）让孩子自己做');
  for (const [f, v, u] of [['a', '3', '米'], ['b', '3', '米'], ['S', '9', '平方米']]) { await c2.locator(`.twin [data-f="${f}"]`).fill(v); await c2.locator(`.twin [data-u="${f}"]`).selectOption(u); }
  await c2.locator('.twin [data-tchk]').click();
  check(/自己做出来了|全靠你自己/.test((await c2.locator('.twin .fb.good').textContent()) ?? ''), '同类题自己做对了：夸他马上就会用了');
  await pad.screenshot({ path: join(shots, 'pad-worked.png') });
  await c2.locator('[data-go]').click();
  const c3 = pad.locator('[data-ch="c3"]');
  for (const [f, v, u] of [['P', '18', '厘米'], ['S', '14', '平方厘米']]) { await c3.locator(`[data-f="${f}"]`).fill(v); await c3.locator(`[data-u="${f}"]`).selectOption(u); }
  await c3.locator('[data-chk]').click(); await c3.locator('[data-go]').click();
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
  check(detail.includes('看了一遍分步演示，同类题自己做对了'), '家长看到哪道题看了演示、同类题自己做对了');
  check(detail.includes('下一课想学：“机器人”'), '家长看到孩子的下一课心愿');
  await parent.screenshot({ path: join(shots, 'parent-record.png') });
  await parent.click('[data-t="兴趣与心愿"]');
  await parent.waitForSelector('#add');
  const ints = (await parent.textContent('#view'))!;
  check(/机器人 · 下一课心愿 · 孩子自述/.test(ints), '心愿自动记为哥哥自己的兴趣');
  const meimeiCard = await parent.locator('.card:has(h3:text-is("妹妹"))').textContent();
  check(!meimeiCard?.includes('机器人'), '妹妹的兴趣里没有哥哥的心愿');
  const prep = await parent.locator('.card:has(h3:text-is("哥哥")) .prep').textContent();
  check(!!prep && /下一课准备单[\s\S]*机器人[\s\S]*下一节课按它出[\s\S]*机器人工厂/.test(prep), '心愿马上变成哥哥的下一课准备单：排第一，用机器人工厂场景');
  check(!!prep?.includes('不够写实'), '准备单写明机器人场景的写实版还在做');
  await parent.locator('.card:has(h3:text-is("哥哥")) .prep').screenshot({ path: join(shots, 'parent-prep.png') });

  // Count on the server: every event exactly once.
  const sessions = await (await fetch(`${base}/v1/sessions`, { headers: { authorization: `Bearer ${tok}` } })).json();
  const local = await pad.evaluate(() => (window as any).__player.events.length);
  check(sessions.length === 1 && sessions[0].events === local, `服务器收到全部 ${local} 条事件，没有重复`);

  // Pause in the middle of a lesson, go on, then leave; the same day it goes on from that step.
  await pad.click('#exit');
  await pad.waitForSelector('.lesson');
  await pad.click('.lesson'); await pad.waitForSelector('#start'); await pad.click('#start');
  await pad.waitForSelector('#next:not([disabled])', { timeout: 30000 }); await pad.click('#next');
  await pad.waitForSelector('#stage canvas', { timeout: 30000 });
  await pad.click('#pause');
  const t1 = await pad.textContent('#left'); await pad.waitForTimeout(2500); const t2 = await pad.textContent('#left');
  check(t1 === t2 && await pad.locator('.pausecard').isVisible(), `点「暂停」：盖上暂停卡，时间停在 ${t1}`);
  await pad.screenshot({ path: join(shots, 'pad-pause.png') });
  await pad.click('#unpause');
  await pad.waitForFunction(t => document.getElementById('left')?.textContent !== t, t1, { timeout: 5000 });
  ok('点「继续上课」，时间接着走');
  await pad.click('#pause'); await pad.click('#leave');
  await pad.waitForSelector('.lesson');
  check((await pad.textContent('.lesson'))?.includes('上到第 2 步，可以接着上'), '点「退出，下次接着上」回到今天的课，写着上到第 2 步');
  await pad.click('.lesson'); await pad.waitForSelector('#cont');
  check((await pad.textContent('#body'))?.includes('上次上到第 2 步「互动演示」'), '再点开：问接着上还是从头开始');
  await pad.click('#cont'); await pad.waitForSelector('#stage canvas', { timeout: 30000 });
  check((await pad.textContent('#gstep'))?.includes('第 2 步'), '点「接着上」直接回到第 2 步，不用从头听说明');
  const again = await (await fetch(`${base}/v1/sessions`, { headers: { authorization: `Bearer ${tok}` } })).json();
  check(again.length === 2, '接着上还算同一次学习记录（今天一共 2 次）');
  check(errors.length === 0, errors.length ? '页面错误：' + errors.join(' | ') : '两个页面都没有报错');
} finally {
  await browser.close();
  await app.close();
}
