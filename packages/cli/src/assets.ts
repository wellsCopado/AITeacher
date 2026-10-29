// Acceptance checks for 3D assets (skills/photoreal-3d-production/reference/acceptance.md): what a machine can
// check before the parent looks. A5 reads the scene code; A1–A4 and A6–A7 read one asset's files and manifest.
// The comparison sheet (B) puts our renders next to the real photos, for the parent's 素材确认.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, relative } from 'node:path';
import { bareMaterials, GlbError, glbStats, parseGlb, type GlbStats } from './glb.js';
import { readJson } from './lib.js';

// ---- A5: no complex object drawn from code ----
export interface AllowEntry { geometry: string; what: string; class: '简单几何件' | '数学标注' | '隐形碰撞面' | '环境（不显示）' | '待替换'; gap?: string }
export interface GeometryLint {
  /** Geometry used in a file with nothing on the allowlist saying what it is: A5 fails, write it down or replace it. */
  unlisted: { file: string; geometry: string; lines: number[] }[];
  /** Allowlist entries for geometry the file no longer uses: delete them. */
  stale: { file: string; geometry: string }[];
  /** Complex objects still drawn from code, each waiting for its replacement in gaps.md. */
  pending: { file: string; geometry: string; what: string; gap: string }[];
}
const GEOMETRY = /\b([A-Z][A-Za-z0-9]*Geometry)\s*\(/g;

export function geometryLint(root: string): GeometryLint {
  const dir = join(root, 'packages', 'components', 'src');
  const allow = readJson<Record<string, AllowEntry[] | string>>(join(dir, 'simple-geometry.allow.json'));
  const out: GeometryLint = { unlisted: [], stale: [], pending: [] };
  const files = readdirSync(dir).filter(f => /\.(js|ts)$/.test(f));
  for (const file of files) {
    const used = new Map<string, number[]>();
    readFileSync(join(dir, file), 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(GEOMETRY)) used.set(m[1], [...(used.get(m[1]) ?? []), i + 1]);
    });
    const entries = Array.isArray(allow[file]) ? allow[file] as AllowEntry[] : [];
    const whole = entries.find(e => e.geometry === '*');
    for (const [geometry, lines] of used) if (!whole && !entries.some(e => e.geometry === geometry)) out.unlisted.push({ file, geometry, lines });
    for (const e of entries) {
      if (e.geometry !== '*' && !used.has(e.geometry)) out.stale.push({ file, geometry: e.geometry });
      else if (e.class === '待替换') out.pending.push({ file, geometry: e.geometry, what: e.what, gap: e.gap ?? '?' });
    }
  }
  for (const file of Object.keys(allow)) if (!file.startsWith('_') && !files.includes(file)) out.stale.push({ file, geometry: '*' });
  return out;
}

// ---- A1–A4, A6, A7: one asset ----
export interface Check { id: string; name: string; ok: boolean | null; detail: string }
interface Manifest {
  source_url?: string; author?: string; license?: string; license_url?: string; downloaded_at?: string; sha256?: string;
  generator?: string | null; reference_photos?: { file?: string; source?: string; angle?: string }[];
  real_scale_m?: Record<string, number>; subject_facts?: unknown[]; motion_refs?: unknown[];
  files?: Record<string, { sha256: string }>;
  /** Budgets of the scene this asset goes into, if tighter than the iPad defaults. */
  budget?: { triangles?: number; drawCalls?: number; textureMB?: number; fileMB?: number };
  stats?: GlbStats; checks?: { at: string; results: Check[] };
}
/** The iPad budget (component-contract.md 3) for everything on screen; one asset may use at most this. */
export const BUDGET = { triangles: 1_000_000, drawCalls: 150, textureMB: 256, fileMB: 40 };

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export function assetDir(root: string, id: string) { return join(root, 'content', 'assets', id); }
/** The model files of an asset folder: model.glb first, then its LODs and any other GLB. */
export function modelFiles(dir: string) {
  return existsSync(dir) ? readdirSync(dir).filter(f => extname(f) === '.glb').sort((a, b) => (a === 'model.glb' ? -1 : b === 'model.glb' ? 1 : a.localeCompare(b))) : [];
}

