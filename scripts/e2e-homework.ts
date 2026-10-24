// Homework loop in a real browser against a real server, with the dls commands the homework-analysis Skill uses:
// parent uploads a photo → Skill pulls and recognises → parent checks items → Skill judges → parent confirms →
// reteach ticket, parent card, mastery. Usage: pnpm e2e:homework [outDir]
import { createRequire } from 'node:module';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
const tmp = mkdtempSync(join(tmpdir(), 'adw-hw-e2e-'));
const app = await buildApp({ root, dbPath: join(tmp, 'db.sqlite'), pin: PIN, serveApps: true });
await app.listen({ host: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
// Async on purpose: the server runs in this process and must keep answering while the CLI talks to it.
const run = promisify(execFile);
const dls = async (...args: string[]) => {
  try { return (await run('pnpm', ['-s', 'dls', ...args], { cwd: root, env: { ...process.env, ADW_SERVER: base, ADW_PIN: PIN, NODE_NO_WARNINGS: '1' }, encoding: 'utf8' })).stdout; }
  catch (e) { return String((e as { stdout?: string }).stdout ?? '') + String((e as { stderr?: string }).stderr ?? ''); }
};
const hwDir = join(root, 'content', 'homework', 'HW-0001');
rmSync(hwDir, { recursive: true, force: true });

const browser = await chromium.launch();
try {
  // A photo of a worksheet: rendered from HTML and saved as a JPEG, like a phone photo.
  const sheet = await (await browser.newContext({ viewport: { width: 1000, height: 640 }, deviceScaleFactor: 2 })).newPage();
  await sheet.goto(pathToFileURL(join(root, 'test', 'fixtures', 'worksheet.html')).href);
  const photo = join(tmp, 'worksheet.jpg');
  await (await sheet.$('.page'))!.screenshot({ path: photo, type: 'jpeg', quality: 85 });
  writeFileSync(join(shots, 'worksheet.jpg'), readFileSync(photo));

  const parent = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  const errors: string[] = [];
  parent.on('pageerror', (e: Error) => errors.push(e.message));
  await parent.goto(`${base}/parent/`);
  await parent.fill('#pin', PIN); await parent.click('.login button');
  await parent.waitForSelector('.tabs');
  await parent.click('[data-t="作业"]');
  await parent.waitForSelector('#up');
  await parent.selectOption('#up [name=child]', 'gege');
  await parent.fill('#up [name=note]', '周长与面积练习');
  await parent.setInputFiles('#up [name=photos]', photo);
  await parent.check('#up [name=consent]');
  await parent.click('#up button');
  await parent.waitForFunction(() => document.getElementById('toast')?.textContent?.includes('已上传 HW-0001'));
  ok('家长上传作业照片（浏览器内压缩）');

  // Skill: list, pull, recognise.
  check((await dls('homework', 'list')).includes('HW-0001 gege'), 'dls homework list 看到这份作业');
  const pulled = await dls('homework', 'pull', 'HW-0001');
  check(pulled.includes('已下载 1 张照片') && existsSync(join(hwDir, 'p1.jpg')), 'dls homework pull 下载了照片（家长已同意）');
  writeFileSync(join(hwDir, 'recognition.json'), readFileSync(join(root, 'test', 'fixtures', 'worksheet.recognition.json')));
  check((await dls('homework', 'recognize', 'HW-0001')).includes('4 题，其中 1 题置信度低'), 'dls homework recognize 上传识别结果');
  check((await dls('homework', 'draft', 'HW-0001')).includes('家长还没核对完'), '家长核对前不能写判断');

  // Parent checks: confirm the confident ones, then look at the 请核对 one and fix the note on item 2.
  await parent.click('.open[data-id="HW-0001"]');
  await parent.waitForSelector('.items');
  await parent.waitForSelector('#photos img');
  check(await parent.locator('.items tr.check').count() === 1, '低置信度的题标了“请核对”');
  await parent.click('#sure');
  await parent.waitForFunction(() => document.querySelectorAll('.items tr.done').length === 3);
  await parent.locator('.items tr[data-no="3"] .ok').click();
  await parent.waitForFunction(() => document.querySelectorAll('.items tr.done').length === 4);
  await parent.locator('.items tr[data-no="2"] [name=teacher_note]').fill('单位写错');
  await parent.locator('.items tr[data-no="2"] .ok').click();
  await parent.waitForFunction(() => document.querySelector('.items tr[data-no="2"]')?.textContent?.includes('原为'));
  await parent.screenshot({ path: join(shots, 'parent-homework-check.png'), fullPage: true });
  ok('家长逐题核对，改过的题保留原识别值');

  // Skill: draft, a first try that judges the child (refused), then a proper judgment.
  check((await dls('homework', 'draft', 'HW-0001')).includes('家长改过第 2 题'), 'dls homework draft 提示家长改过的题');
  const draft = JSON.parse(readFileSync(join(hwDir, 'judgment.json'), 'utf8'));
  check(draft.mastery[0]?.state === '需再支持' && draft.facts.length === 4, '草稿按核对后的题写好事实和掌握状态');
  const judgment = {
    ...draft,
    facts: [
      { text: '周长题（第 1 题）和求宽的题（第 4 题）都做对了。', items: ['1', '4'] },
      { text: '第 2 题算式 6×4=24 正确，面积单位写成了“米”，老师批错，批注“单位写错”。', items: ['2'] },
      { text: '第 3 题面积写了“平方分米”，老师批对。', items: ['3'] },
    ],
    gaps: [{ concept_id: 'M3.MEAS.perimeter_vs_area', misconception: 'MC.unit_len_vs_area', text: '可能在长度单位和面积单位之间切换时不稳定：第 3 题写对了，第 2 题没写对。', confidence: 0.55, verify_by: '下次作业看米和平方米混在一起的题', items: ['2', '3'] }],
    unknowns: ['不知道第 2 题是没想到“面积要用平方米”，还是写的时候顺手写了“米”。'],
    next: [{ kind: '重教', concept_id: 'M3.MEAS.perimeter_vs_area', text: '把“拉卷尺围一圈”和“铺 1 平方米样方”放在一起对比，读数时分别读出“米”和“平方米”。' }],
    mastery: [{ concept_id: 'M3.MEAS.perimeter_vs_area', state: '需再支持', evidence: ['2'] }],
    parent_card: { facts: '这次 4 题对了 3 题，第 2 题面积单位写成了米。', child_share: '', unverified: '可能是面积和长度单位还容易混。', talk: '可以问：围一圈用的是什么尺子？铺满地面数的是什么？' },
  };
  writeFileSync(join(hwDir, 'judgment.json'), JSON.stringify({ ...judgment, unknowns: ['他有点粗心'] }, null, 2));
  const refused = await dls('homework', 'check', 'HW-0001');
  check(refused.includes('✗ J03') && refused.includes('粗心'), 'dls homework check 拦下评价孩子本人的话（J03）');
  writeFileSync(join(hwDir, 'judgment.json'), JSON.stringify(judgment, null, 2));
  check((await dls('homework', 'submit', 'HW-0001')).includes('已提交 LJ-0001（草稿）'), 'dls homework submit 提交判断草稿');

  // Parent reads and confirms the judgment; a reteach ticket appears; the card is edited.
  await parent.click('#back'); await parent.click('.open[data-id="HW-0001"]');
  await parent.waitForSelector('#confirmJ');
  await parent.screenshot({ path: join(shots, 'parent-judgment.png'), fullPage: true });
  await parent.click('#confirmJ');
  await parent.waitForFunction(() => document.getElementById('toast')?.textContent?.includes('RT-0001'));
  ok('家长确认判断，生成重教需求 RT-0001');
  await parent.waitForSelector('#card');
  await parent.fill('#card [name=talk]', '晚饭后一起量一下餐桌，看看围一圈和铺满各用什么单位。');
  await parent.click('#card button.primary');
  await parent.waitForFunction(() => document.getElementById('toast')?.textContent?.includes('家长卡已保存'));
  ok('家长改写家长卡');
  await parent.fill('#fb [name=said]', '老师说最近面积单位常写错');
  await parent.click('#fb button');
  await parent.waitForFunction(() => document.querySelector('#view')?.textContent?.includes('老师说最近面积单位常写错'));
  ok('老师的原话按来源记下');

  await parent.click('[data-t="掌握与重教"]');
  await parent.waitForSelector('#view h4:text("重教需求")');
  const mastery = (await parent.textContent('#view'))!;
  check(mastery.includes('周长与面积的区别') && mastery.includes('需再支持') && mastery.includes('RT-0001'), '掌握与重教页显示状态和重教需求');
  await parent.screenshot({ path: join(shots, 'parent-mastery.png'), fullPage: true });
  const t = await dls('tickets');
  check(t.includes('RT-0001 gege') && t.includes('trigger_judgment_ref: LJ-0001'), 'dls tickets 给出下一步（这个知识点还没发布过课时提示新做一节）');

  await parent.click('[data-t="设备与数据"]');
  await parent.waitForSelector('.export');
  const [download] = await Promise.all([parent.waitForEvent('download'), parent.click('.export[data-c="gege"]')]);
  const exported = JSON.parse(readFileSync(await download.path(), 'utf8'));
  check(exported.homework.length === 1 && exported.judgments.length === 1 && exported.feedback.length === 1, '导出哥哥的全部数据');
  check(errors.length === 0, errors.length ? '页面错误：' + errors.join(' | ') : '页面没有报错');
} finally {
  await browser.close();
  await app.close();
  rmSync(hwDir, { recursive: true, force: true });
}
