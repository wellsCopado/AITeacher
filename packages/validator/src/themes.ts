// Where a lesson's subject lives and which ready scene suits it: the server picks a subject's scene with these
// (never the model), and V24 holds every lesson to them, so a cricket is never put on the sea floor.
import type { ThemeTable } from '../../schema/src/index.js';

/** Where a subject lives (sea, fresh, yard…): the longest habitat word in its name (小龙虾 over 虾), else the default for its kind. */
export function habitatOf(themes: ThemeTable, name: string, kind: 'organism' | 'object'): string {
  let word = '', habitat = themes.habitat_default[kind];
  for (const [h, { words }] of Object.entries(themes.habitats)) for (const w of words) if (name.includes(w) && w.length > word.length) { word = w; habitat = h; }
  return habitat;
}
/**
 * Whether a scene suits a subject that lives in this habitat: only a scene of that same habitat. A tabletop of
 * blocks (habitat "none") holds no subject at all: a lesson can't be about an animal it never shows.
 */
export const fitsHabitat = (themes: ThemeTable, skin: string, habitat: string) => !!themes.skins[skin] && themes.skins[skin].habitat === habitat;
/** The ready scene of a component for a habitat; null when the component has none (then it can't carry this subject). */
export function sceneFor(themes: ThemeTable, component: string, habitat: string): string | null {
  return Object.entries(themes.skins).find(([, s]) => s.component === component && s.status === '已有' && s.habitat === habitat)?.[0] ?? null;
}
export const habitatName = (themes: ThemeTable, habitat: string) => themes.habitats[habitat]?.name ?? (habitat === 'none' ? '不放主角的中性场景' : habitat);

// ---- 写啥主题就做啥图片: what a scene depicts decides what a lesson in it can be about ----
/** Words that name a place in a sentence more often than a lesson's subject (转台的中心, 上海的…). */
const PLACE_WORDS = new Set(['中心', '上海']);
/**
 * Every subject the theme table knows by name, two characters or more: the animals and things of the habitats,
 * what each scene depicts, and the topics. Used to tell what a topic or a sentence is about.
 */
export function subjectWords(themes: ThemeTable): string[] {
  const all = [...Object.values(themes.habitats).flatMap(h => h.words), ...Object.values(themes.skins).flatMap(s => s.depicts ?? []), ...Object.keys(themes.topics)];
  return [...new Set(all)].filter(w => w.length >= 2).sort((a, b) => b.length - a.length);
}
/** The known subjects a text names, longest first, without the ones inside a longer match (螳螂虾, not 螳螂 too). */
export function subjectsIn(themes: ThemeTable, text: string, opts: { places?: boolean } = {}): string[] {
  const found: string[] = [];
  for (const w of subjectWords(themes)) {
    if ((!opts.places && PLACE_WORDS.has(w)) || !text.includes(w) || found.some(f => f.includes(w))) continue;
    found.push(w);
  }
  return found;
}
/**
 * Whether a scene shows this subject word: it is one of the things the scene depicts, or a kind of one (孔雀螳螂虾
 * is a 螳螂虾). Not the other way round: the robot factory depicts 机器人工厂, which doesn't make it a 机器人's scene.
 */
export const shownBy = (themes: ThemeTable, skin: string, word: string) => (themes.skins[skin]?.depicts ?? []).some(d => word.includes(d));
/**
 * Whether a scene can be a topic's scene: the topic names at least one subject we know and the scene depicts every
 * one of them. 「火箭发射」 names 火箭, which no scene depicts; 「花园里的蜜蜂」 names 蜜蜂 too, so not the garden;
 * a topic we don't know at all (火山) has no scene. 「螳螂虾和海底」 is the reef.
 */
export function shows(themes: ThemeTable, skin: string, topic: string): boolean {
  const s = themes.skins[skin];
  if (!s || s.status !== '已有' || !s.depicts?.length) return false;
  const named = subjectsIn(themes, topic, { places: true });
  return named.length > 0 && named.every(w => shownBy(themes, skin, w));
}
/** The ready scenes that depict a topic (optionally of one component); empty means it is made as an 探索课. */
export const scenesShowing = (themes: ThemeTable, topic: string, component?: string) =>
  Object.keys(themes.skins).filter(id => (!component || themes.skins[id].component === component) && shows(themes, id, topic));
