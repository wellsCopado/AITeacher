import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AssetEntry, ChildProfile, InterestObservation, LessonSpec, ThemeTable } from '../../schema/src/index.js';
import { habitatName, habitatOf, scenesShowing } from '../../validator/src/themes.js';
export { fitsHabitat, habitatName, habitatOf, sceneFor, scenesShowing, shows, subjectsIn } from '../../validator/src/themes.js';
/** The ready 3D scenes, for telling the parent why a topic gets its own: 珊瑚礁样方调查、花园围栏与铺砖…. */
export const readyDepicts = (themes: ThemeTable) => Object.values(themes.skins).filter(s => s.status === '已有' && !s.realism && s.depicts?.length).map(s => s.name.split('：')[0]).join('、');

export const readJson = <T = any>(p: string): T => JSON.parse(readFileSync(p, 'utf8'));
export function writeJson(p: string, v: unknown) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); }

/** Repository root: the nearest directory above cwd that has content/components.json. */
export function findRoot(from = process.cwd()): string {
  let d = from;
  for (;;) {
    if (existsSync(join(d, 'content', 'components.json'))) return d;
    const up = dirname(d);
    if (up === d) throw new Error('找不到仓库根目录（需要 content/components.json）');
    d = up;
  }
}

export const STAGE_FILES = {
  target: '01-target.json', director: '02-director.json', assets: '03-assets.json',
  spec: 'lessonspec.json', validation: '05-validation.json', review: '06-review.json',
} as const;

export const REVIEW_CHECKLIST: Record<'科学' | '教研' | '语言' | '安全', string[]> = {
  科学: ['定义和单位正确', '示意已标注、无虚构结构', '画面写实，无卡通或简化生物（BL14）'],
  教研: ['教材映射状态正确', '迁移题不带原题材', '主题来自孩子自己的兴趣'],
  语言: ['中文讲解适龄、准确', '英文 3 条准确，不增加门槛'],
  安全: ['离屏任务需成人陪同、无危险', '无开放聊天、无外链'],
};

/** Canonical JSON (sorted keys) so the same content always hashes the same. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical((v as any)[k])).join(',') + '}';
  return JSON.stringify(v);
}
export function contentHash(sp: LessonSpec): string {
  const { content_hash: _h, published_at: _p, ...rest } = sp;
  return 'sha256:' + createHash('sha256').update(canonical(rest)).digest('hex');
}

export const STATE_RANK: Record<InterestObservation['state'], number> = { 家长指定: -1, 下一课心愿: 0, 近期最喜欢: 1, 喜欢: 2, 曾经喜欢: 3, 只用于安全工程题材: 9 };

/** The asset id of a theme's subject (博比特虫, 机器人…): the same topic always gets the same id. */
export const subjectId = (topic: string) => 'S-' + createHash('sha1').update(topic.trim()).digest('hex').slice(0, 8);
/** Machines and buildings are objects; everything else a child names is taken to be an animal or plant. */
export const subjectKind = (topic: string): 'organism' | 'object' => /机器|车|楼|桥|隧道|船|飞机|火箭|塔|房|工厂|电|器/.test(topic) ? 'object' : 'organism';
/** A theme whose own scene isn't built yet: it uses the ready scene of the subject's habitat, the subject is made as an asset. */
export const isCustomTheme = (t: { id: string }) => t.id.startsWith('topic-');

/** The scenes made for a topic: "机器人工厂" or "工厂里的机器人" finds the 机器人 scenes too. */
export function skinsOf(themes: ThemeTable, topic: string): string[] {
  const keys = Object.keys(themes.topics).sort((a, b) => b.length - a.length);
  return themes.topics[topic] ?? themes.topics[keys.find(k => topic.includes(k)) ?? keys.find(k => k.includes(topic)) ?? ''] ?? [];
}

/**
 * What a child's own words for the next lesson are about: the longest topic we already know (an interest, an
 * answer option, a theme, an animal) that the words name. Null when they name none: then the parent says what the
 * topic is, and until then the words never leave the house.
 */
export function wishTopic(said: string, known: string[]): string | null {
  const s = said.trim().replace(/^还是/, '').replace(/[。！？!?.，,、\s]+$/u, '');
  if (!s) return null;
  const ks = [...new Set(known.map(k => k.trim().replace(/^还是/, '')).filter(Boolean))].sort((a, b) => b.length - a.length);
  return ks.find(k => k === s) ?? ks.find(k => s.includes(k)) ?? null;
}

