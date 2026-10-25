// The built-in lesson writer: any chat model writes the three stage files by the Skill, the validator checks
// them, and the problems go back to the model until the lesson passes (or the rounds run out). Fields that
// must not be the model's choice (ids, child, grade, language mode, theme, wish question) are set here.
import type { LessonSpec } from '../../schema/src/index.js';
import type { Report } from '../../validator/src/index.js';
import type { Ctx } from '../../validator/src/index.js';
import { isCustomTheme } from '../../cli/src/lib.js';
import { checkStages, issues, type Stages } from './lesson.js';
import { exampleStages, guide } from './guide.js';
import type { StudioContext } from './context.js';
import { BRIEF_HEADER } from './design.js';
import { ModelError, parseJsonReply, type Chat, type Message } from './llm.js';

export interface LessonRequest {
  /** What the parent wants, in their words (a topic, a difficulty…), or a whole 课程方案 agreed with a cloud model. Optional. */
  wish?: string;
  /** Component to use (PerimeterArea, ArrayMultiplier…). Optional: the model picks from the child's grade. */
  component?: string;
  /** Revise a lesson the parent sent back: its stage files and the parent's note. It keeps its id and version. */
  revise?: { stages: Stages; note: string };
}

export interface GenerateResult { ok: boolean; stages: Stages | null; spec: LessonSpec | null; report: Report | null; rounds: number }

const OUTPUT_RULES = `## 输出格式（必须严格遵守）
只输出一个 JSON 对象，不要任何其他文字：{"target": {…01-target.json…}, "director": {…02-director.json…}, "assets": {…03-assets.json…}}
- 结构和“示例课”完全一样（字段名、层级、类型都一样），内容是为这个孩子新写的，不要照抄示例的题目和讲解。
- 上下文里 fixed 的值原样使用：tenant_id、for_child、version、learner_profile.grade、learner_profile.language、curriculum_mapping 的 region / system / grade / status / verified_by。lesson_id 用所选组件的 new_lesson_id。
- director.theme 原样复制所选组件的 suggested_theme；end_chat 里 kind 为 next_lesson_wish 的那一题原样复制 wish_question。
- suggested_theme 里有 subject（主角）时：这节课就是讲它的。theme.skin 和 component_params 里的 theme 从 themes_ready 里选最接近它真实环境的场景；标题、说明页、讲解和题目都围绕它写（例如 shrimp 讲解位置写成它的名字和它真实的样子），不要写成别的动物或东西。它的画面由系统另外做，你在 assets.pending 里列出它（系统会自动补）。
- 课内进度看上下文 school：家长写了就按它选知识点；没写就按年级和日期推断，在 parent_tip 里写“课内进度是推断的”。不要因为资料不全而不写课。
- scene_component_ids 只能用 components[].id；component_params 必须符合该组件的 params_schema；热点 anchor 只能用 hotspot_anchors；activity_graph 里的 action 只能用 actions。
- primary_concept 只能用所选组件 teaches 里的知识点，误区从它的 misconceptions 里选。
- assets.use 只能用 assets 里状态为“采用”或“采用标记”的 asset_id；状态为“待采购”的写进 assets.pending，until_ready 写“不展示……”。
- 每个热点 language_pack：中文 1 条、英文 3 条。每道题都写 worked_example（2–5 步，最后一步说出全部答案）和 twin（同一方法换数字或情境，field 与原题相同）。写 encouragement.persist（2–5 句，和主题相连）。
- 数字要自己算对；参考算例必须和公式一致。事实不确定就写“待科学审核”，不要编。`;

export function authorMessages(root: string, ctx: StudioContext, req: LessonRequest): Message[] {
  const system: Message = { role: 'system', content: `你是 AI Discovery World 的课程编写器。按下面的 Skill，为一个孩子写一节以数学为主、包在他自己兴趣里的写实 3D 互动课。\n\n${guide(root, 'author')}\n\n${OUTPUT_RULES}` };
  if (req.revise) return [system, { role: 'user', content: `## 上下文（孩子、可用组件、主题、素材）\n${JSON.stringify(ctx, null, 1)}\n\n## 这次要做的事\n家长看过这节课并退回，意见是：「${req.revise.note}」\n按家长的意见修改，没提到的部分保持不变；lesson_id 和 version 不变。输出修改后的完整 JSON。\n\n## 当前的课\n${JSON.stringify(req.revise.stages)}` }];
  const want = [
    `孩子：${ctx.child.label}（${ctx.child.id}），${ctx.child.grade} 年级。`,
    req.component ? `用组件：${req.component}。` : '从 components 里选适合这个年级的组件。',
    !req.wish ? '家长没有额外要求：主题按 suggested_theme，难度按年级。'
      : req.wish.includes(BRIEF_HEADER) || req.wish.length > 200
        ? `家长和设计顾问谈好的课程方案，照它做；方案和 Skill 规则冲突时以规则为准（组件、参数范围、主题、素材以上下文为准），并在 parent_tip 里说明改了哪里：\n${req.wish}`
        : `家长的要求：${req.wish}`,
  ].join('\n');
  return [
    system,
    { role: 'user', content: `## 上下文（孩子、可用组件、主题、素材）\n${JSON.stringify(ctx, null, 1)}\n\n## 这次要做的课\n${want}\n\n## 示例课（只参考结构）\n${JSON.stringify(exampleStages(root))}` },
  ];
}

