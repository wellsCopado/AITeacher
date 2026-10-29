import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LessonSpec } from '../../schema/src/index.js';
import { RULES, type Ctx, type Issue } from './rules.js';

export { RULES, mechanism, type Ctx, type Issue } from './rules.js';
export { checkJudgment, draftJudgment, validateRecognition, JUDGMENT_RULES, CHECK_BELOW, CHARACTER_WORDS, type JudgmentCtx, type JudgmentReport } from './judgment.js';
export { evalExpr, exprVars, ExprError } from './expr.js';

export interface RuleResult { id: string; name: string; basis: string; level: 'error' | 'warn'; ok: boolean; issues: Issue[] }
export interface Report { lesson: string; ok: boolean; errors: number; warnings: number; results: RuleResult[] }

/**
 * Rules added after the first lessons were written: question types (V20) and the pictures' numbers (V23). They are
 * errors for every lesson written from now on and only warn about the two sample lessons written before them.
 */
export const NEW_LESSON_RULES = ['V20', 'V23'];
export const WRITTEN_BEFORE = ['L-PA@1.0', 'L-ARR@1.0'];
export const isNewLesson = (key: string) => !WRITTEN_BEFORE.includes(key);

export function validate(sp: LessonSpec, ctx: Ctx, opts: { newLesson?: boolean } = {}): Report {
  const results: RuleResult[] = RULES.map(r => {
    let issues: Issue[];
    try { issues = r.check(sp, ctx); }
    catch (e) { issues = [{ path: '$', msg: `规则执行出错（多半是结构不完整，先看 V01）：${(e as Error).message}` }]; }
    const level = opts.newLesson && NEW_LESSON_RULES.includes(r.id) ? 'error' : r.level;
    return { id: r.id, name: r.name, basis: r.basis, level, ok: issues.length === 0, issues };
  });
  const errors = results.filter(r => !r.ok && r.level === 'error').length;
  const warnings = results.filter(r => !r.ok && r.level === 'warn').length;
  return { lesson: `${sp?.lesson_id}@${sp?.version}`, ok: errors === 0, errors, warnings, results };
}

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

/** Load the shared registries under <root>/content. */
export function loadContext(root: string, previous?: LessonSpec | null): Ctx {
  const c = (f: string) => join(root, 'content', f);
  return {
    components: readJson(c('components.json')),
    concepts: readJson(c('concepts.json')),
    assets: readJson(c('assets/registry.json')),
    interests: existsSync(c('interests.json')) ? readJson(c('interests.json')) : [],
    reteach: existsSync(c('reteach.json')) ? readJson(c('reteach.json')) : [],
    children: readJson(c('children.json')),
    previous: previous ?? null,
  };
}
