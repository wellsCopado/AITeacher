// Homework, judgments and reteach (Spec §10): the parent uploads photos, the homework-analysis Skill
// recognises each question, the parent checks every item, the Skill writes a judgment, and the parent
// confirms it. A confirmed "需再支持" opens a reteach ticket; the next judgment verifies it.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type {
  CheckedItem, FeedbackItem, LearningJudgment, MasteryState, ParentCard, Recognition, RecognitionItem, ReteachHistory,
} from '../../../packages/schema/src/index.js';
import { CHECK_BELOW, checkJudgment, draftJudgment, validateRecognition } from '../../../packages/validator/src/index.js';
import { readJson } from '../../../packages/cli/src/lib.js';
import type { Store } from './db.js';
import { fail, isDate, sha } from './http.js';

interface Deps {
  store: Store; root: string; dataDir: string; pin: string;
  today: () => string; iso: () => string;
  parent: { preHandler: (req: FastifyRequest) => Promise<void> };
  childParam: (v: unknown) => string;
}

const MIME: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_PHOTOS = 8, MAX_PHOTO_BYTES = 6 * 1024 * 1024;
const EDITABLE: (keyof RecognitionItem)[] = ['prompt', 'child_answer', 'teacher_mark', 'teacher_note', 'concept_id'];
const MARKS = ['对', '错', '半对', '未批'];

/** Reteach attempts with their outcome, for V15. */
export const reteachHistory = (store: Store): ReteachHistory[] => store.tickets().filter(t => t.mechanism).map(t => ({
  concept_id: t.concept_id, child: t.child, mechanism: t.mechanism!,
  outcome: t.status === '已验证' ? '已验证' : t.status === '未见效' ? '未见效' : '待验证',
}));

