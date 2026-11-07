// 主角能不能当真看 (parent: “改成真实写实…要根据主题去生产3d”). The App's side of the 探索课 Skill's hero gate
// (skills/discovery-lesson-maker/scripts/hero_check.py, references/hero-production.md): what kind of thing the hero is,
// where it may come from, real photos and real size, enough detail and real textures, and a blind look by someone who
// did not make it. Passing proves it is not code-built or flat-coloured; whether it looks real is the parent's call.
import { glbStats, parseGlb } from '../../../packages/cli/src/glb.js';

export const CLASSES: Record<string, string> = {
  organism: '动物、昆虫、植物等生物', human: '人', machine: '机器、机器人、机械臂', vehicle: '车、船、飞机、火箭',
  structure: '建筑、桥、隧道、塔', landform: '山、火山、峡谷等地形', object: '工具、器物等小物件',
};
const MADE = ['scan', 'cc0-library', 'licensed', 'generated'];
const ROUTES: Record<string, string[]> = {
  organism: MADE, human: MADE, machine: [...MADE, 'cad', 'modeled'], vehicle: [...MADE, 'cad', 'modeled'],
  structure: [...MADE, 'cad', 'modeled'], landform: [...MADE, 'modeled', 'procedural'], object: [...MADE, 'cad', 'modeled'],
};
const MIN_TRIANGLES: Record<string, number> = { organism: 15000, human: 20000, machine: 12000, vehicle: 12000, structure: 8000, landform: 8000, object: 4000 };
const MIN_TEXTURE_PX = 1024, MIN_TEXTURED_SHARE = 0.8, SIZE_TOLERANCE = 0.1;
const VERDICTS: Record<string, string> = { photo: '像照片', cg: '看得出是电脑画面', cartoon: '像动画片', toy: '像玩具或模型' };

export interface HeroItem {
  file?: string; class?: string; origin?: string; how?: string; source_url?: string; generator?: string;
  real_size_m?: number | Record<string, number>; reference_photos?: { source?: string; angle?: string }[];
}
export interface HeroFacts { triangles: number; texturedShare: number; colorTexturePx: number; detailMaps: boolean; sizeM: number[] }

/** What the hero gate needs from a .glb (packages/cli/src/glb.ts reads it; no geometry decoding, so Draco/meshopt work too). Throws when it isn't one. */
export function inspectGlb(data: Uint8Array): HeroFacts {
  const glb = parseGlb(Buffer.from(data.buffer, data.byteOffset, data.byteLength)), { json } = glb, stats = glbStats(glb);
  const tex = new Map(stats.textures.map(t => [t.index, t]));
  const colorPx = Math.max(0, ...(json.materials ?? []).map(m => {
    const t = tex.get(m.pbrMetallicRoughness?.baseColorTexture?.index ?? -1);
    return t ? Math.max(t.w ?? 0, t.h ?? 0) : 0;
  }));
  const detail = (json.materials ?? []).some(m => m.normalTexture || m.pbrMetallicRoughness?.metallicRoughnessTexture);
  let all = 0, textured = 0;
  for (const mesh of json.meshes ?? []) for (const p of mesh.primitives) {
    if ((p.mode ?? 4) !== 4) continue;
    const n = Math.floor((p.indices !== undefined ? json.accessors?.[p.indices]?.count : json.accessors?.[p.attributes.POSITION]?.count ?? 0) ?? 0) / 3;
    all += n;
    if (p.attributes.TEXCOORD_0 !== undefined && json.materials?.[p.material ?? -1]?.pbrMetallicRoughness?.baseColorTexture) textured += n;
  }
  return { triangles: stats.triangles, texturedShare: all ? textured / all : 0, colorTexturePx: colorPx, detailMaps: detail, sizeM: stats.size ?? [0, 0, 0] };
}

const realSize = (r: HeroItem['real_size_m']) => typeof r === 'number' ? r : r && typeof r === 'object' ? Math.max(0, ...Object.values(r).filter(v => typeof v === 'number' && v > 0)) || 0 : 0;

