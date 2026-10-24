// Organism media (BL14): until a photoreal model of an animal is in a component, the lesson shows the real
// thing instead — photos, videos or scans the parent adds here, each with who made it and its licence.
// Files are served by an unguessable per-file key so <img>/<video> can load them without a login header.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AssetEntry } from '../../../packages/schema/src/index.js';
import { readJson } from '../../../packages/cli/src/lib.js';
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
  id: m.id, asset_id: m.asset_id, kind: m.kind, url: `/v1/media/${m.id}/${m.key}`, credit: m.credit, license: m.license,
  source_url: m.source_url, caption: m.caption, length_cm: m.length_cm, created_at: m.created_at,
});

export function mediaRoutes(app: FastifyInstance, d: Deps) {
  const { store } = d;
  const organisms = () => readJson<AssetEntry[]>(join(d.root, 'content', 'assets', 'registry.json'))
    .filter(a => a.kind === 'organism' && a.status !== '拒绝');

  app.get('/v1/organisms', d.parent, async () => organisms().map(a => ({
    asset_id: a.asset_id, name: a.name, status: a.status, real_scale: a.real_scale ?? null, media: store.mediaFor(a.asset_id).map(publicMedia),
  })));
  app.get('/v1/media', d.anyone, async req => store.mediaFor((req.query as { asset?: string }).asset).map(publicMedia));

  app.post('/v1/organisms/:asset/media', { ...d.parent, bodyLimit: Math.ceil(MAX_BYTES * 1.4) }, async req => {
    const asset = (req.params as { asset: string }).asset;
    if (!organisms().some(a => a.asset_id === asset)) fail(404, '资产库里没有这个生物');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const t = MEDIA_TYPES[String(b.mime ?? '')] ?? fail(400, '格式不支持：照片 jpg/png/webp，视频 mp4/mov/webm，扫描模型 glb');
    if (b.real !== true) fail(400, '要先确认这是实拍、标本扫描，或依据实拍照片做的写实模型，不是卡通或绘画');
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
      asset_id: asset, kind: t.kind, mime: String(b.mime), file, key, credit, license, source_url: url,
      caption: b.caption ? String(b.caption).slice(0, 120) : null, length_cm: len, added_by: req.who ?? '家长',
    }, d.iso()));
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
}
