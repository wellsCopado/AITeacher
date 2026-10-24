// The lesson-writing Skill as text, for models and agents that don't load skill folders themselves.
// skills/discovery-learning-studio is the single source; nothing here restates its rules.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STAGE_FILES as F, readJson } from '../../cli/src/lib.js';
import type { Stages } from './lesson.js';

export const GUIDE_TOPICS = {
  skill: 'SKILL.md',
  flow: 'reference/lesson-flow.md',
  spec: 'reference/lessonspec.md',
  components: 'reference/components.md',
  themes: 'reference/themes.md',
  validation: 'reference/validation.md',
  principles: 'reference/principles.md',
  review: 'reference/review-checklist.md',
} as const;
export type GuideTopic = keyof typeof GUIDE_TOPICS | 'all' | 'author';

const SKILL_DIR = ['skills', 'discovery-learning-studio'];

/** One topic, 'all' of them, or 'author': what a model needs to write a lesson (everything but the review checklist). */
export function guide(root: string, topic: GuideTopic = 'all'): string {
  const pick = topic === 'all' ? Object.keys(GUIDE_TOPICS) : topic === 'author' ? ['skill', 'flow', 'spec', 'components', 'themes', 'validation', 'principles'] : [topic];
  return pick.map(k => {
    const rel = GUIDE_TOPICS[k as keyof typeof GUIDE_TOPICS];
    if (!rel) throw new Error(`没有这个主题：${k}（可选：${Object.keys(GUIDE_TOPICS).join('、')}、all、author）`);
    const p = join(root, ...SKILL_DIR, rel);
    return existsSync(p) ? `<!-- ${SKILL_DIR.join('/')}/${rel} -->\n${readFileSync(p, 'utf8').replace(/^---[\s\S]*?---\n/, '')}` : '';
  }).join('\n\n');
}

/** The reference lesson: a complete, passing set of stage files to copy the shape from. */
export const EXAMPLE_LESSON = ['L-PA', '1.0'];
export function exampleStages(root: string): Stages {
  const dir = join(root, 'content', 'lessons', ...EXAMPLE_LESSON);
  return { target: readJson(join(dir, F.target)), director: readJson(join(dir, F.director)), assets: readJson(join(dir, F.assets)) };
}
