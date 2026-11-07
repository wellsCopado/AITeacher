// AI lesson writing on the family server. The parent picks any chat model (DeepSeek, Qwen, GPT, Claude, a local
// Ollama…) and has it write a lesson; AI assistants (Codex, Claude Code, Qoder, Cursor…) connect over MCP with a
// token from the parent app. Either way the lesson lands in 课程库 → 等你审核: only the parent's button publishes.
// API keys stay in this server's database and are never sent back, not even to the parent app.
// With the parent's ChatGPT account (Codex on this computer) the parent also plans the lesson in a chat here and has
// ChatGPT draw photoreal pictures from real photos, so nothing has to be done inside Codex itself.
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from 'fastify';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { zipSync } from 'fflate';
import type { LessonSpec, ReteachTicket } from '../../../packages/schema/src/index.js';
import type { Ctx, Report } from '../../../packages/validator/src/index.js';
import {
  BRIEF_HEADER, PROVIDERS, briefFields, topicFromWish, chatWith, codexExec, explorePrompt, exploreId, seedExploreSkill, checkStages, codexImage, codexResearch, codexStatus, createMcp, designPrompt, disassemble, exampleStages, generateLesson, guide,
  isCodex, listModels, outcome, studioContext,
  type Chat, type CodexOpts, type GuideTopic, type LessonRequest, type Message, type ModelConfig, type Stages, type StudioBackend,
} from '../../../packages/studio/src/index.js';
import type { Role, Store } from './db.js';
import { fail, HttpError } from './http.js';
import { reteachHistory } from './homework.js';
import { dateText, type WishBook } from './wishes.js';
import type { PrepRow } from './db.js';
import { habitatName, habitatOf, loadThemes, readyDepicts, scenesShowing, shows, topicPlan } from '../../../packages/cli/src/lib.js';

interface Deps {
  store: Store; root: string; tenant: string; iso: () => string;
  parent: RouteShorthandOptions; agentOrParent: RouteShorthandOptions;
  issue: (role: Role, label: string) => string;
  /** intake: a lesson handed in now, so the rules for new lessons apply. */
  vet: (sp: LessonSpec, intake?: boolean) => { key: string; ticket?: ReteachTicket; report: Report };
  /** Pictures from AI assistants (one-time upload addresses), which organisms they can be of, and ChatGPT's own. */
  media: {
    prepareUpload: (a: Record<string, unknown>, by: string, base: string) => unknown; organismIds: () => string[];
    organism: (asset: string) => { name: string; real_scale: string | null } | undefined;
    references: (asset: string, pending?: boolean) => { path: string; label: string }[];
    addPending: (asset: string, data: Buffer, mime: string, m: { by: string; caption: string; refs?: string[]; kind?: 'photo' | 'cutout'; origin?: string;
      credit?: string; license?: string; source_url?: string | null; length_cm?: number | null }) => { id: string };
  };
  /** The children's next-lesson wishes and their prep lists. */
  wishes: WishBook;
  /** 探索课 packages into the review queue (an 探索课 Codex made here goes the same way as an uploaded one). */
  explore: { importPackage: (zip: Uint8Array, q: { child?: string; name?: string; topic?: string }, who: string) => { key: string; title: string; for_child: string; warnings: string[] } };
  /** Tests swap the network and the codex command out. */
  fetchImpl?: typeof fetch;
  codex?: CodexOpts;
}

const MODELS = 'studio.models', ACTIVE = 'studio.active', CONSENT = 'studio.consent';
type Job = { id: string; child: string; model: string; planner?: string; status: 'running' | 'done' | 'failed'; started_at: string; log: { at: string; msg: string }[]; key?: string; title?: string; error?: string; issues?: { rule: string; path: string; msg: string }[];
  /** explore: a whole 探索课 Codex is making (it takes long, so it runs beside ordinary lesson writing). */
  kind?: 'lesson' | 'explore'; topic?: string };