/** What a topic needs before its lesson: a ready 3D scene, or the subject itself made as an asset. */
export function topicPlan(topic: string, themes: ThemeTable) {
  const ready = scenesShowing(themes, topic).map(id => ({ id, ...themes.skins[id] }));
  const planned = skinsOf(themes, topic).map(id => ({ id, ...themes.skins[id] })).filter(s => s.name && s.status !== '已有');
  const skins = [...ready, ...planned];
  return {
    skins: skins.map(s => ({ id: s.id, name: s.name, component: s.component, status: s.status, ...(s.realism ? { realism: s.realism } : {}) })),
    subject: ready.length ? null : { name: topic, asset_id: subjectId(topic), kind: subjectKind(topic) },
  };
}

export interface ThemeSuggestion {
  theme: LessonSpec['theme'];
  notes: string[];
  wish: LessonSpec['end_chat']['questions'][number];
}

/**
 * Pick the theme for a child's next lesson: what the parent named first, then the child's own next-lesson wish,
 * then their current favourite, then other interests. Those two first ones are always honoured: when their scene
 * isn't built yet, the lesson uses the closest ready scene and the subject itself (the animal, the robot) becomes
 * an asset to make. Other interests without a scene become notes and the next usable one is tried, then a
 * neutral skin. Never uses a sibling's interests.
 */
export function suggestTheme(opts: {
  child: string; tenant: string; component: string; interests: InterestObservation[];
  themes: ThemeTable; profile: ChildProfile; published: LessonSpec[];
}): ThemeSuggestion {
  const { child, tenant, component, themes, profile } = opts;
  const mine = opts.interests
    .filter(x => x.child === child && x.tenant_id === tenant && x.state !== '只用于安全工程题材')
    .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || b.observed_on.localeCompare(a.observed_on));
  const notes: string[] = [];
  let theme: LessonSpec['theme'] | null = null;
  for (const rec of mine) {
    // a scene only carries a topic it depicts (V27): 机器人 is not the robot arm, 蟋蟀 not the garden's fence and tiles
    const ready = scenesShowing(themes, rec.topic, component).map(id => ({ id, ...themes.skins[id] }))[0];
    const why = `${rec.source}：${rec.topic}（${rec.state}）`;
    if (ready) { theme = { id: ready.id, name: ready.name, skin: ready.id, interest_refs: [rec.id], why, no_husbandry: true }; break; }
    if (rec.state === '家长指定' || rec.state === '下一课心愿') {
      // honoured, never swapped for an easier scene: with no scene of its own it is made as an 探索课 (the server does)
      theme = { id: `topic-${subjectId(rec.topic).slice(2)}`, name: rec.topic, interest_refs: [rec.id], why, no_husbandry: true,
        subject: { name: rec.topic, asset_id: subjectId(rec.topic), kind: subjectKind(rec.topic) } };
      notes.push(`「${rec.topic}」没有现成的 3D 场景（现成的只有${readyDepicts(themes)}，画的都不是它）：要按它自己的样子建场景、做图，做成探索课，不用 ${component} 写`);
      break;
    }
    notes.push(`「${rec.topic}」没有现成的 3D 场景，这节课不用它；要讲它就做成探索课`);
  }
  if (!theme) {
    const skin = themes.neutral[component];
    theme = { id: skin, name: themes.skins[skin]?.name ?? skin, skin, interest_refs: [], neutral: true, why: mine.length ? '孩子的兴趣暂时没有可用主题，先用中性题材' : '还没有孩子自述的兴趣，先用中性题材', no_husbandry: true };
  }
  const recent = opts.published.filter(p => p.for_child === child).sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? '')).slice(0, 3);
  if (recent.length === 3 && recent.every(p => p.theme.id === theme!.id)) notes.push('同一主题已连续 3 节，心愿问题里提示可以换一个');

  const current = mine.find(x => theme!.interest_refs.includes(x.id))?.topic;
  let options: string[];
  if (profile.wish_options_from_interests) {
    const topics = [...new Set(mine.map(x => x.topic))];
    options = topics.map(t => (t === current ? `还是${t}` : t));
    for (const f of profile.wish_fallback_options) if (options.length < 5 && !topics.some(t => f.includes(t))) options.push(f);
  } else options = [...profile.wish_fallback_options];
  return { theme, notes, wish: { id: 'wish', kind: 'next_lesson_wish', prompt: profile.wish_prompt, options, allow_own_words: true } };
}

export function loadPublished(root: string): LessonSpec[] {
  const d = join(root, 'content', 'published');
  if (!existsSync(d)) return [];
  return readdirSync(d).filter(f => f.endsWith('.lesson.json')).map(f => readJson<LessonSpec>(join(d, f)));
}

export function loadThemes(root: string): ThemeTable { return readJson(join(root, 'content', 'themes.json')); }
export function loadAssets(root: string): AssetEntry[] { return readJson(join(root, 'content', 'assets', 'registry.json')); }
export function loadInterests(root: string): InterestObservation[] {
  const p = join(root, 'content', 'interests.json');
  return existsSync(p) ? readJson(p) : [];
}
