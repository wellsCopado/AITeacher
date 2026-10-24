import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { buildApp } from '../apps/server/src/app.js';
import {
  checkStages, createMcp, exampleStages, generateLesson, guide, localBackend, modelFromEnv, normalize, parseJsonReply, serveStdio, studioContext,
  type Message, type Stages,
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
    expect(list.result.tools.map(t => t.name)).toEqual(['adw_read_guide', 'adw_get_context', 'adw_get_example', 'adw_check_lesson', 'adw_submit_for_review', 'adw_list_lessons', 'adw_get_lesson']);
    expect(list.result.tools.some(t => /publish|approve/.test(t.name))).toBe(false); // publishing stays the parent's button
    expect(await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'nope' })).toMatchObject({ error: { code: -32601 } });
    const batch = await mcp.handle([{ jsonrpc: '2.0', id: 4, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }]) as object[];
    expect(batch).toHaveLength(1);
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
});
