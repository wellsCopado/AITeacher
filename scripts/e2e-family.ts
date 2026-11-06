// 探索课按家里的上课规则走一遍（真服务器、真浏览器）：按 Skill 做好的课程包先过 check_package.py，
// 家长在「课程库 → 探索课」导入、预览、发布、排到今天；孩子在平板上：步骤按顺序解锁、讲解和题目出字幕、
// 答错先夸再说看哪里、错 3 次先演示再做同类题、休息 / 退出后接着上、动手题、预渲染画面的步骤、学完问心愿；
// 家长在学习记录里看到哪题借助了帮助。预览里再看一步到时间自动进下一步。
// 用法：pnpm e2e:family [截图目录] [--package 课程包目录]（不给课程包时用 test/fixtures/family-lesson 现做一个小包）
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { zipSync } from 'fflate';
import { build } from 'esbuild';
import { buildApp } from '../apps/server/src/app.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const pkgArg = args.includes('--package') ? args[args.indexOf('--package') + 1] : undefined;
const shots = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--package') ?? join(root, 'e2e-shots');
mkdirSync(shots, { recursive: true });
const fail = (m: string) => { console.error('✗ ' + m); process.exitCode = 1; };
const ok = (m: string) => console.log('✓ ' + m);
const check = (cond: unknown, m: string) => (cond ? ok(m) : fail(m));
const skill = join(root, 'skills', 'discovery-lesson-maker');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function wav(seconds: number) {
  const n = Math.round(22050 * seconds), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(22050, 24); b.writeUInt32LE(44100, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
}
// 测试用的小主角：一个三角面，补到 2 KB，好让素材清单真的要登记它。不是写实素材。
function tinyGlb() {
  const bin = Buffer.alloc(2048); [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => bin.writeFloatLE(v, i * 4));
  const doc = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteLength: 36 }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }] };
  let json = Buffer.from(JSON.stringify(doc)); json = Buffer.concat([json, Buffer.alloc(-json.length % 4 & 3, 0x20)]);
  const chunk = (t: number, d: Buffer) => { const h = Buffer.alloc(8); h.writeUInt32LE(d.length, 0); h.writeUInt32LE(t, 4); return Buffer.concat([h, d]); };
  const body = Buffer.concat([chunk(0x4e4f534a, json), chunk(0x004e4942, bin)]);
  const head = Buffer.alloc(12); head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([head, body]);
}

