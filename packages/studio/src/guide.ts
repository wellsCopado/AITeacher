// The lesson-writing Skill as text, for models and agents that don't load skill folders themselves.
// skills/discovery-learning-studio is the single source; nothing here restates its rules.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STAGE_FILES as F, readJson } from '../../cli/src/lib.js';
import type { Stages } from './lesson.js';

export const GUIDE_TOPICS = {
  skill: 'SKILL.md',
  flow: 'reference/lesson-flow.md',
  challenges: 'reference/challenge-types.md',
  spec: 'reference/lessonspec.md',
  components: 'reference/components.md',
  themes: 'reference/themes.md',
  validation: 'reference/validation.md',
  principles: 'reference/principles.md',
  review: 'reference/review-checklist.md',
} as const;
export type GuideTopic = keyof typeof GUIDE_TOPICS | 'all' | 'author';

const SKILL_DIR = ['skills', 'discovery-learning-studio'];

/** Every Skill in skills/: plain Markdown any model or agent can read (SKILL.md first, then reference/ or references/, then examples/). */
export interface SkillInfo { name: string; description: string; files: string[] }
export function skillList(root: string): SkillInfo[] {
  const dir = join(root, 'skills');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && existsSync(join(dir, d.name, 'SKILL.md'))).map(d => {
    const head = readFileSync(join(dir, d.name, 'SKILL.md'), 'utf8').match(/^---[\s\S]*?\ndescription:\s*(.+)\n[\s\S]*?---/);
    const sub = (name: string) => { const p = join(dir, d.name, name); return existsSync(p) ? readdirSync(p).filter(f => f.endsWith('.md')).sort().map(f => `${name}/${f}`) : []; };
    const files = ['SKILL.md', ...sub('reference'), ...sub('references'), ...sub('examples')];
    return { name: d.name, description: head?.[1].trim() ?? '', files };
  });
}

/** One Skill's file, or all of its files (SKILL.md first). Only files the Skill lists can be read. */
export function readSkill(root: string, name: string, file?: string): string {
  const s = skillList(root).find(x => x.name === name);
  if (!s) throw new Error(`没有这个 Skill：${name}（可选：${skillList(root).map(x => x.name).join('、')}）`);
  const pick = file && file !== 'all' ? [file] : s.files;
  return pick.map(f => {
    if (!s.files.includes(f)) throw new Error(`${name} 里没有 ${f}（可选：${s.files.join('、')}）`);
    return `<!-- skills/${name}/${f} -->\n${readFileSync(join(root, 'skills', name, f), 'utf8').replace(/^---[\s\S]*?---\n/, '')}`;
  }).join('\n\n');
}

/** The list of Skills as text: what each is for and which files it has. */
export function skillIndex(root: string): string {
  return ['项目里的 Skill（都是普通的 Markdown，任何模型都能读：先读 SKILL.md，再按它的指引读 reference/ 或 references/）：',
    ...skillList(root).map(s => `\n## ${s.name}\n${s.description}\n文件：${s.files.join('、')}`)].join('\n');
}

/**
 * One topic, 'all' of them, or 'author': what a model needs to write a lesson (everything but the review checklist).
 * Any other Skill: 'skills' for the list, 'skill:<name>' for all of it, 'skill:<name>/<file>' for one file.
 */
export function guide(root: string, topic: GuideTopic | string = 'all'): string {
  if (topic === 'skills') return skillIndex(root);
  const other = /^skill:([a-z0-9-]+)(?:\/(.+))?$/.exec(topic);
  if (other) return readSkill(root, other[1], other[2]);
  const pick = topic === 'all' ? Object.keys(GUIDE_TOPICS) : topic === 'author' ? ['skill', 'flow', 'challenges', 'spec', 'components', 'themes', 'validation', 'principles'] : [topic];
  return pick.map(k => {
    const rel = GUIDE_TOPICS[k as keyof typeof GUIDE_TOPICS];
    if (!rel) throw new Error(`没有这个主题：${k}（可选：${Object.keys(GUIDE_TOPICS).join('、')}、all、author）`);
    const p = join(root, ...SKILL_DIR, rel);
    return existsSync(p) ? `<!-- ${SKILL_DIR.join('/')}/${rel} -->\n${readFileSync(p, 'utf8').replace(/^---[\s\S]*?---\n/, '')}` : '';
  }).join('\n\n');
}

/** The reference lesson: a complete, passing set of stage files to copy the shape from. */
export const EXAMPLE_LESSON = ['L-PA', '1.1'];
export function exampleStages(root: string): Stages {
  const dir = join(root, 'content', 'lessons', ...EXAMPLE_LESSON);
  return { target: readJson(join(dir, F.target)), director: readJson(join(dir, F.director)), assets: readJson(join(dir, F.assets)) };
}
