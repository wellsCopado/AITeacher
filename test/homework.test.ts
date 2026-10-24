import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/server/src/app.js';
import { checkJudgment, draftJudgment } from '../packages/validator/src/index.js';
import { contentHash, REVIEW_CHECKLIST } from '../packages/cli/src/lib.js';
import type { CheckedItem, LearningJudgment, LessonSpec, Recognition } from '../packages/schema/src/index.js';

const root = join(import.meta.dirname, '..');
const concepts = JSON.parse(readFileSync(join(root, 'content', 'concepts.json'), 'utf8'));
const PA = 'M3.MEAS.perimeter_vs_area';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const item = (no: string, mark: CheckedItem['teacher_mark'], extra: Partial<CheckedItem> = {}): CheckedItem =>
  ({ no, photo: 'p1', prompt: `题 ${no}`, child_answer: '24 米', teacher_mark: mark, confidence: 0.95, concept_id: PA, confirmed: true, needs_check: false, ...extra });
const good = (): LearningJudgment => ({
  homework_ref: 'HW-0001', child: 'gege',
  facts: [{ text: '第 2 题面积写成了 24 米，老师批错。', items: ['2'] }],
  gaps: [{ concept_id: PA, misconception: 'MC.unit_len_vs_area', text: '可能把面积单位和长度单位混在一起。', confidence: 0.6, verify_by: '下次作业看面积题的单位', items: ['2'] }],
  unknowns: ['不知道是没想清楚，还是写快了。'],
  next: [{ kind: '重教', concept_id: PA, text: '用铺地砖数格子对比拉卷尺，单位分开写。' }],
  mastery: [{ concept_id: PA, state: '需再支持', evidence: ['2'] }],
  parent_card: { facts: '第 2 题面积写成了米。', child_share: '', unverified: '可能单位混了。', talk: '问问他：围一圈用的是什么，铺满用的是什么？' },
});
const ctx = (items: CheckedItem[] = [item('1', '对'), item('2', '错')]) => ({ concepts, items, previous: [] as LearningJudgment[] });
const failing = (j: LearningJudgment, c = ctx()) => checkJudgment(j, c).results.filter(r => !r.ok).map(r => r.id);

describe('judgment rules J01–J09', () => {
  it('passes a well-formed judgment', () => expect(failing(good())).toEqual([]));
  it('J01 structure', () => expect(failing({ ...good(), next: [] })).toEqual(['J01']));
  it('J02 only checked items', () => {
    expect(failing(good(), ctx([item('1', '对'), item('2', '错', { confirmed: false })]))).toContain('J02');
    expect(failing({ ...good(), facts: [{ text: '第 9 题空着', items: ['9'] }] })).toContain('J02');
  });
  it('J03 no judging the child, no promises', () => {
    expect(failing({ ...good(), unknowns: ['他太粗心了'] })).toContain('J03');
    expect(failing({ ...good(), parent_card: { ...good().parent_card, talk: '这样练保证考满分' } })).toContain('J03');
  });
  it('J04 guesses stay guesses', () => {
    expect(failing({ ...good(), gaps: [{ ...good().gaps[0], text: '肯定是没学会面积' }] })).toContain('J04');
    expect(failing({ ...good(), gaps: [{ ...good().gaps[0], confidence: 0.95 }] })).toContain('J04');
  });
  it('J05 mastery needs matching evidence', () => {
    expect(failing({ ...good(), mastery: [{ concept_id: PA, state: '有独立应用证据', evidence: ['lesson:L-PA@1.0'] }], next: [{ kind: '巩固', text: 'x' }] })).toContain('J05');
    expect(failing({ ...good(), mastery: [{ concept_id: PA, state: '有独立应用证据', evidence: ['1'] }], next: [{ kind: '巩固', text: 'x' }] })).toEqual([]);
    expect(failing({ ...good(), mastery: [{ concept_id: PA, state: '需再支持', evidence: ['1'] }] })).toContain('J05');
    expect(failing({ ...good(), mastery: [{ concept_id: PA, state: '待确认', evidence: ['lesson:L-PA@1.0'] }], next: [{ kind: '观察', text: 'x' }] })).toEqual([]);
  });
  it('J06 needs-support asks for a reteach', () => expect(failing({ ...good(), next: [{ kind: '巩固', concept_id: PA, text: '多练' }] })).toEqual(['J06']));
  it('J07 concepts exist', () => expect(failing({ ...good(), gaps: [{ ...good().gaps[0], misconception: 'MC.nope' }] })).toContain('J07'));
  it('J08 corrections point at a real earlier guess', () => {
    const prev = { ...good(), id: 'LJ-0001' };
    expect(failing({ ...good(), corrects: [{ judgment_id: 'LJ-0001', gap: 0, note: '这次单位都对了' }] }, { ...ctx(), previous: [prev] })).toEqual([]);
    expect(failing({ ...good(), corrects: [{ judgment_id: 'LJ-0001', gap: 3, note: 'x' }] }, { ...ctx(), previous: [prev] })).toContain('J08');
  });
  it('J09 warns when a fact carries a guess', () => {
    const r = checkJudgment({ ...good(), facts: [{ text: '第 2 题可能是写快了', items: ['2'] }] }, ctx());
    expect(r.ok).toBe(true);
    expect(r.results.find(x => x.id === 'J09')!.ok).toBe(false);
  });
  it('draft starts from the checked items', () => {
    const dj = draftJudgment('HW-0001', 'gege', [item('1', '对'), item('2', '错')]);
    expect(dj.mastery).toEqual([{ concept_id: PA, state: '需再支持', evidence: ['2'] }]);
    expect(dj.facts).toHaveLength(2);
  });
});

