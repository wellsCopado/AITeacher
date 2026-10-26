import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { buildApp } from '../apps/server/src/app.js';
import {
  authorMessages, BRIEF_HEADER, checkStages, codexPrompt, codexResearch, codexStatus, createMcp, designPrompt, exampleStages, generateLesson, guide, INSTALL_CODEX, LOGIN_CODEX,
  localBackend, modelFromEnv, normalize, parseJsonReply, serveStdio, studioContext, type Message, type Stages,
} from '../packages/studio/src/index.js';

const root = join(import.meta.dirname, '..');
const example = () => structuredClone(exampleStages(root));
const reply = (s: unknown) => '好的，这是课：\n```json\n' + JSON.stringify(s) + '\n```';

describe('lesson studio core', () => {
  it('gives a model only what lesson writing needs', () => {
    const ctx = studioContext(root, 'gege');
    expect(ctx.child).toMatchObject({ id: 'gege', grade: 4 });
    expect(ctx.components.map(c => c.name)).toContain('PerimeterArea');
    const pa = ctx.components.find(c => c.name === 'PerimeterArea')!;
    expect(pa.new_lesson_id).toBe('L-PA-2'); // L-PA is taken
    expect(pa.wish_question.kind).toBe('next_lesson_wish');
    const text = JSON.stringify(ctx);
    expect(text).not.toContain('"said"'); // a child's own words stay at home
    expect(ctx.interests.every(i => ctx.fixed.for_child === 'gege' && !('said' in i))).toBe(true);
    expect(JSON.stringify(studioContext(root, 'meimei').interests)).not.toContain('螳螂虾'); // never a sibling's interests
  });

  it('reads the Skill as one text', () => {
    const all = guide(root, 'all');
    for (const s of ['lesson-flow.md', 'validation.md', 'review-checklist.md']) expect(all).toContain(s);
    expect(guide(root, 'author')).not.toContain('review-checklist.md');
    expect(() => guide(root, 'nope' as 'all')).toThrow(/没有这个主题/);
  });

  it('checks stage files and says how to fix each problem', () => {
    expect(checkStages(root, example()).report.ok).toBe(true);
    const bad = example();
    bad.assets.use = [...bad.assets.use, 'X-not-registered'];
    const r = checkStages(root, bad);
    expect(r.spec).toBeNull();
    expect(r.report.results[0].id).toBe('S00');
    const noDemo = example();
    delete noDemo.director.challenges[0].worked_example;
    expect(checkStages(root, noDemo).report.results.find(x => x.id === 'V17')!.ok).toBe(false);
  });

  it('parses model replies and model settings from the environment', () => {
    expect(parseJsonReply('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonReply('结果：{"a":{"b":2}} 完')).toEqual({ a: { b: 2 } });
    expect(() => parseJsonReply('没有 JSON')).toThrow();
    expect(modelFromEnv({ ADW_LLM_PROVIDER: 'deepseek', ADW_LLM_API_KEY: 'sk-x' })).toMatchObject({ base_url: 'https://api.deepseek.com', model: 'deepseek-v4-pro', api_key: 'sk-x' });
    expect(modelFromEnv({ ADW_LLM_BASE_URL: 'http://localhost:11434/v1', ADW_LLM_MODEL: 'qwen3' })).toMatchObject({ provider: 'custom', model: 'qwen3' });
    expect(modelFromEnv({})).toBeNull();
  });

  it('keeps ids, child, grade, language and theme out of the model\'s hands', () => {
    const ctx = studioContext(root, 'gege');
    const raw = example();
    Object.assign(raw.target, { lesson_id: 'MADE-UP', for_child: 'meimei', tenant_id: 'other' });
    raw.target.learner_profile.language = { default: 'en', cycle_enabled: false };
    raw.director.theme = { ...raw.director.theme, id: 'not-a-theme' };
    const s = normalize(raw, ctx);
    expect(s.target).toMatchObject({ lesson_id: 'L-PA-2', for_child: 'gege', tenant_id: 'family-001', version: '1.0' });
    expect(s.target.learner_profile.language).toEqual({ default: 'zh', cycle_enabled: true });
    expect(s.director.theme.id).toBe(ctx.components.find(c => c.name === 'PerimeterArea')!.suggested_theme.id);
    expect(s.director.end_chat.questions.at(-1).kind).toBe('next_lesson_wish');
    expect(normalize(example(), ctx, { lesson_id: 'L-PA-7', version: '1.1' }).target).toMatchObject({ lesson_id: 'L-PA-7', version: '1.1' });
  });

  it('gives a cloud chat model a design brief to plan with, and hands the agreed plan to the writer', () => {
    const ctx = studioContext(root, 'gege');
    const text = designPrompt(ctx);
    expect(text).toContain(BRIEF_HEADER);
    expect(text).toContain('螳螂虾（近期最喜欢');
    expect(text).toContain('a 是 1–10 的整数');
    expect(text).not.toMatch(/"said"|IO-\d/);
    const brief = `${BRIEF_HEADER}\n孩子：哥哥\n知识点：周长与面积\n挑战题：1. …`;
    expect(authorMessages(root, ctx, { wish: brief })[1].content).toContain('谈好的课程方案，照它做');
    expect(authorMessages(root, ctx, { wish: '难一点' })[1].content).toContain('家长的要求：难一点');
  });

  it('writes a lesson with any chat model and feeds the validator\'s problems back', async () => {
    const ctx = studioContext(root, 'gege');
    const broken = example();
    delete broken.director.challenges[0].twin;
    const replies = ['抱歉，我不会', reply(broken), reply(example())];
    const seen: Message[][] = [];
    const r = await generateLesson({ root, ctx, chat: async m => { seen.push(structuredClone(m)); return replies.shift()!; } });
    expect(r.ok).toBe(true);
    expect(r.rounds).toBe(3);
    expect(r.spec!.lesson_id).toBe('L-PA-2');
    expect(seen[0][0].content).toContain('lesson-flow.md'); // the Skill is the system prompt
    expect(seen[1].at(-1)!.content).toContain('不是要求的 JSON');
    expect(seen[2].at(-1)!.content).toContain('[V17]');
  });
});

describe('MCP', () => {
  const mcp = createMcp(localBackend(root));
  const call = async (name: string, args: unknown = {}) => {
    const r = await mcp.handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }) as { result: { content: { text: string }[]; isError?: boolean } };
    return r.result;
  };

  it('speaks the protocol', async () => {
    const init = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) as { result: { protocolVersion: string; instructions: string } };
    expect(init.result.protocolVersion).toBe('2025-03-26');
    expect(init.result.instructions).toContain('adw_submit_for_review');
    expect(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    const list = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map(t => t.name)).toEqual(['adw_read_guide', 'adw_read_skill', 'adw_get_context', 'adw_next_lessons', 'adw_get_example', 'adw_check_lesson', 'adw_submit_for_review', 'adw_list_lessons', 'adw_get_lesson']);
    expect(list.result.tools.some(t => /publish|approve/.test(t.name))).toBe(false); // publishing stays the parent's button
    expect(await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'nope' })).toMatchObject({ error: { code: -32601 } });
    const batch = await mcp.handle([{ jsonrpc: '2.0', id: 4, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }]) as object[];
    expect(batch).toHaveLength(1);
  });

  it('serves every Skill to any model: the list, a whole Skill, one file, and nothing outside it', async () => {
    const index = (await call('adw_read_skill')).content[0].text;
    for (const s of ['discovery-learning-studio', 'photoreal-3d-production', 'homework-analysis']) expect(index).toContain(`## ${s}`);
    const whole = (await call('adw_read_skill', { skill: 'photoreal-3d-production' })).content[0].text;
    expect(whole).toContain('skills/photoreal-3d-production/SKILL.md');
    expect(whole).toContain('收集 → 理解 → 整理');
    expect(whole).not.toMatch(/^---\nname:/m); // frontmatter is stripped
    const one = (await call('adw_read_skill', { skill: 'photoreal-3d-production', file: 'reference/host.md' })).content[0].text;
    expect(one.startsWith('<!-- skills/photoreal-3d-production/reference/host.md -->')).toBe(true);
    expect((await call('adw_read_skill', { skill: 'photoreal-3d-production', file: '../../AGENTS.md' })).isError).toBe(true);
    expect((await call('adw_read_skill', { skill: 'nope' })).isError).toBe(true);
    expect((await call('adw_read_guide', { topic: 'author' })).content[0].text).toContain('reference/challenge-types.md');
  });

  it('gives context, the example, and checks a lesson', async () => {
    expect(JSON.parse((await call('adw_get_context', { child: 'gege' })).content[0].text).child.id).toBe('gege');
    expect((await call('adw_get_context', { child: 'nobody' })).isError).toBe(true);
    const ex = JSON.parse((await call('adw_get_example')).content[0].text) as Stages;
    const bad = structuredClone(ex);
    delete bad.director.encouragement;
    const out = JSON.parse((await call('adw_check_lesson', bad)).content[0].text);
    expect(out.ok).toBe(false);
    expect(out.issues.find((i: { rule: string }) => i.rule === 'V18').fix).toBeTruthy();
    expect(out.status).toContain('没有保存'); // the reference lesson is never overwritten
  });

  it('runs over stdio', async () => {
    const input = new PassThrough(), output = new PassThrough();
    serveStdio(mcp, input, output);
    const lines: string[] = [];
    output.on('data', d => lines.push(...String(d).trim().split('\n')));
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\nnot json\n');
    await new Promise(r => setTimeout(r, 30));
    expect(lines.map(l => JSON.parse(l))).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }]);
  });
});