export function homeworkRoutes(app: FastifyInstance, d: Deps) {
  const { store, parent } = d;
  const concepts = () => readJson<Record<string, { name: string; misconceptions: string[] }>>(join(d.root, 'content', 'concepts.json'));
  const hwOr404 = (id: string) => store.homework(id) ?? fail(404, '没有这份作业');
  const params = (req: FastifyRequest) => req.params as Record<string, string>;

  app.get('/v1/concepts', parent, async () => concepts());

  app.post('/v1/homework', { ...parent, bodyLimit: 64 * 1024 * 1024 }, async (req, reply) => {
    const b = (req.body ?? {}) as { child?: unknown; date?: unknown; note?: unknown; ai_consent?: unknown; photos?: { mime?: string; data?: string }[] };
    const child = d.childParam(b.child);
    if (!isDate(b.date)) fail(400, '作业日期格式是 YYYY-MM-DD');
    if (!Array.isArray(b.photos) || !b.photos.length || b.photos.length > MAX_PHOTOS) fail(400, `照片 1–${MAX_PHOTOS} 张`);
    const files = b.photos!.map((p, i) => {
      const ext = MIME[p?.mime ?? ''] ?? fail(400, `第 ${i + 1} 张照片格式不支持（jpg、png、webp）`);
      const buf = Buffer.from(String(p.data ?? '').replace(/^data:[^,]*,/, ''), 'base64');
      if (!buf.length || buf.length > MAX_PHOTO_BYTES) fail(400, `第 ${i + 1} 张照片为空或超过 6 MB`);
      return { id: `p${i + 1}`, mime: p.mime!, sha256: sha(buf), ext, buf };
    });
    const hw = store.addHomework({ child, date: b.date as string, note: b.note ? String(b.note).slice(0, 500) : null, ai_consent: b.ai_consent === true, photos: files.map(({ id, mime, sha256 }) => ({ id, mime, sha256 })) }, d.iso());
    const dir = join(d.dataDir, hw.id);
    mkdirSync(dir, { recursive: true });
    for (const f of files) writeFileSync(join(dir, `${f.id}.${f.ext}`), f.buf);
    return reply.code(201).send(hw);
  });

  app.get('/v1/homework', parent, async (req) => {
    const c = (req.query as { child?: string }).child;
    const js = store.judgments();
    return store.homeworks(c ? d.childParam(c) : undefined).map(h => {
      const items = store.items(h.id);
      return { ...h, items: items.length, to_check: items.filter(i => !i.confirmed).length, judgment: js.find(j => j.homework_ref === h.id)?.id ?? null };
    });
  });
  app.get('/v1/homework/:id', parent, async (req) => {
    const hw = hwOr404(params(req).id);
    return { ...hw, items: store.items(hw.id), judgments: store.judgments(hw.child).filter(j => j.homework_ref === hw.id) };
  });
  app.get('/v1/homework/:id/photos/:pid', parent, async (req, reply) => {
    const hw = hwOr404(params(req).id);
    const p = hw.photos.find(x => x.id === params(req).pid) ?? fail(404, '没有这张照片');
    reply.header('cache-control', 'private, max-age=86400').type(p.mime);
    return readFileSync(join(d.dataDir, hw.id, `${p.id}.${MIME[p.mime]}`));
  });

  /** The Skill's recognition. Every item starts unconfirmed; low confidence is marked 请核对. */
  app.put('/v1/homework/:id/recognition', parent, async (req) => {
    const hw = hwOr404(params(req).id);
    if (!hw.ai_consent) fail(403, '家长没有同意用 AI 识别这份作业的照片');
    if (hw.status === '已判断') fail(409, '这份作业已经判断过了');
    const r = req.body as Recognition;
    if (!validateRecognition(r)) fail(400, '识别结果格式不对', { details: validateRecognition.errors });
    if (r.homework_ref !== hw.id) fail(400, '识别结果不是这份作业的');
    const cs = concepts();
    const seen = new Set<string>();
    for (const it of r.items) {
      if (seen.has(it.no)) fail(400, `题号 ${it.no} 重复`);
      seen.add(it.no);
      if (!hw.photos.some(p => p.id === it.photo)) fail(400, `第 ${it.no} 题的照片 ${it.photo} 不存在`);
      if (it.concept_id && !cs[it.concept_id]) fail(400, `第 ${it.no} 题的知识点 ${it.concept_id} 不在 concepts.json`);
    }
    store.setItems(hw.id, r.items.map(it => ({ ...it, confirmed: false, needs_check: it.confidence < CHECK_BELOW, original: null })), r.recognized_by ?? 'homework-analysis');
    store.setHomeworkStatus(hw.id, '待核对');
    return { ok: true, items: r.items.length, to_check: r.items.filter(i => i.confidence < CHECK_BELOW).length };
  });

  /** The parent confirms an item, optionally correcting it. The recognised values are kept in `original`. */
  app.patch('/v1/homework/:id/items/:no', parent, async (req) => {
    const hw = hwOr404(params(req).id);
    if (hw.status === '已判断') fail(409, '这份作业已经判断过了，改动请重新上传');
    const item = store.items(hw.id).find(i => i.no === params(req).no) ?? fail(404, '没有这道题');
    const set = ((req.body ?? {}) as { set?: Partial<RecognitionItem> }).set ?? {};
    const next: CheckedItem = { ...item, confirmed: true };
    const original: Partial<RecognitionItem> = { ...(item.original ?? {}) };
    // Empty optional fields from a form mean "none", same as null.
    const norm = (k: keyof RecognitionItem, v: unknown) => (v === '' || v === undefined) && (k === 'teacher_note' || k === 'concept_id') ? null : v;
    for (const k of EDITABLE) {
      if (!(k in set) || norm(k, set[k]) === norm(k, item[k])) continue;
      if (k === 'teacher_mark' && !MARKS.includes(String(set[k]))) fail(400, '老师批改只能是 对、错、半对、未批');
      if (k === 'concept_id' && set[k] && !concepts()[String(set[k])]) fail(400, '知识点不在 concepts.json');
      if (!(k in original)) (original as Record<string, unknown>)[k] = item[k];
      (next as unknown as Record<string, unknown>)[k] = norm(k, set[k]) ?? null;
    }
    next.original = Object.keys(original).length ? original : null;
    store.updateItem(hw.id, next);
    const all = store.items(hw.id);
    store.setHomeworkStatus(hw.id, all.every(i => i.confirmed) ? '已核对' : '待核对');
    return next;
  });
  /** Confirm every item the Skill was confident about in one go; 请核对 items still need their own look. */
  app.post('/v1/homework/:id/confirm-sure', parent, async (req) => {
    const hw = hwOr404(params(req).id);
    if (hw.status === '已判断') fail(409, '这份作业已经判断过了');
    const items = store.items(hw.id);
    let n = 0;
    for (const it of items) if (!it.confirmed && !it.needs_check) { store.updateItem(hw.id, { ...it, confirmed: true }); n++; }
    store.setHomeworkStatus(hw.id, store.items(hw.id).every(i => i.confirmed) ? '已核对' : '待核对');
    return { confirmed: n };
  });

  app.get('/v1/homework/:id/draft', parent, async (req) => {
    const hw = hwOr404(params(req).id);
    return draftJudgment(hw.id, hw.child, store.items(hw.id));
  });

  /** The Skill submits a judgment; the server runs J01–J09 on its own data. A draft can be resubmitted until confirmed. */
  app.post('/v1/judgments', parent, async (req, reply) => {
    const j = req.body as LearningJudgment;
    if (!j || typeof j !== 'object') fail(400, '不是判断记录');
    const hw = hwOr404(String(j.homework_ref));
    if (j.child !== hw.child) fail(400, '判断的孩子和作业不一致');
    if (hw.status !== '已核对' && hw.status !== '已判断') fail(409, '家长还没核对完这份作业');
    const existing = store.judgments(hw.child).filter(x => x.homework_ref === hw.id);
    if (existing.some(x => x.status === '已确认')) fail(409, '这份作业的判断已经确认，不能再改');
    const report = checkJudgment({ ...j, id: undefined }, { concepts: concepts(), items: store.items(hw.id), previous: store.judgments(hw.child).filter(x => x.status === '已确认').map(x => x.judgment) });
    if (!report.ok) return reply.code(422).send({ error: '判断校验未通过', report });
    const draft = existing.find(x => x.status === '草稿');
    const { id: _ignored, ...body } = j;
    if (draft) { store.replaceJudgment(draft.id, body); return { id: draft.id, status: '已更新草稿', warnings: report.warnings, report }; }
    return reply.code(201).send({ id: store.addJudgment(body, d.iso()), status: '草稿', warnings: report.warnings, report });
  });

  app.get('/v1/judgments', parent, async (req) => {
    const c = (req.query as { child?: string }).child;
    const rows = store.judgments(c ? d.childParam(c) : undefined);
    const confirmed = rows.filter(r => r.status === '已确认');
    // BL08: a guess overturned later stays, marked 已更正 with the note.
    return rows.map(r => ({
      ...r,
      corrected: confirmed.flatMap(x => (x.judgment.corrects ?? []).filter(k => k.judgment_id === r.id).map(k => ({ gap: k.gap, by: x.id, note: k.note }))),
    }));
  });

  /** Parent confirms: mastery updates, reteach tickets open or close, and the parent card becomes editable. */
  app.post('/v1/judgments/:id/confirm', parent, async (req) => {
    const row = store.judgment(params(req).id) ?? fail(404, '没有这条判断');
    if (row.status === '已确认') return { ok: true, tickets: [] };
    const opened: string[] = [];
    store.tx(() => {
      store.confirmJudgment(row.id, d.iso());
      store.setHomeworkStatus(row.homework_ref, '已判断');
      if (!row.card) store.setCard(row.id, row.judgment.parent_card);
      const tickets = store.tickets(row.child);
      for (const m of row.judgment.mastery) {
        const mine = tickets.filter(t => t.concept_id === m.concept_id);
        for (const t of mine.filter(t => t.status === '已发布')) {
          if (m.state === '有独立应用证据') store.updateTicket(t.id, { status: '已验证' }, d.iso());
          if (m.state === '需再支持') store.updateTicket(t.id, { status: '未见效' }, d.iso());
        }
        if (m.state === '需再支持' && !mine.some(t => t.status === '需求登记')) {
          opened.push(store.addTicket({ child: row.child, concept_id: m.concept_id, judgment_ref: row.id, attempt: mine.length + 1, status: '需求登记' }, d.iso()).id);
        }
      }
    });
    return { ok: true, tickets: opened };
  });

  /** BL10: the parent card is a draft the parent edits; nothing is sent anywhere automatically. */
  app.put('/v1/judgments/:id/card', parent, async (req) => {
    const row = store.judgment(params(req).id) ?? fail(404, '没有这条判断');
    const b = (req.body ?? {}) as Partial<ParentCard>;
    const card: ParentCard = { facts: '', child_share: '', unverified: '', talk: '' };
    for (const k of Object.keys(card) as (keyof ParentCard)[]) card[k] = String(b[k] ?? '').slice(0, 2000);
    store.setCard(row.id, card);
    return card;
  });
  app.post('/v1/judgments/:id/card/used', parent, async (req) => {
    const row = store.judgment(params(req).id) ?? fail(404, '没有这条判断');
    store.setCardUsed(row.id, ((req.body ?? {}) as { used?: unknown }).used !== false);
    return { ok: true };
  });

  /** Per concept: the latest confirmed judgment wins; correct answers inside a lesson only count as 待确认. */
  app.get('/v1/mastery', parent, async (req) => {
    const child = d.childParam((req.query as { child?: string }).child);
    const cs = concepts();
    const state = new Map<string, { state: MasteryState; source: string; since: string }>();
    for (const s of store.sessions(child)) {
      const sp = store.lesson(s.lesson_key);
      if (!sp || !store.events(s.key).some(e => e.type === 'answer' && e.correct)) continue;
      if (!state.has(sp.primary_concept.id)) state.set(sp.primary_concept.id, { state: '待确认', source: `lesson:${s.lesson_key}`, since: s.started_on });
    }
    for (const r of store.judgments(child).filter(r => r.status === '已确认')) {
      for (const m of r.judgment.mastery) state.set(m.concept_id, { state: m.state, source: r.id, since: (r.confirmed_at ?? r.created_at).slice(0, 10) });
    }
    return Object.entries(cs).map(([id, c]) => ({ concept_id: id, name: c.name, ...(state.get(id) ?? { state: '未观察' as MasteryState, source: null, since: null }) }));
  });

  app.get('/v1/tickets', parent, async (req) => {
    const c = (req.query as { child?: string }).child;
    return store.tickets(c ? d.childParam(c) : undefined);
  });
  app.get('/v1/reteach-history', parent, async () => reteachHistory(store));

  app.get('/v1/feedback', parent, async (req) => {
    const c = (req.query as { child?: string }).child;
    return store.feedback(c ? d.childParam(c) : undefined);
  });
  app.post('/v1/feedback', parent, async (req, reply) => {
    const b = (req.body ?? {}) as Partial<FeedbackItem>;
    const child = d.childParam(b.child);
    const sources = ['孩子', '家长', '老师', '作业', '系统'], kinds = ['事实', '解释', '推测'];
    if (!sources.includes(String(b.source))) fail(400, '来源只能是 孩子、家长、老师、作业、系统');
    if (!kinds.includes(String(b.kind))) fail(400, '类型只能是 事实、解释、推测');
    const said = String(b.said ?? '').trim().slice(0, 1000);
    if (!said) fail(400, '请写下原话');
    return reply.code(201).send(store.addFeedback({ child, source: b.source!, said, context: b.context ? String(b.context).slice(0, 500) : null, kind: b.kind!, ref: b.ref ? String(b.ref).slice(0, 40) : null }, d.iso()));
  });

  // BL11: export or delete everything about one child.
  app.get('/v1/children/:id/export', parent, async (req, reply) => {
    const child = d.childParam(params(req).id);
    reply.header('content-disposition', `attachment; filename="${child}-${d.today()}.json"`);
    return { exported_at: d.iso(), note: '作业照片在服务器的数据目录里，按作业编号存放', ...store.exportChild(child) };
  });
  app.delete('/v1/children/:id/data', parent, async (req) => {
    const child = d.childParam(params(req).id);
    const b = (req.body ?? {}) as { pin?: unknown; confirm?: unknown };
    const name = store.children().find(c => c.id === child)!.name;
    if (!timingSafeEqual(Buffer.from(sha(String(b.pin ?? ''))), Buffer.from(sha(d.pin)))) fail(401, '删除前请再输一次家长 PIN');
    if (b.confirm !== name) fail(400, `请输入孩子的称呼「${name}」确认删除`);
    const hw = store.deleteChildData(child);
    for (const id of hw) rmSync(join(d.dataDir, id), { recursive: true, force: true });
    return { ok: true, deleted_homework: hw.length };
  });
}