// ---- server flow ----
let app: Awaited<ReturnType<typeof buildApp>>;
let dataDir: string;
const req = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await app.inject({ method: method as 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(body === undefined ? {} : { payload: body as object }) });
  return { status: r.statusCode, body: r.body && r.headers['content-type']?.toString().includes('json') ? JSON.parse(r.body) : r.rawPayload };
};
const PIN = '2468';
function freeze(sp: LessonSpec): LessonSpec {
  const f: LessonSpec = { ...sp, review_records: Object.entries(REVIEW_CHECKLIST).map(([category, checked]) => ({ category: category as '科学', reviewer: '家长', checked, at: '2026-10-24T08:00:00Z' })), published_at: '2026-10-24T08:00:00Z' };
  f.content_hash = contentHash(f);
  return f;
}
const recognition = (id: string, marks: [string, CheckedItem['teacher_mark'], number][]): Recognition => ({
  homework_ref: id, recognized_by: 'test',
  items: marks.map(([no, mark, confidence]) => ({ no, photo: 'p1', prompt: `长 6 米宽 4 米的长方形，面积是多少？（${no}）`, child_answer: mark === '对' ? '24 平方米' : '24 米', teacher_mark: mark, confidence, concept_id: PA })),
});

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adw-hw-'));
  dataDir = join(dir, 'homework');
  app = await buildApp({ root, dbPath: join(dir, 'db.sqlite'), pin: PIN, now: () => new Date('2026-10-24T02:00:00Z') });
});
afterEach(async () => { await app.close(); });

async function upload(t: string, consent = true) {
  const r = await req('POST', '/v1/homework', t, { child: 'gege', date: '2026-10-23', note: '数学练习', ai_consent: consent, photos: [{ mime: 'image/png', data: PNG }] });
  expect(r.status).toBe(201);
  return r.body.id as string;
}
async function judgeAndConfirm(t: string, id: string, j: LearningJudgment) {
  const s = await req('POST', '/v1/judgments', t, j);
  expect(s.status, JSON.stringify(s.body)).toBeLessThan(300);
  return (await req('POST', `/v1/judgments/${s.body.id}/confirm`, t)).body as { tickets: string[] };
}

