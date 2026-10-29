import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { buildApp } from '../apps/server/src/app.js';
import { summarize } from '../apps/parent/src/summary.js';

const root = join(import.meta.dirname, '..');
const PIN = '2468';
let clock = new Date('2026-10-29T02:00:00Z');
let app: Awaited<ReturnType<typeof buildApp>>;

/** A package as the Skill hands it in: the built page under web/dist, notes beside it. */
function pkg(o: { manifest?: object | null; js?: string; html?: string; extra?: Record<string, string>; folder?: string } = {}) {
  const f = o.folder ?? '台北101_四年级探索课';
  const files: Record<string, Uint8Array> = {
    [`${f}/web/dist/index.html`]: strToU8(o.html ?? '<!doctype html><title>台北101 · 风中的稳定秘密</title><script type="module" src="./assets/app.js"></script>'),
    [`${f}/web/dist/assets/app.js`]: strToU8(o.js ?? "parent.postMessage({adw:'explore/1',type:'ready'},location.origin)"),
    [`${f}/web/dist/models/tower.glb`]: new Uint8Array([103, 108, 84, 70]),
    [`${f}/web/src/main.mjs`]: strToU8('// source, not served'),
    [`${f}/README.md`]: strToU8('# 台北101\n\n说明'),
    [`${f}/课程设计.md`]: strToU8('# 课程设计'),
    [`${f}/licenses/three-LICENSE.txt`]: strToU8('MIT'),
    [`${f}/models/tower.blend`]: new Uint8Array(10),
    '__MACOSX/._README.md': new Uint8Array(4),
    ...Object.fromEntries(Object.entries(o.extra ?? {}).map(([k, v]) => [k, strToU8(v)])),
  };
  if (o.manifest !== null) files[`${f}/exploration.json`] = strToU8(JSON.stringify(o.manifest ?? { format: 'adw-explore/1', id: 'X-TAIPEI101', version: '1.0', title: '台北101：风中的稳定秘密', for_child: 'gege', concept: '统计与平均数', subjects: ['数学', '科学'], minutes: 30 }));
  return Buffer.from(zipSync(files));
}

const req = async (method: string, url: string, token?: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await app.inject({ method: method as 'GET', url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body === undefined ? {} : { payload: body as object }) });
  let parsed: unknown = null;
  try { parsed = r.body ? JSON.parse(r.body) : null; } catch { parsed = r.body; }
  return { status: r.statusCode, body: parsed as any, raw: r.body, headers: r.headers };
};
const upload = (token: string, zip: Buffer, q = '') => req('POST', `/v1/explore/import${q}`, token, zip, { 'content-type': 'application/zip' });
const login = async () => (await req('POST', '/v1/auth/login', undefined, { pin: PIN })).body.token as string;
async function pair(parent: string) {
  const { code } = (await req('POST', '/v1/pair/start')).body;
  await req('POST', `/v1/pair/${code}/approve`, parent, { label: '平板' });
  return (await req('GET', `/v1/pair/${code}`)).body.token as string;
}

beforeEach(async () => {
  clock = new Date('2026-10-29T02:00:00Z');
  app = await buildApp({ root, dbPath: join(mkdtempSync(join(tmpdir(), 'adw-x-')), 'db.sqlite'), pin: PIN, now: () => clock, tts: null });
});
afterEach(async () => { await app.close(); });

