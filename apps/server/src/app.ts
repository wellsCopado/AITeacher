// Family content server: serves today's lessons to the Pad, takes learning events, and gives the parent
// schedule, grants, records, interests and device pairing. Dates are Asia/Shanghai, decided here, never on the Pad.
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChildProfile, InterestObservation, LessonSpec, ReteachTicket } from '../../../packages/schema/src/index.js';
import { loadContext, mechanism, validate } from '../../../packages/validator/src/index.js';
import { contentHash, readJson, REVIEW_CHECKLIST } from '../../../packages/cli/src/lib.js';
import { Store, type EventIn, type Role } from './db.js';
import { HttpError, TZ, addDays, fail, isDate, isKey, sha, shanghaiDate } from './http.js';
import { homeworkRoutes, reteachHistory } from './homework.js';
import { mediaRoutes } from './media.js';
import { studioRoutes } from './studio.js';
import type { CodexOpts } from '../../../packages/studio/src/codex.js';
import { macSay, SYSTEM_VOICE, type Lang, type Synth } from './tts.js';

export { shanghaiDate, TZ } from './http.js';

export interface AppOptions {
  /** Repository root (has content/). */
  root: string;
  dbPath: string;
  /** Where homework photos are kept (default: next to the database). They never leave this server unless the parent agrees. */
  dataDir?: string;
  /** Parent PIN, at least 4 digits. */
  pin: string;
  tenant?: string;
  now?: () => Date;
  /** Serve the built Pad and parent apps from apps/{pad,parent}/dist. */
  serveApps?: boolean;
  logger?: boolean;
  /** Narration voice; default: the Mac's `say` when running on a Mac, none elsewhere. */
  tts?: Synth | null;
  /** How the AI lesson writer reaches model APIs (tests pass a fake). */
  fetchImpl?: typeof fetch;
  /** Which codex command runs the parent's ChatGPT account (default: codex on PATH, or ADW_CODEX_BIN). */
  codex?: CodexOpts;
}

const PAIR_TTL_MS = 10 * 60_000;
const LOCK_AFTER = 5, LOCK_MS = 60_000;


declare module 'fastify' { interface FastifyRequest { role?: Role; who?: string } }