export async function assetCheck(root: string, id: string, opts: { validator?: (bytes: Uint8Array) => Promise<{ errors: number; messages: string[] }> | null } = {}) {
  const dir = assetDir(root, id);
  const reg = readJson<{ asset_id: string; license?: string; source?: string; file?: { path: string; sha256: string } | null }[]>(join(root, 'content', 'assets', 'registry.json')).find(a => a.asset_id === id);
  const mp = join(dir, 'manifest.json');
  const manifest: Manifest = existsSync(mp) ? readJson(mp) : {};
  const results: Check[] = [];
  const add = (id: string, name: string, ok: boolean | null, detail: string) => results.push({ id, name, ok, detail });
  const models = modelFiles(dir);
  if (!reg && !existsSync(mp)) throw new Error(`资产库和 content/assets/${id}/ 里都没有 ${id}`);
  const file = models[0];
  let parsed: ReturnType<typeof parseGlb> | null = null, stats: GlbStats | null = null, bytes: Buffer | null = null;
  if (!file) add('A1', 'GLB 文件有效', false, `content/assets/${id}/ 里没有 .glb 模型文件`);
  else {
    bytes = readFileSync(join(dir, file));
    try {
      parsed = parseGlb(bytes); stats = glbStats(parsed);
      const v = await (opts.validator ?? khronos)(new Uint8Array(bytes));
      if (!v) add('A1', 'GLB 文件有效', true, `${file}：结构正确（没装 Khronos glTF Validator，完整检查要先 pnpm add -D gltf-validator）`);
      else add('A1', 'GLB 文件有效', v.errors === 0, v.errors === 0 ? `${file}：Khronos glTF Validator 0 个错误` : `${file}：${v.errors} 个错误：${v.messages.slice(0, 5).join('；')}`);
    } catch (e) {
      if (!(e instanceof GlbError)) throw e;
      add('A1', 'GLB 文件有效', false, `${file}：${e.message}`);
    }
  }
  if (parsed) {
    const bare = bareMaterials(parsed.json);
    add('A2', '主角材质都有底色、法线、ORM 贴图', parsed.json.materials?.length ? bare.length === 0 : false,
      !parsed.json.materials?.length ? '模型没有材质' : bare.length ? bare.map(m => `${m.name} 缺${m.missing.join('、')}`).join('；') : `${parsed.json.materials.length} 个材质都有三张贴图`);
  } else add('A2', '主角材质都有底色、法线、ORM 贴图', null, '没有能读的模型');
  const real = Object.values(manifest.real_scale_m ?? {}).filter(n => typeof n === 'number' && n > 0);
  if (!stats?.size) add('A3', '尺寸和登记的真实尺寸相差 ≤ 5%', null, '没有能读的模型');
  else if (!real.length) add('A3', '尺寸和登记的真实尺寸相差 ≤ 5%', false, `模型最大边 ${Math.max(...stats.size)} 米；manifest.json 没有 real_scale_m（真实尺寸，米）`);
  else {
    const got = Math.max(...stats.size), want = Math.max(...real), off = Math.abs(got - want) / want;
    add('A3', '尺寸和登记的真实尺寸相差 ≤ 5%', off <= 0.05, `模型 ${stats.size.join(' × ')} 米，最大边 ${got} 米；登记 ${want} 米，相差 ${Math.round(off * 1000) / 10}%`);
  }
  if (stats && bytes) {
    const b = { ...BUDGET, ...manifest.budget }, mb = Math.round(bytes.length / 1024 / 1024 * 10) / 10, over: string[] = [];
    if (stats.triangles > b.triangles) over.push(`三角形 ${stats.triangles} > ${b.triangles}`);
    if (stats.drawCalls > b.drawCalls) over.push(`绘制调用 ${stats.drawCalls} > ${b.drawCalls}`);
    if (stats.textureMB > b.textureMB) over.push(`贴图显存约 ${stats.textureMB} MB > ${b.textureMB} MB`);
    if (mb > b.fileMB) over.push(`文件 ${mb} MB > ${b.fileMB} MB`);
    add('A4', '在 iPad 预算内', over.length === 0, over.length ? over.join('；') : `三角形 ${stats.triangles}，绘制调用 ${stats.drawCalls}，贴图约 ${stats.textureMB} MB，文件 ${mb} MB`);
  } else add('A4', '在 iPad 预算内', null, '没有能读的模型');
  const lint = geometryLint(root);
  add('A5', '没有代码拼的复杂物体', lint.unlisted.length === 0 && lint.pending.length === 0,
    [lint.unlisted.length && `白名单里没写的几何体 ${lint.unlisted.length} 处：${lint.unlisted.map(u => `${u.file} ${u.geometry}（第 ${u.lines.join('、')} 行）`).join('；')}`,
      lint.pending.length && `还有 ${lint.pending.length} 处代码拼的复杂物体等着替换：${[...new Set(lint.pending.map(p => `${p.file}（${p.gap}）`))].join('、')}`].filter(Boolean).join('。') || '场景代码里只有白名单登记过的简单几何件');
  const missing = [
    !manifest.source_url && !reg?.source && '来源网址', !manifest.author && '作者', !(manifest.license ?? reg?.license) && '许可', !manifest.downloaded_at && '下载日期',
    !manifest.subject_facts?.length && '形态核对依据（subject_facts）',
  ].filter(Boolean) as string[];
  const shaWant = manifest.files?.[file ?? '']?.sha256 ?? manifest.sha256 ?? (reg?.file && file && reg.file.path.endsWith(file) ? reg.file.sha256 : undefined);
  if (bytes && !shaWant) missing.push('sha256');
  const shaBad = bytes && shaWant && shaWant.replace(/^sha256:/, '') !== sha256(bytes);
  const refs = (manifest.reference_photos ?? []).length;
  if (manifest.generator && refs < 3) missing.push(`参考照片（AI 生成的要 ≥ 3 张，现在 ${refs} 张）`);
  add('A6', '登记完整', missing.length === 0 && !shaBad, [missing.length && `缺：${missing.join('、')}`, shaBad && `${file} 的 sha256 和登记的不一样（文件被换过）`].filter(Boolean).join('；') || `来源、作者、许可、日期、sha256、形态依据都有${manifest.generator ? `；AI 生成（${manifest.generator}），${refs} 张参考照片` : ''}`);
  if (!stats) add('A7', '动作有依据', null, '没有能读的模型');
  else if (!stats.animations) add('A7', '动作有依据', null, '模型里没有动画（动作在组件代码里的，看组件测试）');
  else add('A7', '动作有依据', !!manifest.motion_refs?.length, manifest.motion_refs?.length ? `${stats.animations} 段动画，动作依据 ${manifest.motion_refs.length} 条；关节限位和速度要按厂家数据表人工核对` : `${stats.animations} 段动画，manifest.json 没有 motion_refs（真实视频或厂家数据）`);
  add('A8', '数学一致', null, '组件单元测试里查（pnpm test）');
  add('A9', '测试全部通过', null, '跑 pnpm test、pnpm typecheck、pnpm e2e:apps');
  return { asset_id: id, file: file ?? null, stats, ok: results.every(r => r.ok !== false), results, manifest: existsSync(mp) ? relative(root, mp) : null };
}

