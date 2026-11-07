// 按主题做主角 (parent, 2026-11-06: “不要老糊弄和不管主题，用素材硬套，要根据主题去生产 3D”). An 探索课's hero is
// the real thing of its topic, written up first in research/subject.json (which one exactly, real photos, real sizes,
// what makes it recognisable, how it was made) and built to a floor: enough triangles, real textures, real size in
// metres, not boxes and cylinders, nothing put together from code geometry. The App's side of the Skill's
// scripts/hero_model.py; both read skills/discovery-lesson-maker/assets/hero-floor.json.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { glbStats, parseGlb } from '../../../packages/cli/src/glb.js';

interface Floor {
  kinds: Record<string, string>; routes: Record<string, string>; no_reference_modeling: string[];
  min_triangles: Record<string, number>; min_texture_px: number; size_tolerance: number;
  primitive_triangles: number; primitive_share: number; min_references: number; min_angles: number;
  min_dimensions: number; min_features: number; banned_origins: string[]; banned_words: string[];
  code_geometry: string; code_geometry_allow: string;
}
let floor: Floor | null = null;
const FLOOR = () => floor ??= JSON.parse(readFileSync(join(import.meta.dirname, '../../../skills/discovery-lesson-maker/assets/hero-floor.json'), 'utf8')) as Floor;

interface Card {
  topic?: string; instance?: string; kind?: string;
  references?: { file?: string; angle?: string; source?: string }[];
  dimensions?: { what?: string; meters?: number; source?: string; main?: boolean }[];
  features?: { name?: string; node?: string }[];
  route?: { hero?: string; why?: string };
}
export interface HeroItem { file?: string; role?: string; origin?: string; depicts?: string; how?: string }

const glob = (pat: string) => new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');

/**
 * files: the package's files by their path from its root (exploration.json's folder). Returns what is wrong; an App-made
 * package with any of it is not taken, an uploaded one shows it to the parent.
 */
