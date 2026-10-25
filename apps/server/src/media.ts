// Organism media (BL14): until a photoreal model of an animal is in a component, the lesson shows the real
// thing instead — photos, videos or scans the parent adds here, each with who made it and its licence.
// Files are served by an unguessable per-file key so <img>/<video> can load them without a login header.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AssetEntry } from '../../../packages/schema/src/index.js';
import { readJson } from '../../../packages/cli/src/lib.js';
import { sniffImage } from '../../../packages/studio/src/codex.js';
import type { MediaRow, Store } from './db.js';
import { fail } from './http.js';

interface Deps {
  store: Store; root: string; mediaDir: string; iso: () => string;
  parent: { preHandler: (req: FastifyRequest) => Promise<void> };
  anyone: { preHandler: (req: FastifyRequest) => Promise<void> };
}

export const MEDIA_TYPES: Record<string, { ext: string; kind: MediaRow['kind'] }> = {
  'image/jpeg': { ext: 'jpg', kind: 'photo' }, 'image/png': { ext: 'png', kind: 'photo' }, 'image/webp': { ext: 'webp', kind: 'photo' },
  'video/mp4': { ext: 'mp4', kind: 'video' }, 'video/quicktime': { ext: 'mov', kind: 'video' }, 'video/webm': { ext: 'webm', kind: 'video' },
  'model/gltf-binary': { ext: 'glb', kind: 'model' },
};
const MAX_BYTES = 48 * 1024 * 1024;

export const publicMedia = (m: MediaRow) => ({
  id: m.id, asset_id: m.asset_id, kind: m.kind, origin: m.origin ?? '实拍', url: `/v1/media/${m.id}/${m.key}`, credit: m.credit, license: m.license,
  source_url: m.source_url, caption: m.caption, length_cm: m.length_cm, created_at: m.created_at,
  added_by: m.added_by, pending: !m.confirmed, refs: m.refs ? JSON.parse(m.refs) as string[] : null,
});
const UPLOAD_BYTES = 20 * 1024 * 1024, UPLOAD_TTL_MS = 30 * 60_000;

/** Pictures that ship with the program, in content/assets/organisms/<asset>/media.json. */
interface Builtin { file: string; kind: 'photo' | 'video' | 'cutout'; origin: string; caption?: string; length_cm?: number; width_px_body?: [number, number]; rig?: string; rig_meta?: string }
const ORIGINS = ['实拍', '标本扫描', 'AI 写实图'], REAL = ['实拍', '标本扫描'];
function builtins(root: string, asset?: string) {
  const dir = join(root, 'content', 'assets', 'organisms');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(a => (!asset || a === asset) && existsSync(join(dir, a, 'media.json'))).flatMap(a =>
    readJson<Builtin[]>(join(dir, a, 'media.json')).map((b, i) => ({
      id: `${a}#${i + 1}`, asset_id: a, kind: b.kind, origin: b.origin, url: `/organism-assets/${a}/${b.file}`,
      credit: '家长提供', license: '家用；AI 生成图，商用前换成实拍或授权素材', source_url: null, caption: b.caption ?? null,
      length_cm: b.length_cm ?? null, body: b.width_px_body ?? null, builtin: true, created_at: null,
      ...(b.rig && b.rig_meta ? { rig: `/organism-assets/${a}/${b.rig}`, rig_meta: `/organism-assets/${a}/${b.rig_meta}` } : {}),
    })));
}

