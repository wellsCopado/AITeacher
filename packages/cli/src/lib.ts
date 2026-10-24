import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AssetEntry, ChildProfile, InterestObservation, LessonSpec, ThemeTable } from '../../schema/src/index.js';

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

const STATE_RANK: Record<InterestObservation['state'], number> = { 下一课心愿: 0, 近期最喜欢: 1, 喜欢: 2, 曾经喜欢: 3, 只用于安全工程题材: 9 };

export interface ThemeSuggestion {
  theme: LessonSpec['theme'];
  notes: string[];
  wish: LessonSpec['end_chat']['questions'][number];
}

/**
 * Pick the theme for a child's next lesson: their own next-lesson wish first, then their current
 * favourite, then other interests. Skins that don't exist yet become notes (asset tickets), and the
 * lesson falls back to the next usable interest or a neutral skin. Never uses a sibling's interests.
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
    const skins = themes.topics[rec.topic] ?? [];
    if (!skins.length) { notes.push(`「${rec.topic}」还没有对应主题，需要开素材工单`); continue; }
    const fit = skins.map(s => ({ id: s, ...themes.skins[s] })).filter(s => s.component === component);
    const ready = fit.find(s => s.status === '已有');
    if (!ready) { for (const s of fit) notes.push(`「${rec.topic}」对应的主题「${s.name}」待开发，需要开素材工单`); continue; }
    theme = { id: ready.id, name: ready.name, skin: ready.id, interest_refs: [rec.id], why: `${rec.source}：${rec.topic}（${rec.state}）`, no_husbandry: true };
    break;
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
