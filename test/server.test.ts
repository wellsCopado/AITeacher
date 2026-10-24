import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, shanghaiDate } from '../apps/server/src/app.js';
import { contentHash, REVIEW_CHECKLIST } from '../packages/cli/src/lib.js';
import { Queue } from '../apps/pad/src/queue.js';
import { summarize } from '../apps/parent/src/summary.js';
import type { LessonSpec } from '../packages/schema/src/index.js';

const root = join(import.meta.dirname, '..');
const PIN = '2468';
const spec = (lesson: string) => JSON.parse(readFileSync(join(root, 'content', 'lessons', lesson, '1.0', 'lessonspec.json'), 'utf8')) as LessonSpec;
function freeze(sp: LessonSpec): LessonSpec {
  const f: LessonSpec = { ...sp, review_records: Object.entries(REVIEW_CHECKLIST).map(([category, checked]) => ({ category: category as '科学', reviewer: '家长', checked, at: '2026-10-24T08:00:00Z' })), published_at: '2026-10-24T08:00:00Z' };
  f.content_hash = contentHash(f);
  return f;
}

let clock = new Date('2026-10-24T02:00:00Z'); // 10:00 in Shanghai
let app: Awaited<ReturnType<typeof buildApp>>;
const req = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await app.inject({ method: method as 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(body === undefined ? {} : { payload: body as object }) });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
const login = async () => (await req('POST', '/v1/auth/login', undefined, { pin: PIN })).body.token as string;
async function pair(parent: string, label = '哥哥的 iPad') {
  const { code } = (await req('POST', '/v1/pair/start')).body;
  expect((await req('GET', `/v1/pair/${code}`)).body.status).toBe('waiting');
  expect((await req('POST', `/v1/pair/${code}/approve`, parent, { label })).status).toBe(200);
  const got = (await req('GET', `/v1/pair/${code}`)).body;
  expect(got.status).toBe('approved');
  expect((await req('GET', `/v1/pair/${code}`)).status).toBe(404); // the token is handed out once
  return got.token as string;
}

beforeEach(async () => {
  clock = new Date('2026-10-24T02:00:00Z');
  app = await buildApp({ root, dbPath: join(mkdtempSync(join(tmpdir(), 'adw-')), 'db.sqlite'), pin: PIN, now: () => clock });
});
afterEach(async () => { await app.close(); });