export function mediaRoutes(app: FastifyInstance, d: Deps) {
  const { store } = d;
  // the registry's animals, then whatever lessons are about (博比特虫, 机器人…) that still needs its pictures
  const organisms = (): { asset_id: string; name?: string; status: string; real_scale?: string }[] => {
    const reg = readJson<AssetEntry[]>(join(d.root, 'content', 'assets', 'registry.json')).filter(a => a.kind === 'organism' && a.status !== '拒绝');
    return [...reg, ...store.subjects().filter(s => !reg.some(a => a.asset_id === s.asset_id))
      .map(s => ({ asset_id: s.asset_id, name: s.name, status: store.mediaFor(s.asset_id).some(m => m.confirmed) ? '采用标记' : '待制作' }))];
  };

  app.get('/v1/organisms', d.parent, async () => organisms().map(a => ({
    asset_id: a.asset_id, name: a.name, status: a.status, real_scale: a.real_scale ?? null,
    media: [...builtins(d.root, a.asset_id), ...store.mediaFor(a.asset_id).map(publicMedia)],
  })));
  app.get('/v1/media', d.anyone, async req => {
    const asset = (req.query as { asset?: string }).asset;
    return [...builtins(d.root, asset), ...store.mediaFor(asset).filter(m => m.confirmed).map(publicMedia)];
  });
  app.get('/organism-assets/:asset/:file', async (req, reply) => {
    const { asset, file } = req.params as { asset: string; file: string };
    const b = builtins(d.root, asset).find(x => [x.url, x.rig, x.rig_meta].some(u => u?.endsWith('/' + file))) ?? fail(404, '没有这个素材');
    const ext = file.split('.').pop()!;
    reply.header('cache-control', 'public, max-age=604800').type(({ jpg: 'image/jpeg', webp: 'image/webp', png: 'image/png', mp4: 'video/mp4', json: 'application/json' } as Record<string, string>)[ext] ?? 'application/octet-stream');
    return readFileSync(join(d.root, 'content', 'assets', 'organisms', b.asset_id, file));
  });

  app.post('/v1/organisms/:asset/media', { ...d.parent, bodyLimit: Math.ceil(MAX_BYTES * 1.4) }, async req => {
    const asset = (req.params as { asset: string }).asset;
    if (!organisms().some(a => a.asset_id === asset)) fail(404, '资产库里没有这个生物');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const t = MEDIA_TYPES[String(b.mime ?? '')] ?? fail(400, '格式不支持：照片 jpg/png/webp，视频 mp4/mov/webm，扫描模型 glb');
    if (b.real !== true) fail(400, '要先确认这是写实的（实拍、标本扫描或 AI 写实图），不是卡通或绘画');
    const origin = ORIGINS.includes(String(b.origin)) ? String(b.origin) : '实拍';
    const credit = String(b.credit ?? '').trim().slice(0, 200), license = String(b.license ?? '').trim().slice(0, 100);
    if (!credit) fail(400, '写上作者或来源（例如 维基共享资源 · 某某）');
    if (!license) fail(400, '写上授权（例如 CC BY-SA 4.0、自己拍的）');
    const buf = Buffer.from(String(b.data ?? ''), 'base64');
    if (!buf.length || buf.length > MAX_BYTES) fail(400, `文件要在 ${MAX_BYTES / 1024 / 1024} MB 以内`);
    const len = b.length_cm == null || b.length_cm === '' ? null : Number(b.length_cm);
    if (len !== null && !(len > 0 && len < 1000)) fail(400, '身长按厘米填，例如 16');
    const url = b.source_url ? String(b.source_url).slice(0, 500) : null;
    if (url && !/^https?:\/\//.test(url)) fail(400, '来源链接要以 http 开头');
    const key = randomBytes(18).toString('base64url');
    mkdirSync(d.mediaDir, { recursive: true });
    const file = `${asset}-${key}.${t.ext}`;
    writeFileSync(join(d.mediaDir, file), buf);
    return publicMedia(store.addMedia({
      asset_id: asset, kind: t.kind, origin, mime: String(b.mime), file, key, credit, license, source_url: url,
      caption: b.caption ? String(b.caption).slice(0, 120) : null, length_cm: len, added_by: req.who ?? '家长', confirmed: 1, refs: null,
    }, d.iso()));
  });

  // AI assistants (Codex can make a photoreal picture on the parent's computer) get a one-time address and send
  // the file with curl; it waits in 生物素材 until the parent confirms it, and no child sees it before that.
  const tickets = new Map<string, { asset: string; origin: string; caption: string | null; credit: string; license: string; refs: string[]; length_cm: number | null; by: string; until: number }>();
  const prepareUpload = (a: Record<string, unknown>, by: string, base: string) => {
    const asset = String(a.asset_id ?? '');
    if (!organisms().some(o => o.asset_id === asset)) fail(404, `资产库里没有这个生物：${asset}（可选：${organisms().map(o => o.asset_id).join('、')}）`);
    const origin = ORIGINS.includes(String(a.origin)) ? String(a.origin) : fail(400, '类型只能是 实拍、标本扫描、AI 写实图');
    const credit = String(a.credit ?? '').trim().slice(0, 200), license = String(a.license ?? '').trim().slice(0, 100);
    if (!credit || !license) fail(400, '要写作者或来源（credit）和授权（license）');
    const refs = (Array.isArray(a.references) ? a.references : []).map(x => String(x).trim().slice(0, 300)).filter(Boolean).slice(0, 10);
    if (origin === 'AI 写实图' && refs.length < 3) fail(400, 'AI 写实图要写至少 3 张参考的实拍照片（链接或出处），家长核对形态时要用');
    const len = a.length_cm == null || a.length_cm === '' ? null : Number(a.length_cm);
    if (len !== null && !(len > 0 && len < 1000)) fail(400, '身长按厘米填，例如 16');
    const t = randomBytes(18).toString('base64url');
    for (const [k, v] of tickets) if (v.until < Date.now()) tickets.delete(k);
    tickets.set(t, { asset, origin, caption: a.caption ? String(a.caption).slice(0, 120) : null, credit, license, refs, length_cm: len, by, until: Date.now() + UPLOAD_TTL_MS });
    const url = `${base}/v1/uploads/${t}`;
    return {
      upload_url: url, expires_in_minutes: UPLOAD_TTL_MS / 60_000,
      curl: `curl -sS -X POST --data-binary @<图片文件路径> -H "content-type: image/png" ${url}`,
      note: 'content-type 按文件换成 image/jpeg、image/png 或 image/webp，20 MB 以内。地址只能用一次。上传后家长在“生物素材”里确认，孩子才看得到。',
    };
  };
  app.addContentTypeParser(/^image\//, { parseAs: 'buffer', bodyLimit: UPLOAD_BYTES }, (_req, body, done) => done(null, body));
  app.post('/v1/uploads/:ticket', { bodyLimit: UPLOAD_BYTES }, async (req, reply) => {
    const t = (req.params as { ticket: string }).ticket, tk = tickets.get(t);
    if (!tk || tk.until < Date.now()) { tickets.delete(t); fail(404, '上传地址无效或已过期，请重新获取'); }
    const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const buf = req.body as Buffer;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) fail(400, '只收 jpg、png、webp 图片（content-type 写 image/jpeg、image/png 或 image/webp）');
    if (!Buffer.isBuffer(buf) || sniffImage(buf) !== mime) fail(400, '收到的不是这种格式的图片文件');
    tickets.delete(t);
    const key = randomBytes(18).toString('base64url'), file = `${tk!.asset}-${key}.${MEDIA_TYPES[mime].ext}`;
    mkdirSync(d.mediaDir, { recursive: true });
    writeFileSync(join(d.mediaDir, file), buf);
    const m = store.addMedia({
      asset_id: tk!.asset, kind: 'photo', origin: tk!.origin, mime, file, key, credit: tk!.credit, license: tk!.license, source_url: null,
      caption: tk!.caption, length_cm: tk!.length_cm, added_by: tk!.by, confirmed: 0, refs: tk!.refs.length ? JSON.stringify(tk!.refs) : null,
    }, d.iso());
    return reply.code(201).send({ ...publicMedia(m), status: '已上传，等家长在“课程库 → 生物素材”里确认' });
  });
  app.post('/v1/media/:id/confirm', d.parent, async req => {
    const m = store.media((req.params as { id: string }).id) ?? fail(404, '没有这个素材');
    store.confirmMedia(m.id);
    return publicMedia(store.media(m.id)!);
  });

  app.delete('/v1/media/:id', d.parent, async req => {
    const m = store.media((req.params as { id: string }).id) ?? fail(404, '没有这个素材');
    rmSync(join(d.mediaDir, m.file), { force: true });
    store.deleteMedia(m.id);
    return { ok: true };
  });

  // Range requests: iPad Safari only plays video that it can fetch in pieces.
  app.get('/v1/media/:id/:key', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id, key } = req.params as { id: string; key: string };
    const m = store.media(id);
    if (!m || m.key !== key) fail(404, '没有这个素材');
    const path = join(d.mediaDir, m!.file), size = statSync(path).size;
    reply.header('accept-ranges', 'bytes').header('cache-control', 'private, max-age=604800').type(m!.mime);
    const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (!r) return reply.header('content-length', size).send(readFileSync(path));
    let start = r[1] ? Number(r[1]) : size - Number(r[2]), end = r[1] && r[2] ? Number(r[2]) : size - 1;
    if (!r[1]) end = size - 1;
    if (start < 0 || start >= size || end < start) return reply.code(416).header('content-range', `bytes */${size}`).send();
    end = Math.min(end, size - 1);
    return reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1)
      .send(readFileSync(path).subarray(start, end + 1));
  });
  /** Real photos of one organism (实拍 / 标本扫描), oldest first, for ChatGPT to draw from and the parent to check against. */
  const references = (asset: string) => [
    ...builtins(d.root, asset).filter(b => b.kind === 'photo' && REAL.includes(b.origin)).map(b => ({ path: join(d.root, 'content', 'assets', 'organisms', asset, b.url.split('/').pop()!), label: `${b.origin} · ${b.caption ?? '随程序自带'}` })),
    ...store.mediaFor(asset).filter(m => m.confirmed && m.kind === 'photo' && REAL.includes(m.origin ?? '实拍'))
      .map(m => ({ path: join(d.mediaDir, m.file), label: [m.id, m.origin ?? '实拍', m.credit, m.caption, m.source_url].filter(Boolean).join(' · ') })),
  ].filter(r => existsSync(r.path));
  /** A picture made here by ChatGPT: hidden from the children until the parent confirms it. */
  const addPending = (asset: string, data: Buffer, mime: string, m: { by: string; caption: string; refs: string[] }) => {
    const key = randomBytes(18).toString('base64url'), file = `${asset}-${key}.${MEDIA_TYPES[mime].ext}`;
    mkdirSync(d.mediaDir, { recursive: true });
    writeFileSync(join(d.mediaDir, file), data);
    return store.addMedia({
      asset_id: asset, kind: 'photo', origin: 'AI 写实图', mime, file, key, credit: 'ChatGPT 依据实拍照片生成', license: '家用；AI 生成图，商用前换成实拍或授权素材',
      source_url: null, caption: m.caption.slice(0, 120), length_cm: null, added_by: m.by, confirmed: 0, refs: JSON.stringify(m.refs),
    }, d.iso());
  };
  const organism = (asset: string) => { const a = organisms().find(o => o.asset_id === asset); return a && { name: a.name ?? a.asset_id, real_scale: a.real_scale ?? null }; };
  return { prepareUpload, organismIds: () => organisms().map(a => a.asset_id), organism, references, addPending };
}