describe('homework → judgment → reteach on the server', () => {
  it('runs the full loop and verifies the reteach on the next homework', async () => {
    const t = (await req('POST', '/v1/auth/login', undefined, { pin: PIN })).body.token;
    const id = await upload(t);
    expect(id).toBe('HW-0001');
    expect(existsSync(join(dataDir, id, 'p1.png'))).toBe(true);
    expect((await req('GET', `/v1/homework/${id}/photos/p1`, t)).status).toBe(200);
    expect((await req('GET', `/v1/homework/${id}/photos/p1`)).status).toBe(401);

    // Recognition: the low-confidence item is marked 请核对.
    const rec = await req('PUT', `/v1/homework/${id}/recognition`, t, recognition(id, [['1', '对', 0.95], ['2', '错', 0.6]]));
    expect(rec.body).toEqual({ ok: true, items: 2, to_check: 1 });
    // A judgment before the parent has checked everything is refused.
    expect((await req('POST', '/v1/judgments', t, good())).status).toBe(409);
    expect((await req('POST', `/v1/homework/${id}/confirm-sure`, t)).body.confirmed).toBe(1);
    // The parent corrects item 2: the child actually wrote 24 米 but the teacher marked 半对. Original kept.
    const fixed = (await req('PATCH', `/v1/homework/${id}/items/2`, t, { set: { teacher_mark: '半对' } })).body;
    expect(fixed).toMatchObject({ confirmed: true, teacher_mark: '半对', original: { teacher_mark: '错' } });
    // A form sends "" for an empty note; that is not a correction.
    expect((await req('PATCH', `/v1/homework/${id}/items/1`, t, { set: { teacher_note: '', concept_id: PA } })).body.original).toBeNull();
    expect((await req('GET', `/v1/homework/${id}`, t)).body.status).toBe('已核对');

    // Server-side checks: a judgment that calls the child careless is refused.
    const bad = await req('POST', '/v1/judgments', t, { ...good(), unknowns: ['他太粗心'] });
    expect(bad.status).toBe(422);
    expect(bad.body.report.results.find((r: { id: string }) => r.id === 'J03').ok).toBe(false);

    const first = await judgeAndConfirm(t, id, good());
    expect(first.tickets).toEqual(['RT-0001']);
    expect((await req('POST', '/v1/judgments', t, good())).status).toBe(409); // confirmed is final
    let tickets = (await req('GET', '/v1/tickets?child=gege', t)).body;
    expect(tickets[0]).toMatchObject({ id: 'RT-0001', concept_id: PA, judgment_ref: 'LJ-0001', attempt: 1, status: '需求登记' });
    const mastery = (await req('GET', '/v1/mastery?child=gege', t)).body;
    expect(mastery.find((m: { concept_id: string }) => m.concept_id === PA)).toMatchObject({ state: '需再支持', source: 'LJ-0001' });
    expect(mastery.find((m: { concept_id: string }) => m.concept_id === 'M2.MUL.table').state).toBe('未观察');

    // Parent card: a draft the parent edits; marked used only by the parent.
    const card = (await req('PUT', '/v1/judgments/LJ-0001/card', t, { ...good().parent_card, talk: '晚饭后一起量一下桌子。' })).body;
    expect(card.talk).toBe('晚饭后一起量一下桌子。');

    // A reteach lesson must name a confirmed judgment with an open ticket, and must change the teaching (V10).
    const base = JSON.parse(readFileSync(join(root, 'content/lessons/L-PA/1.0/lessonspec.json'), 'utf8')) as LessonSpec;
    expect((await req('POST', '/v1/lessons', t, freeze(base))).status).toBe(201);
    const same = freeze({ ...base, version: '1.1', previous_version: '1.0', trigger_judgment_ref: 'LJ-0009' });
    expect((await req('POST', '/v1/lessons', t, same)).body.error).toMatch(/LJ-0009/);
    const unchanged = freeze({ ...base, version: '1.1', previous_version: '1.0', trigger_judgment_ref: 'LJ-0001' });
    const r10 = await req('POST', '/v1/lessons', t, unchanged);
    expect(r10.status).toBe(422);
    expect(r10.body.report.results.find((r: { id: string }) => r.id === 'V10').ok).toBe(false);
    const reteach = freeze({
      ...base, version: '1.1', previous_version: '1.0', trigger_judgment_ref: 'LJ-0001',
      activity_graph: [...base.activity_graph.slice(0, 2), { id: 'contrast-units', type: 'contrast', teaches: PA, prompt: '围一圈用米，铺满用平方米', complete: 'viewed' }, ...base.activity_graph.slice(2)],
    });
    const r11 = await req('POST', '/v1/lessons', t, reteach);
    expect(r11.status, JSON.stringify(r11.body)).toBe(201);
    tickets = (await req('GET', '/v1/tickets?child=gege', t)).body;
    expect(tickets[0]).toMatchObject({ status: '已发布', lesson_ref: 'L-PA@1.1', mechanism: 'PerimeterArea' });

    // Next homework: done right on its own → the ticket is verified and the old guess is marked corrected.
    const id2 = await upload(t);
    await req('PUT', `/v1/homework/${id2}/recognition`, t, recognition(id2, [['1', '对', 0.95], ['2', '对', 0.95]]));
    await req('POST', `/v1/homework/${id2}/confirm-sure`, t);
    const j2: LearningJudgment = {
      homework_ref: id2, child: 'gege',
      facts: [{ text: '两道面积题都写了平方米，老师批对。', items: ['1', '2'] }],
      gaps: [], unknowns: [], next: [{ kind: '新课', text: '可以往下学组合图形。' }],
      mastery: [{ concept_id: PA, state: '有独立应用证据', evidence: ['1', '2'] }],
      corrects: [{ judgment_id: 'LJ-0001', gap: 0, note: '这次面积单位都对了，原来的推测已更正' }],
      parent_card: { facts: '两道面积题都对了。', child_share: '', unverified: '', talk: '问问他怎么记住单位的。' },
    };
    expect((await judgeAndConfirm(t, id2, j2)).tickets).toEqual([]);
    tickets = (await req('GET', '/v1/tickets?child=gege', t)).body;
    expect(tickets[0].status).toBe('已验证');
    const js = (await req('GET', '/v1/judgments?child=gege', t)).body;
    expect(js[0].corrected).toEqual([{ gap: 0, by: 'LJ-0002', note: '这次面积单位都对了，原来的推测已更正' }]);
    expect(js[0].judgment.gaps[0].text).toBe(good().gaps[0].text); // the old guess is kept
    expect((await req('GET', '/v1/mastery?child=gege', t)).body.find((m: { concept_id: string }) => m.concept_id === PA).state).toBe('有独立应用证据');
    expect((await req('GET', '/v1/reteach-history', t)).body).toEqual([{ concept_id: PA, child: 'gege', mechanism: 'PerimeterArea', outcome: '已验证' }]);
  });

  it('refuses AI recognition without the parent\'s consent', async () => {
    const t = (await req('POST', '/v1/auth/login', undefined, { pin: PIN })).body.token;
    const id = await upload(t, false);
    expect((await req('PUT', `/v1/homework/${id}/recognition`, t, recognition(id, [['1', '对', 0.9]]))).status).toBe(403);
  });

  it('keeps feedback by source, exports a child and deletes only with PIN and name', async () => {
    const t = (await req('POST', '/v1/auth/login', undefined, { pin: PIN })).body.token;
    const id = await upload(t);
    expect((await req('POST', '/v1/feedback', t, { child: 'gege', source: '老师', said: '面积单位常写错', kind: '事实', ref: id })).status).toBe(201);
    expect((await req('POST', '/v1/feedback', t, { child: 'gege', source: '邻居', said: 'x', kind: '事实' })).status).toBe(400);
    const ex = (await req('GET', '/v1/children/gege/export', t)).body;
    expect(ex.homework).toHaveLength(1);
    expect(ex.feedback[0]).toMatchObject({ source: '老师', said: '面积单位常写错' });
    expect((await req('DELETE', '/v1/children/gege/data', t, { pin: '0000', confirm: '哥哥' })).status).toBe(401);
    expect((await req('DELETE', '/v1/children/gege/data', t, { pin: PIN, confirm: '妹妹' })).status).toBe(400);
    expect((await req('DELETE', '/v1/children/gege/data', t, { pin: PIN, confirm: '哥哥' })).body).toEqual({ ok: true, deleted_homework: 1 });
    expect(existsSync(join(dataDir, id))).toBe(false);
    expect((await req('GET', '/v1/children/gege/export', t)).body.homework).toEqual([]);
  });
});
