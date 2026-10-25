// AI lesson writing on the family server. The parent picks any chat model (DeepSeek, Qwen, GPT, Claude, a local
// Ollama…) and has it write a lesson; AI assistants (Codex, Claude Code, Qoder, Cursor…) connect over MCP with a
// token from the parent app. Either way the lesson lands in 课程库 → 等你审核: only the parent's button publishes.
// API keys stay in this server's database and are never sent back, not even to the parent app.
// With the parent's ChatGPT account (Codex on this computer) the parent also plans the lesson in a chat here and has
// ChatGPT draw photoreal pictures from real photos, so nothing has to be done inside Codex itself.
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { LessonSpec, ReteachTicket } from '../../../packages/schema/src/index.js';
import type { Ctx, Report } from '../../../packages/validator/src/index.js';
import {
  BRIEF_HEADER, PROVIDERS, briefFields, chatWith, checkStages, codexImage, codexStatus, createMcp, designPrompt, disassemble, exampleStages, generateLesson, guide,
  isCodex, listModels, outcome, studioContext,
  type Chat, type CodexOpts, type GuideTopic, type LessonRequest, type Message, type ModelConfig, type Stages, type StudioBackend,
} from '../../../packages/studio/src/index.js';
import type { Role, Store } from './db.js';
import { fail, HttpError } from './http.js';
import { reteachHistory } from './homework.js';

interface Deps {
  store: Store; root: string; tenant: string; iso: () => string;
  parent: RouteShorthandOptions; agentOrParent: RouteShorthandOptions;
  issue: (role: Role, label: string) => string;
  vet: (sp: LessonSpec) => { key: string; ticket?: ReteachTicket; report: Report };
  /** Pictures from AI assistants (one-time upload addresses), which organisms they can be of, and ChatGPT's own. */
  media: {
    prepareUpload: (a: Record<string, unknown>, by: string, base: string) => unknown; organismIds: () => string[];
    organism: (asset: string) => { name: string; real_scale: string | null } | undefined;
    references: (asset: string) => { path: string; label: string }[];
    addPending: (asset: string, data: Buffer, mime: string, m: { by: string; caption: string; refs: string[] }) => { id: string };
  };
  /** Tests swap the network and the codex command out. */
  fetchImpl?: typeof fetch;
  codex?: CodexOpts;
}