export async function buildApp(o: AppOptions) {
  if (!/^\d{4,12}$/.test(o.pin)) throw new Error('家长 PIN 需要 4–12 位数字（环境变量 ADW_PIN）');
  const tenant = o.tenant ?? 'family-001';
  const now = o.now ?? (() => new Date());
  const today = () => shanghaiDate(now());
  const iso = () => now().toISOString();
  const store = new Store(o.dbPath, tenant);
  const children = readJson<Record<string, ChildProfile>>(join(o.root, 'content', 'children.json'));
  seed(store, o.root, tenant, children, iso());

  const app = Fastify({ logger: o.logger ?? false, bodyLimit: 8 * 1024 * 1024 });
  app.decorate('store', store);
  app.addHook('onClose', async () => store.db.close());
  app.setErrorHandler((e: Error & { statusCode?: number }, _req, reply) => {
    const status = e instanceof HttpError ? e.status : e.statusCode ?? 500;
    if (status >= 500) app.log.error(e);
    reply.code(status).send({ error: status >= 500 ? '服务器出错了' : e.message, ...(e instanceof HttpError ? e.extra : {}) });
  });

  // ---- auth ----
  let failures = 0, lockedUntil = 0;
  const issue = (role: Role, label: string) => { const t = randomBytes(32).toString('base64url'); store.addToken(sha(t), role, label, iso()); return t; };
  const auth = (...roles: Role[]) => async (req: FastifyRequest) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    const tok = m && store.token(sha(m[1]));
    if (!tok) fail(401, '需要登录或配对');
    if (!roles.includes(tok!.role)) fail(403, '这个操作只有家长能做');
    req.role = tok!.role; req.who = tok!.label;
  };
  const parent = { preHandler: auth('parent') };
  const anyone = { preHandler: auth('parent', 'device') };
  /** An AI assistant the parent let in can hand lessons in for review, nothing else. */
  const agentOrParent = { preHandler: auth('parent', 'agent') };

  app.post('/v1/auth/login', async (req) => {
    if (Date.now() < lockedUntil) fail(429, '试错次数太多，请 1 分钟后再试');
    const pin = String((req.body as { pin?: unknown })?.pin ?? '');
    const a = Buffer.from(sha(pin)), b = Buffer.from(sha(o.pin));
    if (!timingSafeEqual(a, b)) {
      if (++failures >= LOCK_AFTER) { lockedUntil = Date.now() + LOCK_MS; failures = 0; }
      fail(401, 'PIN 不对');
    }
    failures = 0;
    return { token: issue('parent', '家长') };
  });

  // Pairing: the Pad asks for a code, the parent approves it, the Pad picks up its token once.
  app.post('/v1/pair/start', async () => {
    store.expirePairings(new Date(now().getTime() - PAIR_TTL_MS).toISOString());
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    store.startPairing(code, iso());
    return { code, expires_in: PAIR_TTL_MS / 1000 };
  });
  app.get('/v1/pair/:code', async (req) => {
    store.expirePairings(new Date(now().getTime() - PAIR_TTL_MS).toISOString());
    const p = store.pairing((req.params as { code: string }).code);
    if (!p) fail(404, '配对码已过期，请重新开始');
    if (!p!.token) return { status: 'waiting' };
    store.endPairing(p!.code);
    return { status: 'approved', token: p!.token, label: p!.label };
  });
  app.post('/v1/pair/:code/approve', parent, async (req) => {
    const p = store.pairing((req.params as { code: string }).code);
    if (!p) fail(404, '没有这个配对码，或已过期');
    const label = String((req.body as { label?: unknown })?.label ?? '').trim().slice(0, 40) || `Pad ${p!.code}`;
    if (store.devices().some(d => d.label === label)) fail(409, `已经有叫「${label}」的设备`);
    store.approvePairing(p!.code, label, issue('device', label));
    return { ok: true, label };
  });
  app.get('/v1/devices', parent, async () => store.devices());
  app.delete('/v1/devices/:label', parent, async (req) => { store.revokeDevice((req.params as { label: string }).label); return { ok: true }; });

  // ---- shared ----
  app.get('/v1/time', async () => ({ today: today(), now: iso(), tz: TZ }));
  app.get('/v1/children', anyone, async () => store.children());

  const childParam = (v: unknown) => { const c = String(v ?? ''); if (!store.hasChild(c)) fail(400, '没有这个孩子'); return c; };
  // Automatic schedule (the parent's choice, on unless turned off): each child gets one lesson a day, the oldest
  // published one they haven't finished. Today's pick is written down the first time anyone looks, so it stays
  // the same all day; the parent can change or cancel any day, and that day is then theirs.
  const autoOn = () => (store.setting('schedule.auto') ?? '1') === '1';
  const unfinished = (child: string) => {
    const done = new Set(store.sessions(child).filter(s => s.finished).map(s => s.lesson_key));
    return store.lessons().filter(l => l.for_child === child && !done.has(l.key)).reverse().map(l => l.key);
  };
  const ensureAuto = (date: string, child: string) => {
    if (!autoOn() || date !== today() || store.dayMode(date, child)) return;
    const next = unfinished(child)[0];
    if (next) store.setSchedule(date, child, [next], 'auto');
  };
  /** BL13: a child sees a lesson only when it is scheduled for today or a parent granted it. */
  const todayFor = (child: string) => {
    const d = today();
    ensureAuto(d, child);
    const out = new Map<string, { key: string; title: string; concept: string; reason: '今天的课' | '临时授权'; expires_on: string | null }>();
    const add = (key: string, reason: '今天的课' | '临时授权', expires_on: string | null) => {
      const sp = store.lesson(key);
      if (!sp || sp.for_child !== child || out.has(key)) return;
      out.set(key, { key, title: sp.title, concept: sp.primary_concept.name, reason, expires_on });
    };
    for (const k of store.scheduled(d, child)) add(k, '今天的课', d);
    for (const g of store.activeGrants(child, d)) add(g.lesson_key, '临时授权', g.expires_on);
    return [...out.values()].map(l => ({ ...l, finished: store.sessions(child).some(s => s.lesson_key === l.key && s.started_on === d && s.finished) }));
  };
  app.get('/v1/today', anyone, async (req) => {
    const child = childParam((req.query as { child?: string }).child);
    return { today: today(), child, lessons: todayFor(child) };
  });
  app.get('/v1/lessons/:key', anyone, async (req) => {
    const key = (req.params as { key: string }).key;
    const sp = store.lesson(key) ?? fail(404, '没有这节课');
    if (req.role === 'device') {
      const child = childParam((req.query as { child?: string }).child);
      if (!todayFor(child).some(l => l.key === key)) fail(403, '这节课今天没有安排，请家长排课或临时授权');
    }
    return sp;
  });

  /** Events arrive in batches from the Pad's offline queue; ids make resending safe. */
  app.post('/v1/sessions/:key/events', anyone, async (req) => {
    const key = (req.params as { key: string }).key;
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) fail(400, '学习记录编号不对');
    const body = (req.body ?? {}) as { child?: unknown; lesson?: unknown; events?: unknown };
    const child = childParam(body.child);
    if (!isKey(body.lesson)) fail(400, '缺少课程编号');
    const lessonKey = body.lesson as string;
    const sp = store.lesson(lessonKey) ?? fail(404, '没有这节课');
    if (sp.for_child !== child) fail(400, '这节课不是给这个孩子的');
    const existing = store.session(key);
    if (existing && (existing.child !== child || existing.lesson_key !== lessonKey)) fail(409, '这个学习记录编号已经属于别的课');
    if (!Array.isArray(body.events) || body.events.length > 500) fail(400, '事件列表不对');
    const events = (body.events as EventIn[]).map((e, i) => {
      if (!e || typeof e.id !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(e.id)) fail(400, `第 ${i + 1} 条事件缺少编号`);
      if (typeof e.type !== 'string' || typeof e.at !== 'string' || Number.isNaN(Date.parse(e.at))) fail(400, `第 ${i + 1} 条事件格式不对`);
      return e;
    });
    const first = events.map(e => e.at).sort()[0];
    // Pads may sync late; the session belongs to the day its first event happened, never a future day.
    const startedOn = existing?.started_on ?? (first ? [shanghaiDate(new Date(first)), today()].sort()[0] : today());
    const fresh = store.tx(() => {
      store.ensureSession(key, child, lessonKey, startedOn, iso());
      const f = store.addEvents(key, events, iso());
      for (const e of f) {
        if (e.type === 'next_lesson_wish' && typeof e.answer === 'string' && e.answer.trim()) {
          const topic = e.answer.trim().slice(0, 40);
          store.addInterest({ child, topic, source: '孩子自述', said: topic, observed_on: startedOn.slice(0, 7), state: '下一课心愿', lesson_ref: lessonKey }, iso());
        }
        if (e.type === 'lesson_end') store.finishSession(key);
      }
      return f;
    });
    return { accepted: fresh.length, duplicates: events.length - fresh.length };
  });

  // ---- parent ----
  app.get('/v1/lessons', parent, async () => store.lessons());
  /** Everything a lesson must pass before children can see it; the server re-runs V01–V15 with its own records. */
  const vet = (sp: LessonSpec) => {
    if (!sp || typeof sp !== 'object' || !isKey(`${sp.lesson_id}@${sp.version}`)) fail(400, '不是一份课程文件');
    if (!store.hasChild(sp.for_child)) fail(400, '没有这个孩子');
    const key = `${sp.lesson_id}@${sp.version}`;
    const previous = sp.previous_version ? store.lesson(`${sp.lesson_id}@${sp.previous_version}`) ?? null : null;
    let ticket: ReteachTicket | undefined;
    if (sp.trigger_judgment_ref) {
      const j = store.judgment(sp.trigger_judgment_ref);
      if (!j || j.status !== '已确认') fail(400, `重教依据的判断 ${sp.trigger_judgment_ref} 不存在或家长还没确认`);
      if (j!.child !== sp.for_child) fail(400, '重教依据的判断不是这个孩子的');
      ticket = store.tickets(sp.for_child).find(t => t.judgment_ref === sp.trigger_judgment_ref && t.concept_id === sp.primary_concept.id && t.status === '需求登记');
      if (!ticket) fail(400, `判断 ${sp.trigger_judgment_ref} 没有对「${sp.primary_concept.name}」的待做重教需求`);
    }
    const report = validate(sp, { ...loadContext(o.root, previous), interests: store.interests(), reteach: reteachHistory(store) });
    return { key, ticket, report };
  };
  const publish = (sp: LessonSpec, ticket?: ReteachTicket) => store.tx(() => {
    const key = `${sp.lesson_id}@${sp.version}`;
    store.addLesson(sp);
    store.deleteDraft(key);
    if (ticket) store.updateTicket(ticket.id, { status: '已发布', lesson_ref: key, mechanism: mechanism(sp) }, iso());
  });

  /** Publish a lesson frozen and reviewed elsewhere (dls publish --server, no parent app). */
  app.post('/v1/lessons', parent, async (req, reply) => {
    const sp = req.body as LessonSpec;
    if (!sp?.content_hash || !sp.published_at) fail(400, '课程还没有冻结（先运行 dls publish，或用 dls submit 交给家长端审核）');
    if (contentHash(sp) !== sp.content_hash) fail(400, '内容哈希对不上，文件在发布后被改过');
    const missing = Object.keys(REVIEW_CHECKLIST).filter(c => !(sp.review_records ?? []).some(r => r.category === c));
    if (missing.length) fail(400, `审核未完成：${missing.join('、')}`);
    const key = `${sp.lesson_id}@${sp.version}`;
    const prev = store.lesson(key);
    if (prev) { if (prev.content_hash === sp.content_hash) return reply.code(200).send({ key, status: '已存在' }); fail(409, `${key} 已发布且已冻结；修改请升版本号`); }
    const { ticket, report } = vet(sp);
    if (!report.ok) return reply.code(422).send({ error: '服务器校验未通过', report });
    publish(sp, ticket);
    return reply.code(201).send({ key, status: '已发布', warnings: report.warnings });
  });

  // ---- stage 6 in the parent app: the Skill submits, the parent reviews and publishes with one click ----
  app.get('/v1/review-checklist', parent, async () => REVIEW_CHECKLIST);
  app.post('/v1/drafts', agentOrParent, async (req, reply) => {
    const { review_records: _r, content_hash: _h, published_at: _p, ...sp } = req.body as LessonSpec;
    const { key, report } = vet(sp as LessonSpec);
    if (store.lesson(key)) fail(409, `${key} 已发布且已冻结；修改请升版本号`);
    if (!report.ok) return reply.code(422).send({ error: '服务器校验未通过', report });
    store.upsertDraft(sp as LessonSpec, req.who ?? '家长', iso());
    return reply.code(201).send({ key, status: '待审核', warnings: report.warnings });
  });
  app.get('/v1/drafts', parent, async () => store.drafts().map(d => {
    const sp = store.draft(d.key)!;
    const { report } = vet(sp);
    return {
      ...d, child: sp.for_child, concept: sp.primary_concept.name, theme: { name: sp.theme.name, why: sp.theme.why },
      challenges: sp.challenges.map(c => ({ prompt: c.prompt, with_theme: c.with_theme, answers: c.answers.map(a => `${a.label ? a.label + ' ' : ''}${a.value}${a.unit ? ' ' + a.unit : ''}`) })),
      pending_assets: (sp.pending_assets ?? []).map(p => p.asset_id),
      offscreen: sp.offscreen?.task ?? null,
      ok: report.ok,
      issues: report.results.filter(r => !r.ok).flatMap(r => r.issues.map(i => ({ rule: r.id, level: r.level, msg: i.msg }))),
    };
  }));
  app.get('/v1/drafts/:key', parent, async (req) => store.draft((req.params as { key: string }).key) ?? fail(404, '没有这节待审核的课'));
  app.post('/v1/drafts/:key/approve', parent, async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const draft = store.draft(key) ?? fail(404, '没有这节待审核的课');
    const checked = ((req.body ?? {}) as { checked?: Record<string, string[]> }).checked ?? {};
    for (const [cat, items] of Object.entries(REVIEW_CHECKLIST)) {
      const missing = items.filter(i => !(checked[cat] ?? []).includes(i));
      if (missing.length) fail(400, `「${cat}」还有没勾的：${missing.join('；')}`);
    }
    if (store.lesson(key)) fail(409, `${key} 已经发布过了`);
    const { ticket, report } = vet(draft);
    if (!report.ok) return reply.code(422).send({ error: '服务器校验未通过', report });
    const at = iso();
    const sp: LessonSpec = { ...draft, review_records: Object.entries(REVIEW_CHECKLIST).map(([category, items]) => ({ category: category as '科学', reviewer: req.who ?? '家长', checked: items, at })), published_at: at };
    sp.content_hash = contentHash(sp);
    publish(sp, ticket);
    return reply.code(201).send({ key, status: '已发布', content_hash: sp.content_hash });
  });
  app.post('/v1/drafts/:key/reject', parent, async (req) => {
    const key = (req.params as { key: string }).key;
    if (!store.draft(key)) fail(404, '没有这节待审核的课');
    const note = String(((req.body ?? {}) as { note?: unknown }).note ?? '').trim().slice(0, 1000);
    if (!note) fail(400, '写一句要改什么');
    store.rejectDraft(key, note);
    return { ok: true };
  });

  app.get('/v1/schedule', parent, async (req) => {
    const q = req.query as { from?: string; to?: string };
    const from = isDate(q.from) ? q.from : today(), to = isDate(q.to) ? q.to : addDays(from, 13);
    return store.scheduleRange(from, to);
  });
  /** The next days as the parent sees them: what each child has, and whether the parent or the automatic plan chose it. */
  app.get('/v1/schedule/plan', parent, async (req) => {
    const n = Math.min(14, Math.max(1, Number((req.query as { days?: string }).days ?? 7) || 7));
    const dates = [...Array(n)].map((_, i) => addDays(today(), i));
    const lessonOf = (key: string, child: string) => ({ key, title: store.lesson(key)?.title ?? key, finished: store.sessions(child).some(s => s.lesson_key === key && s.finished) });
    const rows = store.children().map(c => {
      const queue = unfinished(c.id);
      return dates.map(date => {
        ensureAuto(date, c.id);
        const mode = store.dayMode(date, c.id);
        if (mode) {
          const keys = store.scheduled(date, c.id);
          for (const k of keys) { const i = queue.indexOf(k); if (i >= 0) queue.splice(i, 1); } // assume it gets done that day
          return { date, child: c.id, mode, lessons: keys.map(k => lessonOf(k, c.id)) };
        }
        const next = autoOn() ? queue.shift() : undefined;
        return { date, child: c.id, mode: next ? 'planned' : 'none', lessons: next ? [lessonOf(next, c.id)] : [] };
      });
    });
    return { auto: autoOn(), today: today(), days: dates.map((date, i) => ({ date, kids: rows.map(r => r[i]) })), grants: store.grants().filter(g => g.expires_on >= today()) };
  });
  app.put('/v1/schedule/auto', parent, async (req) => {
    store.setSetting('schedule.auto', (req.body as { on?: unknown })?.on ? '1' : '0');
    return { auto: autoOn() };
  });
  /** Give a day back to the automatic plan. */
  app.delete('/v1/schedule/:date/:child', parent, async (req) => {
    const { date, child } = req.params as { date: string; child: string };
    if (!isDate(date)) fail(400, '日期格式是 YYYY-MM-DD');
    store.clearSchedule(date, childParam(child));
    return { ok: true };
  });
  app.put('/v1/schedule', parent, async (req) => {
    const b = (req.body ?? {}) as { date?: unknown; child?: unknown; lessons?: unknown };
    if (!isDate(b.date)) fail(400, '日期格式是 YYYY-MM-DD');
    const child = childParam(b.child);
    const keys = Array.isArray(b.lessons) ? b.lessons : fail(400, '缺少课程列表');
    for (const k of keys) { const sp = isKey(k) ? store.lesson(k) : undefined; if (!sp) fail(400, `没有课程 ${k}`); if (sp!.for_child !== child) fail(400, `${k} 不是给这个孩子的`); }
    store.setSchedule(b.date as string, child, [...new Set(keys as string[])]);
    return { ok: true };
  });

  app.get('/v1/grants', parent, async () => store.grants());
  app.post('/v1/grants', parent, async (req) => {
    const b = (req.body ?? {}) as { child?: unknown; lesson?: unknown; days?: unknown };
    const child = childParam(b.child);
    const sp = isKey(b.lesson) ? store.lesson(b.lesson as string) : undefined;
    if (!sp) fail(404, '没有这节课');
    if (sp!.for_child !== child) fail(400, '这节课不是给这个孩子的');
    const days = Number(b.days ?? 1);
    if (!Number.isInteger(days) || days < 1 || days > 7) fail(400, '临时授权 1–7 天');
    const expires_on = addDays(today(), days - 1);
    store.addGrant(child, b.lesson as string, expires_on, req.who ?? '家长', iso());
    return { ok: true, expires_on };
  });

  app.get('/v1/sessions', parent, async (req) => {
    const c = (req.query as { child?: string }).child;
    return store.sessions(c ? childParam(c) : undefined);
  });
  app.get('/v1/sessions/:key/events', parent, async (req) => {
    const key = (req.params as { key: string }).key;
    if (!store.session(key)) fail(404, '没有这条学习记录');
    return store.events(key);
  });

  app.get('/v1/interests', parent, async (req) => {
    const c = (req.query as { child?: string }).child;
    return store.interests(c ? childParam(c) : undefined);
  });
  app.post('/v1/interests', parent, async (req) => {
    const b = (req.body ?? {}) as Partial<InterestObservation>;
    const child = childParam(b.child);
    const topic = String(b.topic ?? '').trim().slice(0, 40);
    if (!topic) fail(400, '缺少兴趣主题');
    const states: InterestObservation['state'][] = ['下一课心愿', '近期最喜欢', '喜欢', '曾经喜欢', '只用于安全工程题材'];
    const state = states.includes(b.state as InterestObservation['state']) ? b.state! : '喜欢';
    const source = b.source === '孩子自述' ? '孩子自述' : '家长报告';
    return store.addInterest({ child, topic, source, said: b.said ? String(b.said).slice(0, 200) : null, observed_on: today().slice(0, 7), state, lesson_ref: null }, iso());
  });

  // Lessons assembled in content/lessons but not yet published wait for review in the parent app.
  for (const f of lessonFiles(o.root)) {
    const sp = readJson<LessonSpec>(f);
    const key = `${sp.lesson_id}@${sp.version}`;
    if (sp.tenant_id !== tenant || store.lesson(key) || store.draft(key)) continue;
    try { if (vet(sp).report.ok) store.upsertDraft(sp, 'content/lessons', iso()); } catch { /* not ready: the Skill will submit it */ }
  }

  homeworkRoutes(app, { store, root: o.root, dataDir: o.dataDir ?? join(dirname(o.dbPath), 'homework'), today, iso, parent, childParam, pin: o.pin });
  // ---- narration audio (Spec: sound on the Pad) ----
  const tts = o.tts === undefined ? macSay() : o.tts;
  // Which voice reads: the parent's choice in the app, else ADW_VOICE_ZH / ADW_VOICE_EN, else the most natural one found.
  const known = (lang: Lang, name: unknown): name is string => typeof name === 'string' && (name === SYSTEM_VOICE || !tts?.list || tts.list.some(v => v.lang === lang && v.name === name));
  if (tts) for (const lang of ['zh', 'en'] as Lang[]) {
    const want = store.setting(`voice.${lang}`) ?? process.env[`ADW_VOICE_${lang.toUpperCase()}`];
    if (want && known(lang, want)) tts.voices[lang] = want;
  }
  app.decorate('ttsVoices', tts?.voices ?? null);
  const ttsDir = join(dirname(o.dbPath), 'tts');
  const making = new Map<string, Promise<Buffer>>();
  app.get('/v1/tts/info', anyone, async () => ({ available: !!tts, voices: tts?.voices ?? null }));
  // The parent picks the voices (and can hear one before choosing it).
  app.get('/v1/tts/voices', parent, async () => ({ available: !!tts, current: tts?.voices ?? null, options: tts?.list ?? [] }));
  app.put('/v1/tts/voices', parent, async (req) => {
    if (!tts) fail(501, '这台服务器不能生成语音（需要在 Mac 上运行）');
    const b = (req.body ?? {}) as Partial<Record<Lang, string>>;
    for (const lang of ['zh', 'en'] as Lang[]) if (b[lang] !== undefined && !known(lang, b[lang])) fail(400, `这台 Mac 上没有这个${lang === 'zh' ? '中文' : '英文'}声音`);
    for (const lang of ['zh', 'en'] as Lang[]) if (b[lang]) { tts!.voices[lang] = b[lang]!; store.setSetting(`voice.${lang}`, b[lang]!); }
    return { current: tts!.voices };
  });
  app.get('/v1/tts', anyone, async (req, reply) => {
    const q = req.query as { lang?: string; text?: string; voice?: string };
    const lang: Lang = q.lang === 'en' ? 'en' : q.lang === 'zh' ? 'zh' : fail(400, '语言只能是 zh 或 en');
    const text = String(q.text ?? '').trim();
    if (!text || text.length > 600) fail(400, '朗读的文字要在 600 字以内');
    if (!tts) fail(501, '这台服务器不能生成语音（需要在 Mac 上运行）');
    if (q.voice !== undefined && !known(lang, q.voice)) fail(400, '没有这个声音');
    const voice = q.voice ?? tts!.voices[lang];
    const key = sha(`${voice}|${lang}|${text}`).slice(0, 32), file = join(ttsDir, `${key}.wav`);
    let buf: Buffer;
    if (existsSync(file)) buf = readFileSync(file);
    else {
      if (!making.has(key)) making.set(key, tts!.make(text, lang, voice).then(b => { mkdirSync(ttsDir, { recursive: true }); writeFileSync(file, b); return b; }).finally(() => making.delete(key)));
      buf = await making.get(key)!;
    }
    return reply.header('cache-control', 'private, max-age=2592000').type('audio/wav').send(buf);
  });

  const media = mediaRoutes(app, { store, root: o.root, mediaDir: join(dirname(o.dbPath), 'media'), iso, parent, anyone });
  studioRoutes(app, { store, root: o.root, tenant, iso, parent, agentOrParent, issue, vet, media, fetchImpl: o.fetchImpl, codex: o.codex });

  // ---- static apps ----
  if (o.serveApps) {
    const threeDir = join(o.root, 'node_modules', 'three');
    await app.register(fastifyStatic, { root: join(o.root, 'apps', 'pad', 'dist'), prefix: '/pad/', decorateReply: false });
    await app.register(fastifyStatic, { root: join(o.root, 'apps', 'parent', 'dist'), prefix: '/parent/', decorateReply: false });
    await app.register(fastifyStatic, { root: threeDir, prefix: '/vendor/three/', decorateReply: false, allowedPath: p => p.startsWith('/build/') || p.startsWith('/examples/jsm/'), maxAge: '30d' });
    app.get('/', async (_req, reply: FastifyReply) => reply.redirect('/pad/'));
  }
  return app;
}

