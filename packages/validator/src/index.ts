import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LessonSpec } from '../../schema/src/index.js';
import { RULES, type Ctx, type Issue } from './rules.js';

export { RULES, type Ctx, type Issue } from './rules.js';
export { evalExpr, exprVars, ExprError } from './expr.js';

export interface RuleResult { id: string; name: string; basis: string; level: 'error' | 'warn'; ok: boolean; issues: Issue[] }
export interface Report { lesson: string; ok: boolean; errors: number; warnings: number; results: RuleResult[] }

export function validate(sp: LessonSpec, ctx: Ctx): Report {
  const results: RuleResult[] = RULES.map(r => {
    let issues: Issue[];
    try { issues = r.check(sp, ctx); }
    catch (e) { issues = [{ path: '$', msg: `规则执行出错（多半是结构不完整，先看 V01）：${(e as Error).message}` }]; }
    return { id: r.id, name: r.name, basis: r.basis, level: r.level, ok: issues.length === 0, issues };
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
    children: readJson(c('children.json')),
    previous: previous ?? null,
  };
}
