// 探索课: whole interactive web lessons (3D scene + teaching in one page) made outside the App with the
// discovery-lesson-maker Skill and handed in as a .zip. The parent imports the package, previews it, and approves,
// sends it back or declines it, like any other lesson; once published it is scheduled, played on the Pad in a
// frame and recorded like the rest. The page reports progress through adw-explore/1 (skills/discovery-lesson-maker/assets/web/adw-host.mjs).
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from 'fastify';
import fastifyStatic from '@fastify/static';
import { unzipSync } from 'fflate';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import type { ExploreStatus, Store } from './db.js';
import { fail, sha } from './http.js';

export const BRIDGE = 'adw-explore/1';
const MAX_ZIP = 600 * 1024 * 1024, MAX_SITE = 800 * 1024 * 1024, MAX_FILES = 5000;
/** Files kept beside the page for the parent: the package's own notes, licences and sources. */
const DOC = /^(?:[^/]+\.md|licenses\/.+|research\/sources\.json|exploration\.json)$/;

/** What the App knows about one imported 探索课. */
export interface Exploration {
  format: typeof BRIDGE;
  lesson_id: string; version: string; title: string; for_child: string;
  concept: string; subjects: string[]; minutes: number | null; summary: string;
  /** The page tells the App its progress (adw-explore/1); without it the child says when they're done. */
  bridge: boolean;
  /** Notes kept for the parent (README.md, 课程设计.md, 验收结果.md …). */
  docs: string[];
  sha256: string; bytes: number; files: number;
  /** The zip's file name, for the parent. */
  source_name: string;
  warnings: string[];
  /** The published version this one replaces in the automatic schedule. */
  replaces: string | null;
  imported_at: string; published_at?: string;
}

/** exploration.json, all fields optional: a package made before the Skill knew the App still imports. */
interface Manifest { format?: string; id?: string; version?: string; title?: string; for_child?: string; grade?: number; concept?: string; subjects?: string[]; minutes?: number; summary?: string; entry?: string }

/** Zips made on a Mac often store UTF-8 names without saying so; read them back as UTF-8. */
const fixName = (n: string) => {
  if (!/[\u0080-ÿ]/.test(n) || /[^\u0000-ÿ]/.test(n)) return n;
  const u = Buffer.from(n, 'latin1').toString('utf8');
  return u.includes('�') ? n : u;
};
const safePath = (p: string) => !!p && !p.startsWith('/') && !p.split('/').some(s => s === '..' || s === '') && !/[\\\0]/.test(p);
const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const bump = (v: string) => { const [a, b] = v.split('.').map(Number); return `${a}.${b + 1}`; };
const newer = (a: string, b: string) => { const [x, y] = a.split('.').map(Number), [p, q] = b.split('.').map(Number); return x !== p ? x > p : y > q; };