/** The Khronos glTF Validator, when it is installed (pnpm add -D gltf-validator); null otherwise. */
async function khronos(bytes: Uint8Array) {
  let v: { validateBytes(b: Uint8Array, o?: object): Promise<{ issues: { numErrors: number; messages: { severity: number; code: string; message: string; pointer?: string }[] } }> };
  try { v = createRequire(import.meta.url)('gltf-validator'); } catch { return null; }
  const r = await v.validateBytes(bytes, { maxIssues: 50 });
  return { errors: r.issues.numErrors, messages: r.issues.messages.filter(m => m.severity === 0).map(m => `${m.code} ${m.message}${m.pointer ? `（${m.pointer}）` : ''}`) };
}

/** Write the latest check into manifest.json (`stats`, `checks`), so the parent app and the next agent see it. */
export function saveChecks(root: string, r: Awaited<ReturnType<typeof assetCheck>>, at: string) {
  const mp = join(assetDir(root, r.asset_id), 'manifest.json');
  const m: Manifest = existsSync(mp) ? readJson(mp) : {};
  writeFileSync(mp, JSON.stringify({ ...m, ...(r.stats ? { stats: r.stats } : {}), checks: { at, results: r.results } }, null, 2) + '\n');
}

// ---- B: the comparison sheet ----
const VIEWS = [
  { name: '3/4 前侧', az: -0.65, el: 0.32, zoom: 1 },
  { name: '正侧', az: Math.PI / 2, el: 0.04, zoom: 1 },
  { name: '俯视', az: 0, el: Math.PI / 2 - 0.02, zoom: 1 },
  { name: '特写', az: -0.4, el: 0.25, zoom: 0.5 },
];
const MIME: Record<string, string> = { '.js': 'text/javascript', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.html': 'text/html' };

/**
 * Render the asset from the four views of acceptance.md B and put each next to the real photo taken from that
 * angle (manifest reference_photos[].angle, else in order), into content/assets/<id>/sheet.png.
 * Studio light, not the lesson's: the lesson's light is checked in the preview, next to this sheet.
 */
export async function assetSheet(root: string, id: string, opts: { out?: string; title?: string } = {}) {
  const dir = assetDir(root, id), file = modelFiles(dir)[0];
  if (!file) throw new Error(`content/assets/${id}/ 里没有 .glb 模型文件`);
  const manifest: Manifest = existsSync(join(dir, 'manifest.json')) ? readJson(join(dir, 'manifest.json')) : {};
  const photos = (manifest.reference_photos ?? []).filter(p => p.file && existsSync(join(dir, p.file)));
  const pick = (v: string, i: number) => photos.find(p => p.angle === v) ?? photos.filter(p => !VIEWS.some(x => x.name === p.angle))[i] ?? null;
  let chromium: { launch(o?: object): Promise<any> };
  try { ({ chromium } = createRequire(join(root, 'package.json'))('playwright')); }
  catch { throw new Error('出对照图要用 Playwright：先运行 pnpm dlx playwright install chromium（并 pnpm add -D playwright）'); }
  const three = join(root, 'node_modules', 'three');
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#fff;font:15px -apple-system,"PingFang SC",sans-serif;color:#222}#sheet{padding:16px;width:1080px}
    h1{font-size:18px;margin:0 0 4px}.sub{color:#666;margin:0 0 12px}.row{display:grid;grid-template-columns:120px 470px 470px;gap:10px;align-items:center;margin-bottom:10px}
    canvas,img,.none{width:470px;height:352px;object-fit:cover;background:#808080;border-radius:6px}.none{display:flex;align-items:center;justify-content:center;background:#eee;color:#b00}
    .h{font-weight:600;color:#444}</style><div id="sheet"><h1>${opts.title ?? id} · 对照图</h1>
    <p class="sub">左：我们的渲染（${file}，工作室光照，课里的光照看预览）；右：同角度的真实照片。家长在「素材确认」里看它判断像不像。</p>
    <div class="row h"><span></span><span>我们的渲染</span><span>真实照片</span></div>
    ${VIEWS.map((v, i) => { const p = pick(v.name, i); return `<div class="row"><b>${v.name}</b><canvas data-v="${i}" width="940" height="704"></canvas>${p ? `<img src="/asset/${encodeURI(p.file!)}">` : '<div class="none">缺这个角度的参考照片</div>'}</div>`; }).join('')}</div>
    <script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
    <script type="module">
      import * as THREE from 'three';
      import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
      import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
      const views = ${JSON.stringify(VIEWS)};
      const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); r.setSize(940, 704, false);
      r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.ACESFilmicToneMapping; r.shadowMap.enabled = true;
      const scene = new THREE.Scene(); scene.background = new THREE.Color(0x808080);
      scene.environment = new THREE.PMREMGenerator(r).fromScene(new RoomEnvironment(), 0.04).texture;
      const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(3, 5, 4); sun.castShadow = true; scene.add(sun);
      const gltf = await new GLTFLoader().loadAsync('/asset/${encodeURI(file)}'); scene.add(gltf.scene);
      const box = new THREE.Box3().setFromObject(gltf.scene), c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3()).length();
      const cam = new THREE.PerspectiveCamera(35, 940 / 704, s / 100, s * 20);
      views.forEach((v, i) => {
        const d = s * 1.9 * v.zoom; // the whole model in frame: half its diagonal over sin(half the field of view), with a margin
        cam.position.set(c.x + d * Math.cos(v.el) * Math.sin(v.az), c.y + d * Math.sin(v.el), c.z + d * Math.cos(v.el) * Math.cos(v.az)); cam.lookAt(c);
        r.render(scene, cam);
        document.querySelector('[data-v="' + i + '"]').getContext('2d').drawImage(r.domElement, 0, 0);
      });
      await Promise.all([...document.images].map(i => i.complete ? null : new Promise(ok => { i.onload = i.onerror = ok; })));
      document.body.dataset.done = '1';
    </script>`;
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  try {
    const page = await b.newPage({ viewport: { width: 1112, height: 800 }, deviceScaleFactor: 1 });
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));
    // everything comes from disk: three.js from node_modules, the model and photos from the asset folder
    await page.route('http://sheet.local/**', async (route: any) => {
      const p = decodeURI(new URL(route.request().url()).pathname);
      const f = p === '/' ? null : p.startsWith('/three/') ? join(three, p.slice(7)) : p.startsWith('/asset/') ? join(dir, p.slice(7)) : null;
      if (p === '/') return route.fulfill({ contentType: 'text/html', body: html });
      if (!f || !f.startsWith(p.startsWith('/three/') ? three : dir) || !existsSync(f) || !statSync(f).isFile()) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ contentType: MIME[extname(f).toLowerCase()] ?? 'application/octet-stream', body: readFileSync(f) });
    });
    await page.goto('http://sheet.local/');
    await page.waitForSelector('body[data-done="1"]', { timeout: 120_000 }).catch(() => { throw new Error(`渲染没完成：${errors.join('；') || '超时'}`); });
    const out = opts.out ?? join(dir, 'sheet.png');
    await (await page.$('#sheet')).screenshot({ path: out });
    return { out, views: VIEWS.map((v, i) => ({ view: v.name, photo: pick(v.name, i)?.file ?? null })) };
  } finally { await b.close(); }
}
