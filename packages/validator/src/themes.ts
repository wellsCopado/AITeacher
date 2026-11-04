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