/** Reads a package zip: where the built page is, what it is called, and the files to keep. Throws HttpError for the parent. */
export function readPackage(zip: Uint8Array) {
  const names: { raw: string; name: string; size: number }[] = [];
  try { unzipSync(zip, { filter: f => { names.push({ raw: f.name, name: fixName(f.name), size: f.originalSize }); return false; } }); }
  catch { fail(400, '打不开这个文件：要选课程包 .zip'); }
  const files = names.filter(f => !f.name.endsWith('/') && !/(^|\/)(__MACOSX|node_modules|\.git)\//.test(f.name) && !/(^|\/)\.DS_Store$/.test(f.name));
  if (files.some(f => !safePath(f.name))) fail(400, '课程包里有不安全的文件路径，没有导入');
  const has = new Set(files.map(f => f.name));
  // the package folder: where exploration.json is, else the shallowest built page (web/dist, site, dist, or the page itself)
  const depth = (p: string) => p.split('/').length;
  const manifests = files.filter(f => /(^|\/)exploration\.json$/.test(f.name)).sort((a, b) => depth(a.name) - depth(b.name));
  const pages = ['web/dist/index.html', 'site/index.html', 'dist/index.html', 'index.html'];
  let base = '', manifest: Manifest = {};
  if (manifests.length) {
    base = manifests[0].name.slice(0, -'exploration.json'.length);
    try { manifest = JSON.parse(Buffer.from(extract(zip, [manifests[0].raw])[manifests[0].raw]).toString('utf8')); } catch { fail(400, 'exploration.json 不是合法的 JSON'); }
  } else {
    const found = files.map(f => f.name).filter(n => pages.some(p => n === p || n.endsWith('/' + p)))
      .sort((a, b) => pages.findIndex(p => a.endsWith(p)) - pages.findIndex(p => b.endsWith(p)) || depth(a) - depth(b))[0];
    if (!found) fail(400, '课程包里没有找到网页（web/dist/index.html）。请让做课的 AI 先构建（pnpm build）再打包');
    base = found!.slice(0, found!.length - pages.find(p => found!.endsWith(p))!.length);
  }
  const entry = manifest.entry && safePath(manifest.entry) && has.has(base + manifest.entry) ? manifest.entry : pages.find(p => has.has(base + p));
  if (!entry) fail(400, '课程包里没有找到网页（web/dist/index.html）。请让做课的 AI 先构建（pnpm build）再打包');
  const siteDir = posix.join(base || '.', posix.dirname(entry!)).replace(/^\.$/, '');
  const prefix = siteDir ? siteDir + '/' : '';
  const site = files.filter(f => f.name.startsWith(prefix));
  const docs = files.filter(f => f.name.startsWith(base) && !f.name.startsWith(prefix) && DOC.test(f.name.slice(base.length)));
  const bytes = site.reduce((a, f) => a + f.size, 0);
  if (site.length > MAX_FILES || bytes > MAX_SITE) fail(413, `网页太大（${Math.round(bytes / 1048576)} MB，${site.length} 个文件），平板打不开；请让做课的 AI 压缩模型和贴图`);
  const out = extract(zip, [...site, ...docs].map(f => f.raw));
  const byName = new Map([...site, ...docs].map(f => [f.name, out[f.raw]]));
  const html = Buffer.from(byName.get(base + entry!) ?? new Uint8Array()).toString('utf8');
  if (/<script[^>]+src=["']\/?src\/[^"']+\.(m?js|ts)["']/.test(html)) fail(400, '这是没构建的源码页面（引用 /src/…），请让做课的 AI 先构建（pnpm build），把 web/dist 打进包里');
  const bridge = site.some(f => /\.(m?js|html)$/.test(f.name) && Buffer.from(byName.get(f.name)!).includes('explore/1'));
  const warnings: string[] = [];
  if (!bridge) warnings.push('这节课没接 App 的进度接口：App 不知道孩子做到哪；孩子退出时自己选“学完了”还是“下次接着上”。');
  if (/(src|href)=["']\/(?!\/)/.test(html)) warnings.push('网页里用的是绝对路径（/assets/…）。App 会自动转接，一般能打开；以后请让做课的 AI 用相对路径构建（vite 的 base: "./"）。');
  if (bytes > 150 * 1048576) warnings.push(`网页有 ${Math.round(bytes / 1048576)} MB，平板第一次打开会比较慢。`);
  const title = String(manifest.title ?? '').trim() || /<title>([^<]+)<\/title>/i.exec(html)?.[1]?.trim() || base.replace(/\/$/, '').split('/').pop() || '探索课';
  let pkgName = '';
  for (const p of [base + 'web/package.json', base + 'package.json']) if (has.has(p)) {
    try { pkgName = JSON.parse(Buffer.from(extract(zip, [names.find(n => n.name === p)!.raw])[names.find(n => n.name === p)!.raw]).toString('utf8')).name ?? ''; } catch { /* no name */ }
    if (pkgName) break;
  }
  const digest = sha(Buffer.concat([...site, ...docs].sort((a, b) => a.name.localeCompare(b.name)).flatMap(f => [Buffer.from(f.name.slice(base.length) + '\0'), Buffer.from(byName.get(f.name)!)])));
  return {
    manifest, title: title.slice(0, 80), pkgName, folder: base.replace(/\/$/, '').split('/').pop() ?? '', digest, bytes, warnings, bridge,
    site: site.map(f => ({ path: f.name.slice(prefix.length), data: byName.get(f.name)! })),
    docs: docs.map(f => ({ path: f.name.slice(base.length), data: byName.get(f.name)! })),
  };
}
function extract(zip: Uint8Array, raw: string[]) {
  const want = new Set(raw);
  try { return unzipSync(zip, { filter: f => want.has(f.name) }); } catch { return fail(400, '课程包有损坏的文件，没有导入'); }
}

interface Deps {
  store: Store; dir: string; iso: () => string;
  parent: RouteShorthandOptions; agentOrParent: RouteShorthandOptions;
  childParam: (v: unknown) => string;
}

export async function exploreRoutes(app: FastifyInstance, d: Deps) {
  const { store, dir, iso } = d;
  mkdirSync(dir, { recursive: true });
  await app.register(fastifyStatic, { root: dir, serve: false });
  const folder = (key: string) => join(dir, key);
  const drafts = () => store.exploreDrafts<Exploration>();
  const known = (key: string) => !!store.exploration(key) || drafts().some(x => x.key === key);

  app.addContentTypeParser(['application/zip', 'application/x-zip-compressed'], { parseAs: 'buffer', bodyLimit: MAX_ZIP }, (_req, body, done) => done(null, body));
  /** The parent (or an AI assistant the parent let in) hands in a package; it waits for review. */
  app.post('/v1/explore/import', { ...d.agentOrParent, bodyLimit: MAX_ZIP }, async (req, reply) => {
    const q = req.query as { child?: string; name?: string };
    if (!Buffer.isBuffer(req.body)) fail(415, '要上传课程包 .zip');
    const pkg = readPackage(new Uint8Array(req.body as Buffer));
    const m = pkg.manifest;
    const kids = store.children();
    // who it's for: the parent's pick, else the package's, else the grade its name says (四年级 → the grade-4 child)
    const named = /([一二三四五六])年级/.exec(`${pkg.title} ${pkg.folder} ${q.name ?? ''}`)?.[1];
    const grade = Number(m.grade) || (named ? '一二三四五六'.indexOf(named) + 1 : 0);
    const child = q.child ? d.childParam(q.child) : m.for_child && store.hasChild(m.for_child) ? m.for_child : kids.find(k => k.grade === grade)?.id ?? fail(400, '选一下这节课给谁');
    const lessonId = /^X-[A-Za-z0-9-]{1,48}$/.test(m.id ?? '') ? m.id! : `X-${slug(m.id ?? '') || slug(pkg.pkgName) || pkg.digest.slice(0, 8)}`;
    const published = store.lessons().filter(l => l.lesson_id === lessonId);
    const same = published.find(l => l.content_hash === pkg.digest);
    if (same) fail(409, `这个课程包和已发布的「${same.title}」（${same.key}）完全一样，不用再导入`);
    const rows = drafts().filter(x => x.key.startsWith(lessonId + '@'));
    // a newer package of a lesson still waiting replaces it; versions published or declined stay taken
    const taken = [...published.map(l => l.version), ...rows.filter(x => x.status === '不采用').map(x => x.meta.version)];
    let version = /^\d+\.\d+$/.test(m.version ?? '') ? m.version! : '1.0';
    for (const v of taken) if (!newer(version, v)) version = bump(v);
    const key = `${lessonId}@${version}`;
    for (const x of rows.filter(x => x.status !== '不采用')) { store.deleteExploreDraft(x.key); rmSync(folder(x.key), { recursive: true, force: true }); }
    const x: Exploration = {
      format: BRIDGE, lesson_id: lessonId, version, title: pkg.title, for_child: child,
      concept: String(m.concept ?? '').slice(0, 80), subjects: Array.isArray(m.subjects) ? m.subjects.map(String).slice(0, 8) : [],
      minutes: Number(m.minutes) > 0 ? Math.round(Number(m.minutes)) : null, summary: String(m.summary ?? '').slice(0, 600),
      bridge: pkg.bridge, docs: pkg.docs.filter(f => f.path.endsWith('.md')).map(f => f.path), sha256: pkg.digest, bytes: pkg.bytes, files: pkg.site.length,
      source_name: String(q.name ?? '').slice(0, 120), warnings: pkg.warnings,
      replaces: published.sort((a, b) => (newer(a.version, b.version) ? -1 : 1))[0]?.key ?? null, imported_at: iso(),
    };
    // written next to the final place first, so a half-written package never shows
    const tmp = `${folder(key)}.part`;
    rmSync(tmp, { recursive: true, force: true });
    for (const f of pkg.site) { const p = join(tmp, 'site', f.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.data); }
    for (const f of pkg.docs) { const p = join(tmp, 'docs', f.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.data); }
    rmSync(folder(key), { recursive: true, force: true });
    renameSync(tmp, folder(key));
    store.upsertExploreDraft(x, req.who ?? '家长', iso());
    return reply.code(201).send({ key, status: '待审核', ...x });
  });

  app.get('/v1/explore', d.parent, async () => drafts().map(r => ({ ...r.meta, key: r.key, status: r.status, note: r.note, imported_by: r.imported_by })));
  const row = (req: FastifyRequest) => { const key = (req.params as { key: string }).key; return drafts().find(x => x.key === key) ?? fail(404, '没有这节待审核的探索课'); };
  app.post('/v1/explore/:key/approve', d.parent, async (req, reply) => {
    const r = row(req);
    if (r.status !== '待审核') fail(409, r.status === '不采用' ? '这节课在“没采用的课”里，先放回审核' : '这节课退回修改了，等新的课程包');
    if (!(req.body as { previewed?: unknown } | undefined)?.previewed) fail(400, '先预览一遍，再勾上“我预览过了”');
    if (store.lessons().some(l => l.key === r.key)) fail(409, `${r.key} 已经发布过了`);
    store.tx(() => { store.addExploration({ ...r.meta, published_at: iso() }); store.deleteExploreDraft(r.key); });
    return reply.code(201).send({ key: r.key, status: '已发布' });
  });
  app.post('/v1/explore/:key/reject', d.parent, async (req) => {
    const r = row(req);
    const note = String((req.body as { note?: unknown } | undefined)?.note ?? '').trim().slice(0, 1000);
    if (!note) fail(400, '写一句要改什么');
    store.setExploreStatus(r.key, '已退回', note);
    return { ok: true };
  });
  app.post('/v1/explore/:key/discard', d.parent, async (req) => {
    const r = row(req);
    if (r.status === '不采用') fail(409, '这节课已经不采用了');
    store.setExploreStatus(r.key, '不采用', String((req.body as { reason?: unknown } | undefined)?.reason ?? '').trim().slice(0, 1000) || null);
    return { ok: true };
  });
  app.post('/v1/explore/:key/restore', d.parent, async (req) => {
    const r = row(req);
    if (r.status !== '不采用') fail(409, '这节课不在“没采用的课”里');
    store.setExploreStatus(r.key, '待审核' as ExploreStatus, null);
    return { ok: true };
  });
  /** The package's own notes (课程设计、验收结果…) for the parent to read before deciding. */
  app.get('/v1/explore/:key/docs/*', d.parent, async (req, reply) => {
    const { key, '*': rest } = req.params as { key: string; '*': string };
    if (!known(key) || !safePath(rest) || !rest.endsWith('.md')) fail(404, '没有这份说明');
    const p = join(folder(key), 'docs', rest);
    if (!existsSync(p)) fail(404, '没有这份说明');
    return reply.type('text/markdown; charset=utf-8').send(readFileSync(p, 'utf8'));
  });

  // The pages themselves. No login: a frame can't send one, and nothing here is about the children.
  const send = (reply: FastifyReply, key: string, rest: string) => {
    const site = join(folder(key), 'site');
    let file = rest === '' || rest.endsWith('/') ? `${rest}index.html` : rest;
    if (!safePath(file)) return fail(404, '没有这个文件');
    if (existsSync(join(site, file)) && statSync(join(site, file)).isDirectory()) file += '/index.html';
    if (!existsSync(join(site, file))) return fail(404, '没有这个文件');
    return reply.header('cache-control', store.exploration(key) ? 'public, max-age=86400' : 'no-cache').sendFile(file, site);
  };
  app.get('/explore/:key', async (req, reply) => reply.redirect(`/explore/${encodeURIComponent((req.params as { key: string }).key)}/`));
  app.get('/explore/:key/*', async (req, reply) => {
    const { key, '*': rest } = req.params as { key: string; '*': string };
    if (!known(key)) fail(404, '没有这节探索课');
    return send(reply, key, decodeURIComponent(rest));
  });
  // A package built with absolute paths asks for /assets/… at the server's root: answer from the lesson it came from.
  app.setNotFoundHandler(async (req, reply) => {
    const from = /^\/explore\/([^/]+)\//.exec(new URL(String(req.headers.referer ?? ''), 'http://x').pathname)?.[1];
    const path = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '');
    if (req.method === 'GET' && from && known(decodeURIComponent(from)) && safePath(path) && existsSync(join(folder(decodeURIComponent(from)), 'site', path))) return send(reply, decodeURIComponent(from), path);
    return reply.code(404).send({ error: '没有这个地址' });
  });

  return {
    /** For the Pad: how to open a published 探索课. */
    forPad: (key: string) => { const x = store.exploration<Exploration>(key); return x && { kind: 'explore' as const, key, title: x.title, for_child: x.for_child, concept: x.concept, url: `/explore/${key}/`, bridge: x.bridge, minutes: x.minutes }; },
    /** Folders of packages nobody refers to any more (a replaced draft whose removal was interrupted). */
    tidy: () => { for (const n of readdirSync(dir)) if (n.endsWith('.part') || !known(n)) rmSync(join(dir, n), { recursive: true, force: true }); },
  };
}
