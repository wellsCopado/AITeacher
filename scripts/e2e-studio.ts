// AI lesson writing in a real browser: the parent adds a model (a stand-in OpenAI-compatible server on this
// machine), tests it, switches models, lets an AI assistant in over MCP, has a lesson written, sends it back
// with a note and has it revised. Usage: pnpm e2e:studio [outDir]
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildApp } from '../apps/server/src/app.js';
import { exampleStages } from '../packages/studio/src/index.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? join(root, 'e2e-shots');
mkdirSync(shots, { recursive: true });
const fail = (m: string) => { console.error('✗ ' + m); process.exitCode = 1; };
const ok = (m: string) => console.log('✓ ' + m);
const check = (cond: unknown, m: string) => (cond ? ok(m) : fail(m));

execFileSync('node', [join(root, 'scripts', 'build-apps.mjs')], { stdio: 'ignore' });

// A stand-in model: lists two models, answers the test line, and writes the example lesson (the first time
// without encouragement, so the validator sends it back once).
const asked: string[] = [];
let lessonReplies = 0;
const model = createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'family-small' }, { id: 'family-large' }] }));
    const msgs = JSON.parse(body).messages as { content: string }[];
    asked.push(msgs.map(m => m.content).join('\n'));
    if (msgs[0].content.startsWith('用一句话')) return res.end(JSON.stringify({ choices: [{ message: { content: '我是家里的测试模型。' } }] }));
    const s = structuredClone(exampleStages(root));
    if (lessonReplies++ === 0) delete s.director.encouragement;
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(s) } }] }));
  });
});
await new Promise<void>(r => model.listen(0, '127.0.0.1', r));
const modelUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;