/** H1–H6 for one hero and its .glb bytes (undefined when the file isn't in the package). */
export function checkHero(it: HeroItem, data: Uint8Array | undefined): string[] {
  const label = it.file || '主角', e: string[] = [];
  const cls = it.class && CLASSES[it.class] ? it.class : '';
  if (!cls) e.push(`主角 ${label} 没写 class（是哪一类东西：${Object.keys(CLASSES).join('/')}）`);
  if (cls && !ROUTES[cls].includes(String(it.origin))) e.push(cls === 'organism' || cls === 'human'
    ? `主角 ${label} 是${CLASSES[cls]}，origin「${it.origin}」不行：动物和人只能来自实物扫描、授权素材，或依据真实照片生成后修整，不能手工或程序建模`
    : `主角 ${label} 的 origin「${it.origin}」不行：允许 ${ROUTES[cls].join('/')}`);
  const refs = (it.reference_photos ?? []).filter(r => r && String(r.source ?? '').trim() && String(r.angle ?? '').trim());
  if (refs.length < 3 || new Set(refs.map(r => String(r.angle).trim())).size < 3) e.push(`主角 ${label} 要有至少 3 张不同角度的真实照片（reference_photos）`);
  if (['scan', 'cad', 'cc0-library', 'licensed'].includes(String(it.origin)) && !String(it.source_url ?? '').trim()) e.push(`主角 ${label} 来自 ${it.origin}，要写 source_url`);
  if (it.origin === 'generated' && !String(it.generator ?? '').trim()) e.push(`主角 ${label} 是 AI 生成的，要写 generator`);
  const real = realSize(it.real_size_m);
  if (!real) e.push(`主角 ${label} 没写 real_size_m（真实尺寸，米）`);
  if (!/\.glb$/i.test(String(it.file ?? ''))) return [...e, `主角 ${label} 交 .glb`];
  if (!data) return [...e, `主角 ${label} 的文件不在包里`];
  let f: HeroFacts;
  try { f = inspectGlb(data); } catch (err) { return [...e, `主角 ${label} 读不了：${(err as Error).message}`]; }
  const longest = Math.max(...f.sizeM);
  if (real && longest && Math.abs(longest - real) / real > SIZE_TOLERANCE) e.push(`主角 ${label} 模型最长 ${longest} 米，真实是 ${real} 米：按 1 单位 = 1 米改`);
  const floor = MIN_TRIANGLES[cls || 'object'];
  if (f.triangles < floor) e.push(`主角 ${label} 只有 ${f.triangles} 个三角形（${cls || '这一类'}至少 ${floor}）：多半是代码拼的或低多边形`);
  if (f.texturedShare < MIN_TEXTURED_SHARE) e.push(`主角 ${label} 只有 ${Math.round(f.texturedShare * 100)}% 的面贴了颜色贴图：纯色拼件像动画片`);
  if (f.colorTexturePx < MIN_TEXTURE_PX) e.push(`主角 ${label} 的颜色贴图最大 ${f.colorTexturePx} 像素，要 ≥ ${MIN_TEXTURE_PX}`);
  if (!f.detailMaps) e.push(`主角 ${label} 没有法线或粗糙度贴图：会像塑料`);
  return e;
}

interface BlindRow { view?: string; subject?: string; media?: string; photo?: string; ours?: string; reviewer?: string; reviewer_made_it?: boolean; same_thing?: boolean; verdict?: string; flaws?: string[] }

/** H7: lesson-flow.json visual_gate.blind_review — photo and our picture shuffled, judged by someone who didn't make it. */
export function checkBlindReview(gate: unknown): string[] {
  const rows = (((gate as { blind_review?: unknown })?.blind_review ?? []) as unknown[]).filter((r): r is BlindRow => !!r && typeof r === 'object');
  if (rows.length < 3) return [`没有 3 个角度的盲看记录（visual_gate.blind_review，现在 ${rows.length} 条）`];
  const e: string[] = [];
  for (const [i, r] of rows.entries()) {
    const tag = r.view || `第 ${i + 1} 条`;
    const gaps = (['view', 'photo', 'ours', 'reviewer', 'verdict'] as const).filter(k => !String(r[k] ?? '').trim());
    if (gaps.length) { e.push(`盲看 ${tag} 没写 ${gaps.join('、')}`); continue; }
    if (r.reviewer_made_it === true) e.push(`盲看 ${tag}：审看人参与了制作，不算盲看`);
    if (r.same_thing !== true) e.push(`盲看 ${tag}：审看人认为画面和照片不是同一个东西`);
    if (!VERDICTS[String(r.verdict)]) e.push(`盲看 ${tag}：verdict 写 ${Object.keys(VERDICTS).join('/')} 之一`);
    else if (r.verdict === 'cartoon' || r.verdict === 'toy') e.push(`盲看 ${tag}：审看人说画面${VERDICTS[r.verdict]}`);
    else if (r.verdict === 'cg' && r.media === 'render') e.push(`盲看 ${tag}：预渲染图还看得出是电脑画面`);
  }
  if (!rows.some(r => r.subject === 'hero')) e.push('盲看记录里没有主角（subject 写 "hero"）');
  if (new Set(rows.map((r, i) => r.view ?? i)).size < 3) e.push('盲看要 3 个不同角度');
  return e;
}