describe('探索课 packages', () => {
  it('imports a package for review, serves its page, and publishes it only after the parent previewed it', async () => {
    const t = await login();
    const r = await upload(t, pkg(), '?name=' + encodeURIComponent('台北101_四年级探索课_20261027.zip'));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ key: 'X-TAIPEI101@1.0', status: '待审核', title: '台北101：风中的稳定秘密', for_child: 'gege', bridge: true, files: 3, docs: ['README.md', '课程设计.md'] });
    expect(r.body.warnings).toEqual([]);
    const list = (await req('GET', '/v1/explore', t)).body;
    expect(list.map((x: { key: string }) => x.key)).toEqual(['X-TAIPEI101@1.0']);

    // the page and its files; the source and the Blender file stay out
    const page = await req('GET', '/explore/X-TAIPEI101@1.0/');
    expect(page.status).toBe(200);
    expect(page.raw).toContain('风中的稳定秘密');
    expect((await req('GET', '/explore/X-TAIPEI101@1.0/models/tower.glb')).status).toBe(200);
    expect((await req('GET', '/explore/X-TAIPEI101@1.0/../../db.sqlite')).status).toBe(404);
    expect((await req('GET', '/explore/X-OTHER@1.0/')).status).toBe(404);
    expect((await req('GET', '/v1/explore/X-TAIPEI101@1.0/docs/课程设计.md', t)).raw).toBe('# 课程设计');

    expect((await req('POST', '/v1/explore/X-TAIPEI101@1.0/approve', t, {})).status).toBe(400);
    expect((await req('POST', '/v1/explore/X-TAIPEI101@1.0/approve', t, { previewed: true })).status).toBe(201);
    expect((await req('GET', '/v1/explore', t)).body).toEqual([]);
    const lessons = (await req('GET', '/v1/lessons', t)).body;
    expect(lessons.find((l: { key: string }) => l.key === 'X-TAIPEI101@1.0')).toMatchObject({ kind: 'explore', for_child: 'gege', title: '台北101：风中的稳定秘密' });
  });

  it('is scheduled, opened on the Pad and finished like any other lesson', async () => {
    const t = await login(), pad = await pair(t);
    await upload(t, pkg());
    await req('POST', '/v1/explore/X-TAIPEI101@1.0/approve', t, { previewed: true });
    expect((await req('PUT', '/v1/schedule', t, { date: '2026-10-29', child: 'gege', lessons: ['X-TAIPEI101@1.0'] })).status).toBe(200);
    expect((await req('PUT', '/v1/schedule', t, { date: '2026-10-29', child: 'meimei', lessons: ['X-TAIPEI101@1.0'] })).status).toBe(400);
    const today = (await req('GET', '/v1/today?child=gege', pad)).body;
    expect(today.lessons).toEqual([expect.objectContaining({ key: 'X-TAIPEI101@1.0', kind: 'explore', title: '台北101：风中的稳定秘密', concept: '统计与平均数' })]);
    const open = (await req('GET', '/v1/lessons/X-TAIPEI101@1.0?child=gege', pad)).body;
    expect(open).toMatchObject({ kind: 'explore', url: '/explore/X-TAIPEI101@1.0/', bridge: true });
    expect((await req('GET', '/v1/lessons/X-TAIPEI101@1.0?child=meimei', pad)).status).toBe(403);

    const progress = { type: 'explore_progress', done: 4, total: 4, section: 3, tasks: [
      { id: 'locate', label: '装置与机制', passed: true, result: 'independent', helped: false, wrong: 0 },
      { id: 'fair', label: '公平比较', passed: true, result: 'corrected', helped: false, wrong: 1 },
      { id: 'average', label: '平均数', passed: true, result: 'assisted', helped: true, wrong: 1 },
      { id: 'transfer', label: '新条件结论', passed: true, result: 'independent', helped: false, wrong: 0 }] };
    const events = [
      { id: 'ev-start-001', at: '2026-10-29T02:01:00Z', type: 'start' },
      { id: 'ev-prog-0001', at: '2026-10-29T02:20:00Z', ...progress },
      { id: 'ev-end-00001', at: '2026-10-29T02:20:01Z', type: 'lesson_end' },
      { id: 'ev-wish-0001', at: '2026-10-29T02:21:00Z', type: 'next_lesson_wish', question: 'next', answer: '桥', source: '孩子自述' },
    ];
    expect((await req('POST', '/v1/sessions/sess-explore-1/events', pad, { child: 'gege', lesson: 'X-TAIPEI101@1.0', events })).status).toBe(200);
    expect((await req('GET', '/v1/today?child=gege', pad)).body.lessons[0].finished).toBe(true);
    const sessions = (await req('GET', '/v1/sessions?child=gege', t)).body;
    expect(sessions[0]).toMatchObject({ lesson_key: 'X-TAIPEI101@1.0', finished: 1 });
    // the parent's record says what was checked and how, in plain words
    const evs = (await req('GET', '/v1/sessions/sess-explore-1/events', t)).body;
    const text = summarize(evs, (await req('GET', '/v1/lessons/X-TAIPEI101@1.0', t)).body);
    expect(text).toContain('核对了 4/4 项');
    expect(text).toContain('平均数（借助帮助完成）');
    expect(text).toContain('下一课想学：“桥”');
    // the automatic plan moves on: a finished 探索课 isn't picked again
    const plan = (await req('GET', '/v1/schedule/plan?days=2', t)).body;
    expect(plan.days[1].kids.find((k: { child: string }) => k.child === 'gege').lessons.map((l: { key: string }) => l.key)).not.toContain('X-TAIPEI101@1.0');
  });

  it('sends back, declines and restores; a new package of the same lesson replaces the one waiting', async () => {
    const t = await login();
    await upload(t, pkg());
    expect((await req('POST', '/v1/explore/X-TAIPEI101@1.0/reject', t, { note: '' })).status).toBe(400);
    expect((await req('POST', '/v1/explore/X-TAIPEI101@1.0/reject', t, { note: '楼的玻璃太假' })).status).toBe(200);
    expect((await req('GET', '/v1/explore', t)).body[0]).toMatchObject({ status: '已退回', note: '楼的玻璃太假' });
    expect((await req('POST', '/v1/explore/X-TAIPEI101@1.0/approve', t, { previewed: true })).status).toBe(409);
    // the revised package takes its place
    const again = await upload(t, pkg({ js: "parent.postMessage({adw:'explore/1',type:'ready'},location.origin)//v2" }));
    expect(again.body).toMatchObject({ key: 'X-TAIPEI101@1.0', status: '待审核' });
    expect((await req('GET', '/v1/explore', t)).body).toHaveLength(1);
    expect((await req('POST', '/v1/explore/X-TAIPEI101@1.0/discard', t, { reason: '不想学这个' })).status).toBe(200);
    expect((await req('GET', '/v1/explore', t)).body[0]).toMatchObject({ status: '不采用', note: '不想学这个' });
    expect((await req('POST', '/v1/explore/X-TAIPEI101@1.0/restore', t)).status).toBe(200);
    expect((await req('GET', '/v1/explore', t)).body[0]).toMatchObject({ status: '待审核', note: null });
  });

  it('gives a changed package of a published lesson the next version, and refuses the same one twice', async () => {
    const t = await login();
    await upload(t, pkg());
    await req('POST', '/v1/explore/X-TAIPEI101@1.0/approve', t, { previewed: true });
    expect((await upload(t, pkg())).status).toBe(409);
    const v2 = await upload(t, pkg({ js: "parent.postMessage({adw:'explore/1',type:'ready'},location.origin)//v2" }));
    expect(v2.body).toMatchObject({ key: 'X-TAIPEI101@1.1', replaces: 'X-TAIPEI101@1.0' });
    expect((await req('GET', '/explore/X-TAIPEI101@1.0/')).status).toBe(200); // the published one keeps working
  });

  it('takes a package without exploration.json and says what the App cannot do with it', async () => {
    const t = await login();
    const r = await upload(t, pkg({ manifest: null, folder: '上海中心_四年级角度探索课', js: 'console.log(1)',
      html: '<!doctype html><title>上海中心 · 追踪一条外缘</title><script type="module" src="/assets/app.js"></script>',
      extra: { '上海中心_四年级角度探索课/web/package.json': '{"name":"shanghai-tower-angle-course"}' } }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ key: 'X-shanghai-tower-angle-course@1.0', title: '上海中心 · 追踪一条外缘', for_child: 'gege', bridge: false });
    expect(r.body.warnings.join()).toContain('没接 App 的进度接口');
    expect(r.body.warnings.join()).toContain('绝对路径');
    // built with absolute paths: /assets/app.js asked by its page still arrives
    const asset = await req('GET', '/assets/app.js', undefined, undefined, { referer: 'http://mac.local:8787/explore/X-shanghai-tower-angle-course@1.0/?adw=1' });
    expect(asset.status).toBe(200);
    expect(asset.raw).toBe('console.log(1)');
    expect((await req('GET', '/assets/app.js')).status).toBe(404);
  });

  it('refuses what is not a built lesson', async () => {
    const t = await login();
    expect((await upload(t, Buffer.from('not a zip'))).status).toBe(400);
    const src = Buffer.from(zipSync({ 'x/web/index.html': strToU8('<script type="module" src="/src/main.mjs"></script>') }));
    expect((await upload(t, src)).body.error).toContain('pnpm build');
    const evil = Buffer.from(zipSync({ 'x/index.html': strToU8('<title>a</title>'), '../evil.txt': strToU8('x') }));
    expect((await upload(t, evil)).body.error).toContain('不安全');
    const pad = await pair(t);
    expect((await upload(pad, pkg())).status).toBe(403);
  });
});