describe('pointer files for other agents', () => {
  it('Codex, Claude Code and Qoder all find the one Skill', () => {
    for (const f of ['AGENTS.md', '.agents/skills/discovery-learning-studio/SKILL.md', '.claude/skills/discovery-learning-studio/SKILL.md', '.qoder/rules/discovery-learning-studio.md']) {
      expect(existsSync(join(root, f)), f).toBe(true);
      expect(readFileSync(join(root, f), 'utf8')).toContain('skills/discovery-learning-studio');
    }
    expect(readFileSync(join(root, '.agents/skills/discovery-learning-studio/SKILL.md'), 'utf8')).toMatch(/^---\nname: discovery-learning-studio\ndescription: /);
  });
});

describe('server: models, AI lesson writer, MCP for agents', () => {
  const PIN = '2468';
  let app: Awaited<ReturnType<typeof buildApp>>;
  const calls: { url: string; body: any; auth: string | null }[] = [];
  let modelReplies: string[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body, auth: (init.headers as Record<string, string>)?.authorization ?? null });
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-flash' }] }));
    if (body?.messages?.[0]?.content?.startsWith('用一句话')) return new Response(JSON.stringify({ choices: [{ message: { content: '我是一个模型。' } }] }));
    return new Response(JSON.stringify({ choices: [{ message: { content: modelReplies.shift() ?? reply(example()) } }] }));
  }) as typeof fetch;
  const req = async (method: string, url: string, token?: string, body?: unknown) => {
    const r = await app.inject({ method: method as 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(body === undefined ? {} : { payload: body as object }) });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
  const login = async () => (await req('POST', '/v1/auth/login', undefined, { pin: PIN })).body.token as string;
  const until = async (url: string, token: string) => {
    for (let i = 0; i < 200; i++) { const j = (await req('GET', url, token)).body; if (j.status !== 'running') return j; await new Promise(r => setTimeout(r, 10)); }
    throw new Error('job did not finish');
  };

  beforeEach(async () => {
    calls.length = 0; modelReplies = [];
    app = await buildApp({ root, dbPath: join(mkdtempSync(join(tmpdir(), 'adw-')), 'db.sqlite'), pin: PIN, tts: null, fetchImpl: fakeFetch });
  });
  afterEach(async () => { await app.close(); });

  it('keeps API keys on the server and switches models', async () => {
    const p = await login();
    let v = (await req('POST', '/v1/studio/models', p, { provider: 'deepseek', base_url: 'https://api.deepseek.com', model: 'deepseek-v4-pro', api_key: 'sk-secret-1234' })).body;
    expect(JSON.stringify(v)).not.toContain('sk-secret');
    expect(v.models[0]).toMatchObject({ has_key: true, key_tail: '1234', label: 'DeepSeek · deepseek-v4-pro' });
    const first = v.models[0].id;
    expect(v.active).toBe(first);
    v = (await req('POST', '/v1/studio/models', p, { provider: 'ollama', base_url: 'http://localhost:11434/v1', model: 'qwen3' })).body;
    expect(v.models).toHaveLength(2);
    expect(v.active).toBe(v.models[1].id);
    v = (await req('PUT', '/v1/studio/settings', p, { active: first })).body;
    expect(v.active).toBe(first);
    // editing without a key keeps the stored one
    v = (await req('POST', '/v1/studio/models', p, { id: first, model: 'deepseek-flash' })).body;
    expect(v.models[0]).toMatchObject({ model: 'deepseek-flash', has_key: true });
    expect((await req('POST', '/v1/studio/models', p, { base_url: 'ftp://x', model: 'm' })).status).toBe(400);

    const t = (await req('POST', '/v1/studio/models/test', p, { id: first })).body;
    expect(t).toMatchObject({ ok: true, reply: '我是一个模型。', models: ['deepseek-flash', 'deepseek-v4-pro'] });
    expect(calls.every(c => c.auth === 'Bearer sk-secret-1234')).toBe(true);
    expect((await req('POST', '/v1/studio/models/test', p, { base_url: 'https://api.example.com/v1', list_only: true })).body.models).toHaveLength(2);
    expect((await req('DELETE', `/v1/studio/models/${first}`, p)).body.models).toHaveLength(1);
  });

  it('writes a lesson with the chosen model, only after consent, into the review queue', async () => {
    const p = await login();
    expect((await req('POST', '/v1/studio/generate', p, { child: 'gege' })).status).toBe(400); // no model yet
    await req('POST', '/v1/studio/models', p, { provider: 'deepseek', base_url: 'https://api.deepseek.com', model: 'deepseek-v4-pro', api_key: 'sk-1' });
    expect((await req('POST', '/v1/studio/generate', p, { child: 'gege' })).status).toBe(403); // the parent hasn't agreed to send anything out
    await req('PUT', '/v1/studio/settings', p, { consent: true });
    const broken = example(); delete broken.director.encouragement;
    modelReplies = [reply(broken)];
    const { job } = (await req('POST', '/v1/studio/generate', p, { child: 'gege', wish: '难一点' })).body;
    const done = await until(`/v1/studio/jobs/${job}`, p);
    expect(done).toMatchObject({ status: 'done', key: 'L-PA-2@1.0' });
    expect(done.log.map((l: { msg: string }) => l.msg).join('\n')).toMatch(/第 2 轮/);
    const sent = JSON.stringify(calls.map(c => c.body));
    expect(sent).toContain('难一点');
    expect(sent).not.toContain('"said"');
    const draft = (await req('GET', '/v1/drafts', p)).body.find((x: { key: string }) => x.key === 'L-PA-2@1.0');
    expect(draft).toMatchObject({ status: '待审核', submitted_by: 'AI 出课 · DeepSeek · deepseek-v4-pro', ok: true });

    // the parent sends it back with a note; the model revises the same lesson
    await req('POST', '/v1/drafts/L-PA-2@1.0/reject', p, { note: '第一题数字小一点' });
    const again = (await req('POST', '/v1/studio/generate', p, { revise: 'L-PA-2@1.0' })).body.job;
    expect(await until(`/v1/studio/jobs/${again}`, p)).toMatchObject({ status: 'done', key: 'L-PA-2@1.0' });
    expect(JSON.stringify(calls.at(-1)!.body)).toContain('第一题数字小一点');
    expect((await req('GET', '/v1/drafts', p)).body.find((x: { key: string }) => x.key === 'L-PA-2@1.0').status).toBe('待审核');
  });

  it('lets an AI assistant in over MCP to hand lessons in, never to publish', async () => {
    const p = await login();
    const { token } = (await req('POST', '/v1/agents', p, { label: 'Codex' })).body;
    expect((await req('GET', '/v1/agents', p)).body.map((a: { label: string }) => a.label)).toEqual(['Codex']);
    const rpc = (tok: string | undefined, method: string, params?: unknown) => req('POST', '/mcp', tok, { jsonrpc: '2.0', id: 1, method, params });
    expect((await rpc(undefined, 'ping')).status).toBe(401);
    expect((await req('GET', '/mcp', token)).status).toBe(405);
    expect((await rpc(token, 'initialize', { protocolVersion: '2025-06-18' })).body.result.serverInfo.name).toBe('adw-lesson-studio');
    expect((await req('POST', '/mcp', token, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);

    const tool = async (name: string, args: unknown) => JSON.parse((await rpc(token, 'tools/call', { name, arguments: args })).body.result.content[0].text);
    const ctx = await tool('adw_get_context', { child: 'gege' });
    const s = example();
    s.target.lesson_id = ctx.components.find((c: { name: string }) => c.name === 'PerimeterArea').new_lesson_id;
    Object.assign(s.target, { version: ctx.fixed.version, previous_version: null }); // a new lesson starts at the version the context fixes
    expect((await tool('adw_check_lesson', s)).ok).toBe(true);
    const sub = await tool('adw_submit_for_review', s);
    expect(sub.status).toContain('已交给家长审核');
    const key = `${s.target.lesson_id}@1.0`;
    expect((await req('GET', '/v1/drafts', p)).body.find((x: { key: string }) => x.key === key).submitted_by).toBe('Codex');

    // the assistant sees the parent's note and fetches the lesson to revise it
    await req('POST', `/v1/drafts/${key}/reject`, p, { note: '主题换成大桥' });
    const listed = (await tool('adw_list_lessons', { child: 'gege' })).find((l: { key: string }) => l.key === key);
    expect(listed).toMatchObject({ status: '已退回', note: '主题换成大桥' });
    expect((await tool('adw_get_lesson', { key })).stages.target.lesson_id).toBe(s.target.lesson_id);

    // only the parent publishes, and the parent can take the token away
    expect((await req('POST', `/v1/drafts/${key}/approve`, token, { checked: {} })).status).toBe(403);
    expect((await req('GET', '/v1/drafts', token)).status).toBe(403);
    expect((await req('GET', '/v1/studio/models', token)).status).toBe(403);
    await req('DELETE', '/v1/agents/Codex', p);
    expect((await rpc(token, 'ping')).status).toBe(401);
  });

  it('lets an assistant plan with the parent and hand the plan to the parent\'s own model', async () => {
    const p = await login();
    const { token } = (await req('POST', '/v1/agents', p, { label: 'Codex' })).body;
    const tool = async (name: string, args: unknown) => (await req('POST', '/mcp', token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).body.result;
    const names = (await req('POST', '/mcp', token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(['adw_write_with_model', 'adw_job_status', 'adw_prepare_image_upload']));
    expect((await req('GET', '/v1/studio/design-prompt?child=gege', p)).body.text).toContain(BRIEF_HEADER);
    expect((await req('GET', '/v1/studio/design-prompt?child=gege', token)).status).toBe(403);

    const brief = `${BRIEF_HEADER}\n孩子：哥哥（4 年级）\n知识点：周长与面积\n组件和主题：PerimeterArea，珊瑚礁\n挑战题：1. 长 5 宽 3…`;
    expect((await tool('adw_write_with_model', { child: 'gege', brief })).isError).toBe(true); // no model set up yet
    await req('POST', '/v1/studio/models', p, { provider: 'deepseek', base_url: 'https://api.deepseek.com', model: 'deepseek-v4-pro', api_key: 'sk-1' });
    expect((await tool('adw_write_with_model', { child: 'gege', brief })).content[0].text).toContain('勾选同意'); // consent first
    await req('PUT', '/v1/studio/settings', p, { consent: true });
    const started = JSON.parse((await tool('adw_write_with_model', { child: 'gege', brief })).content[0].text);
    let job: any;
    for (let i = 0; i < 200; i++) { job = JSON.parse((await tool('adw_job_status', { job: started.job })).content[0].text); if (job.status !== 'running') break; await new Promise(r => setTimeout(r, 10)); }
    expect(job).toMatchObject({ status: 'done', key: 'L-PA-2@1.0', planner: 'Codex' });
    expect(JSON.stringify(calls.at(-1)!.body)).toContain('谈好的课程方案');
    expect((await req('GET', '/v1/drafts', p)).body.find((x: { key: string }) => x.key === 'L-PA-2@1.0').submitted_by).toBe('AI 出课 · DeepSeek · deepseek-v4-pro · 方案：Codex');
  });

  it('does what the parent names: child and topic, with the subject shown before it can be published', async () => {
    const p = await login();
    await req('POST', '/v1/studio/models', p, { provider: 'deepseek', base_url: 'https://api.deepseek.com', model: 'deepseek-v4-pro', api_key: 'sk-1' });
    await req('PUT', '/v1/studio/settings', p, { consent: true });
    await req('PUT', '/v1/progress/meimei', p, { text: '第二单元 表内乘法（一）' });
    expect((await req('GET', '/v1/progress', p)).body).toMatchObject({ meimei: '第二单元 表内乘法（一）', gege: '' });

    const titled = (t: string) => { const e = example(); e.director.title = t; return reply(e); };
    modelReplies = [titled('珊瑚礁沙底：博比特虫的伏击圈有多大')];
    const { job } = (await req('POST', '/v1/studio/generate', p, { child: 'gege', topic: '博比特虫' })).body;
    const done = await until(`/v1/studio/jobs/${job}`, p);
    expect(done.status, JSON.stringify(done)).toBe('done');
    const sent = JSON.stringify(calls.at(-1)!.body);
    expect(sent).toContain('博比特虫');
    expect(sent).toContain('家长指定');
    const draft = (await req('GET', `/v1/drafts/${done.key}`, p)).body;
    expect(draft.theme).toMatchObject({ name: '博比特虫', subject: { name: '博比特虫', kind: 'organism' } });
    const subject = draft.theme.subject.asset_id;
    expect(draft.pending_assets.map((x: { asset_id: string }) => x.asset_id)).toContain(subject);
    expect(draft.pending_assets.map((x: { asset_id: string }) => x.asset_id)).not.toContain('M-peacock-mantis-shrimp'); // no shrimp standing in for the worm
    // the parent's topic was used: it stays an interest, no longer a standing order
    expect((await req('GET', '/v1/interests?child=gege', p)).body.find((x: { topic: string }) => x.topic === '博比特虫')).toMatchObject({ state: '喜欢', lesson_ref: done.key });

    // 生物素材 lists the worm as still to be made; publishing waits for its picture
    const worm = (await req('GET', '/v1/organisms', p)).body.find((o: { asset_id: string }) => o.asset_id === subject);
    expect(worm).toMatchObject({ name: '博比特虫', status: '待制作' });
    expect((await req('GET', '/v1/drafts', p)).body.find((x: { key: string }) => x.key === done.key).subject).toMatchObject({ name: '博比特虫', ready: false });
    const checklist = (await req('GET', '/v1/review-checklist', p)).body;
    const approve = () => req('POST', `/v1/drafts/${done.key}/approve`, p, { checked: checklist });
    const blocked = await approve();
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain('博比特虫');
    const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex').toString('base64');
    await req('POST', `/v1/organisms/${subject}/media`, p, { mime: 'image/png', data: PNG, real: true, origin: '实拍', credit: '海洋馆', license: '自己拍的' });
    expect((await approve()).status).toBe(201);

    // an agreed plan for 妹妹 is written for 妹妹, about what it says, whoever was selected
    const arr = JSON.parse(JSON.stringify(Object.fromEntries((['target', 'director', 'assets'] as const).map((k, i) => [k, JSON.parse(readFileSync(join(root, 'content/lessons/L-ARR/1.0', ['01-target.json', '02-director.json', '03-assets.json'][i]), 'utf8'))]))));
    arr.director.title = '机器人工厂：机械臂摆零件';
    // a new lesson: a hands-on question and a choice question with its picture (the 1.0 sample predates both rules)
    arr.director.challenges = [
      { id: 'c1', prompt: '机械臂要摆出 3 行、每行 4 个齿轮。拖角上的把手或点 ＋，把行数摆出来。', with_theme: true, task: { type: 'build', start: { rows: 1, cols: 4 }, controls: ['rows'] },
        answers: [{ field: 'rows', label: '几行', value: 3, unit: '行' }], hints: ['每行 4 个已经摆好了，一共要几行？'],
        worked_example: { steps: ['每行 4 个，要摆 3 行。', '一行一行加：1 行、2 行、3 行。', '所以摆 3 行。'] },
        twin: { prompt: '机械臂要摆出 2 行、每行 4 个齿轮。', task: { type: 'build', start: { rows: 1, cols: 4 }, controls: ['rows'] }, answers: [{ field: 'rows', label: '几行', value: 2, unit: '行' }] } },
      { id: 'c2', prompt: '3 行，每行 4 个，一共几个？', with_theme: false, picture: { params: { rows: 3, cols: 4 } }, options: ['12 个', '7 个', '34 个'],
        answers: [{ field: 'total', value: '12 个' }], hints: ['有 3 个 4。'],
        worked_example: { steps: ['每行 4 个，有 3 行。', '4 + 4 + 4，就是 3 × 4。', '所以一共 12 个。'] },
        twin: { prompt: '2 行，每行 5 个，一共几个？', picture: { params: { rows: 2, cols: 5 } }, options: ['10 个', '7 个', '25 个'], answers: [{ field: 'total', value: '10 个' }] } },
    ];
    modelReplies = [reply(arr)];
    const brief = `${BRIEF_HEADER}\n孩子：妹妹（2 年级）\n主题：机器人（工厂里的机械臂）\n主角：工业机械臂\n知识点：乘法的意义`;
    const j2 = (await req('POST', '/v1/studio/generate', p, { child: 'gege', wish: brief })).body.job;
    const d2 = await until(`/v1/studio/jobs/${j2}`, p);
    expect(d2).toMatchObject({ child: 'meimei' });
    // the model wrote it on blocks, the parent named a robot: the robot scene is used anyway (no blocks for a robot)
    expect((await req('GET', `/v1/drafts/${d2.key}`, p)).body.theme).toMatchObject({ skin: 'robot_factory', id: 'robot_factory' });
    expect((await req('GET', `/v1/drafts/${d2.key}`, p)).body.component_params.ArrayMultiplier.theme).toBe('robot_factory');
    expect(JSON.stringify(calls.at(-1)!.body)).toContain('第二单元 表内乘法（一）'); // her school progress went along
    expect((await req('GET', '/v1/interests?child=meimei', p)).body.some((x: { topic: string }) => x.topic === '机器人')).toBe(true);
  });

  it('writes the next lesson from the first queued wish, never sends the child\'s words, and marks the wish 已安排', async () => {
    const p = await login();
    await req('POST', '/v1/studio/models', p, { provider: 'deepseek', base_url: 'https://api.deepseek.com', model: 'deepseek-v4-pro', api_key: 'sk-1' });
    await req('PUT', '/v1/studio/settings', p, { consent: true });
    await req('POST', '/v1/interests', p, { child: 'gege', topic: '螳螂虾', state: '下一课心愿', said: '我想看螳螂虾打架' });
    await req('POST', '/v1/interests', p, { child: 'gege', topic: '机器人', state: '下一课心愿', said: '机器人搬东西' });
    const [first, second] = (await req('GET', '/v1/preps', p)).body;

    // any assistant sees the queue over MCP, topics only
    const { token } = (await req('POST', '/v1/agents', p, { label: 'Codex' })).body;
    const next = (await req('POST', '/mcp', token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'adw_next_lessons', arguments: {} } })).body.result.content[0].text;
    expect(JSON.parse(next)[0].queue.map((q: { topic: string }) => q.topic)).toEqual(['螳螂虾', '机器人']);
    expect(next).not.toMatch(/打架|搬东西/);

    const { job } = (await req('POST', '/v1/studio/generate', p, { child: 'gege' })).body;
    const done = await until(`/v1/studio/jobs/${job}`, p);
    expect(done.status, JSON.stringify(done)).toBe('done');
    expect(done.log.map((l: { msg: string }) => l.msg).join('\n')).toMatch(/按哥哥\d+月\d+日的心愿「螳螂虾」准备的/);
    const sent = JSON.stringify(calls.at(-1)!.body);
    expect(sent).toContain('next_lesson_wish');
    expect(sent).not.toMatch(/打架|搬东西/);
    const draft = (await req('GET', `/v1/drafts/${done.key}`, p)).body;
    expect(draft.parent_tip).toMatch(/按哥哥\d+月\d+日的心愿「螳螂虾」准备。$/);
    let preps = (await req('GET', '/v1/preps', p)).body;
    expect(preps.find((x: { id: string }) => x.id === first.id)).toMatchObject({ status: '已安排', lesson_ref: done.key });
    expect(preps.find((x: { id: string }) => x.id === second.id).status).toBe('准备中');
    expect((await req('GET', '/v1/interests?child=gege', p)).body.find((x: { said: string }) => x.said === '我想看螳螂虾打架').state).toBe('喜欢');

    // the parent can have a later one written now; a used one can't be used twice
    expect((await req('POST', '/v1/studio/generate', p, { prep: first.id })).status).toBe(400);
    const robot = example(); robot.director.title = '机器人巡检：围出机器人的工作区';
    modelReplies = [reply(robot)];
    const j2 = (await req('POST', '/v1/studio/generate', p, { prep: second.id })).body.job;
    const d2 = await until(`/v1/studio/jobs/${j2}`, p);
    expect(d2.status, JSON.stringify(d2)).toBe('done');
    preps = (await req('GET', '/v1/preps', p)).body;
    expect(preps.find((x: { id: string }) => x.id === second.id)).toMatchObject({ status: '已安排', lesson_ref: d2.key });

    // the parent doesn't take the 螳螂虾 lesson: the wish goes back in the queue, and lesson writing hears why
    expect((await req('POST', `/v1/drafts/${done.key}/discard`, p, { reason: '画面太假' })).body.wishes_back).toEqual(['螳螂虾']);
    preps = (await req('GET', '/v1/preps', p)).body;
    expect(preps.find((x: { id: string }) => x.id === first.id)).toMatchObject({ status: '准备中', lesson_ref: null });
    expect((await req('GET', '/v1/interests?child=gege', p)).body.find((x: { said: string }) => x.said === '我想看螳螂虾打架').state).toBe('下一课心愿');
    const ctx = JSON.parse((await req('POST', '/mcp', token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'adw_get_context', arguments: { child: 'gege' } } })).body.result.content[0].text);
    expect(ctx.parent_declined.lessons).toEqual([expect.objectContaining({ title: draft.title, reason: '画面太假' })]);
    expect(ctx.next_lesson_wish.topic).toBe('螳螂虾');
    await req('POST', `/v1/drafts/${done.key}/restore`, p);
    preps = (await req('GET', '/v1/preps', p)).body;
    expect(preps.find((x: { id: string }) => x.id === first.id)).toMatchObject({ status: '已安排', lesson_ref: done.key });
  });

  it('takes a picture from an assistant only through a one-time address, and shows it to children only after the parent confirms', async () => {
    const p = await login();
    const { token } = (await req('POST', '/v1/agents', p, { label: 'Codex' })).body;
    const tool = async (args: unknown) => (await req('POST', '/mcp', token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'adw_prepare_image_upload', arguments: args } })).body.result;
    const base = { asset_id: 'M-peacock-mantis-shrimp', origin: 'AI 写实图', caption: '洞口的孔雀螳螂虾', credit: 'Codex 生成', license: '家用' };
    expect((await tool({ ...base, references: ['a', 'b'] })).content[0].text).toContain('至少 3 张');
    expect((await tool({ ...base, asset_id: 'cartoon-shrimp', references: ['a', 'b', 'c'] })).isError).toBe(true);
    const ok = JSON.parse((await tool({ ...base, references: ['https://commons.wikimedia.org/a', '图鉴 p.12', '水族馆实拍'] })).content[0].text);
    expect(ok.curl).toContain('--data-binary');
    const path = new URL(ok.upload_url).pathname;
    const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    const up = (body: Buffer, type = 'image/png') => app.inject({ method: 'POST', url: path, headers: { 'content-type': type }, payload: body });
    expect((await up(Buffer.from('not a picture'))).statusCode).toBe(400);
    const r = await up(PNG);
    expect(r.statusCode).toBe(201);
    expect(JSON.parse(r.body)).toMatchObject({ pending: true, added_by: 'Codex', origin: 'AI 写实图' });
    expect((await up(PNG)).statusCode).toBe(404); // one time only
    const id = JSON.parse(r.body).id;
    const onPad = async () => (await req('GET', '/v1/media?asset=M-peacock-mantis-shrimp', p)).body.map((m: { id: string }) => m.id);
    expect(await onPad()).not.toContain(id);
    const shrimp = (await req('GET', '/v1/organisms', p)).body.find((o: { asset_id: string }) => o.asset_id === 'M-peacock-mantis-shrimp');
    expect(shrimp.media.find((m: { id: string }) => m.id === id)).toMatchObject({ pending: true, refs: ['https://commons.wikimedia.org/a', '图鉴 p.12', '水族馆实拍'] });
    expect((await req('POST', `/v1/media/${id}/confirm`, token)).status).toBe(403); // only the parent confirms
    await req('POST', `/v1/media/${id}/confirm`, p);
    expect(await onPad()).toContain(id);
  });
});