/** 照 Skill 做一个小课程包：上课流程、每句录音、素材清单都齐。 */
async function fixturePackage() {
  const dir = join(mkdtempSync(join(tmpdir(), 'adw-family-')), 'package');
  const src = join(dir, 'web', 'src'), dist = join(dir, 'web', 'dist');
  mkdirSync(src, { recursive: true }); mkdirSync(join(dist, 'models'), { recursive: true });
  for (const f of ['adw-host.mjs', 'adw-family.mjs', 'adw-family-phrases.json']) copyFileSync(join(skill, 'assets', 'web', f), join(src, f));
  const fx = join(root, 'test', 'fixtures', 'family-lesson');
  copyFileSync(join(fx, 'main.js'), join(src, 'main.js')); copyFileSync(join(fx, 'index.html'), join(dist, 'index.html'));
  await build({ entryPoints: [join(src, 'main.js')], bundle: true, format: 'esm', target: 'es2022', outfile: join(dist, 'assets', 'index.js'), nodePaths: [join(root, 'node_modules')], logLevel: 'error' });
  const flow = JSON.parse(readFileSync(join(skill, 'examples', 'lesson-flow.example.json'), 'utf8'));
  flow.lesson = 'X-E2E-FAMILY';
  writeFileSync(join(dist, 'lesson-flow.json'), JSON.stringify(flow));
  const lines = JSON.parse(execFileSync('python3', ['-c', 'import json,sys; sys.path.insert(0, sys.argv[1]); from family_flow import all_lines, line_file; print(json.dumps(sorted({line_file(l, t) for l, t, _ in all_lines(json.load(open(sys.argv[2])))})))', join(skill, 'scripts'), join(dist, 'lesson-flow.json')], { encoding: 'utf8' }));
  for (const f of lines as string[]) { mkdirSync(dirname(join(dist, f)), { recursive: true }); writeFileSync(join(dist, f), wav(0.2)); }
  const glb = tinyGlb(); writeFileSync(join(dist, 'models', 'hero.glb'), glb);
  const topic = '斜拉桥';
  writeFileSync(join(dir, 'exploration.json'), JSON.stringify({ format: 'adw-explore/1', topic, id: 'X-E2E-FAMILY', version: '1.0', title: '斜拉桥：谁拉住了桥面', for_child: 'gege', concept: '平均分', subjects: ['数学', '科学', '英语'], minutes: 15, summary: '拖开拉索、摆桥墩把桥面平均分。', entry: 'web/dist/index.html' }));
  mkdirSync(join(dir, 'research'));
  writeFileSync(join(dir, 'research', 'assets.json'), JSON.stringify({ topic, items: [{ file: 'web/dist/models/hero.glb', sha256: sha(glb), role: 'hero', depicts: '斜拉桥（测试用三角面）', made_for: topic, origin: 'procedural', how: 'e2e-family.ts 生成', license: '自制' }] }));
  writeFileSync(join(dir, 'research', 'sources.json'), '{"sources":[]}');
  mkdirSync(join(dir, 'evidence')); writeFileSync(join(dir, 'evidence', 'visual-gate.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9])); // 占位：测试不看画面
  for (const f of ['README.md', '课程设计.md', '验收结果.md']) writeFileSync(join(dir, f), `# ${f}\n\n端到端测试包。\n`);
  return dir;
}

function zipFolder(dir: string) {
  const files: Record<string, Uint8Array> = {};
  const walk = (at: string) => { for (const n of readdirSync(at)) {
    if (/^(node_modules|\.git|\.DS_Store)$/.test(n)) continue;
    const f = join(at, n); if (statSync(f).isDirectory()) walk(f); else files[`package/${relative(dir, f).split('\\').join('/')}`] = new Uint8Array(readFileSync(f));
  } };
  walk(dir);
  return Buffer.from(zipSync(files, { level: 0 }));
}

const pkg = pkgArg ?? await fixturePackage();
let pre: { errors?: string[]; checks?: { familyFlow?: boolean } } = {};
try { pre = JSON.parse(execFileSync('python3', [join(skill, 'scripts', 'check_package.py'), pkg], { encoding: 'utf8' })); }
catch (e) { pre = JSON.parse((e as { stdout?: string }).stdout || '{"errors":["check_package.py 没跑起来"]}'); }
check(pre.errors?.length === 0 && pre.checks?.familyFlow, `课程包过 check_package.py（上课流程、录音、素材清单）${pre.errors?.length ? '：' + pre.errors.join(' | ') : ''}`);
const flow = JSON.parse(readFileSync(join(pkg, 'web', 'dist', 'lesson-flow.json'), 'utf8'));
const id = JSON.parse(readFileSync(join(pkg, 'exploration.json'), 'utf8')).id as string;
const key = `${id}@1.0`;

execFileSync('node', [join(root, 'scripts', 'build-apps.mjs')], { stdio: 'ignore' });
const PIN = '2468';
const tts = { voices: { zh: 'Tingting', en: 'Samantha' }, make: async () => wav(0.2) };
const app = await buildApp({ root, dbPath: join(mkdtempSync(join(tmpdir(), 'adw-e2e-')), 'db.sqlite'), pin: PIN, serveApps: true, tts });
await app.listen({ host: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
// 每个页面（含课程 iframe）记下字幕条出现过的每一句
const recordSubs = () => {
  const w = window as any; w.__subs = [];
  new MutationObserver(() => { const t = document.querySelector('.adw-family-sub')?.textContent; if (t && w.__subs.at(-1) !== t) w.__subs.push(t); })
    .observe(document, { subtree: true, childList: true, characterData: true });
};

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
try {
  const parent = await (await browser.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
  const padCtx = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
  await padCtx.addInitScript(recordSubs);
  const pad = await padCtx.newPage();
  const errors: string[] = [];
  for (const p of [parent, pad]) p.on('pageerror', (e: Error) => errors.push(e.message));

  await parent.goto(`${base}/parent/`);
  await parent.fill('#pin', PIN); await parent.click('.login button');
  await parent.waitForSelector('.tabs');
  await pad.goto(`${base}/pad/?adw_time=1`);
  await pad.waitForFunction(() => /\d{3} \d{3}/.test(document.getElementById('code')?.textContent ?? ''));
  const code = (await pad.textContent('#code'))!.replace(/\s/g, '');
  await parent.click('[data-t="设备与数据"]');
  await parent.fill('#pair [name=code]', code); await parent.fill('#pair [name=label]', '哥哥的平板');
  await parent.click('#pair button');
  await pad.waitForSelector('.kidbtn', { timeout: 10000 });
  await pad.click('.kidbtn[data-id="gege"]');

  // 家长导入、看提示、预览、发布、排到今天
  await parent.click('[data-t="课程库"]');
  await parent.waitForSelector('#ximport');
  await parent.setInputFiles('#ximport input[type=file]', { name: 'family-e2e.zip', mimeType: 'application/zip', buffer: zipFolder(pkg) });
  await parent.click('#ximport button');
  await parent.waitForSelector(`.xdraft[data-k="${key}"]`, { timeout: 60000 });
  const card = parent.locator(`.xdraft[data-k="${key}"]`);
  const cardText = (await card.textContent()) ?? '';
  check(!cardText.includes('没按家里的上课规则') && !cardText.includes('画面没按主题登记'), '导入后卡片上没有“没按家里的上课规则”“画面没按主题登记”的提示');
  await card.screenshot({ path: join(shots, 'family-card.png') });

  const [pv] = await Promise.all([parent.waitForEvent('popup'), card.locator('a.btn').click()]);
  await pv.waitForFunction(() => (window as any).__lesson, null, { timeout: 60000 });
  const before = await pv.evaluate(() => (window as any).__lesson.engine.state.step);
  await pv.evaluate((s) => (window as any).__lesson.engine.tick(s), flow.steps[0].seconds);
  const after = await pv.evaluate(() => { const s = (window as any).__lesson.engine.state; return { step: s.step, t: s.tasks[Object.keys(s.tasks)[0]] }; });
  check(before === 0 && after.step === 1 && after.t.timeout, '家长预览：第 1 步到时间自动进第 2 步，没做完的题记“超时”');
  await pv.close();
  // 画面对照图放在卡片最前面；没勾“对照图看过了”不能发布
  await card.locator('.xgate img[src^="blob:"]').waitFor({ timeout: 15000 });
  ok('家长卡片最前面显示画面对照图');
  await card.locator('.seen').check(); await card.locator('.xapprove').click();
  await parent.waitForFunction(() => /画面对照图/.test(document.getElementById('toast')?.textContent ?? ''));
  ok('没勾“对照图看过了”不能发布');
  await card.locator('.gseen').check(); await card.locator('.xapprove').click();
  await parent.waitForSelector('#jp');
  await parent.click('#jp .when[data-n="0"]');
  await parent.waitForFunction(() => /已排到今天/.test(document.getElementById('toast')?.textContent ?? ''));
  ok('家长预览过、发布、排到今天');

  // 孩子上课
  await pad.reload();
  await pad.waitForSelector('.kidbtn', { timeout: 10000 }).then(() => pad.click('.kidbtn[data-id="gege"]')).catch(() => {});
  await pad.waitForSelector(`.lesson[data-key="${key}"]`);
  await pad.click(`.lesson[data-key="${key}"]`);
  const fr = pad.frameLocator('#xframe');
  const frame = async () => pad.frames().find(f => f.url().includes('/explore/'))!;
  await fr.locator('.adw-family-steps li').first().waitFor({ timeout: 60000 });
  const f1 = await frame();
  await f1.waitForFunction(() => (window as any).__ready, null, { timeout: 120000 });
  const classes = await fr.locator('.adw-family-steps li').evaluateAll(els => els.map(e => e.className));
  check(classes[0] === 'now' && classes.slice(1).every(c => c === 'locked'), '只有第 1 步亮着，后面的步骤锁着');
  check(await fr.locator('.adw-family-next').isDisabled(), '题没做完，“下一步”点不了');
  await f1.waitForFunction((t) => (window as any).__subs.includes(t), flow.tasks.which.ask, { timeout: 15000 });
  const subs1 = await f1.evaluate(() => (window as any).__subs.slice());
  check(subs1.includes(flow.narration.intro.zh) && subs1.indexOf(flow.narration.intro.zh) < subs1.indexOf(flow.tasks.which.ask), '进第 1 步先出讲解字幕（中文），再出题目字幕');
  await pad.screenshot({ path: join(shots, 'family-step1.png') });

  const wrong = flow.tasks.which.options.find((o: any) => !o.right);
  for (let i = 0; i < 3; i++) {
    await fr.locator(`#task button[data-option="${wrong.id}"]`).click();
    if (i < 2) await f1.waitForFunction((t) => (window as any).__subs.includes(t), wrong.look);
  }
  await fr.locator('#task .demo').waitFor({ timeout: 20000 });
  await f1.waitForFunction((t) => (window as any).__subs.includes(t), flow.tasks.which.worked_example[0], { timeout: 20000 });
  const subs2 = await f1.evaluate(() => (window as any).__subs.slice());
  const g = subs2.indexOf(wrong.good), l = subs2.indexOf(wrong.look), p = subs2.indexOf(flow.encouragement.persist[0]);
  check(g >= 0 && g < l && l < p, '答错：先夸做对的地方，再说看哪里，再给坚持的理由');
  check(subs2.includes(flow.tasks.which.hints[0]), '第 2 次错给提示');
  ok('错 3 次：开始一步一步演示');
  await fr.locator('#task button[data-option="l"]').waitFor({ timeout: 30000 });
  check((await fr.locator('#task .ask').textContent()) === flow.tasks.which.twin.ask, '演示完出同类题');
  await fr.locator('#task button[data-option="l"]').click();
  await fr.locator('.adw-family-next:not([disabled])').waitFor();
  ok('同类题做对，“下一步”可以点了');
  await pad.waitForFunction(() => /已核对 1\/3 项/.test(document.getElementById('xprog')?.textContent ?? ''), null, { timeout: 10000 });
  ok('平板顶上显示“已核对 1/3 项”');
  await fr.locator('.adw-family-next').click();
  await fr.locator('.adw-family-steps li.now', { hasText: flow.steps[1].title }).waitFor();

  // 休息：倒计时停住；退出再进，接着第 2 步
  await pad.click('#xrest'); await pad.waitForSelector('#xcard:not([hidden])');
  const t0 = await fr.locator('.adw-family-time').textContent();
  await pad.waitForTimeout(2500);
  check((await fr.locator('.adw-family-time').textContent()) === t0, '点“休息”：倒计时停住');
  await pad.click('#xleave');
  await pad.waitForSelector(`.lesson[data-key="${key}"]`);
  await pad.click(`.lesson[data-key="${key}"]`);
  await fr.locator('.adw-family-steps li.now', { hasText: flow.steps[1].title }).waitFor({ timeout: 60000 });
  ok('退出再进：从第 2 步接着上');

  // 动手题：摆桥墩（12 格平均分 3 段）
  await fr.locator('#task .cells button').first().waitFor();
  await fr.locator('#task .cells button[data-cell="4"]').click();
  await fr.locator('#task .cells button[data-cell="8"]').click();
  await fr.locator('#task .check').click();
  await fr.locator('.adw-family-next:not([disabled])').waitFor();
  ok('动手题按场景状态判对');
  await fr.locator('.adw-family-next').click();
  await fr.locator('.adw-family-steps li.now', { hasText: flow.steps[2].title }).waitFor();
  if (flow.steps[2].media === 'render') check(await fr.locator('#still').isVisible(), '第 3 步写的是 media: render，给孩子看预渲染画面');
  await pad.screenshot({ path: join(shots, 'family-step3.png') });
  await fr.locator('#task .check').click();
  // 最后一题做完，全部核对通过：App 自己弹出“学完了”
  await pad.waitForSelector('#xwish', { timeout: 15000 });
  check((await pad.textContent('#xcard'))?.includes('3 项都核对完了'), '最后一步做完：平板说学完了，问下一次想探索什么');
  const pick = flow.wish.options[0];
  await pad.click(`#xcard .xpick[data-w="${pick}"]`);
  check((await pad.inputValue('#xwish')) === pick, `课末给孩子点选下一课主题（${flow.wish.options.join('、')}），点了就填好`);
  await pad.click('#xbye');
  await pad.waitForSelector(`.lesson[data-key="${key}"]`);
  await pad.evaluate(() => (window as any).__pad.flush());

  await parent.click('[data-t="学习记录"]');
  await parent.waitForSelector('.open');
  await parent.locator('tr', { hasText: '斜拉桥' }).first().locator('.open').click();
  await parent.waitForSelector('#detail .card');
  const detail = (await parent.textContent('#detail')) ?? '';
  check(detail.includes('核对了 3/3 项') && detail.includes(`${flow.tasks.which.label}（借助帮助完成）`), '家长在学习记录里看到 3/3 项，看了演示的那题记“借助帮助完成”');
  await parent.screenshot({ path: join(shots, 'family-record.png') });
  check(errors.length === 0, errors.length ? '页面错误：' + errors.join(' | ') : '家长端、平板和课程页面都没有报错');
} finally {
  await browser.close();
  await app.close();
}