describe('family server', () => {
  it('uses the Shanghai date, not UTC', () => {
    expect(shanghaiDate(new Date('2026-10-24T17:30:00Z'))).toBe('2026-10-25');
  });

  it('needs the PIN and locks after repeated failures', async () => {
    expect((await req('GET', '/v1/lessons')).status).toBe(401);
    for (let i = 0; i < 5; i++) expect((await req('POST', '/v1/auth/login', undefined, { pin: '0000' })).status).toBe(401);
    expect((await req('POST', '/v1/auth/login', undefined, { pin: PIN })).status).toBe(429);
  });

  it('seeds children and interests from content/', async () => {
    const t = await login();
    expect((await req('GET', '/v1/children', t)).body.map((c: { id: string }) => c.id)).toEqual(['gege', 'meimei']);
    const ints = (await req('GET', '/v1/interests?child=gege', t)).body;
    expect(ints.some((x: { topic: string }) => x.topic === '螳螂虾')).toBe(true);
    expect((await req('GET', '/v1/interests?child=meimei', t)).body).toEqual([]);
  });

  it('publishes only frozen, fully reviewed, valid lessons, and never overwrites a version', async () => {
    const t = await login();
    const sp = freeze(spec('L-PA'));
    expect((await req('POST', '/v1/lessons', t, spec('L-PA'))).status).toBe(400);
    expect((await req('POST', '/v1/lessons', t, { ...sp, title: '改过的标题' })).body.error).toMatch(/哈希/);
    const partial = { ...sp, review_records: sp.review_records!.slice(0, 2) }; partial.content_hash = contentHash(partial);
    expect((await req('POST', '/v1/lessons', t, partial)).body.error).toMatch(/审核未完成/);
    expect((await req('POST', '/v1/lessons', t, sp)).status).toBe(201);
    expect((await req('POST', '/v1/lessons', t, sp)).body.status).toBe('已存在');
    const changed = freeze({ ...spec('L-PA'), parent_tip: '另一句' });
    expect((await req('POST', '/v1/lessons', t, changed)).status).toBe(409);
  });

  it('re-validates on the server with its own interest records', async () => {
    const t = await login();
    // Give 妹妹's lesson a theme built on 哥哥's interest: V14 must refuse it.
    const bad = spec('L-ARR');
    bad.theme = { ...bad.theme, neutral: false, interest_refs: ['IO-0003'] };
    const f = freeze(bad);
    const r = await req('POST', '/v1/lessons', t, f);
    expect(r.status).toBe(422);
    expect(r.body.report.results.find((x: { id: string }) => x.id === 'V14').ok).toBe(false);
  });

  it('shows a child only the lessons scheduled today or granted, and only their own', async () => {
    const t = await login();
    await req('POST', '/v1/lessons', t, freeze(spec('L-PA')));
    await req('POST', '/v1/lessons', t, freeze(spec('L-ARR')));
    const pad = await pair(t);
    expect((await req('GET', '/v1/lessons', pad)).status).toBe(403);
    expect((await req('GET', '/v1/today?child=gege', pad)).body.lessons).toEqual([]);
    expect((await req('GET', '/v1/lessons/L-PA@1.0?child=gege', pad)).status).toBe(403);
    expect((await req('PUT', '/v1/schedule', t, { date: '2026-10-24', child: 'gege', lessons: ['L-ARR@1.0'] })).status).toBe(400);
    expect((await req('PUT', '/v1/schedule', t, { date: '2026-10-24', child: 'gege', lessons: ['L-PA@1.0'] })).status).toBe(200);
    expect((await req('GET', '/v1/today?child=gege', pad)).body.lessons.map((l: { key: string }) => l.key)).toEqual(['L-PA@1.0']);
    expect((await req('GET', '/v1/lessons/L-PA@1.0?child=gege', pad)).body.lesson_id).toBe('L-PA');
    expect((await req('GET', '/v1/lessons/L-PA@1.0?child=meimei', pad)).status).toBe(403);
    clock = new Date('2026-10-24T16:30:00Z'); // 00:30 next day in Shanghai
    expect((await req('GET', '/v1/today?child=gege', pad)).body.lessons).toEqual([]);
    // A 3-day grant covers today and the next two days.
    expect((await req('POST', '/v1/grants', t, { child: 'meimei', lesson: 'L-ARR@1.0', days: 3 })).body.expires_on).toBe('2026-10-27');
    expect((await req('POST', '/v1/grants', t, { child: 'meimei', lesson: 'L-ARR@1.0', days: 30 })).status).toBe(400);
    expect((await req('GET', '/v1/today?child=meimei', pad)).body.lessons[0].reason).toBe('临时授权');
    clock = new Date('2026-10-27T15:00:00Z');
    expect((await req('GET', '/v1/today?child=meimei', pad)).body.lessons).toHaveLength(1);
    clock = new Date('2026-10-27T16:30:00Z');
    expect((await req('GET', '/v1/today?child=meimei', pad)).body.lessons).toEqual([]);
  });

  it('stores events idempotently and turns a next-lesson wish into the child\'s own interest', async () => {
    const t = await login();
    await req('POST', '/v1/lessons', t, freeze(spec('L-PA')));
    const pad = await pair(t);
    const events = [
      { id: 'ev-00000001', at: '2026-10-24T02:01:00Z', type: 'step', step: '说明' },
      { id: 'ev-00000002', at: '2026-10-24T02:05:00Z', type: 'answer', challenge: 'c1', correct: true, hints: 1 },
      { id: 'ev-00000003', at: '2026-10-24T02:09:00Z', type: 'next_lesson_wish', question: 'wish', answer: '机器人', source: '孩子自述' },
      { id: 'ev-00000004', at: '2026-10-24T02:10:00Z', type: 'lesson_end', solved: ['c1'] },
    ];
    const body = { child: 'gege', lesson: 'L-PA@1.0', events };
    expect((await req('POST', '/v1/sessions/sess-0000001/events', pad, body)).body).toEqual({ accepted: 4, duplicates: 0 });
    expect((await req('POST', '/v1/sessions/sess-0000001/events', pad, body)).body).toEqual({ accepted: 0, duplicates: 4 });
    expect((await req('POST', '/v1/sessions/sess-0000001/events', pad, { ...body, lesson: 'L-ARR@1.0' })).status).toBe(404);
    expect((await req('POST', '/v1/sessions/sess-0000001/events', pad, { ...body, child: 'meimei' })).status).toBe(400);
    const wishes = (await req('GET', '/v1/interests?child=gege', t)).body.filter((x: { state: string }) => x.state === '下一课心愿');
    expect(wishes).toHaveLength(1);
    expect(wishes[0]).toMatchObject({ topic: '机器人', source: '孩子自述', lesson_ref: 'L-PA@1.0', observed_on: '2026-10' });
    const sessions = (await req('GET', '/v1/sessions', t)).body;
    expect(sessions[0]).toMatchObject({ key: 'sess-0000001', child: 'gege', finished: 1, events: 4 });
    expect((await req('GET', '/v1/today?child=gege', pad)).body.lessons).toEqual([]); // not scheduled, so not shown even though played
    const evs = (await req('GET', '/v1/sessions/sess-0000001/events', t)).body;
    expect(evs.map((e: { type: string }) => e.type)).toEqual(['step', 'answer', 'next_lesson_wish', 'lesson_end']);
    expect(summarize(evs)).toContain('下一课想学：“机器人”');
    expect((await req('GET', '/v1/sessions/sess-0000001/events', pad)).status).toBe(403);
  });

  it('dates a late-synced session by its first event', async () => {
    const t = await login();
    await req('POST', '/v1/lessons', t, freeze(spec('L-PA')));
    clock = new Date('2026-10-26T02:00:00Z');
    await req('POST', '/v1/sessions/sess-late-01/events', t, { child: 'gege', lesson: 'L-PA@1.0', events: [{ id: 'late-0000001', at: '2026-10-24T13:00:00Z', type: 'step' }] });
    expect((await req('GET', '/v1/sessions', t)).body[0].started_on).toBe('2026-10-24');
  });

  it('revoking a device ends its access', async () => {
    const t = await login();
    const pad = await pair(t, 'Pad A');
    expect((await req('GET', '/v1/children', pad)).status).toBe(200);
    expect((await req('GET', '/v1/devices', t)).body.map((d: { label: string }) => d.label)).toEqual(['Pad A']);
    await req('DELETE', `/v1/devices/${encodeURIComponent('Pad A')}`, t);
    expect((await req('GET', '/v1/children', pad)).status).toBe(401);
  });
});