const PIN = '2468';
const app = await buildApp({ root, dbPath: join(mkdtempSync(join(tmpdir(), 'adw-e2e-')), 'db.sqlite'), pin: PIN, serveApps: true, tts: null });
await app.listen({ host: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  await page.goto(`${base}/parent/`);
  await page.fill('#pin', PIN); await page.click('.login button');
  await page.waitForSelector('.tabs');

  // 课程库 before any model: the card says where to set one up.
  await page.click('[data-t="课程库"]');
  await page.waitForSelector('#writer');
  check((await page.textContent('#writer'))?.includes('还没有设置大模型'), '没设置模型时，「AI 出一节课」提示先去设置');

  // 设备与数据 → 大模型: a preset fills the address, the list comes from the model server, the test answers.
  await page.click('[data-t="设备与数据"]');
  await page.waitForSelector('#mform');
  await page.selectOption('#mform [name=provider]', 'deepseek');
  check(await page.inputValue('#mform [name=base_url]') === 'https://api.deepseek.com' && await page.inputValue('#mform [name=model]') === 'deepseek-v4-pro', '选 DeepSeek 自动填好接口地址和模型名');
  await page.fill('#mform [name=api_key]', 'sk-e2e-secret-9999');
  await page.click('#mform button.primary');
  await page.waitForSelector('#models tr:nth-child(2)');
  const html = await page.content();
  check(html.includes('••••9999') && !html.includes('sk-e2e-secret'), '保存后 Key 只显示后 4 位，页面里没有完整 Key');

  await page.selectOption('#mform [name=provider]', 'ollama');
  await page.fill('#mform [name=base_url]', modelUrl);
  await page.fill('#mform [name=label]', '家里的测试模型');
  await page.click('#mlistbtn');
  await page.waitForFunction(() => document.getElementById('mresult')?.textContent?.includes('family-small'));
  check(await page.locator('#mlist option').count() === 2, '「获取模型列表」列出这个接口能用的模型');
  await page.fill('#mform [name=model]', 'family-large');
  await page.click('#mtry');
  await page.waitForFunction(() => document.getElementById('mresult')?.textContent?.includes('能用'));
  check((await page.textContent('#mresult'))?.includes('我是家里的测试模型'), '「测试」拿到模型的一句回答');
  await page.click('#mform button.primary');
  await page.waitForFunction(() => document.querySelectorAll('#models input[name=active]').length === 2);
  check(await page.locator('#models input[name=active]').nth(1).isChecked(), '新加的模型自动设为正在用的');
  await page.locator('#models input[name=active]').nth(0).check();
  await page.waitForFunction(() => document.getElementById('toast')?.textContent?.includes('已切换'));
  await page.locator('#models input[name=active]').nth(1).check();
  ok('在两个模型之间一键切换');
  check(await page.locator('#consent').count() === 1, '有“同意发送年级和兴趣主题”的勾选');
  await page.locator('#models').screenshot({ path: join(shots, 'parent-models.png') });

  // AI 助手接入: a token for Codex, shown once with ready-to-paste settings; it works over MCP; removing it stops it.
  await page.fill('#aform [name=label]', 'Codex');
  await page.click('#aform button');
  await page.waitForSelector('#asnip textarea');
  const snips: string[] = await page.locator('#asnip textarea').evaluateAll((els: HTMLTextAreaElement[]) => els.map(e => e.value));
  const token = snips[0];
  check(snips[1].includes('[mcp_servers.adw]') && snips[1].includes(`${base}/mcp`) && snips[2].startsWith('claude mcp add --transport http adw') && snips[3].includes('"mcpServers"'), '生成令牌后给出 Codex、Claude Code、Cursor/Qoder 的配置');
  await page.locator('#agents').screenshot({ path: join(shots, 'parent-agents.png') });
  const mcp = (tok: string) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  const tools = (await (await mcp(token)).json()).result.tools.map((t: { name: string }) => t.name);
  check(tools.includes('adw_submit_for_review') && !tools.some((t: string) => /publish|approve/.test(t)), `用这个令牌通过 MCP 看到做课工具（${tools.length} 个，没有发布工具）`);
  page.once('dialog', d => d.accept());
  await page.click('#agents .arevoke');
  await page.waitForFunction(() => document.getElementById('agents')?.textContent?.includes('还没有接入的助手'));
  check((await mcp(token)).status === 401, '移除后这个令牌马上不能用');

  // 课程库 → AI 出一节课 with the chosen model; the validator sends it back once and it comes back right.
  await page.click('[data-t="课程库"]');
  await page.waitForSelector('#wform');
  const before = await page.locator('.draft').count();
  await page.selectOption('#wform [name=child]', 'gege');
  await page.fill('#wform [name=wish]', '用大桥做主题');
  await page.click('#wform button');
  await page.waitForFunction(() => document.getElementById('toast')?.textContent?.includes('写好了'), null, { timeout: 30_000 });
  check(await page.locator('.draft').count() === before + 1, '写好的课出现在“等你审核”');
  const card = page.locator('.draft[data-k="L-PA-2@1.0"]');
  check((await card.textContent())?.includes('由 AI 出课 · 家里的测试模型 交来'), '审核卡片写明是哪个模型写的');
  check(asked.some(a => a.includes('用大桥做主题')) && asked.some(a => a.includes('[V18]')), '家长的要求发给了模型；校验问题自动发回让模型改');
  check(!asked.some(a => a.includes('"said"')), '发给模型的内容里没有孩子的原话');

  // The parent sends it back with a note; one button has it revised under the same id.
  await card.locator('.note').fill('第一题数字小一点');
  await card.locator('.reject').click();
  await page.waitForSelector('.draft[data-k="L-PA-2@1.0"] .revise');
  await page.click('.draft[data-k="L-PA-2@1.0"] .revise');
  await page.waitForFunction(() => document.getElementById('toast')?.textContent?.includes('写好了'), null, { timeout: 30_000 });
  check(asked.at(-1)!.includes('第一题数字小一点'), '「让 AI 按意见改」把家长的意见发给模型');
  check((await page.locator('.draft[data-k="L-PA-2@1.0"] .badge').first().textContent()) === '待审核', '改好的课重新回到“待审核”（id 不变）');
  await page.locator('#writer').screenshot({ path: join(shots, 'parent-writer.png') });
  check(!errors.length, `页面没有脚本错误${errors.length ? '：' + errors.join('；') : ''}`);
} finally {
  await browser.close();
  await app.close();
  model.close();
}
