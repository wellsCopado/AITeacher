// Everything a model (or a person) needs to write the next lesson for one child, in one object:
// the child, their own interests and wishes, which concepts and 3D components exist, which theme to use,
// which assets may be used, which lesson ids are taken. Only what lesson writing needs leaves the family:
// grade and interest topics, never names beyond 哥哥/妹妹, never homework photos or learning records.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProfile, InterestObservation, LessonSpec, ThemeTable } from '../../schema/src/index.js';
import { loadAssets, loadInterests, loadPublished, loadThemes, readJson, suggestTheme } from '../../cli/src/lib.js';

export interface ContextSources {
  interests?: InterestObservation[];
  /** Published lessons (the server's own, or content/published). */
  published?: LessonSpec[];
  /** Lesson keys already used anywhere (drafts, published, local folders), so a new lesson gets a free id. */
  takenKeys?: string[];
  tenant?: string;
  /** Where the child is in school maths, in the parent's words (e.g. 第二单元 表内乘法（一）), if the parent wrote it. */
  progress?: string | null;
  /** Today (YYYY-MM-DD), for guessing the term and unit when there is no progress note. */
  today?: string;
}

/** 上海: the first term runs September to January, the second February to June. */
export function termOf(date: string) {
  const m = Number(date.slice(5, 7));
  return m >= 9 || m === 1 ? '第一学期' : m <= 6 ? '第二学期' : '暑假';
}

const ABBR: Record<string, string> = { PerimeterArea: 'PA', ArrayMultiplier: 'ARR' };

export function localTakenKeys(root: string): string[] {
  const dir = join(root, 'content', 'lessons');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap(id => readdirSync(join(dir, id)).map(v => `${id}@${v}`));
}

/** A free lesson id for a new lesson on this component, e.g. L-PA-2, L-PA-3. */
export function freeLessonId(component: string, taken: string[]): string {
  const base = `L-${ABBR[component] ?? component.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase()}`;
  const ids = new Set(taken.map(k => k.split('@')[0]));
  for (let n = 2; ; n++) if (!ids.has(`${base}-${n}`)) return `${base}-${n}`;
}

export function studioContext(root: string, child: string, src: ContextSources = {}) {
  const children = readJson<Record<string, ChildProfile>>(join(root, 'content', 'children.json'));
  const profile = children[child];
  if (!profile) throw new Error(`没有这个孩子：${child}（可选：${Object.keys(children).join('、')}）`);
  const tenant = src.tenant ?? 'family-001';
  const interests = (src.interests ?? loadInterests(root)).filter(x => x.child === child && x.tenant_id === tenant);
  const published = src.published ?? loadPublished(root);
  const themes: ThemeTable = loadThemes(root);
  const components = readJson<Record<string, { versions: string[]; status: string; teaches: string[]; themes: string[]; hotspotAnchors: string[]; actions: string[]; paramsSchema: unknown; handsOn?: Record<string, string[]> }>>(join(root, 'content', 'components.json'));
  const concepts = readJson<Record<string, { name: string; misconceptions: string[] }>>(join(root, 'content', 'concepts.json'));
  const taken = [...new Set([...(src.takenKeys ?? []), ...localTakenKeys(root), ...published.map(p => `${p.lesson_id}@${p.version}`)])];
  const usable = Object.entries(components).filter(([, c]) => c.status === '已审');
  const today = src.today ?? new Date().toISOString().slice(0, 10);
  return {
    child: { id: child, label: profile.name, grade: profile.grade, region: profile.region, system: profile.system },
    /** School progress: the parent's note, or a guess from grade and date that the lesson must call a guess. */
    school: { today, term: termOf(today), progress: src.progress?.trim() || null },
    tenant_id: tenant,
    interests: interests.map(x => ({ id: x.id, topic: x.topic, source: x.source, state: x.state, observed_on: x.observed_on })),
    components: usable.map(([name, c]) => {
      const s = suggestTheme({ child, tenant, component: name, interests: src.interests ?? loadInterests(root), themes, profile, published });
      return {
        id: `${name}@${c.versions[c.versions.length - 1]}`, name,
        teaches: c.teaches.map(id => ({ id, name: concepts[id]?.name ?? id, misconceptions: concepts[id]?.misconceptions ?? [] })),
        hotspot_anchors: c.hotspotAnchors, actions: c.actions, params_schema: c.paramsSchema,
        /** Params the child can set by hand in a hands-on question (challenges[].task), per task type. */
        hands_on: c.handsOn ?? {},
        themes_ready: Object.entries(themes.skins).filter(([, k]) => k.component === name && k.status === '已有').map(([id, k]) => ({ id, name: k.name })),
        suggested_theme: s.theme, theme_notes: s.notes,
        /** Use exactly this as the next_lesson_wish question in end_chat (V14). */
        wish_question: s.wish,
        new_lesson_id: freeLessonId(name, taken),
      };
    }),
    concepts: Object.entries(concepts).map(([id, c]) => ({ id, name: c.name, misconceptions: c.misconceptions })),
    assets: loadAssets(root).filter(a => a.status === '采用' || a.status === '采用标记' || a.status === '待采购')
      .map(a => ({ asset_id: a.asset_id, name: a.name, kind: a.kind, realism: a.realism, status: a.status, commercial_ok: a.commercial_ok })),
    lessons_for_child: published.filter(p => p.for_child === child).map(p => ({ key: `${p.lesson_id}@${p.version}`, title: p.title, concept: p.primary_concept.id, theme: p.theme.id, published_at: p.published_at ?? null })),
    taken_keys: taken,
    fixed: {
      tenant_id: tenant, for_child: child, version: '1.0',
      learner_profile: { grade: profile.grade, language: { default: 'zh', cycle_enabled: true } },
      curriculum_mapping: { region: profile.region, system: profile.system, grade: profile.grade, status: '参考·待核对', verified_by: null },
    },
  };
}
export type StudioContext = ReturnType<typeof studioContext>;