/** Set what the model must not choose. `keep`: the target of the lesson being revised (its id, version, reteach links stay). */
export function normalize(raw: any, ctx: StudioContext, keep?: Record<string, any>): Stages {
  if (!raw || typeof raw !== 'object') throw new ModelError('模型返回的 JSON 不是对象');
  const s: Stages = { target: raw.target ?? raw['01-target'] ?? {}, director: raw.director ?? raw['02-director'] ?? {}, assets: raw.assets ?? raw['03-assets'] ?? {} };
  const compName = String(s.director.scene_component_ids?.[0] ?? '').split('@')[0];
  const comp = ctx.components.find(c => c.name === compName) ?? ctx.components[0];
  const t = s.target, f = ctx.fixed;
  Object.assign(t, { lesson_id: keep?.lesson_id ?? comp.new_lesson_id, version: keep?.version ?? f.version, tenant_id: f.tenant_id, for_child: f.for_child, previous_version: keep?.previous_version ?? null, trigger_judgment_ref: keep?.trigger_judgment_ref ?? null });
  t.learner_profile = { ...(t.learner_profile ?? {}), grade: f.learner_profile.grade, language: f.learner_profile.language, recent_judgment_ref: null };
  t.curriculum_mapping = { term: '', source: '沪学习 App 参考目录', publisher: '待核对', unit: '待核对', ...(t.curriculum_mapping ?? {}), ...f.curriculum_mapping, checked_on: new Date().toISOString().slice(0, 10) };
  // the theme comes from what the parent named or the child's own interests (V14), not from the model's imagination;
  // for a subject without its own scene the model only picks which ready scene fits it best
  const sug = comp.suggested_theme, mt = s.director.theme, ready = comp.themes_ready.map(x => x.id);
  const refsOk = !!mt && Array.isArray(mt.interest_refs) && mt.interest_refs.every((r: string) => ctx.interests.some(i => i.id === r));
  const ownOk = refsOk && (ready.includes(mt.id) || (isCustomTheme(mt) && ready.includes(mt.skin) && !!mt.subject?.asset_id));
  let theme = sug;
  if (keep && ownOk) theme = mt;
  else if (isCustomTheme(sug)) theme = { ...sug, skin: ready.includes(mt?.skin) ? mt.skin : sug.skin, subject: { ...sug.subject!, kind: ['organism', 'object'].includes(mt?.subject?.kind) ? mt.subject.kind : sug.subject!.kind } };
  else if (ownOk && ready.includes(mt.id)) theme = mt;
  s.director.theme = { ...theme, no_husbandry: true };
  if (theme.skin && s.director.component_params?.[comp.name]) s.director.component_params[comp.name].theme = theme.skin;
  // the subject has to be seen: it waits in pending until its pictures or 3D are made and confirmed (V19)
  const subj = s.director.theme.subject as { name: string; asset_id: string; kind: string } | undefined;
  if (subj) {
    const pending = ((s.assets.pending ?? []) as { asset_id: string; kind: string }[]).filter(p => p.asset_id !== subj.asset_id && !(subj.kind === 'organism' && p.kind === 'organism'));
    s.assets.pending = [...pending, { asset_id: subj.asset_id, kind: subj.kind, realism_required: 'ai_from_photo', status: '待制作', until_ready: `不展示：${subj.name}的写实画面或 3D 做好、家长确认后才出现` }];
    s.assets.use = ((s.assets.use ?? []) as string[]).filter(id => id !== subj.asset_id);
  }
  const qs = (s.director.end_chat?.questions ?? []).filter((q: { kind?: string }) => q?.kind !== 'next_lesson_wish');
  s.director.end_chat = { skippable: true, questions: [...qs.slice(0, 2), comp.wish_question] };
  s.assets.scope = 'family';
  return s;
}

export async function generateLesson(o: {
  root: string; ctx: StudioContext; request?: LessonRequest; chat: Chat; rounds?: number; validatorCtx?: Partial<Ctx>;
  onLog?: (line: string) => void;
}): Promise<GenerateResult> {
  const log = o.onLog ?? (() => undefined);
  const messages = authorMessages(o.root, o.ctx, o.request ?? {});
  const max = o.rounds ?? 4;
  let last: GenerateResult = { ok: false, stages: null, spec: null, report: null, rounds: 0 };
  for (let round = 1; round <= max; round++) {
    log(round === 1 ? '模型正在写课…' : `第 ${round} 轮：模型按校验意见修改…`);
    const reply = await o.chat(messages);
    messages.push({ role: 'assistant', content: reply });
    let stages: Stages;
    try { stages = normalize(parseJsonReply(reply), o.ctx, o.request?.revise?.stages.target); }
    catch (e) {
      log(`返回内容不能用：${(e as Error).message}`);
      messages.push({ role: 'user', content: '刚才的回复不是要求的 JSON 对象。只输出 {"target":…,"director":…,"assets":…} 这一个 JSON 对象。' });
      last = { ...last, rounds: round };
      continue;
    }
    const { spec, report } = checkStages(o.root, stages, o.validatorCtx);
    last = { ok: report.ok, stages, spec, report, rounds: round };
    if (report.ok) { log(`校验通过（${report.warnings} 条警告）：${spec!.title}`); return last; }
    const list = issues(report).filter(i => i.level === 'error');
    log(`校验没通过：${list.length} 个问题（${[...new Set(list.map(i => i.rule))].join('、')}）`);
    messages.push({ role: 'user', content: `校验没通过，请逐条改正后重新输出完整 JSON（target、director、assets 三部分都要）：\n${list.map(i => `- [${i.rule}] ${i.path}：${i.msg}${i.fix ? `（怎么改：${i.fix}）` : ''}`).join('\n')}` });
  }
  return last;
}