describe('lesson review in the parent app', () => {
  it('lists unpublished lessons for review, publishes only with all four reviews ticked, and takes rejections', async () => {
    const t = await login();
    const drafts = (await req('GET', '/v1/drafts', t)).body;
    expect(drafts.map((d: { key: string }) => d.key).sort()).toEqual(['L-ARR@1.0', 'L-PA@1.0']);
    const arr = drafts.find((d: { key: string }) => d.key === 'L-ARR@1.0');
    expect(arr.ok).toBe(true);
    expect(arr.issues.some((i: { rule: string; level: string }) => i.rule === 'V12' && i.level === 'warn')).toBe(true);
    expect((await req('GET', '/v1/drafts/L-PA@1.0', t)).body.title).toMatch(/螳螂虾/);
    const list = (await req('GET', '/v1/review-checklist', t)).body as Record<string, string[]>;
    const partial = { ...list, 安全: list['安全'].slice(0, 1) };
    expect((await req('POST', '/v1/drafts/L-PA@1.0/approve', t, { checked: partial })).body.error).toMatch(/安全/);
    const ok = await req('POST', '/v1/drafts/L-PA@1.0/approve', t, { checked: list });
    expect(ok.status).toBe(201);
    const sp = (await req('GET', '/v1/lessons/L-PA@1.0', t)).body;
    expect(sp.review_records).toHaveLength(4);
    expect(contentHash(sp)).toBe(sp.content_hash);
    expect((await req('GET', '/v1/drafts', t)).body.map((d: { key: string }) => d.key)).toEqual(['L-ARR@1.0']);
    expect((await req('POST', '/v1/drafts/L-ARR@1.0/reject', t, { note: '' })).status).toBe(400);
    await req('POST', '/v1/drafts/L-ARR@1.0/reject', t, { note: '题目再简单一点' });
    expect((await req('GET', '/v1/drafts', t)).body[0]).toMatchObject({ status: '已退回', note: '题目再简单一点' });
    // The Skill resubmits after changes; it goes back to 待审核.
    expect((await req('POST', '/v1/drafts', t, spec('L-ARR'))).status).toBe(201);
    expect((await req('GET', '/v1/drafts', t)).body[0]).toMatchObject({ status: '待审核', note: null });
    expect((await req('POST', '/v1/drafts', t, spec('L-PA'))).status).toBe(409); // already published
  });
});

