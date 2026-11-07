import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { heroGlb } from './fixtures/hero-glb.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { buildApp } from '../apps/server/src/app.js';
import {
  authorMessages, BRIEF_HEADER, checkStages, codexPrompt, codexResearch, codexStatus, createMcp, designPrompt, exampleStages, generateLesson, guide, INSTALL_CODEX, LOGIN_CODEX,
  localBackend, modelFromEnv, normalize, parseJsonReply, serveStdio, studioContext, type Message, type Stages,
} from '../packages/studio/src/index.js';
import { subjectId } from '../packages/cli/src/lib.js';

const root = join(import.meta.dirname, '..');
const example = () => structuredClone(exampleStages(root));
/** What a model that follows the Skill sends back: the example's structure, written about the subject and where it lives (V24). */
const about = (name: string, land = false) => {
  const e = example();
  let s = JSON.stringify(e.director).replaceAll('螳螂虾', name).replace(/mantis shrimp/gi, 'the animal');
  // …and in the garden it names the garden's own tools, not the reef's tape and quadrats (V26)
  if (land) s = s.replace(/珊瑚礁|珊瑚|海底|潜到|sea floor|卷尺|样方|PVC |tape|quadrat/g, w => ({ 珊瑚礁: '花园', 珊瑚: '石头', 海底: '草地', 潜到: '走到', 'sea floor': 'ground', 卷尺: '测距轮', 样方: '地砖', 'PVC ': '', tape: 'wheel', quadrat: 'paver' } as Record<string, string>)[w]);
  e.director = JSON.parse(s);
  return e;
};
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

  it('does what the parent names: a topic a ready scene depicts is written in it, any other is never put in an old scene', async () => {
    const p = await login();
    await req('POST', '/v1/studio/models', p, { provider: 'deepseek', base_url: 'https://api.deepseek.com', model: 'deepseek-v4-pro', api_key: 'sk-1' });
    await req('PUT', '/v1/studio/settings', p, { consent: true });
    await req('PUT', '/v1/progress/meimei', p, { text: '第二单元 表内乘法（一）' });
    expect((await req('GET', '/v1/progress', p)).body).toMatchObject({ meimei: '第二单元 表内乘法（一）', gege: '' });

    // 博比特虫: no ready scene depicts it, so it gets its own as an 探索课; without the ChatGPT account nothing can make
    // that, and nothing is written into the reef instead
    calls.length = 0;
    const worm = await req('POST', '/v1/studio/generate', p, { child: 'gege', topic: '博比特虫' });
    expect(worm.status).toBe(400);
    expect(worm.body.error).toContain('「博比特虫」没有现成的 3D 场景（现成的只有珊瑚礁样方调查、花园围栏与铺砖、积木方块，画的都不是它）');
    expect(worm.body.error).toContain('ChatGPT 账号');
    expect(calls).toHaveLength(0);
    expect((await req('GET', '/v1/interests?child=gege', p)).body.some((x: { topic: string }) => x.topic === '博比特虫')).toBe(false);

    // an agreed plan for 妹妹 is written for 妹妹, about what it says, whoever was selected
    const arr = JSON.parse(JSON.stringify(Object.fromEntries((['target', 'director', 'assets'] as const).map((k, i) => [k, JSON.parse(readFileSync(join(root, 'content/lessons/L-ARR/1.0', ['01-target.json', '02-director.json', '03-assets.json'][i]), 'utf8'))]))));
    arr.director = JSON.parse(JSON.stringify(arr.director).replaceAll('积木', '齿轮').replace(/blocks/g, 'gears').replace(/"(theme|skin|id)":"gears"/g, '"$1":"blocks"'));
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
    // the robot factory failed the parent's realism check (themes.json realism): a robot-arm lesson is never written in
    // it any more; the topic is made as an 探索课 with its own real model (here without the ChatGPT account: refused)
    const brief = `${BRIEF_HEADER}\n孩子：妹妹（2 年级）\n主题：工厂里的机械臂\n主角：工业机械臂\n知识点：乘法的意义`;
    const r2 = await req('POST', '/v1/studio/generate', p, { child: 'gege', wish: brief });
    expect(r2.status, JSON.stringify(r2.body)).toBe(400);
    expect(r2.body.error).toContain('「工厂里的机械臂」没有现成的 3D 场景');
  });

  it('never puts a topic into a scene that does not depict it: the cricket of 11-04, the rocket of 11-05, from every way in', async () => {
    const p = await login();
    await req('POST', '/v1/studio/models', p, { provider: 'deepseek', base_url: 'https://api.deepseek.com', model: 'deepseek-v4-pro', api_key: 'sk-1' });
    await req('PUT', '/v1/studio/settings', p, { consent: true });
    calls.length = 0;
    // the 主题 box, a one-line request, an agreed plan, a component picked by hand: each would have to be an 探索课
    const asks = [{ child: 'gege', wish: '写一个蟋蟀的课程' }, { child: 'meimei', topic: '火箭发射' }, { child: 'gege', wish: `${BRIEF_HEADER}\n孩子：哥哥（4 年级）\n主题：火山\n知识点：角的度量` },
      { child: 'gege', topic: '金鱼', component: 'PerimeterArea@1.2' }, { child: 'meimei', topic: '机器人' }];
    for (const [i, body] of asks.entries()) {
      const r = await req('POST', '/v1/studio/generate', p, body);
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.error).toContain(`「${['蟋蟀', '火箭发射', '火山', '金鱼', '机器人'][i]}」没有现成的 3D 场景`);
      expect(r.body.error).toContain('ChatGPT 账号');
    }
    expect(calls).toHaveLength(0);

    // the parent sends a lesson back asking for another topic: changing its words can't change its pictures
    modelReplies = [reply(example())];
    const first = await until(`/v1/studio/jobs/${(await req('POST', '/v1/studio/generate', p, { child: 'gege' })).body.job}`, p);
    expect(first.status, JSON.stringify(first)).toBe('done');
    await req('POST', `/v1/drafts/${first.key}/reject`, p, { note: '改成火箭发射的课' });
    const back = await req('POST', '/v1/studio/generate', p, { revise: first.key });
    expect(back.status).toBe(400);
    expect(back.body.error).toContain('「火箭发射」不在「珊瑚礁样方调查」的画面里');

    // an assistant hands in the old scene with new words anyway: the words are about a rocket, the pictures a reef (V27)
    const { token } = (await req('POST', '/v1/agents', p, { label: 'Codex' })).body;
    const tool = async (name: string, args: unknown) => JSON.parse((await req('POST', '/mcp', token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).body.result.content[0].text);
    const s = example();
    s.director.title = '火箭发射：发射场有多大';
    s.director.intro.paragraphs[0] = '火箭就要发射了，我们去发射场看看。';
    const checked = await tool('adw_check_lesson', s);
    expect(checked.ok).toBe(false);
    expect(JSON.stringify(checked)).toContain('V27');
    expect(JSON.stringify(checked)).toContain('这里讲「火箭」，场景「珊瑚礁样方调查」里没有它');
  });

  it('does not write a queued wish into an old scene either: an elephant has none, so it would be an 探索课', async () => {
    const p = await login();
    await req('POST', '/v1/studio/models', p, { provider: 'deepseek', base_url: 'https://api.deepseek.com', model: 'deepseek-v4-pro', api_key: 'sk-1' });
    await req('PUT', '/v1/studio/settings', p, { consent: true });
    await req('POST', '/v1/interests', p, { child: 'gege', topic: '大象', state: '下一课心愿', said: '我想看大象' });
    calls.length = 0;
    const r = await req('POST', '/v1/studio/generate', p, { child: 'gege' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('「大象」没有现成的 3D 场景');
    expect(r.body.error).toContain('探索课');
    expect(calls).toHaveLength(0); // nothing went to a model
  });

  it('writes the next lesson from the first queued wish, never sends the child\'s words, and marks the wish 已安排', async () => {
    const p = await login();
    await req('POST', '/v1/studio/models', p, { provider: 'deepseek', base_url: 'https://api.deepseek.com', model: 'deepseek-v4-pro', api_key: 'sk-1' });
    await req('PUT', '/v1/studio/settings', p, { consent: true });
    await req('POST', '/v1/interests', p, { child: 'gege', topic: '螳螂虾', state: '下一课心愿', said: '我想看螳螂虾打架' });
    await req('POST', '/v1/interests', p, { child: 'gege', topic: '花园', state: '下一课心愿', said: '在花园里搬东西' });
    const [first, second] = (await req('GET', '/v1/preps', p)).body;

    // any assistant sees the queue over MCP, topics only
    const { token } = (await req('POST', '/v1/agents', p, { label: 'Codex' })).body;
    const next = (await req('POST', '/mcp', token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'adw_next_lessons', arguments: {} } })).body.result.content[0].text;
    expect(JSON.parse(next)[0].queue.map((q: { topic: string }) => q.topic)).toEqual(['螳螂虾', '花园']);
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
    const garden = about('花园', true); garden.director.title = '花园围栏：围出一块菜地';
    modelReplies = [reply(garden)];
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
    const { job } = (await req('POST', '/v1/studio/generate', p, { child: 'gege', model: codex, wish: '再难一点' })).body;
    expect(await until(`/v1/studio/jobs/${job}`, p)).toMatchObject({ status: 'done', key: 'L-PA-2@1.0' });
    const run = runs().at(-1)!;
    expect(run.args).toEqual(expect.arrayContaining(['exec', '--skip-git-repo-check', '--ignore-user-config', '--sandbox', 'read-only', '--ephemeral']));
    expect(run.prompt).toContain('lesson-flow.md'); // the Skill rides along
    expect(run.prompt).toContain('再难一点');
    expect(run.prompt).not.toContain('"said"');
    const mine = async () => (await req('GET', '/v1/drafts', p)).body.find((x: { key: string }) => x.key === 'L-PA-2@1.0');
    expect(await mine()).toMatchObject({ submitted_by: 'AI 出课 · ChatGPT（本机 Codex）', status: '待审核' });

    // a failed sign-in comes back in words the parent can act on
    writeFileSync(join(home, 'broken'), '');
    const t = (await req('POST', '/v1/studio/models/test', p, { id: codex })).body;
    expect(t).toMatchObject({ ok: false, error: LOGIN_CODEX });
  });

  it('makes a whole 探索课 from a topic: Codex works from the 探索课 Skill, decides what to learn, and the package waits for the parent', async () => {
    const { p } = await setup();
    expect((await req('POST', '/v1/explore/make', p, { child: 'gege', topic: '蜜蜂' })).status).toBe(403); // only after consent
    await req('PUT', '/v1/studio/settings', p, { consent: true });
    await req('PUT', '/v1/progress/gege', p, { text: '第三单元 角的度量' });
    expect((await req('POST', '/v1/explore/make', p, { child: 'gege' })).status).toBe(400);
    const r = await req('POST', '/v1/explore/make', p, { child: 'gege', topic: '蜜蜂', wish: '讲讲蜂巢为什么是六边形' });
    expect(r.status).toBe(202);
    const done = await until(`/v1/studio/jobs/${r.body.job}`, p);
    expect(done.status, JSON.stringify(done)).toBe('done');
    const run = runs().at(-1)!;
    // what Codex is told: the topic, grade and school progress, to find out what to learn first, not to default to tape measures
    for (const words of ['「蜜蜂」', '4 年级', '第三单元 角的度量', '讲讲蜂巢为什么是六边形', './skill/SKILL.md', '不要默认周长和面积', 'check_package.py', 'family-profile.md', 'adw-family.mjs', '一中三英', '错 3 次先演示', 'visual-gate.jpg', 'topic-3d-production.md', 'research/subject.json', '不是方块圆柱拼的']) expect(run.prompt).toContain(words);
    expect(run.args).toContain('workspace-write');
    const said = done.log.map((l: { msg: string }) => l.msg).join('\n');
    expect(said).toContain('查到了：蜜蜂的巢房是六边形'); // its progress shows while it works
    expect(said).toContain('运行：');
    expect(said).toContain('已放进“课程库 → 探索课”：蜜蜂的六边形巢房');
    // it waits in 探索课 like an uploaded package; the parent previews it, nothing is published
    const x = (await req('GET', '/v1/explore', p)).body.find((k: { key: string }) => k.key === done.key);
    expect(x).toMatchObject({ title: '蜜蜂的六边形巢房', for_child: 'gege', status: '待审核', concept: '角的度量', bridge: true });
    expect(x.imported_by).toMatch(/^AI 做探索课 · /);
    expect(x).toMatchObject({ family: true, gate: 'gate.jpg' }); // the family's lesson rules, and the visual gate the parent sees first
    expect(x.files).toBe(4); // the built page only: no node_modules, no link out of Codex's folder
    expect(x).toMatchObject({ topic: '蜜蜂', assets: [{ role: 'hero', depicts: '蜜蜂（三维模型）', origin: 'modeled' }] });
    expect(done.key).toMatch(/^X-GEGE-\d{8}-[0-9a-f]{4}@1\.0$/);
    expect((await app.inject({ method: 'GET', url: `/explore/${done.key}/index.html` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/explore/${done.key}/leak.txt` })).statusCode).toBe(404); // a link out of Codex's folder stays out
    expect((await req('GET', '/v1/lessons', p)).body.some((l: { key: string }) => l.key === done.key)).toBe(false);

    // nothing handed in: it says so
    writeFileSync(join(home, 'no-package'), '');
    const bad = await until(`/v1/studio/jobs/${(await req('POST', '/v1/explore/make', p, { child: 'gege', topic: '蚂蚁' })).body.job}`, p);
    expect(bad).toMatchObject({ status: 'failed' });
    expect(bad.error).toContain('没有交出课程包');
    rmSync(join(home, 'no-package'));
    // made here without the family's lesson rules or the visual gate: not taken (an uploaded old package only gets a warning)
    writeFileSync(join(home, 'no-family'), '');
    const loose = await until(`/v1/studio/jobs/${(await req('POST', '/v1/explore/make', p, { child: 'gege', topic: '蜻蜓' })).body.job}`, p);
    rmSync(join(home, 'no-family'));
    expect(loose).toMatchObject({ status: 'failed' });
    expect(loose.error).toContain('没按家里的规则做完');
    expect(loose.error).toContain('adw-family.mjs');
    expect(loose.error).toContain('画面对照图');
    // a hero that is a toy (no subject card, a few bytes of model, no real size): not taken either
    writeFileSync(join(home, 'toy-hero'), '');
    const toy = await until(`/v1/studio/jobs/${(await req('POST', '/v1/explore/make', p, { child: 'gege', topic: '甲虫' })).body.job}`, p);
    rmSync(join(home, 'toy-hero'));
    expect(toy).toMatchObject({ status: 'failed' });
    expect(toy.error).toContain('主角没按主题真实做');
    expect(toy.error).toContain('没有主角卡');
  });

  it('写啥主题就做啥图片: three topics never made before each become an 探索课 with their own pictures, from every way in', async () => {
    const { p } = await setup();
    await req('PUT', '/v1/studio/settings', p, { consent: true });
    await req('PUT', '/v1/progress/meimei', p, { text: '第四单元 表内乘法（一）' });
    const made = async (r: { status: number; body: any }, topic: string, child: string) => {
      expect(r.status, JSON.stringify(r.body)).toBe(202);
      expect(r.body).toMatchObject({ kind: 'explore', topic });
      const done = await until(`/v1/studio/jobs/${r.body.job}`, p);
      expect(done.status, JSON.stringify(done)).toBe('done');
      const run = runs().at(-1)!;
      // Codex is told the topic word for word and the steps every topic goes through: research, the picture list, own pictures
      for (const words of [`「${topic}」`, `topic "${topic}"`, 'references/topic-assets.md', 'research/assets.json', '不用 App 里、别的课的场景和素材']) expect(run.prompt).toContain(words);
      expect(run.args).toContain('workspace-write');
      const x = (await req('GET', '/v1/explore', p)).body.find((k: { key: string }) => k.key === done.key);
      expect(x).toMatchObject({ for_child: child, topic, status: '待审核', assets: [{ role: 'hero', depicts: `${topic}（三维模型）` }] });
      return done;
    };
    // 妹妹 + 火箭发射 in the 主题 box (2026-11-05: “图片还是机器臂”): no robot arm, its own lesson
    const rocket = await made(await req('POST', '/v1/studio/generate', p, { child: 'meimei', topic: '火箭发射' }), '火箭发射', 'meimei');
    expect(rocket.log[0].msg).toContain('「火箭发射」没有现成的 3D 场景');
    expect(runs().at(-1)!.prompt).toContain('2 年级');
    expect(runs().at(-1)!.prompt).toContain('第四单元 表内乘法（一）');
    // 哥哥 + a one-line request
    await made(await req('POST', '/v1/studio/generate', p, { child: 'gege', wish: '写一个蜜蜂的课程' }), '蜜蜂', 'gege');
    // an agreed plan
    await made(await req('POST', '/v1/studio/generate', p, { child: 'meimei', wish: `${BRIEF_HEADER}\n孩子：哥哥（4 年级）\n主题：火山\n知识点：角的度量` }), '火山', 'gege');
    // a lesson sent back with “改成…”: the reef lesson stays as it was, the new topic gets its own
    writeFileSync(join(home, 'replies.json'), JSON.stringify([reply(example())]));
    const reef = await until(`/v1/studio/jobs/${(await req('POST', '/v1/studio/generate', p, { child: 'gege', model: (await req('GET', '/v1/studio/models', p)).body.models[0].id })).body.job}`, p);
    expect(reef.status, JSON.stringify(reef)).toBe('done');
    await req('POST', `/v1/drafts/${reef.key}/reject`, p, { note: '改成火山的课' });
    const again = await made(await req('POST', '/v1/studio/generate', p, { revise: reef.key }), '火山', 'gege');
    expect(again.log[0].msg).toContain('「火山」不在「珊瑚礁样方调查」的画面里');
    // a child's queued wish
    await req('POST', '/v1/interests', p, { child: 'meimei', topic: '蝴蝶', state: '下一课心愿', said: '我想看蝴蝶' });
    const prep = (await req('GET', '/v1/preps', p)).body.find((x: { topic: string }) => x.topic === '蝴蝶');
    const fly = await made(await req('POST', '/v1/studio/generate', p, { prep: prep.id }), '蝴蝶', 'meimei');
    expect((await req('GET', '/v1/preps', p)).body.find((x: { id: string }) => x.id === prep.id)).toMatchObject({ status: '已安排', lesson_ref: fly.key });

    // a package with a picture brought in from elsewhere and not on the list is not taken
    writeFileSync(join(home, 'assets-copied'), '');
    const copied = await until(`/v1/studio/jobs/${(await req('POST', '/v1/studio/generate', p, { child: 'meimei', topic: '月亮' })).body.job}`, p);
    expect(copied.status).toBe('failed');
    expect(copied.error).toContain('画面没有按「月亮」做，没放进课程库');
    expect(copied.error).toContain('img/robot-arm.png');
    // nor one that carries another lesson's model: the rocket's own, inside a 恐龙 lesson
    rmSync(join(home, 'assets-copied'));
    const rocketModel = join(home, 'rocket.glb');
    writeFileSync(rocketModel, heroGlb({ size: [6, 12, 6], seed: createHash('md5').update('火箭发射').digest().readUInt32BE(0) }));
    writeFileSync(join(home, 'assets-reused'), rocketModel);
    const reused = await until(`/v1/studio/jobs/${(await req('POST', '/v1/studio/generate', p, { child: 'gege', topic: '恐龙' })).body.job}`, p);
    expect(reused.status).toBe('failed');
    expect(reused.error).toContain('那节课的一模一样');
    expect((await req('GET', '/v1/explore', p)).body.map((x: { topic: string }) => x.topic).sort()).toEqual(['火山', '火山', '火箭发射', '蜜蜂', '蝴蝶'].sort());
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
    expect(codex).toBeTruthy();
    // an assistant hands in a reef lesson with the shrimp as its subject: the reef depicts it (V27), its pictures are still to make (V19)
    const { token } = (await req('POST', '/v1/agents', p, { label: 'Codex' })).body;
    const tool = async (name: string, args: unknown) => JSON.parse((await req('POST', '/mcp', token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).body.result.content[0].text);
    const ctx = await tool('adw_get_context', { child: 'gege' });
    const e = example(), subject = subjectId('螳螂虾');
    e.target.lesson_id = ctx.components.find((c: { name: string }) => c.name === 'PerimeterArea').new_lesson_id;
    Object.assign(e.target, { version: ctx.fixed.version, previous_version: null });
    e.director.theme = { ...e.director.theme, subject: { name: '螳螂虾', asset_id: subject, kind: 'organism' } };
    e.assets.pending = [{ asset_id: subject, kind: 'organism', realism_required: 'ai_from_photo', status: '待制作', until_ready: '不展示：螳螂虾的写实画面做好、家长确认后才出现' }];
    const sub = await tool('adw_submit_for_review', e);
    expect(sub.status, JSON.stringify(sub)).toContain('已交给家长审核');
    const done = { key: `${e.target.lesson_id}@1.0` };
    const checklist = (await req('GET', '/v1/review-checklist', p)).body;
    const approve = () => req('POST', `/v1/drafts/${done.key}/approve`, p, { checked: checklist });
    const blocked = await approve();
    expect(blocked.status).toBe(409); // publishing waits for its pictures
    expect(blocked.body.error).toContain('螳螂虾');
    // 生物素材 → 让 ChatGPT 做: real photos from the web first, then a top view
    const started = await req('POST', '/v1/studio/subject', p, { asset: subject });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    expect(await until(`/v1/studio/tasks/${started.body.id}`, p)).toMatchObject({ status: 'done', step: '做好了，等你确认' });

    // first it searched the web (only the animal's name went out), then drew from what it found
    const [find, draw] = runs().slice(-2);
    expect(find.args).toEqual(expect.arrayContaining(['--sandbox', 'workspace-write', 'web_search="live"', 'sandbox_workspace_write.network_access=true']));
    expect(find.prompt).toContain('「螳螂虾」');
    expect(find.prompt).not.toMatch(/哥哥|gege/);
    expect(draw.images).toHaveLength(4);
    expect(draw.prompt).toMatch(/正上方垂直俯视[\s\S]*头朝画面左边/);
    expect(draw.prompt).toContain('真实体长约 100 厘米');

    const worm = (await req('GET', '/v1/organisms', p)).body.find((o: { asset_id: string }) => o.asset_id === subject);
    expect(worm).toMatchObject({ name: '螳螂虾', subject: 'organism', real_scale: '约 100 厘米', facts: { scientific_name: 'Eunice aphroditois', length_cm: 100 } }); // (the fake's canned find)
    const photos = worm.media.filter((m: { kind: string }) => m.kind === 'photo'), cut = worm.media.find((m: { kind: string }) => m.kind === 'cutout');
    expect(photos).toHaveLength(4); // the file outside its folder was not taken
    expect(photos[0]).toMatchObject({ origin: '实拍', pending: true, credit: '摄影者 1', license: 'CC BY-SA 4.0', source_url: 'https://commons.wikimedia.org/wiki/File:Bobbit_1.jpg' });
    expect(cut).toMatchObject({ origin: 'AI 写实图', pending: true, length_cm: 100 });
    expect(cut.refs).toHaveLength(4);

    // children see none of it until the parent checked it; the parent's preview shows it already
    const device = async (q = '') => (await req('GET', `/v1/media?asset=${subject}${q}`, p)).body.length;
    expect(await device()).toBe(0);
    expect(await device('&pending=1')).toBe(5);
    expect((await approve()).status).toBe(409);
    expect((await req('POST', `/v1/organisms/${subject}/confirm`, p)).body).toEqual({ confirmed: 5 });
    expect(await device()).toBe(5);
    expect((await approve()).status).toBe(201);

    // a child's wish for an animal no scene depicts makes no photos for an old scene: its lesson will be an 探索课
    await req('POST', '/v1/interests', p, { child: 'meimei', topic: '海蛞蝓', state: '下一课心愿', said: '我想看海蛞蝓' });
    const prep = (await req('GET', '/v1/preps', p)).body.find((x: { topic: string }) => x.topic === '海蛞蝓');
    expect(prep).toMatchObject({ explore: true, subject: { state: '没有现成的场景：按「海蛞蝓」自己的样子做成探索课' } });
    expect(prep.log.at(-1).msg).toContain('做成探索课');
    expect((await req('GET', '/v1/studio/tasks', p)).body.some((t: { asset?: string }) => t.asset === prep.subject.asset_id)).toBe(false);

    // too few photos found: it says so instead of drawing from nothing
    writeFileSync(join(home, 'few-photos'), '');
    const few = await codexResearch({ name: '博比特虫' }, { bin, env: { ...process.env, CODEX_HOME: home } });
    expect(few.photos).toHaveLength(2);
  });
});
