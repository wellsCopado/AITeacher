// 写啥主题就做啥图片 (parent, 2026-11-05: “图片还是机器臂，这完全不对啊”“不要总是复用原来的素材”). An 探索课's
// pictures, models, textures and videos are each listed in research/assets.json as made for the lesson's topic; this is
// the App's side of the rule the 探索课 Skill checks before handing in (scripts/topic_assets.py, references/topic-assets.md),
// plus what only the App can see: a picture file that is exactly another lesson's.
import { createHash } from 'node:crypto';
import { checkHero, type HeroItem } from './hero-check.js';

/** Files a child sees: pictures, textures, models, videos. Sound, fonts and code are not pictures. */
export const VISUAL = /\.(png|jpe?g|webp|avif|gif|svg|ktx2|basis|hdr|exr|glb|gltf|usdz|fbx|obj|drc|mp4|webm|mov|m4v)$/i;
const MODEL = /\.(glb|gltf|usdz|fbx|obj|drc)$/i;
/** Smaller ones are mostly interface icons: not required on the list, not compared between lessons. */
export const MIN_BYTES = 1024;
const ORIGINS = new Set(['modeled', 'procedural', 'scan', 'cad', 'photo', 'cc0-library', 'licensed', 'generated', 'rendered', 'drawn']);
const ROLES = new Set(['hero', 'part', 'scene', 'picture', 'video', 'ui']);
/** The fixed scenes' and the example lesson's things: on another topic's list they were most likely carried over. */
const APP_SCENE_THINGS = ['机械臂', '齿轮', '转台', '积木', '珊瑚', '螳螂虾', '卷尺', '样方', 'PVC', '测距轮', '栅栏', '地砖', '石板'];

export interface AssetItem extends HeroItem { file?: string; sha256?: string; role?: string; depicts?: string; made_for?: string; origin?: string; how?: string; source?: string; sourceIds?: string[]; license?: string }
/** What the parent's card shows of the list: what each picture is of and where it came from. */
export interface AssetLine { file: string; role: string; depicts: string; origin: string }

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
/** Do a and b share n characters in a row (「火箭发射」 and 「长征二号F火箭」 share 火箭). */
const common = (a: string, b: string, n = 2) => a.length < n ? b.includes(a) : [...Array(a.length - n + 1).keys()].some(i => b.includes(a.slice(i, i + n)));

/** The visual files of a site that count (big enough), by their sha256. */
export function visualHashes(site: { path: string; data: Uint8Array }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of site) if (VISUAL.test(f.path) && f.data.length >= MIN_BYTES) out.set(sha256(f.data), f.path);
  return out;
}

/** Checks the list against the package. errors: what makes a lesson made for a topic fail; old packages get them as warnings. */
export function checkAssets(topic: string, list: unknown, site: { path: string; data: Uint8Array }[]) {
  const errors: string[] = [], warnings: string[] = [], lines: AssetLine[] = [];
  if (!topic) errors.push('exploration.json 没写 topic（家长给的主题原词）：没法核对画面是不是为这个主题做的');
  if (list === undefined) return { errors: [...errors, '没有素材清单 research/assets.json：说不清每张图、每个模型画的是什么、从哪来'], warnings, lines };
  const items = (list as { items?: unknown })?.items;
  if (!Array.isArray(items)) return { errors: [...errors, 'research/assets.json 要写成 {"topic": "…", "items": [ … ]}'], warnings, lines };
  if (topic && String((list as { topic?: unknown }).topic ?? '').trim() !== topic) errors.push(`素材清单的主题「${String((list as { topic?: unknown }).topic ?? '')}」和这节课的「${topic}」不一样`);
  const every = new Set(site.filter(f => VISUAL.test(f.path)).map(f => sha256(f.data))), must = visualHashes(site);
  const listed = new Set<string>(), elsewhere: string[] = [], gaps: string[] = [], heroes: AssetItem[] = [];
  items.forEach((raw, i) => {
    const it = (raw && typeof raw === 'object' ? raw : {}) as AssetItem, label = it.file || `第 ${i + 1} 项`, role = String(it.role ?? '');
    if (!ROLES.has(role)) errors.push(`${label}：role 写 hero/part/scene/picture/video/ui 之一`);
    const need = ['file', 'depicts', 'origin', 'license', ...(role === 'ui' ? [] : ['made_for', 'sha256'])] as (keyof AssetItem)[];
    const miss = need.filter(k => !String(it[k] ?? '').trim());
    if (!String(it.how ?? '').trim() && !it.sourceIds?.length && !String(it.source ?? '').trim()) miss.push('how' as keyof AssetItem);
    if (miss.length) gaps.push(`${label} 没写 ${miss.join('、')}`);
    if (it.origin && !ORIGINS.has(it.origin)) errors.push(`${label}：origin「${it.origin}」不认识`);
    if (role !== 'ui' && topic && it.made_for && it.made_for.trim() !== topic) elsewhere.push(`${label}（给「${it.made_for}」做的）`);
    const sha = String(it.sha256 ?? '').toLowerCase();
    if (sha) { listed.add(sha); if (!every.has(sha)) warnings.push(`${label}：网页里没有 sha256 对得上的文件`); }
    if (role === 'hero') heroes.push(it);
    const borrowed = role !== 'ui' && topic ? APP_SCENE_THINGS.filter(w => String(it.depicts ?? '').includes(w) && !topic.includes(w)) : [];
    if (borrowed.length) warnings.push(`${label} 画的是「${it.depicts}」：${borrowed.join('、')}是 App 固定场景里的东西，确认它真是「${topic}」里有的`);
    if (lines.length < 40) lines.push({ file: String(it.file ?? '').slice(0, 120), role, depicts: String(it.depicts ?? '').slice(0, 60), origin: String(it.origin ?? '') });
  });
  if (gaps.length) errors.push(`素材清单没写全：${gaps.slice(0, 5).join('；')}`);
  if (elsewhere.length) errors.push(`这些素材不是为「${topic}」做的：${elsewhere.slice(0, 5).join('、')}`);
  const unlisted = [...must].filter(([h]) => !listed.has(h)).map(([, p]) => p).sort();
  if (unlisted.length) errors.push(`${unlisted.length} 个画面文件不在素材清单里：${unlisted.slice(0, 5).join('、')}`);
  if (!heroes.length) errors.push('素材清单里没有主角（role 为 hero 的三维模型）');
  for (const h of heroes) {
    if (!MODEL.test(String(h.file ?? ''))) errors.push(`主角 ${h.file} 不是三维模型：照片、视频、截图不能代替可以转着看的主角`);
    if (topic && !common(topic, String(h.depicts ?? ''))) errors.push(`主角画的是「${h.depicts ?? ''}」，主题是「${topic}」`);
    // 主角能不能当真看：类别、来源、真实照片、真实尺寸、面数、贴图（hero-check.ts）
    const sha = String(h.sha256 ?? '').toLowerCase();
    errors.push(...checkHero(h, site.find(f => sha && sha256(f.data) === sha)?.data));
  }
  return { errors, warnings, lines };
}
