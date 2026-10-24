// Lesson studio: the one place lesson writing goes through, whoever writes — a person with dls, an agent over
// MCP, or the built-in AI lesson writer with any chat model.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProfile } from '../../schema/src/index.js';
import { STAGE_FILES as F, loadPublished, readJson, writeJson } from '../../cli/src/lib.js';
import { studioContext } from './context.js';
import { EXAMPLE_LESSON, exampleStages, guide, type GuideTopic } from './guide.js';
import { checkStages, disassemble, issues, readStages, writeStages, type Stages } from './lesson.js';
import type { CheckOutcome, StudioBackend } from './mcp.js';

export * from './lesson.js';
export * from './context.js';
export * from './guide.js';
export * from './llm.js';
export * from './generate.js';
export * from './mcp.js';

export function outcome(r: ReturnType<typeof checkStages>): CheckOutcome {
  return { key: r.key, ok: r.report.ok, errors: r.report.errors, warnings: r.report.warnings, issues: issues(r.report).map(({ rule_name: _n, ...i }) => i), ...(r.spec ? { title: r.spec.title } : {}) };
}

export const childList = (root: string) =>
  Object.entries(readJson<Record<string, ChildProfile>>(join(root, 'content', 'children.json'))).map(([id, c]) => ({ id, label: c.name, grade: c.grade }));

/** Works on a repo checkout: stage files go to content/lessons/<id>/<version>/; submitting needs a server. */
export function localBackend(root: string, submit?: (spec: unknown) => Promise<{ key: string; status: string }>): StudioBackend {
  return {
    where: 'local',
    children: () => childList(root),
    context: child => studioContext(root, child),
    guide: topic => guide(root, topic as GuideTopic),
    example: () => exampleStages(root),
    check(stages) {
      const r = checkStages(root, stages);
      const o = outcome(r);
      if (!/^[A-Za-z0-9-]+@\d+\.\d+$/.test(r.key)) return o;
      // never overwrite the reference lesson or a published one: a new lesson takes the id from adw_get_context
      if (r.key === EXAMPLE_LESSON.join('@') || loadPublished(root).some(p => `${p.lesson_id}@${p.version}` === r.key))
        return { ...o, status: `没有保存：${r.key} 是示例课或已发布的课。新课用 adw_get_context 给的 new_lesson_id` };
      const dir = join(root, 'content', 'lessons', ...r.key.split('@'));
      writeStages(dir, stages);
      if (r.spec) { writeJson(join(dir, F.spec), r.spec); writeJson(join(dir, F.validation), r.report); }
      return { ...o, saved_to: dir };
    },
    async submit(stages: Stages) {
      const r = this.check(stages) as CheckOutcome;
      if (!r.ok) return { ...r, status: '校验没通过，先改好再交' };
      if (!submit) return { ...r, status: `已存到 ${r.saved_to}。还没连上家里的服务器：设置环境变量 ADW_SERVER 和 ADW_TOKEN（家长端“AI 助手接入”生成）后重新提交，或在仓库里运行 pnpm -s dls submit ${r.saved_to}` };
      const spec = checkStages(root, stages).spec!;
      return { ...r, ...(await submit(spec)) };
    },
    lessons: child => loadPublished(root).filter(p => !child || p.for_child === child).map(p => ({ key: `${p.lesson_id}@${p.version}`, title: p.title, child: p.for_child, status: '已发布' })),
    lesson(key) {
      const dir = join(root, 'content', 'lessons', ...key.split('@'));
      if (/^[A-Za-z0-9-]+@\d+\.\d+$/.test(key) && existsSync(join(dir, F.target))) return { key, status: '本地阶段文件', stages: readStages(dir) };
      const p = loadPublished(root).find(x => `${x.lesson_id}@${x.version}` === key);
      if (!p) throw new Error(`没有这节课：${key}`);
      return { key, status: '已发布（已冻结，修改请升版本号）', stages: disassemble(p) };
    },
  };
}
