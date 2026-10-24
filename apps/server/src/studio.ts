// AI lesson writing on the family server. The parent picks any chat model (DeepSeek, Qwen, GPT, Claude, a local
// Ollama…) and has it write a lesson; AI assistants (Codex, Claude Code, Qoder, Cursor…) connect over MCP with a
// token from the parent app. Either way the lesson lands in 课程库 → 等你审核: only the parent's button publishes.
// API keys stay in this server's database and are never sent back, not even to the parent app.
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { LessonSpec, ReteachTicket } from '../../../packages/schema/src/index.js';
import type { Ctx, Report } from '../../../packages/validator/src/index.js';
import {
  PROVIDERS, chatWith, checkStages, createMcp, disassemble, exampleStages, generateLesson, guide, listModels, outcome, studioContext,
  type Chat, type GuideTopic, type LessonRequest, type ModelConfig, type Stages, type StudioBackend,
} from '../../../packages/studio/src/index.js';
import type { Role, Store } from './db.js';
import { fail, HttpError } from './http.js';
import { reteachHistory } from './homework.js';

interface Deps {
  store: Store; root: string; tenant: string; iso: () => string;
  parent: RouteShorthandOptions; agentOrParent: RouteShorthandOptions;
  issue: (role: Role, label: string) => string;
  vet: (sp: LessonSpec) => { key: string; ticket?: ReteachTicket; report: Report };
  /** Tests swap the network out. */
  fetchImpl?: typeof fetch;
}

const MODELS = 'studio.models', ACTIVE = 'studio.active', CONSENT = 'studio.consent';
type Job = { id: string; child: string; model: string; status: 'running' | 'done' | 'failed'; started_at: string; log: { at: string; msg: string }[]; key?: string; title?: string; error?: string; issues?: { rule: string; path: string; msg: string }[] };
/** A model on this machine (Ollama, LM Studio…): nothing leaves the house, so no consent is needed. */
const isLocal = (m: ModelConfig) => { try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(m.base_url).hostname); } catch { return false; } };