/** A planning chat turn, or a picture ChatGPT is drawing: both take a minute or more, so the app polls them. */
type Task = { id: string; status: 'running' | 'done' | 'failed'; started_at: string; model: string; reply?: string; brief?: string | null; asset?: string; media_id?: string; error?: string;
  /** Making a lesson's animal: which step it is on (finding photos, drawing the top view). */
  step?: string };
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
  /** Lessons the parent didn't take, most recent last, with the reason; never the children's words. */
  const declined = (child: string) => store.drafts().filter(x => x.status === '不采用' && x.for_child === child).slice(-10).map(x => {
    const sp = store.draft(x.key)!;
    return { title: x.title, theme: sp.theme.name, concept: sp.primary_concept.name, reason: x.note };
  });
  /** What a lesson for this child is written from; it follows the first queued wish, or the prep list the parent picked. */
  const context = (child: string, prep?: string) => {
    if (!store.hasChild(child)) fail(400, `没有这个孩子：${child}（可选：${store.children().map(c => c.id).join('、')}）`);
    return studioContext(root, child, { interests: d.wishes.interestsFor(child, prep), wishOn: d.wishes.head(child, prep)?.wished_on, published: published(), takenKeys: [...store.lessons().map(l => l.key), ...store.drafts().map(x => x.key)], declined: declined(child), tenant: d.tenant, progress: progress(child), today: iso().slice(0, 10) });
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
    const { key, report } = d.vet(spec, true);
    if (store.lesson(key)) fail(409, `${key} 已发布且已冻结；修改请升版本号`);
    if (!report.ok) return { key, report, followed: [] as PrepRow[] };
    const followed = store.tx(() => { const f = d.wishes.follow(spec, key); store.upsertDraft(spec, by, iso()); return f; });
    return { key, report, followed };
  };

  // ---- the built-in lesson writer (a job): 课程库 → AI 出一节课, or an assistant handing over an agreed plan ----
  const jobs = new Map<string, Job>();
  const startJob = (b: { child?: string; wish?: string; component?: string; model?: string; revise?: string; topic?: string; prep?: string }, planner?: string): Job => {
    // an agreed plan says for whom and about what; the parent's own 主题 box says what it is about, and so does a
    // one-line request that names one (“写一个蟋蟀的课程”): before, that topic never became the lesson's subject or scene
    const plan = b.wish ? briefFields(String(b.wish)) : {};
    if (!b.revise && plan.child && childId(plan.child)) b.child = childId(plan.child);
    const boxed = String(b.topic ?? '').trim().slice(0, 20) || plan.topic;
    const topic = boxed || (b.wish && !b.revise ? topicFromWish(String(b.wish)) ?? undefined : undefined);
    const request: LessonRequest = { wish: b.wish ? String(b.wish).slice(0, 8000) : undefined, component: b.component || undefined };
    let child = childId(String(b.child ?? '')) ?? String(b.child ?? '');
    // 写啥主题就做啥图片: the fixed 3D scenes only take lessons about what they depict (V27). Any other topic gets its
    // own scene and pictures: Codex makes it as an 探索课 from the 探索课 Skill, never the old scene with new words.
    const th = loadThemes(root);
    const comps = request.component ? [request.component.split('@')[0]] : [...new Set(Object.values(th.skins).map(s => s.component))];
    const ownScene = (t: string) => comps.some(c => scenesShowing(th, t, c).length > 0);
    const notShown = (t: string, where?: string) => `「${t}」${where ? `不在「${where}」的画面里` : '没有现成的 3D 场景'}（现成的只有${readyDepicts(th)}，画的都不是它），套旧场景只能改字、图还是原来的`;
    if (b.revise) {
      const draft = store.draft(b.revise) ?? fail(404, '没有这节待审核的课');
      const row = store.drafts().find(x => x.key === b.revise)!;
      if (row.status !== '已退回' || !row.note) fail(400, '这节课没有被退回，没有修改意见');
      // the parent's note asks for another topic (“改成火箭发射”): that is a new lesson with its own pictures
      const asked = topicFromWish(row.note!), skin = draft.theme.skin ?? '';
      if (asked && !draft.title.includes(asked) && !shows(th, skin, asked)) return startExplore({ child: draft.for_child, topic: asked, wish: row.note!,
        why: `${notShown(asked, th.skins[skin]?.name ?? skin)}：按「${asked}」自己的样子做成一节探索课。原来那节课还在“等你审核”里，不要了点“不采用”` });
      request.revise = { stages: disassemble(draft), note: row.note! };
      child = draft.for_child;
    }
    let prep: PrepRow | undefined;
    if (b.prep) {
      prep = store.prep(String(b.prep));
      if (!prep || prep.status !== '准备中') fail(400, '这张准备单不在排队里（已经安排、跳过了，或者还要你先确认主题）');
      child = prep!.child;
      if (!ownScene(prep!.topic)) return startExplore({ child, topic: prep!.topic, prep: prep!.id, why: `按${d.wishes.label(child)}${dateText(prep!.wished_on)}的心愿准备。${notShown(prep!.topic)}：按它自己的样子做成探索课` });
    }
    if (topic && !b.revise && !ownScene(topic)) return startExplore({ child, topic, wish: b.wish, why: `${notShown(topic)}：按「${topic}」自己的样子做成探索课` });
    // a request in the parent's own words whose topic can't be read: never let the model pick an old scene for it and
    // tie the two together (“宇宙探索准备：机器人把零件摆整齐”, 2026-11-07). The parent names the topic, or it isn't written.
    // (a request only about how hard or which maths, “难一点”, keeps the child's own interest as the topic)
    const onlyHow = (w: string) => !w.replace(/数学|面积|周长|乘法|除法|加法|减法|口诀|计算|应用题|难|简单|容易|一点|一些|点|些|再|更|稍微|知识点?|题目?|新课|下一|课程?|一节|一个|写|出|做|来|给|哥哥|妹妹|的|吧|呢|啊|[\s\p{P}\d]/gu, '');
    if (!topic && !b.revise && !b.prep && b.wish && !String(b.wish).includes(BRIEF_HEADER) && !onlyHow(String(b.wish)))
      fail(400, '从你写的要求里看不出这节课的主题：在「主题」框写上（例如：宇宙、蜜蜂），就按这个主题自己的样子做，不会套用现成的场景');
    if ([...jobs.values()].some(j => j.status === 'running' && j.kind !== 'explore')) fail(409, '上一节课还在写，写完再开始下一节');
    const m = pick(b.model);
    const directed = topic && !b.revise && store.hasChild(child) ? store.directTopic(child, topic, iso().slice(0, 7), iso()) : null;
    const ctx = context(child, b.prep);
    // the same for what the child wished for or the parent named earlier (大象, 金鱼, 火箭): its own 探索课
    const stuck = !b.revise && ctx.components.every(c => c.suggested_theme.subject && !c.suggested_theme.skin) ? ctx.components[0]?.suggested_theme : undefined;
    if (stuck?.subject) {
      const ref = stuck.interest_refs[0], queued = d.wishes.queue(child).find(p => p.interest_id === ref);
      return startExplore({ child, topic: stuck.subject.name, prep: queued?.id, interest: ref, why: `${stuck.why}。${notShown(stuck.subject.name)}：按它自己的样子做成探索课` });
    }
    const job: Job = { id: randomBytes(6).toString('hex'), child, model: m.label, status: 'running', started_at: iso(), log: [], ...(planner ? { planner } : {}) };
    jobs.set(job.id, job);
    for (const old of [...jobs.keys()].slice(0, -10)) jobs.delete(old);
    const log = (msg: string) => job.log.push({ at: iso(), msg });
    log(b.revise ? `按家长意见修改 ${b.revise}（${m.label}）` : `用 ${m.label} 给${ctx.child.label}写课${planner ? `（方案来自 ${planner}）` : request.wish && request.wish.length > 200 ? '（按粘贴的课程方案）' : ''}`);
    if (topic && !boxed) log(`主题「${topic}」：从你写的要求里看出来的。不对的话，在「主题」框里写上想要的主题再出一次`);
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
        const th = loadThemes(root), t = r.spec.theme;
        if (t.subject && t.skin && th.skins[t.skin]) log(`场景用「${th.skins[t.skin].name}」：${t.subject.name}生活在${habitatName(th, habitatOf(th, t.subject.name, t.subject.kind))}`);
        for (const p of s.followed) log(`按${ctx.child.label}${dateText(p.wished_on)}的心愿「${p.topic}」准备的`);
        if (directed && r.spec.theme.interest_refs.includes(directed.id)) store.topicUsed(directed.id, s.key);
        const subj = r.spec.theme.subject, cm = codexModel();
        if (subj && store.mediaFor(subj.asset_id).some(x => x.confirmed)) log(`主角「${subj.name}」的画面已经有了`);
        else if (subj && subj.kind === 'organism' && cm && consent() && !subjectTask(subj.asset_id)) {
          makeSubject(subj.asset_id, cm);
          log(`已让 ChatGPT 去找「${subj.name}」的实拍照片，再画成能动的 3D：做好后在“生物素材”里看一眼、确认，这节课就能发布`);
        } else if (subj) log(`主角「${subj.name}」还没有画面：在“生物素材”里加照片或让 ChatGPT 做，确认后这节课才能发布`);
        log(`已放进“课程库 → 等你审核”：${r.spec.title}`);
      } catch (e) { job.status = 'failed'; job.error = (e as Error).message; log(`出错：${(e as Error).message}`); }
    })();
    return job;
  };
  /** kind explore: the topic had no scene of its own, so it is being made as an 探索课 (the reply's topic says which). */
  app.post('/v1/studio/generate', d.parent, async (req, reply) => {
    const j = startJob((req.body ?? {}) as Record<string, string>);
    return reply.code(202).send({ job: j.id, kind: j.kind ?? 'lesson', ...(j.kind === 'explore' ? { topic: j.topic, why: j.log[0]?.msg } : {}) });
  });
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
  /**
   * A lesson's animal made by ChatGPT from start to finish: it finds real photos on the web (unless 3 are already
   * here), then draws a photoreal top view that the 3D scene joints into a moving animal at its true size.
   * Everything waits in 生物素材 until the parent has checked it against the photos.
   */
  const codexModel = () => models().find(x => isCodex(x));
  const subjectTask = (asset: string) => [...tasks.values()].find(t => t.status === 'running' && t.asset === asset);
  const makeSubject = (asset: string, m: ModelConfig, note = ''): Task => {
    const o = d.media.organism(asset) ?? fail(404, '资产库里没有这个生物');
    if (subjectTask(asset)) fail(409, `「${o.name}」正在做，做好再开始`);
    return startTask(m, { asset, step: '上网找实拍照片' }, async t => {
      const model = m.model || undefined;
      let refs = d.media.references(asset, true), len = Number(/[\d.]+/.exec(o.real_scale ?? '')?.[0]) || null;
      if (refs.length < 3) {
        const found = await codexResearch({ name: o.name, model }, d.codex);
        if (found.photos.length + refs.length < 3) throw new Error(`ChatGPT 只找到 ${found.photos.length} 张「${o.name}」的实拍照片，不够 3 张：可以自己加几张再试`);
        store.setSetting(`subject.${asset}`, JSON.stringify({ scientific_name: found.scientific_name, length_cm: found.length_cm, habitat: found.habitat, facts: found.facts, by: m.label, at: iso() }));
        len = found.length_cm ?? len;
        for (const p of found.photos) d.media.addPending(asset, p.data, p.mime, { by: m.label, origin: '实拍', caption: p.caption, credit: p.author, license: p.license, source_url: p.source_url });
        refs = d.media.references(asset, true);
      }
      t.step = '画俯视写实图（做 3D 用）';
      const use = refs.slice(-4);
      const prompt = [
        `依据附上的 ${use.length} 张实拍照片，画一张「${o.name}」的照片级写实图，在小学数学课的场景里做成会动的 3D 模型用。${len ? `真实体长约 ${len} 厘米。` : ''}`,
        '- 正上方垂直俯视，整只完整入画，身体舒展、平放；细长的身体摆成平缓的弧线或直线，不要卷曲、打结或重叠。头朝画面左边，尾朝右边。',
        '- 背景完全透明（PNG 透明背景）；做不到透明就用纯白、没有阴影、没有地面纹理的背景。',
        '- 像标本摄影：形态、颜色、斑纹、身体比例，附肢、触角、眼的数量和位置都和参考照片一致；光线均匀柔和，不要卡通、插画感，不要发光或夸张的颜色。',
        '- 画面里只有这一只生物：不要文字、水印、比例尺、人或手。',
        note && `- 家长的要求：${note}`,
      ].filter(Boolean).join('\n');
      const img = await codexImage({ prompt, references: use.map(r => r.path), model }, d.codex);
      t.media_id = d.media.addPending(asset, img.data, img.mime, { by: m.label, kind: 'cutout', caption: `${o.name} · 俯视全身，课里做成会动的 3D`, refs: use.map(r => r.label), length_cm: len }).id;
      t.step = '做好了，等你确认';
      t.reply = img.note;
    });
  };
  app.post('/v1/studio/subject', d.parent, async (req, reply) => {
    const b = (req.body ?? {}) as { asset?: string; note?: string };
    const m = codexModel() ?? fail(400, '自动找照片和画图要用 ChatGPT 账号：先在“设备与数据 → 大模型”里添加“ChatGPT 账号（本机 Codex）”');
    if (!consent()) fail(403, '先在“设备与数据 → 大模型”里勾选同意：会把这种生物的名字和实拍照片发给 ChatGPT');
    const t = makeSubject(String(b.asset ?? ''), m, String(b.note ?? '').trim().slice(0, 300));
    return reply.code(202).send({ id: t.id, model: m.label });
  });
  app.get('/v1/studio/tasks', d.parent, async () => [...tasks.values()].reverse());
  app.get('/v1/studio/tasks/:id', d.parent, async (req) => tasks.get((req.params as { id: string }).id) ?? fail(404, '没有这个任务'));

  // ---- next-lesson prep lists (pipeline P0): get the wished-for topic ready before its lesson ----
  /** How far a prep list's topic is: the ready scene that depicts it, or the 探索课 that will be made for it. */
  const readiness = (p: PrepRow) => {
    const th = loadThemes(root), plan = topicPlan(p.topic, th);
    const ready = plan.skins.filter(s => s.status === '已有');
    const making = [...jobs.values()].find(j => j.kind === 'explore' && j.status === 'running' && j.topic === p.topic && j.child === p.child);
    // no scene depicts it: its lesson is an 探索课 with its own scene and pictures (写啥主题就做啥图片)
    const subject = ready.length ? null : { name: p.topic, asset_id: plan.subject!.asset_id, kind: plan.subject!.kind,
      state: making ? '正在做成探索课' : `没有现成的场景：按「${p.topic}」自己的样子做成探索课` };
    return {
      scenes: ready.map(s => ({ name: s.name, component: s.component, ...(s.realism ? { realism: s.realism } : {}) })),
      planned: plan.skins.filter(s => s.status !== '已有').map(s => s.name),
      subject, explore: !ready.length,
      ready: !!ready.length && ready.every(s => !s.realism),
    };
  };
  const prepView = (p: PrepRow, withWords: boolean) => {
    const { said: _s, log, ...rest } = p;
    return { ...rest, ...(withWords ? { said: p.said, log } : {}), child_label: d.wishes.label(p.child), wished: dateText(p.wished_on), ...(p.status === '等你确认主题' ? { topic: withWords ? p.topic : null } : {}), ...readiness(p) };
  };
  /** Start collecting what a queued prep list needs, as far as this server can do it by itself. */
  const prepare = (id: string) => {
    const p = store.prep(id);
    if (!p || p.status !== '准备中') return;
    const say = (msg: string) => store.logPrep(id, msg, iso());
    const r = readiness(p);
    if (r.scenes.length) {
      say(`用现成的 3D 场景「${r.scenes.map(s => s.name).join('、')}」${r.scenes.some(s => s.realism) ? `（${r.scenes.find(s => s.realism)!.realism}）` : ''}`);
      return;
    }
    say(`「${p.topic}」没有现成的 3D 场景（现成的只有${readyDepicts(loadThemes(root))}，画的都不是它），旧场景改字换不了图：点“现在按它出课”，家里 Mac 上的 ChatGPT（Codex）会按「${p.topic}」自己的样子建场景、做每一张图，做成探索课`);
  };
  app.get('/v1/preps', d.parent, async () => store.preps().map(p => prepView(p, true)));
  app.post('/v1/preps/:id/topic', d.parent, async (req) => {
    const p = d.wishes.setTopic((req.params as { id: string }).id, String((req.body as { topic?: unknown })?.topic ?? ''));
    prepare(p.id);
    return prepView(store.prep(p.id)!, true);
  });
  app.post('/v1/preps/:id/skip', d.parent, async (req) => { d.wishes.skip((req.params as { id: string }).id); return { ok: true }; });
  app.post('/v1/preps/:id/prepare', d.parent, async (req) => {
    const id = (req.params as { id: string }).id;
    if (!store.prep(id)) fail(404, '没有这张准备单');
    prepare(id);
    return prepView(store.prep(id)!, true);
  });

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
    nextLessons: () => store.children().map(c => {
      const all = store.preps(c.id);
      return { child: c.id, label: d.wishes.label(c.id), queue: d.wishes.queue(c.id).map(p => prepView(p, false)), waiting_for_parent: all.filter(p => p.status === '等你确认主题').length };
    }),
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

  // ---- 探索课 made here: Codex works from the 探索课 Skill, decides what is worth learning about the topic, builds
  // the topic's own scene and lesson, and the package goes into 课程库 → 探索课 like an uploaded one ----
  const EXPLORE_MIN = Number(process.env.ADW_EXPLORE_MINUTES) || 240;
  /** The package Codex left: its zip, or its package/ folder zipped here (without node_modules). */
  const packed = (dir: string): Uint8Array | null => {
    const top = readdirSync(dir);
    const folder = top.includes('package') ? join(dir, 'package') : null;
    if (folder && existsSync(join(folder, 'exploration.json'))) {
      const files: Record<string, Uint8Array> = {};
      const walk = (at: string) => { for (const n of readdirSync(at)) {
        if (/^(node_modules|\.git|__MACOSX|\.DS_Store)$/.test(n)) continue;
        const f = join(at, n), st = lstatSync(f); // links stay out: nothing outside Codex's folder goes into a package
        if (st.isDirectory()) walk(f); else if (st.isFile()) files[`package/${relative(folder, f).split('\\').join('/')}`] = new Uint8Array(readFileSync(f));
      } };
      walk(folder);
      return zipSync(files, { level: 0 });
    }
    const zip = top.find(n => n.endsWith('.zip'));
    return zip ? new Uint8Array(readFileSync(join(dir, zip))) : null;
  };
  /**
   * An 探索课 Codex makes from a topic: the parent's own request in 探索课, or a lesson request whose topic no fixed
   * scene depicts (写啥主题就做啥图片). why: the first log line, saying why it became an 探索课. prep / interest: the
   * child's wish or the parent's earlier topic it follows, marked done once the lesson is in.
   */
  function startExplore(o: { child: string; topic: string; wish?: string; why?: string; prep?: string; interest?: string }): Job {
    const topic = o.topic.trim().slice(0, 20) || fail(400, '写一下这节探索课的主题，例如：蜜蜂');
    const child = childId(o.child) ?? fail(400, '选一下给谁做');
    const routed = o.why ? `${o.why}。` : '';
    const m = codexModel() ?? fail(400, `${routed}做探索课要用 ChatGPT 账号：先在「设备与数据 → 大模型」添加“ChatGPT 账号（Codex）”`);
    if (!consent()) fail(403, `${routed}先在「设备与数据 → 大模型」勾选同意（只发年级、主题和课内进度）`);
    if ([...jobs.values()].some(j => j.status === 'running' && j.kind === 'explore')) fail(409, `${routed}上一节探索课还在做，做好再开始下一节`);
    const ctx = context(child);
    const job: Job = { id: randomBytes(6).toString('hex'), child, model: m.label, status: 'running', started_at: iso(), log: [], kind: 'explore', topic };
    jobs.set(job.id, job);
    for (const old of [...jobs.keys()].slice(0, -10)) jobs.delete(old);
    const log = (msg: string) => { job.log.push({ at: iso(), msg }); if (job.log.length > 300) job.log.splice(1, job.log.length - 300); };
    const id = exploreId(child, iso().slice(0, 10), randomBytes(2).toString('hex'));
    log(`${routed}让 ChatGPT（Codex）给${ctx.child.label}做一节「${topic}」的探索课：先查该学什么，再按「${topic}」自己的样子建场景、做每一张图，最后打包验收。一般要几十分钟到几小时，可以先做别的`);
    void (async () => {
      let dir = '';
      try {
        const r = await codexExec({ prompt: explorePrompt(ctx, { topic, wish: o.wish ? String(o.wish).slice(0, 2000) : undefined, id }), model: m.model || undefined, write: true, web: true,
          seed: at => seedExploreSkill(root, at), onProgress: log }, { ...d.codex, timeoutMs: EXPLORE_MIN * 60_000 });
        dir = r.dir;
        const zip = packed(dir);
        if (!zip) throw new Error(`ChatGPT 没有交出课程包${r.text ? `：${r.text.slice(0, 200)}` : ''}`);
        // made for this topic: the App checks its pictures were made for it and are no other lesson's (topic-assets.md)
        const x = d.explore.importPackage(zip, { child, name: `AI 做的「${topic}」`, topic }, `AI 做探索课 · ${m.label}`);
        if (r.text) log(r.text.slice(0, 400));
        if (o.prep) d.wishes.arranged(o.prep, x.key);
        if (o.interest) store.topicUsed(o.interest, x.key);
        Object.assign(job, { status: 'done', key: x.key, title: x.title });
        log(`已放进“课程库 → 探索课”：${x.title}。先点“预览这节课”走一遍，再决定${x.warnings.length ? `（有 ${x.warnings.length} 条提示，看卡片上的红字）` : ''}`);
      } catch (e) { job.status = 'failed'; job.error = (e as Error).message; log(`没做成：${(e as Error).message}`); }
      finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
    })();
    return job;
  }
  app.post('/v1/explore/make', d.parent, async (req, reply) => {
    const b = (req.body ?? {}) as { child?: string; topic?: string; wish?: string };
    const j = startExplore({ child: String(b.child ?? ''), topic: String(b.topic ?? ''), wish: b.wish ? String(b.wish) : undefined });
    return reply.code(202).send({ job: j.id, kind: 'explore', topic: j.topic });
  });

  app.get('/v1/studio/jobs', d.parent, async () => [...jobs.values()].reverse().map(({ log: _l, ...j }) => j));
  app.get('/v1/studio/jobs/:id', d.parent, async (req) => jobs.get((req.params as { id: string }).id) ?? fail(404, '没有这个任务'));
  return { prepare };
}