const MODELS = 'studio.models', ACTIVE = 'studio.active', CONSENT = 'studio.consent';
type Job = { id: string; child: string; model: string; planner?: string; status: 'running' | 'done' | 'failed'; started_at: string; log: { at: string; msg: string }[]; key?: string; title?: string; error?: string; issues?: { rule: string; path: string; msg: string }[] };
/** A planning chat turn, or a picture ChatGPT is drawing: both take a minute or more, so the app polls them. */
type Task = { id: string; status: 'running' | 'done' | 'failed'; started_at: string; model: string; reply?: string; brief?: string | null; asset?: string; media_id?: string; error?: string };
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
    if (isCodex({ provider: b.provider ?? keep?.provider ?? '' })) {
      const model = String(b.model ?? keep?.model ?? '').trim().replace(/^-$/, '');
      return { id: keep?.id ?? `m-${randomBytes(4).toString('hex')}`, label: String(b.label ?? '').trim().slice(0, 40) || keep?.label || `ChatGPT（本机 Codex）${model ? ` · ${model}` : ''}`, provider: 'codex', base_url: '', model, json_mode: false };
    }
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
  const chatFor = (m: ModelConfig): Chat => chatWith(m, { fetchImpl: d.fetchImpl, codex: d.codex });
  const pick = (id?: string) => {
    const m = id ? models().find(x => x.id === id || x.label === id) : active();
    if (!m) fail(400, id ? `没有这个模型：${id}（可选：${models().map(x => x.label).join('、')}）` : '还没有设置大模型：设备与数据 → 大模型');
    if (!isLocal(m!) && !consent()) fail(403, '先在“设备与数据 → 大模型”里勾选同意：会把年级、兴趣主题发给所选模型（不含姓名、照片和学习记录）');
    return m!;
  };

  app.get('/v1/studio/models', d.parent, async () => view());
  app.post('/v1/studio/models', d.parent, async (req) => {
    const b = (req.body ?? {}) as Partial<ModelConfig>;
    const all = models(), old = b.id ? all.find(m => m.id === b.id) : undefined;
    if (b.id && !old) fail(404, '没有这个模型设置');
    const m = fromBody(b, old);
    store.setSetting(MODELS, JSON.stringify(old ? all.map(x => (x.id === m.id ? m : x)) : [...all, m]));
    // a new model becomes the one lessons are written with; ChatGPT only if there is no other (it plans and draws)
    if (!store.setting(ACTIVE) || (!old && !isCodex(m))) store.setSetting(ACTIVE, m.id);
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
    if (isCodex(m)) {
      if (b.list_only) return { models: null, list_error: '用 ChatGPT 账号时不用选模型：留空就用 Codex 默认的模型' };
      const st = await codexStatus(d.codex);
      if (!st.installed || !st.logged_in) return { ok: false, error: st.detail, codex: st };
      try {
        const reply = await chatWith(m, { codex: d.codex, timeoutMs: 120_000 })([{ role: 'user', content: '用一句话介绍你自己（不超过 20 个字）。' }]);
        return { ok: true, reply: reply.trim().slice(0, 200), ms: Date.now() - t0, codex: st };
      } catch (e) { return { ok: false, error: (e as Error).message, codex: st }; }
    }
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
  const progress = (child: string) => store.setting(`progress.${child}`);
  const context = (child: string) => {
    if (!store.hasChild(child)) fail(400, `没有这个孩子：${child}（可选：${store.children().map(c => c.id).join('、')}）`);
    return studioContext(root, child, { interests: store.interests(), published: published(), takenKeys: [...store.lessons().map(l => l.key), ...store.drafts().map(x => x.key)], tenant: d.tenant, progress: progress(child), today: iso().slice(0, 10) });
  };
  /** 哥哥 / 妹妹 or an id → the child's id. */
  const childId = (s: string) => store.children().find(c => c.id === s || c.name === s)?.id;
  // ---- where each child is in school maths, in the parent's words (the lesson writer guesses from the date without it) ----
  app.get('/v1/progress', d.parent, async () => Object.fromEntries(store.children().map(c => [c.id, progress(c.id) ?? ''])));
  app.put('/v1/progress/:child', d.parent, async (req) => {
    const child = childId((req.params as { child: string }).child) ?? fail(404, '没有这个孩子');
    store.setSetting(`progress.${child}`, String((req.body as { text?: unknown })?.text ?? '').trim().slice(0, 300));
    return { child, text: progress(child) };
  });
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

  // ---- the built-in lesson writer (a job): 课程库 → AI 出一节课, or an assistant handing over an agreed plan ----
  const jobs = new Map<string, Job>();
  const startJob = (b: { child?: string; wish?: string; component?: string; model?: string; revise?: string; topic?: string }, planner?: string): Job => {
    const m = pick(b.model);
    // an agreed plan says for whom and about what; the parent's own 主题 box says what it is about
    const plan = b.wish ? briefFields(String(b.wish)) : {};
    if (!b.revise && plan.child && childId(plan.child)) b.child = childId(plan.child);
    const topic = String(b.topic ?? '').trim().slice(0, 20) || plan.topic;
    if ([...jobs.values()].some(j => j.status === 'running')) fail(409, '上一节课还在写，写完再开始下一节');
    const request: LessonRequest = { wish: b.wish ? String(b.wish).slice(0, 8000) : undefined, component: b.component || undefined };
    let child = childId(String(b.child ?? '')) ?? String(b.child ?? '');
    if (b.revise) {
      const draft = store.draft(b.revise) ?? fail(404, '没有这节待审核的课');
      const row = store.drafts().find(x => x.key === b.revise)!;
      if (row.status !== '已退回' || !row.note) fail(400, '这节课没有被退回，没有修改意见');
      request.revise = { stages: disassemble(draft), note: row.note! };
      child = draft.for_child;
    }
    const directed = topic && !b.revise && store.hasChild(child) ? store.directTopic(child, topic, iso().slice(0, 7), iso()) : null;
    const ctx = context(child);
    const job: Job = { id: randomBytes(6).toString('hex'), child, model: m.label, status: 'running', started_at: iso(), log: [], ...(planner ? { planner } : {}) };
    jobs.set(job.id, job);
    for (const old of [...jobs.keys()].slice(0, -10)) jobs.delete(old);
    const log = (msg: string) => job.log.push({ at: iso(), msg });
    log(b.revise ? `按家长意见修改 ${b.revise}（${m.label}）` : `用 ${m.label} 给${ctx.child.label}写课${planner ? `（方案来自 ${planner}）` : request.wish && request.wish.length > 200 ? '（按粘贴的课程方案）' : ''}`);
    void (async () => {
      try {
        const r = await generateLesson({ root, ctx, request, chat: chatFor(m), validatorCtx: valCtx(request.revise?.stages ?? ({} as Stages)), onLog: log });
        if (!r.ok || !r.spec) {
          job.status = 'failed';
          job.error = r.report ? `写了 ${r.rounds} 轮还有问题没改好` : '模型没有给出能用的课';
          job.issues = (r.report?.results ?? []).filter(x => !x.ok && x.level === 'error').flatMap(x => x.issues.map(i => ({ rule: x.id, path: i.path, msg: i.msg }))).slice(0, 20);
          return;
        }
        const s = submit(r.spec, `AI 出课 · ${m.label}${planner ? ` · 方案：${planner}` : ''}`);
        if (!s.report.ok) { job.status = 'failed'; job.error = '服务器校验没通过'; return; }
        Object.assign(job, { status: 'done', key: s.key, title: r.spec.title });
        if (directed && r.spec.theme.interest_refs.includes(directed.id)) store.topicUsed(directed.id, s.key);
        const subj = r.spec.theme.subject;
        if (subj) log(store.mediaFor(subj.asset_id).some(x => x.confirmed) ? `主角「${subj.name}」的画面已经有了` : `主角「${subj.name}」还没有画面：在“生物素材”里加照片或让 ChatGPT 画，确认后这节课才能发布`);
        log(`已放进“课程库 → 等你审核”：${r.spec.title}`);
      } catch (e) { job.status = 'failed'; job.error = (e as Error).message; log(`出错：${(e as Error).message}`); }
    })();
    return job;
  };
  app.post('/v1/studio/generate', d.parent, async (req, reply) => reply.code(202).send({ job: startJob((req.body ?? {}) as Record<string, string>).id }));
  /** What to paste into ChatGPT (or any chat) to plan the next lesson with it; the plan comes back to 课程方案. */
  app.get('/v1/studio/design-prompt', d.parent, async (req) => {
    const child = childId(String((req.query as { child?: string }).child ?? '')) ?? fail(400, '选一个孩子');
    return { text: designPrompt(context(child), store.children().filter(c => c.id !== child).map(c => context(c.id))) };
  });

  // ---- in the parent app with ChatGPT (or any model): plan the lesson in a chat, draw pictures from real photos ----
  const tasks = new Map<string, Task>();
  const startTask = (model: ModelConfig, extra: Partial<Task>, work: (t: Task) => Promise<void>): Task => {
    const t: Task = { id: randomBytes(6).toString('hex'), status: 'running', started_at: iso(), model: model.label, ...extra };
    tasks.set(t.id, t);
    for (const old of [...tasks.keys()].slice(0, -30)) tasks.delete(old);
    void work(t).then(() => { t.status = 'done'; }, e => { t.status = 'failed'; t.error = (e as Error).message; });
    return t;
  };
  app.get('/v1/studio/codex', d.parent, async () => codexStatus(d.codex));
  /** One turn of 和 AI 商量方案: the design brief is the system prompt; the parent's chat is kept by the app. */
  app.post('/v1/studio/plan', d.parent, async (req, reply) => {
    const b = (req.body ?? {}) as { child?: string; model?: string; messages?: Message[] };
    const m = pick(b.model);
    const child = childId(String(b.child ?? '')) ?? fail(400, '选一个孩子');
    const msgs = (Array.isArray(b.messages) ? b.messages : []).slice(-40)
      .map(x => ({ role: x?.role === 'assistant' ? 'assistant' as const : 'user' as const, content: String(x?.content ?? '').slice(0, 8000) })).filter(x => x.content.trim());
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') fail(400, '先写一句你想要的');
    const system = `${designPrompt(context(child), store.children().filter(c => c.id !== child).map(c => context(c.id)))}\n\n现在你在家长端的“和 AI 商量方案”里直接和家长对话：每次回复简短（300 字以内），一次只问一两个问题。家长说“好了”“就这样”或者方案已经谈定，就按上面的格式输出完整的${BRIEF_HEADER}，前后不要加别的话。`;
    const t = startTask(m, {}, async t => {
      const text = (await chatWith({ ...m, json_mode: false }, { fetchImpl: d.fetchImpl, codex: d.codex, timeoutMs: 10 * 60_000 })([{ role: 'system', content: system }, ...msgs])).trim();
      const at = text.indexOf(BRIEF_HEADER);
      Object.assign(t, { reply: text, brief: at >= 0 ? text.slice(at) : null });
    });
    return reply.code(202).send({ id: t.id, model: m.label });
  });
  /** ChatGPT draws one photoreal picture from at least 3 real photos; it waits in 生物素材 for the parent's check. */
  app.post('/v1/studio/image', d.parent, async (req, reply) => {
    const b = (req.body ?? {}) as { asset?: string; model?: string; note?: string };
    const asset = String(b.asset ?? ''), o = d.media.organism(asset) ?? fail(404, '资产库里没有这个生物');
    const m = b.model ? pick(b.model) : models().find(x => isCodex(x)) ?? fail(400, '画图要用 ChatGPT 账号：先在“设备与数据 → 大模型”里添加“ChatGPT 账号（本机 Codex）”');
    if (!isCodex(m)) fail(400, '只有“ChatGPT 账号（本机 Codex）”能画图');
    if (!consent()) fail(403, '先在“设备与数据 → 大模型”里勾选同意：画图时会把这种生物的实拍照片发给 ChatGPT');
    if ([...tasks.values()].some(t => t.status === 'running' && t.asset)) fail(409, '上一张图还在画，画好再开始下一张');
    const refs = d.media.references(asset).slice(-4);
    if (refs.length < 3) fail(400, `要先在这里加至少 3 张${o.name}的实拍或标本照片（现在 ${refs.length} 张），ChatGPT 依据它们画，你也拿它们核对`);
    const note = String(b.note ?? '').trim().slice(0, 300);
    const prompt = [
      `依据附上的 ${refs.length} 张实拍照片，画一张「${o.name}」的照片级写实图，给小学生的数学课里当观察图用。${o.real_scale ? `真实体长约 ${o.real_scale}。` : ''}`,
      '- 要像真实拍摄的生态照片：不要卡通、插画、绘画感，不要夸张的颜色或发光。',
      '- 形态、颜色、斑纹、身体比例，腿、眼、触角、附肢的数量和位置都要和参考照片一致，不要多也不要少。',
      '- 整只生物完整入画，背景是它真实的栖息环境，简单不杂乱。',
      '- 画面里不要有文字、水印、比例尺、人或手。',
      note && `- 家长的要求：${note}`,
    ].filter(Boolean).join('\n');
    const t = startTask(m, { asset }, async t => {
      const img = await codexImage({ prompt, references: refs.map(r => r.path), model: m.model || undefined }, d.codex);
      t.media_id = d.media.addPending(asset, img.data, img.mime, { by: m.label, caption: note || `${o.name} · ChatGPT 依据实拍照片画的`, refs: refs.map(r => r.label) }).id;
      t.reply = img.note;
    });
    return reply.code(202).send({ id: t.id, model: m.label });
  });
  app.get('/v1/studio/tasks', d.parent, async () => [...tasks.values()].reverse());
  app.get('/v1/studio/tasks/:id', d.parent, async (req) => tasks.get((req.params as { id: string }).id) ?? fail(404, '没有这个任务'));

  // ---- AI assistants over MCP (Streamable HTTP, JSON replies) ----
  const backend = (who: string, base: string): StudioBackend => ({
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
    models: () => models().map(m => m.label),
    writeWithModel(a) {
      if (a.brief.trim().length < 20) fail(400, 'brief 要写谈好的课程方案全文');
      const j = startJob({ child: a.child, wish: a.brief, model: a.model }, who);
      return { job: j.id, model: j.model, status: '开始写课了。用 adw_job_status 查进度，写好后在家长端“课程库 → 等你审核”。' };
    },
    jobStatus: id => jobs.get(id) ?? fail(404, '没有这个任务'),
    organisms: d.media.organismIds,
    prepareImageUpload: a => d.media.prepareUpload(a, who, base),
  });
  app.post('/mcp', d.agentOrParent, async (req: FastifyRequest, reply) => {
    const out = await createMcp(backend(req.role === 'agent' ? req.who ?? 'AI 助手' : '家长', `${req.protocol}://${req.headers.host}`)).handle(req.body);
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

  app.get('/v1/studio/jobs', d.parent, async () => [...jobs.values()].reverse().map(({ log: _l, ...j }) => j));
  app.get('/v1/studio/jobs/:id', d.parent, async (req) => jobs.get((req.params as { id: string }).id) ?? fail(404, '没有这个任务'));
}