export function checkHero(topic: string, files: Map<string, Uint8Array>, items: HeroItem[]): { errors: string[]; subject: string | null } {
  const f = FLOOR(), e: string[] = [];
  const raw = files.get('research/subject.json');
  if (!raw) return { errors: ['没有主角卡 research/subject.json：没写清主角具体是哪一个、真实照片、真实尺寸、辨识特征和怎么做出来'], subject: null };
  let card: Card;
  try { card = JSON.parse(Buffer.from(raw).toString('utf8')); } catch { return { errors: ['research/subject.json 不是合法的 JSON'], subject: null }; }
  const kind = card.kind && f.kinds[card.kind] ? card.kind : 'other';
  if (topic && String(card.topic ?? '').trim() !== topic) e.push(`主角卡的主题是「${card.topic ?? ''}」，不是「${topic}」`);
  if (!String(card.instance ?? '').trim()) e.push('主角卡没写主角具体是哪一个（型号、物种、哪座建筑）');
  const refs = (card.references ?? []).filter(r => String(r.source ?? '').trim() && String(r.angle ?? '').trim());
  if (refs.length < f.min_references) e.push(`真实参考照片只有 ${refs.length} 张，至少 ${f.min_references} 张`);
  else if (new Set(refs.map(r => r.angle)).size < f.min_angles) e.push(`参考照片要至少 ${f.min_angles} 个不同角度`);
  const dims = (card.dimensions ?? []).filter(d => d.what && typeof d.meters === 'number' && d.meters > 0 && String(d.source ?? '').trim());
  if (dims.length < f.min_dimensions) e.push(`带来源的真实尺寸只有 ${dims.length} 条，至少 ${f.min_dimensions} 条`);
  const main = dims.find(d => d.main);
  const feats = (card.features ?? []).filter(x => String(x.name ?? '').trim());
  if (feats.length < f.min_features) e.push(`辨识特征只有 ${feats.length} 个，至少 ${f.min_features} 个`);
  const route = card.route?.hero ?? '';
  if (!f.routes[route]) e.push('主角卡没写主角怎么做出来（扫描、CAD、照片建模、有许可的写实模型、照着照片和尺寸建模）');
  else if (route === 'modeled-from-reference' && f.no_reference_modeling.includes(kind)) e.push('动物不能照着照片手工建模：要用扫描件、照片建模或写实成品');

  for (const h of items.filter(i => i.role === 'hero')) {
    const file = String(h.file ?? '');
    if (f.banned_origins.includes(String(h.origin))) e.push(`主角 ${file} 是程序几何体拼的或手绘的`);
    if (f.banned_words.some(w => `${h.depicts ?? ''} ${h.how ?? ''}`.toLowerCase().includes(w.toLowerCase()))) e.push(`主角 ${file} 是低多边形、卡通或风格化的`);
    const data = /\.glb$/i.test(file) ? files.get(file) : undefined;
    if (!data) continue;
    let s;
    try { const g = parseGlb(Buffer.from(data)); s = { ...glbStats(g), json: g.json }; } catch (err) { e.push(`主角模型 ${file} 读不了：${(err as Error).message}`); continue; }
    const need = f.min_triangles[kind] ?? f.min_triangles.other;
    if (s.triangles < need) e.push(`主角模型只有 ${s.triangles} 个三角面，至少 ${need} 个`);
    const prims = (s.json.meshes ?? []).flatMap(m => m.primitives).map(p => Math.floor((s.json.accessors?.[p.indices ?? p.attributes.POSITION]?.count ?? 0) / 3));
    const small = prims.filter(t => t <= f.primitive_triangles).length;
    if (prims.length >= 6 && small / prims.length > f.primitive_share) e.push(`主角模型 ${small}/${prims.length} 个部件只有几十个面：像方块、圆柱拼的`);
    const mats = s.json.materials ?? [];
    const base = mats.map(m => m.pbrMetallicRoughness?.baseColorTexture?.index).filter((i): i is number => i !== undefined);
    if (!base.length) e.push('主角模型没有颜色贴图，像塑料玩具');
    else {
      const px = base.map(i => s.textures[i]).filter(t => t?.w && t.h).map(t => Math.max(t.w!, t.h!));
      if (px.length && Math.max(...px) < f.min_texture_px) e.push(`主角颜色贴图最大只有 ${Math.max(...px)} 像素，至少 ${f.min_texture_px}`);
    }
    if (!mats.some(m => m.normalTexture || m.pbrMetallicRoughness?.metallicRoughnessTexture)) e.push('主角模型没有法线或粗糙度贴图');
    if (main && s.size) {
      const big = Math.max(...s.size), real = main.meters!;
      if (big < (1 - f.size_tolerance) * real || big > (1 + f.size_tolerance) * real) e.push(`主角模型最长 ${big} 米，真实的「${main.what}」是 ${real} 米：没按真实尺寸做`);
    }
    const names = [...(s.json.nodes ?? []).map(n => (n as { name?: string }).name ?? ''), ...(s.json.meshes ?? []).map(m => (m as { name?: string }).name ?? '')].filter(Boolean);
    const lost = feats.filter(x => !x.node || !names.some(n => glob(x.node!).test(n))).map(x => x.name);
    if (lost.length) e.push(`辨识特征在模型里找不到：${lost.slice(0, 4).join('、')}`);
  }
  const code = new RegExp(f.code_geometry);
  const lines: string[] = [];
  for (const [p, d] of files) if (/^web\/src\/.+\.(m?[jt]sx?)$/i.test(p))
    Buffer.from(d).toString('utf8').split('\n').forEach((l, i) => { if (code.test(l) && !l.includes(f.code_geometry_allow)) lines.push(`${p}:${i + 1}`); });
  if (lines.length) e.push(`代码里用几何体拼了 ${lines.length} 处画面（${lines.slice(0, 3).join('、')}）`);
  return { errors: e, subject: String(card.instance ?? '').trim() || null };
}