describe('ChatGPT through Codex on the home computer, all from the parent app', () => {
  const PIN = '2468', bin = join(root, 'test', 'fixtures', 'fake-codex.mjs');
  let app: Awaited<ReturnType<typeof buildApp>>, home: string, log: string;
  const deepseek: string[] = [];
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    deepseek.push(String(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: reply(example()) } }] }));
  }) as typeof fetch;
  const req = async (method: string, url: string, token?: string, body?: unknown) => {
    const r = await app.inject({ method: method as 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(body === undefined ? {} : { payload: body as object }) });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
  const until = async (url: string, token: string) => {
    for (let i = 0; i < 400; i++) { const j = (await req('GET', url, token)).body; if (j.status !== 'running') return j; await new Promise(r => setTimeout(r, 10)); }
    throw new Error('task did not finish');
  };
  const runs = () => readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { args: string[]; prompt: string; images: string[] });
  const setup = async () => {
    const p = (await req('POST', '/v1/auth/login', undefined, { pin: PIN })).body.token as string;
    const v = (await req('POST', '/v1/studio/models', p, { provider: 'codex' })).body;
    return { p, codex: v.models.at(-1).id as string };
  };

  beforeEach(async () => {
    chmodSync(bin, 0o755);
    home = mkdtempSync(join(tmpdir(), 'adw-codex-home-')); log = join(home, 'runs.jsonl'); deepseek.length = 0;
    app = await buildApp({ root, dbPath: join(mkdtempSync(join(tmpdir(), 'adw-')), 'db.sqlite'), pin: PIN, tts: null, fetchImpl: fakeFetch, codex: { bin, env: { ...process.env, CODEX_HOME: home, FAKE_CODEX_LOG: log } } });
  });
  afterEach(async () => { await app.close(); });

  it('says whether Codex is installed and signed in', async () => {
    expect(await codexStatus({ bin, env: { ...process.env, CODEX_HOME: home } })).toMatchObject({ installed: true, logged_in: true, version: '0.164.0' });
    expect(await codexStatus({ bin, env: { ...process.env, CODEX_HOME: home, FAKE_CODEX_LOGGED_OUT: '1' } })).toMatchObject({ installed: true, logged_in: false, detail: LOGIN_CODEX });
    expect(await codexStatus({ bin: join(home, 'no-such-codex') })).toMatchObject({ installed: false, detail: INSTALL_CODEX });
    // a conversation becomes one instruction
    const one = codexPrompt([{ role: 'system', content: '规则' }, { role: 'user', content: '你好' }, { role: 'assistant', content: '想练什么？' }, { role: 'user', content: '面积' }]);
    expect(one).toContain('【说明】\n规则');
    expect(one).toMatch(/【对方】\n你好[\s\S]*【你】\n想练什么？[\s\S]*【对方】\n面积/);
  });

  it('uses the ChatGPT account with no key or address, and writes a lesson with it after consent', async () => {
    const { p, codex } = await setup();
    const v = (await req('GET', '/v1/studio/models', p)).body;
    expect(v.models[0]).toMatchObject({ provider: 'codex', base_url: '', model: '', label: 'ChatGPT（本机 Codex）', has_key: false });
    expect((await req('GET', '/v1/studio/codex', p)).body).toMatchObject({ installed: true, logged_in: true });
    expect((await req('POST', '/v1/studio/models/test', p, { id: codex })).body).toMatchObject({ ok: true, reply: '我是 ChatGPT。' });

    expect((await req('POST', '/v1/studio/generate', p, { child: 'gege', model: codex })).status).toBe(403); // goes to OpenAI's cloud: consent first
    await req('PUT', '/v1/studio/settings', p, { consent: true });
    writeFileSync(join(home, 'replies.json'), JSON.stringify([reply(example())]));
    const { job } = (await req('POST', '/v1/studio/generate', p, { child: 'gege', model: codex, wish: '用大桥' })).body;
    expect(await until(`/v1/studio/jobs/${job}`, p)).toMatchObject({ status: 'done', key: 'L-PA-2@1.0' });
    const run = runs().at(-1)!;
    expect(run.args).toEqual(expect.arrayContaining(['exec', '--skip-git-repo-check', '--ignore-user-config', '--sandbox', 'read-only', '--ephemeral']));
    expect(run.prompt).toContain('lesson-flow.md'); // the Skill rides along
    expect(run.prompt).toContain('用大桥');
    expect(run.prompt).not.toContain('"said"');
    const mine = async () => (await req('GET', '/v1/drafts', p)).body.find((x: { key: string }) => x.key === 'L-PA-2@1.0');
    expect(await mine()).toMatchObject({ submitted_by: 'AI 出课 · ChatGPT（本机 Codex）', status: '待审核' });

    // a failed sign-in comes back in words the parent can act on
    writeFileSync(join(home, 'broken'), '');
    const t = (await req('POST', '/v1/studio/models/test', p, { id: codex })).body;
    expect(t).toMatchObject({ ok: false, error: LOGIN_CODEX });
  });

  it('plans the lesson in a chat in the parent app and hands the agreed plan to another model to write', async () => {
    const { p, codex } = await setup();
    const ds = (await req('POST', '/v1/studio/models', p, { provider: 'deepseek', base_url: 'https://api.deepseek.com', model: 'deepseek-v4-pro', api_key: 'sk-1' })).body.models.at(-1).id;
    await req('PUT', '/v1/studio/settings', p, { consent: true });
    expect((await req('POST', '/v1/studio/plan', p, { child: 'gege', model: codex, messages: [] })).status).toBe(400);
    expect((await req('POST', '/v1/studio/plan', p, { child: 'gege', model: codex, messages: [{ role: 'assistant', content: '你好' }] })).status).toBe(400);

    const said: Message[] = [{ role: 'user', content: '哥哥想练面积' }];
    let t = await until(`/v1/studio/tasks/${(await req('POST', '/v1/studio/plan', p, { child: 'gege', model: codex, messages: said })).body.id}`, p);
    expect(t).toMatchObject({ status: 'done', reply: '想练面积还是周长？我建议用大桥做主题。', brief: null });
    expect(runs().at(-1)!.prompt).toContain('课程设计顾问'); // the design brief is behind the chat
    expect(runs().at(-1)!.prompt).toContain('哥哥想练面积');

    said.push({ role: 'assistant', content: t.reply }, { role: 'user', content: '好了' });
    t = await until(`/v1/studio/tasks/${(await req('POST', '/v1/studio/plan', p, { child: 'gege', model: codex, messages: said })).body.id}`, p);
    expect(t.brief).toMatch(new RegExp(`^${BRIEF_HEADER}`));

    const { job } = (await req('POST', '/v1/studio/generate', p, { child: 'gege', model: ds, wish: t.brief })).body;
    expect(await until(`/v1/studio/jobs/${job}`, p)).toMatchObject({ status: 'done' });
    expect(deepseek.join('\n')).toContain('长方形面积'); // DeepSeek wrote it from the plan
    expect((await req('GET', '/v1/drafts', p)).body.find((x: { key: string }) => x.key === 'L-PA-2@1.0').submitted_by).toBe('AI 出课 · DeepSeek · deepseek-v4-pro');
  });

  it('draws a photoreal picture from at least 3 real photos, hidden from children until the parent confirms', async () => {
    const shrimp = 'M-peacock-mantis-shrimp';
    const p = (await req('POST', '/v1/auth/login', undefined, { pin: PIN })).body.token as string;
    expect((await req('POST', '/v1/studio/image', p, { asset: shrimp })).status).toBe(400); // no ChatGPT account set up
    await req('POST', '/v1/studio/models', p, { provider: 'codex' });
    expect((await req('POST', '/v1/studio/image', p, { asset: shrimp })).status).toBe(403); // consent first
    await req('PUT', '/v1/studio/settings', p, { consent: true });
    const few = await req('POST', '/v1/studio/image', p, { asset: shrimp });
    expect(few).toMatchObject({ status: 400 });
    expect(few.body.error).toContain('至少 3 张');

    const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex').toString('base64');
    for (const n of [1, 2, 3]) {
      expect((await req('POST', `/v1/organisms/${shrimp}/media`, p, { mime: 'image/png', data: PNG, real: true, origin: '实拍', credit: `水族馆 ${n}`, license: '自己拍的', caption: `实拍 ${n}` })).status).toBe(200);
    }
    const draw = async () => until(`/v1/studio/tasks/${(await req('POST', '/v1/studio/image', p, { asset: shrimp, note: '侧面全身' })).body.id}`, p);
    const t = await draw();
    expect(t).toMatchObject({ status: 'done', asset: shrimp });
    const run = runs().at(-1)!;
    expect(run.images).toHaveLength(3);
    expect(run.args).toEqual(expect.arrayContaining(['--sandbox', 'workspace-write']));
    expect(run.prompt).toContain('孔雀螳螂虾');
    expect(run.prompt).toContain('侧面全身');

    const media = (await req('GET', '/v1/organisms', p)).body.find((o: { asset_id: string }) => o.asset_id === shrimp).media;
    const made = media.find((m: { id: string }) => m.id === t.media_id);
    expect(made).toMatchObject({ pending: true, origin: 'AI 写实图', added_by: 'ChatGPT（本机 Codex）', caption: '侧面全身' });
    expect(made.refs).toHaveLength(3);
    expect(made.refs[0]).toContain('水族馆 1');
    const onPad = async () => (await req('GET', `/v1/media?asset=${shrimp}`, p)).body.map((m: { id: string }) => m.id);
    expect(await onPad()).not.toContain(t.media_id);
    await req('POST', `/v1/media/${t.media_id}/confirm`, p);
    expect(await onPad()).toContain(t.media_id);

    // Codex forgot to copy the picture out: it is still found where Codex saves pictures
    writeFileSync(join(home, 'no-copy'), '');
    expect(await draw()).toMatchObject({ status: 'done' });
  });

  it('makes the animal a lesson is about by itself: real photos from the web, then a top view the scene turns into 3D', async () => {
    const { p, codex } = await setup();
    await req('PUT', '/v1/studio/settings', p, { consent: true });
    const e = example(); e.director.title = '珊瑚礁沙底：博比特虫的伏击圈有多大';
    writeFileSync(join(home, 'replies.json'), JSON.stringify([reply(e)]));
    const { job } = (await req('POST', '/v1/studio/generate', p, { child: 'gege', topic: '博比特虫', model: codex })).body;
    const done = await until(`/v1/studio/jobs/${job}`, p);
    expect(done.status, JSON.stringify(done)).toBe('done');
    expect(done.log.map((l: { msg: string }) => l.msg).join('\n')).toContain('已让 ChatGPT 去找「博比特虫」的实拍照片');
    const subject = (await req('GET', `/v1/drafts/${done.key}`, p)).body.theme.subject.asset_id;
    const task = (await req('GET', '/v1/studio/tasks', p)).body.find((t: { asset?: string }) => t.asset === subject);
    expect(await until(`/v1/studio/tasks/${task.id}`, p)).toMatchObject({ status: 'done', step: '做好了，等你确认' });

    // first it searched the web (only the animal's name went out), then drew from what it found
    const [find, draw] = runs().slice(-2);
    expect(find.args).toEqual(expect.arrayContaining(['--sandbox', 'workspace-write', 'web_search="live"', 'sandbox_workspace_write.network_access=true']));
    expect(find.prompt).toContain('「博比特虫」');
    expect(find.prompt).not.toMatch(/哥哥|gege/);
    expect(draw.images).toHaveLength(4);
    expect(draw.prompt).toMatch(/正上方垂直俯视[\s\S]*头朝画面左边/);
    expect(draw.prompt).toContain('真实体长约 100 厘米');

    const worm = (await req('GET', '/v1/organisms', p)).body.find((o: { asset_id: string }) => o.asset_id === subject);
    expect(worm).toMatchObject({ name: '博比特虫', subject: 'organism', real_scale: '约 100 厘米', facts: { scientific_name: 'Eunice aphroditois', length_cm: 100 } });
    const photos = worm.media.filter((m: { kind: string }) => m.kind === 'photo'), cut = worm.media.find((m: { kind: string }) => m.kind === 'cutout');
    expect(photos).toHaveLength(4); // the file outside its folder was not taken
    expect(photos[0]).toMatchObject({ origin: '实拍', pending: true, credit: '摄影者 1', license: 'CC BY-SA 4.0', source_url: 'https://commons.wikimedia.org/wiki/File:Bobbit_1.jpg' });
    expect(cut).toMatchObject({ origin: 'AI 写实图', pending: true, length_cm: 100 });
    expect(cut.refs).toHaveLength(4);

    // children see none of it until the parent checked it; the parent's preview shows it already
    const device = async (q = '') => (await req('GET', `/v1/media?asset=${subject}${q}`, p)).body.length;
    expect(await device()).toBe(0);
    expect(await device('&pending=1')).toBe(5);
    const checklist = (await req('GET', '/v1/review-checklist', p)).body;
    const approve = () => req('POST', `/v1/drafts/${done.key}/approve`, p, { checked: checklist });
    expect((await approve()).status).toBe(409);
    expect((await req('POST', `/v1/organisms/${subject}/confirm`, p)).body).toEqual({ confirmed: 5 });
    expect(await device()).toBe(5);
    expect((await approve()).status).toBe(201);

    // a child's wish for an animal with no scene starts the photos right away, before any lesson is written
    await req('POST', '/v1/interests', p, { child: 'meimei', topic: '海蛞蝓', state: '下一课心愿', said: '我想看海蛞蝓' });
    const prep = (await req('GET', '/v1/preps', p)).body.find((x: { topic: string }) => x.topic === '海蛞蝓');
    expect(prep.log.at(-1).msg).toContain('已让 ChatGPT 去找「海蛞蝓」的实拍照片');
    const early = (await req('GET', '/v1/studio/tasks', p)).body.find((t: { asset?: string }) => t.asset === prep.subject.asset_id);
    expect(await until(`/v1/studio/tasks/${early.id}`, p)).toMatchObject({ status: 'done' });
    expect(runs().at(-2)!.prompt).not.toContain('我想看');
    expect((await req('GET', '/v1/preps', p)).body.find((x: { id: string }) => x.id === prep.id).subject.state).toContain('等你在“生物素材”里确认');

    // too few photos found: it says so instead of drawing from nothing
    writeFileSync(join(home, 'few-photos'), '');
    const few = await codexResearch({ name: '博比特虫' }, { bin, env: { ...process.env, CODEX_HOME: home } });
    expect(few.photos).toHaveLength(2);
  });
});