/** First start: children from content/children.json, interests from content/interests.json, lessons from content/published/. */
function seed(store: Store, root: string, tenant: string, children: Record<string, ChildProfile>, now: string) {
  for (const [id, c] of Object.entries(children)) store.upsertChild(id, c.name, c.grade);
  const ip = join(root, 'content', 'interests.json');
  if (store.interestCount() === 0 && existsSync(ip)) {
    store.tx(() => { for (const x of readJson<InterestObservation[]>(ip)) if (x.tenant_id === tenant) store.addInterest(x, now); });
  }
  const pub = join(root, 'content', 'published');
  if (!existsSync(pub)) return;
  for (const f of readdirSync(pub).filter(f => f.endsWith('.lesson.json'))) {
    const sp = readJson<LessonSpec>(join(pub, f));
    if (store.lesson(`${sp.lesson_id}@${sp.version}`) || contentHash(sp) !== sp.content_hash) continue;
    store.addLesson(sp);
  }
}

const lessonFiles = (root: string) => {
  const dir = join(root, 'content', 'lessons');
  if (!existsSync(dir)) return [];
  const sub = (d: string) => readdirSync(d).filter(n => statSync(join(d, n)).isDirectory());
  return sub(dir).flatMap(id => sub(join(dir, id)).map(v => join(dir, id, v, 'lessonspec.json'))).filter(f => existsSync(f));
};

declare module 'fastify' { interface FastifyInstance { store: Store } }