describe('Pad offline queue', () => {
  const mem = () => { const m = new Map<string, string>(); return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v) }; };
  it('keeps events while the server is unreachable and sends each once it is back', async () => {
    const kv = mem();
    let up = false; const sent: string[] = [];
    const q = new Queue(kv, async b => { if (!up) throw new Error('offline'); sent.push(...b.events.map(e => e.id)); }, 2);
    const meta = { session: 's1', child: 'gege', lesson: 'L-PA@1.0' };
    for (let i = 1; i <= 3; i++) q.push(meta, { id: `e${i}`, at: new Date().toISOString(), type: 'step' });
    await expect(q.flush()).rejects.toThrow('offline');
    expect(q.pending()).toBe(3);
    up = true;
    await q.flush();
    expect(sent).toEqual(['e1', 'e2', 'e3']);
    expect(q.pending()).toBe(0);
    // A survives-reload check: a new Queue over the same storage sees the same state.
    q.push(meta, { id: 'e4', at: new Date().toISOString(), type: 'lesson_end' });
    expect(new Queue(kv, async () => {}).pending()).toBe(1);
  });
});

describe('organism media', () => {
  it('takes real photos or videos with credit and licence, and serves video in ranges for iPad Safari', async () => {
    const parent = await login();
    const pad = await pair(parent);
    const data = Buffer.from('0123456789abcdef').toString('base64');
    const add = (body: object, tok = parent) => req('POST', '/v1/organisms/M-peacock-mantis-shrimp/media', tok, { mime: 'video/mp4', data, credit: '拍摄者', license: 'CC BY 4.0', real: true, ...body });
    expect((await add({ real: false })).status).toBe(400);
    expect((await add({ license: '' })).status).toBe(400);
    expect((await add({ mime: 'image/gif' })).status).toBe(400);
    expect((await add({}, pad)).status).toBe(403);
    expect((await req('POST', '/v1/organisms/M-not-there/media', parent, {})).status).toBe(404);
    const m = (await add({ caption: '出击', length_cm: 16 })).body;
    expect(m).toMatchObject({ kind: 'video', length_cm: 16, credit: '拍摄者' });
    expect((await req('GET', '/v1/media', pad)).body.map((x: { id: string }) => x.id)).toEqual([m.id]);

    const full = await app.inject({ method: 'GET', url: m.url });
    expect(full.statusCode).toBe(200);
    expect(full.headers['accept-ranges']).toBe('bytes');
    const part = await app.inject({ method: 'GET', url: m.url, headers: { range: 'bytes=2-5' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 2-5/16');
    expect(part.body).toBe('2345');
    expect((await app.inject({ method: 'GET', url: m.url, headers: { range: 'bytes=-4' } })).body).toBe('cdef');
    expect((await app.inject({ method: 'GET', url: `/v1/media/${m.id}/wrongkey` })).statusCode).toBe(404);

    expect((await req('DELETE', `/v1/media/${m.id}`, parent)).status).toBe(200);
    expect((await req('GET', '/v1/media', pad)).body).toEqual([]);
  });
});