export function studioRoutes(app: FastifyInstance, d: Deps) {
  const { store, root, iso } = d;

  // ---- models: any OpenAI-compatible API, switched with one click ----
  const models = (): ModelConfig[] => { try { return JSON.parse(store.setting(MODELS) ?? '[]'); } catch { return []; } };
  const active = () => { const id = store.setting(ACTIVE); const all = models(); return all.find(m => m.id === id) ?? all[0] ?? null; };
  const consent = () => store.setting(CONSENT) === '1';
  const masked = ({ api_key, ...m }: ModelConfig) => ({ ...m, has_key: !!api_key, key_tail: api_key ? api_key.slice(-4) : null });
  const fromBody = (b: Partial<ModelConfig>, keep?: ModelConfig): ModelConfig => {
    const base_url = String(b.base_url ?? keep?.base_url ?? '').trim().replace(/\/+$/, '');
    const model = String(b.model ?? keep?.model ?? '').trim();
    if (!/^https?:\/\/[^\s/]+/.test(base_url)) fail(400, '接口地址要以 http:// 或 https:// 开头');
    if (!model) fail(400, '填写模型名（可以先点“获取模型列表”）');
    const provider = PROVIDERS.some(p => p.id === b.provider) ? b.provider! : keep?.provider ?? 'custom';
    const key = typeof b.api_key === 'string' && b.api_key.trim() ? b.api_key.trim() : keep?.api_key;
    return {
      id: keep?.id ?? `m-${randomBytes(4).toString('hex')}`,
      label: String(b.label ?? '').trim().slice(0, 40) || keep?.label || `${PROVIDERS.find(p => p.id === provider)?.label ?? '模型'} · ${model}`,
      provider, base_url, model, ...(key ? { api_key: key } : {}), json_mode: b.json_mode ?? keep?.json_mode ?? true,
    };
  };
  const view = () => ({ providers: PROVIDERS, models: models().map(masked), active: active()?.id ?? null, consent: consent() });
  const chatFor = (m: ModelConfig): Chat => chatWith(m, { fetchImpl: d.fetchImpl });

  app.get('/v1/studio/models', d.parent, async () => view());
  app.post('/v1/studio/models', d.parent, async (req) => {
    const b = (req.body ?? {}) as Partial<ModelConfig>;
    const all = models(), old = b.id ? all.find(m => m.id === b.id) : undefined;
    if (b.id && !old) fail(404, '没有这个模型设置');
    const m = fromBody(b, old);
    store.setSetting(MODELS, JSON.stringify(old ? all.map(x => (x.id === m.id ? m : x)) : [...all, m]));
    if (!store.setting(ACTIVE) || !old) store.setSetting(ACTIVE, m.id);
    return view();
  });
  app.delete('/v1/studio/models/:id', d.parent, async (req) => {
    const id = (req.params as { id: string }).id;
    store.setSetting(MODELS, JSON.stringify(models().filter(m => m.id !== id)));
    if (store.setting(ACTIVE) === id) store.setSetting(ACTIVE, models()[0]?.id ?? '');
    return view();
  });
  app.put('/v1/studio/settings', d.parent, async (req) => {
    const b = (req.body ?? {}) as { active?: string; consent?: boolean };
    if (b.active !== undefined) { if (!models().some(m => m.id === b.active)) fail(404, '没有这个模型设置'); store.setSetting(ACTIVE, b.active); }
    if (b.consent !== undefined) store.setSetting(CONSENT, b.consent ? '1' : '0');
    return view();
  });
  /** Try a model before using it: which models the key can see, and one short reply. Unsaved settings work too. */
  app.post('/v1/studio/models/test', d.parent, async (req) => {
    const b = (req.body ?? {}) as Partial<ModelConfig> & { list_only?: boolean };
    const old = b.id ? models().find(m => m.id === b.id) : undefined;
    const m = fromBody(b.list_only ? { ...b, model: b.model || '-' } : b, old);
    const t0 = Date.now();
    let list: string[] | null = null, list_error: string | null = null;
    try { list = await listModels(m, { fetchImpl: d.fetchImpl }); } catch (e) { list_error = (e as Error).message; }
    if (b.list_only) return { models: list, list_error };
    try {
      const reply = await chatWith({ ...m, json_mode: false }, { fetchImpl: d.fetchImpl, timeoutMs: 60_000 })([{ role: 'user', content: '用一句话介绍你自己（不超过 20 个字）。' }]);
      return { ok: true, reply: reply.trim().slice(0, 200), ms: Date.now() - t0, models: list, list_error };
    } catch (e) { return { ok: false, error: (e as Error).message, models: list, list_error }; }
  });

  // ---- what lesson writing sees from this server ----
  const published = () => store.lessons().map(l => store.lesson(l.key)!).filter(Boolean);
  const context = (child: string) => {
    if (!store.hasChild(child)) fail(400, `没有这个孩子：${child}（可选：${store.children().map(c => c.id).join('、')}）`);
    return studioContext(root, child, { interests: store.interests(), published: published(), takenKeys: [...store.lessons().map(l => l.key), ...store.drafts().map(x => x.key)], tenant: d.tenant });
  };
  const valCtx = (s: Stages): Partial<Ctx> => {
    const t = s?.target ?? {};
    return { interests: store.interests(), reteach: reteachHistory(store), previous: t.previous_version ? store.lesson(`${t.lesson_id}@${t.previous_version}`) ?? null : null };
  };
  const lessonList = (child?: string) => [
    ...store.lessons().filter(l => !child || l.for_child === child).map(l => ({ key: l.key, title: l.title, child: l.for_child, status: '已发布' })),
    ...store.drafts().filter(x => !child || x.for_child === child).map(x => ({ key: x.key, title: x.title, child: x.for_child, status: x.status, note: x.note, submitted_by: x.submitted_by })),
  ];
  /** Hand a lesson in for review. Same checks as the parent's own submit; never publishes. */
  const submit = (spec: LessonSpec, by: string) => {
    if (spec.tenant_id !== d.tenant) fail(400, `tenant_id 应该是 ${d.tenant}`);
    const { key, report } = d.vet(spec);
    if (store.lesson(key)) fail(409, `${key} 已发布且已冻结；修改请升版本号`);
    if (!report.ok) return { key, report };
    store.upsertDraft(spec, by, iso());
    return { key, report };
  };

  // ---- AI assistants over MCP (Streamable HTTP, JSON replies) ----
  const backend = (who: string): StudioBackend => ({
    where: 'server',
    children: () => store.children().map(c => ({ id: c.id, label: c.name, grade: c.grade })),
    context,
    guide: topic => guide(root, topic as GuideTopic),
    example: () => exampleStages(root),
    check: stages => outcome(checkStages(root, stages, valCtx(stages))),
    async submit(stages) {
      const r = checkStages(root, stages, valCtx(stages));
      if (!r.spec || !r.report.ok) return { ...outcome(r), status: '校验没通过，先改好再交' };
      try {
        const s = submit(r.spec, who);
        return { ...outcome({ ...r, report: s.report }), status: s.report.ok ? `已交给家长审核（家长端 → 课程库 → 等你审核），提交人：${who}` : '服务器校验没通过' };
      } catch (e) { if (e instanceof HttpError) return { ...outcome(r), ok: false, status: e.message }; throw e; }
    },
    lessons: lessonList,
    lesson(key) {
      const draft = store.draft(key), row = store.drafts().find(x => x.key === key);
      if (draft) return { key, status: row?.status, note: row?.note ?? null, stages: disassemble(draft) };
      const sp = store.lesson(key);
      if (!sp) throw new Error(`没有这节课：${key}`);
      return { key, status: '已发布（已冻结，修改请升版本号）', stages: disassemble(sp) };
    },
  });
  app.post('/mcp', d.agentOrParent, async (req: FastifyRequest, reply) => {
    const out = await createMcp(backend(req.role === 'agent' ? req.who ?? 'AI 助手' : '家长')).handle(req.body);
    return out ? reply.type('application/json').send(out) : reply.code(202).send();
  });
  const noStream = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header('allow', 'POST').send({ error: 'MCP 在这里只用 POST（Streamable HTTP，直接返回 JSON）' });
  app.get('/mcp', noStream);
  app.delete('/mcp', noStream);

  // AI assistant tokens: the parent lets one in by name, sees its token once, and can take it away.
  app.get('/v1/agents', d.parent, async () => store.agents());
  app.post('/v1/agents', d.parent, async (req) => {
    const label = String((req.body as { label?: unknown })?.label ?? '').trim().slice(0, 40);
    if (!label) fail(400, '给这个 AI 助手起个名字，例如 Codex、Qoder');
    if (store.agents().some(a => a.label === label)) fail(409, `已经有叫「${label}」的 AI 助手`);
    return { label, token: d.issue('agent', label) };
  });
  app.delete('/v1/agents/:label', d.parent, async (req) => { store.revokeAgent((req.params as { label: string }).label); return { ok: true }; });

  // ---- the built-in lesson writer: one button in 课程库 ----
  const jobs = new Map<string, Job>();
  app.post('/v1/studio/generate', d.parent, async (req, reply) => {
    const b = (req.body ?? {}) as { child?: string; wish?: string; component?: string; model?: string; revise?: string };
    const m = b.model ? models().find(x => x.id === b.model) : active();
    if (!m) fail(400, '还没有设置大模型：设备与数据 → 大模型');
    if (!isLocal(m!) && !consent()) fail(403, '先在“设备与数据 → 大模型”里勾选同意：会把年级、兴趣主题发给所选模型（不含姓名、照片和学习记录）');
    if ([...jobs.values()].some(j => j.status === 'running')) fail(409, '上一节课还在写，写完再开始下一节');
    const request: LessonRequest = { wish: b.wish ? String(b.wish).slice(0, 500) : undefined, component: b.component || undefined };
    let child = String(b.child ?? '');
    if (b.revise) {
      const draft = store.draft(b.revise) ?? fail(404, '没有这节待审核的课');
      const row = store.drafts().find(x => x.key === b.revise)!;
      if (row.status !== '已退回' || !row.note) fail(400, '这节课没有被退回，没有修改意见');
      request.revise = { stages: disassemble(draft), note: row.note! };
      child = draft.for_child;
    }
    const ctx = context(child);
    const job: Job = { id: randomBytes(6).toString('hex'), child, model: `${m!.label}`, status: 'running', started_at: iso(), log: [] };
    jobs.set(job.id, job);
    for (const old of [...jobs.keys()].slice(0, -10)) jobs.delete(old);
    const log = (msg: string) => job.log.push({ at: iso(), msg });
    log(b.revise ? `按家长意见修改 ${b.revise}（${m!.label}）` : `用 ${m!.label} 给${ctx.child.label}写课`);
    void (async () => {
      try {
        const r = await generateLesson({ root, ctx, request, chat: chatFor(m!), validatorCtx: request.revise ? valCtx(request.revise.stages) : valCtx({} as Stages), onLog: log });
        if (!r.ok || !r.spec) {
          job.status = 'failed';
          job.error = r.report ? `写了 ${r.rounds} 轮还有问题没改好` : '模型没有给出能用的课';
          job.issues = (r.report?.results ?? []).filter(x => !x.ok && x.level === 'error').flatMap(x => x.issues.map(i => ({ rule: x.id, path: i.path, msg: i.msg }))).slice(0, 20);
          return;
        }
        const s = submit(r.spec, `AI 出课 · ${m!.label}`);
        if (!s.report.ok) { job.status = 'failed'; job.error = '服务器校验没通过'; return; }
        Object.assign(job, { status: 'done', key: s.key, title: r.spec.title });
        log(`已放进“课程库 → 等你审核”：${r.spec.title}`);
      } catch (e) { job.status = 'failed'; job.error = (e as Error).message; log(`出错：${(e as Error).message}`); }
    })();
    return reply.code(202).send({ job: job.id });
  });
  app.get('/v1/studio/jobs', d.parent, async () => [...jobs.values()].reverse().map(({ log: _l, ...j }) => j));
  app.get('/v1/studio/jobs/:id', d.parent, async (req) => jobs.get((req.params as { id: string }).id) ?? fail(404, '没有这个任务'));
}
