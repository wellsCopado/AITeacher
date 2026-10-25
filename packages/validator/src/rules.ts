import Ajv2020 from 'ajv/dist/2020.js';
import type {
  AssetEntry, Challenge, ChildProfile, ComponentDef, HandsOnTask, InterestObservation, LessonSpec, ReteachHistory,
} from '../../schema/src/index.js';
import { lessonSpecSchema } from '../../schema/src/index.js';
import { evalExpr, exprVars, ExprError } from './expr.js';

export interface Concept { name: string; misconceptions: string[] }
export interface Ctx {
  components: Record<string, ComponentDef>;
  concepts: Record<string, Concept>;
  assets: AssetEntry[];
  interests: InterestObservation[];
  children: Record<string, ChildProfile>;
  /** The version this one replaces; needed for V10 on a reteach. */
  previous?: LessonSpec | null;
  /** Earlier reteach attempts and whether they helped; needed for V15. */
  reteach?: ReteachHistory[];
}

/** The teaching mechanism of a lesson: which reviewed components carry the representation. */
export const mechanism = (sp: Pick<LessonSpec, 'scene_component_ids'>) => [...new Set(sp.scene_component_ids.map(c => c.split('@')[0]))].sort().join('+');
export interface Issue { path: string; msg: string; fix?: string }
export interface Rule {
  id: string; name: string; basis: string; level: 'error' | 'warn';
  /** Return the problems found; an empty list means the rule passes. */
  check(sp: LessonSpec, ctx: Ctx): Issue[];
}

const ajv = new (Ajv2020 as unknown as typeof Ajv2020.default)({ allErrors: true, strict: false });
const validateSpec = ajv.compile(lessonSpecSchema);
const paramValidators = new Map<string, ReturnType<typeof ajv.compile>>();

const splitId = (cid: string) => { const [name, ver] = cid.split('@'); return { name, ver }; };
const usable = (a: AssetEntry) => a.status === '采用' || a.status === '采用标记';

/** All strings in the spec, with their JSON paths, for content scans. */
function strings(v: unknown, path = '$', out: [string, string][] = []): [string, string][] {
  if (typeof v === 'string') out.push([path, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => strings(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) strings(x, `${path}.${k}`, out);
  return out;
}

export const RULES: Rule[] = [
  {
    id: 'V01', name: 'LessonSpec 符合 Schema，组件参数符合组件自带 Schema', basis: 'FR45', level: 'error',
    check(sp, ctx) {
      const issues: Issue[] = [];
      if (!validateSpec(sp)) {
        for (const e of validateSpec.errors ?? []) issues.push({ path: '$' + e.instancePath.replace(/\//g, '.'), msg: `${e.message ?? '不符合 Schema'}${e.params && 'allowedValues' in e.params ? `（可选：${(e.params as { allowedValues: unknown[] }).allowedValues.join(' / ')}）` : ''}` });
        return issues;
      }
      for (const cid of sp.scene_component_ids) {
        const { name } = splitId(cid);
        const def = ctx.components[name];
        if (!def) continue; // reported by V06
        const params = sp.component_params[name];
        if (params === undefined) { issues.push({ path: `$.component_params.${name}`, msg: `缺少组件 ${name} 的参数` }); continue; }
        let v = paramValidators.get(name);
        if (!v) { v = ajv.compile(def.paramsSchema); paramValidators.set(name, v); }
        if (!v(params)) for (const e of v.errors ?? []) issues.push({ path: `$.component_params.${name}${e.instancePath.replace(/\//g, '.')}`, msg: e.message ?? '参数不合法' });
      }
      if (sp.distribution.tenant_id !== sp.tenant_id) issues.push({ path: '$.distribution.tenant_id', msg: '与 tenant_id 不一致' });
      if (sp.learner_profile.grade !== sp.curriculum_mapping.grade) issues.push({ path: '$.learner_profile.grade', msg: '与教材映射的年级不一致' });
      return issues;
    },
  },
  {
    id: 'V02', name: '参考算例全部通过（含零值与越界），公式只用安全四则运算', basis: 'FR09 / AC05', level: 'error',
    check(sp) {
      const m = sp.experiment_model_version; const issues: Issue[] = [];
      for (const [k, o] of Object.entries(m.outputs)) {
        try { for (const v of exprVars(o.expr)) if (!(v in m.vars)) issues.push({ path: `$.experiment_model_version.outputs.${k}`, msg: `公式用了未声明的变量 ${v}` }); }
        catch (e) { issues.push({ path: `$.experiment_model_version.outputs.${k}`, msg: (e as Error).message }); }
      }
      const hasBoundary = m.reference_cases.some(c => c.expect === 'reject_out_of_range');
      if (!hasBoundary) issues.push({ path: '$.experiment_model_version.reference_cases', msg: '缺少越界算例', fix: '加一条 expect: reject_out_of_range 的算例' });
      m.reference_cases.forEach((c, i) => {
        const p = `$.experiment_model_version.reference_cases[${i}]`;
        const inRange = Object.entries(m.vars).every(([k, v]) => {
          const x = c.in[k];
          return typeof x === 'number' && x >= v.min && x <= v.max && Math.abs((x - v.min) / v.step - Math.round((x - v.min) / v.step)) < 1e-9;
        });
        if (c.expect === 'reject_out_of_range') { if (inRange) issues.push({ path: p, msg: '标为越界，但输入在合法范围内' }); return; }
        if (!inRange) { issues.push({ path: p, msg: '输入超出变量范围或不在步长上' }); return; }
        if (!c.out) { issues.push({ path: p, msg: '缺少期望输出 out' }); return; }
        for (const [k, want] of Object.entries(c.out)) {
          const o = m.outputs[k];
          if (!o) { issues.push({ path: `${p}.out.${k}`, msg: `没有名为 ${k} 的输出` }); continue; }
          try {
            const got = evalExpr(o.expr, c.in);
            if (Math.abs(got - want) > 1e-9) issues.push({ path: `${p}.out.${k}`, msg: `期望 ${want}，公式算出 ${got}` });
          } catch (e) { issues.push({ path: `${p}.out.${k}`, msg: e instanceof ExprError ? e.message : String(e) }); }
        }
      });
      return issues;
    },
  },
  {
    id: 'V03', name: '每个活动节点和热点都写了 teaches，且引用存在的知识点或误区', basis: 'BL02', level: 'error',
    check(sp, ctx) {
      const allowed = new Set<string>([
        sp.primary_concept.id, ...sp.primary_concept.target_misconceptions,
        ...(ctx.concepts[sp.primary_concept.id]?.misconceptions ?? []), ...(sp.prerequisites ?? []),
      ]);
      const issues: Issue[] = [];
      if (!ctx.concepts[sp.primary_concept.id]) issues.push({ path: '$.primary_concept.id', msg: `知识点 ${sp.primary_concept.id} 不在 concepts.json` });
      const chk = (t: string | null, path: string) => {
        if (!t) issues.push({ path, msg: '没有写它帮助理解哪个知识', fix: '填主知识点、它的误区或前置知识点的 id' });
        else if (!allowed.has(t)) issues.push({ path, msg: `${t} 不是本课的主知识点、误区或前置知识点` });
      };
      sp.activity_graph.forEach((n, i) => chk(n.teaches, `$.activity_graph[${i}].teaches`));
      sp.hotspots.forEach((h, i) => chk(h.teaches, `$.hotspots[${i}].teaches`));
      return issues;
    },
  },
  {
    id: 'V04', name: '每个热点都有中文讲解', basis: 'FR13', level: 'error',
    check: sp => sp.hotspots.flatMap((h, i) => h.language_pack.zh.trim() ? [] : [{ path: `$.hotspots[${i}].language_pack.zh`, msg: '中文讲解为空' }]),
  },
  {
    id: 'V05', name: '讲解固定 1 中 3 英：每个热点英文 3 条齐全，不提供纯中文模式', basis: 'FR13 / BL06', level: 'error',
    check: sp => [
      ...(sp.learner_profile.language.cycle_enabled ? [] : [{ path: '$.learner_profile.language.cycle_enabled', msg: '讲解必须是 1 中 3 英循环', fix: 'cycle_enabled: true' }]),
      ...sp.hotspots.flatMap((h, i) => {
        const n = h.language_pack.en.filter(s => s && s.trim()).length;
        return n === 3 ? [] : [{ path: `$.hotspots[${i}].language_pack.en`, msg: `英文只有 ${n} 条，要写满 3 条` }];
      }),
    ],
  },
  {
    id: 'V06', name: '只引用已审组件及其版本；Spec 中没有脚本、HTML 或代码', basis: 'FR44', level: 'error',
    check(sp, ctx) {
      const issues: Issue[] = [];
      const anchors = new Set<string>();
      sp.scene_component_ids.forEach((cid, i) => {
        const { name, ver } = splitId(cid);
        const def = ctx.components[name];
        if (!def || def.status !== '已审') { issues.push({ path: `$.scene_component_ids[${i}]`, msg: `${name} 不在已审组件白名单` }); return; }
        if (!def.versions.includes(ver)) issues.push({ path: `$.scene_component_ids[${i}]`, msg: `${name} 没有已审版本 ${ver}（已审：${def.versions.join('、')}）` });
        def.hotspotAnchors.forEach(a => anchors.add(a));
        if (sp.theme.skin && !def.themes.includes(sp.theme.skin)) issues.push({ path: '$.theme.skin', msg: `组件 ${name} 没有主题皮肤 ${sp.theme.skin}` });
      });
      sp.hotspots.forEach((h, i) => { if (anchors.size && !anchors.has(h.anchor)) issues.push({ path: `$.hotspots[${i}].anchor`, msg: `锚点 ${h.anchor} 不在组件提供的锚点里` }); });
      const code = /<\s*\/?\s*(script|iframe|img|svg|style|a)\b|javascript:|\bfunction\s*\(|=>|\beval\s*\(|\bimport\s*\(/i;
      for (const [path, s] of strings(sp)) {
        if (/^\$\.source_refs\[\d+\]\.url$/.test(path)) continue;
        if (code.test(s)) issues.push({ path, msg: '内容里像是有代码或 HTML' });
      }
      return issues;
    },
  },
  {
    id: 'V07', name: '每个素材有许可证和来源，已在资产库登记并采用，示意已标注', basis: 'FR04 / FR05', level: 'error',
    check(sp, ctx) {
      const issues: Issue[] = [];
      sp.object_asset_versions.forEach((a, i) => {
        const p = `$.object_asset_versions[${i}]`;
        if (!a.license.trim() || !a.source.trim() || !a.depiction.trim()) issues.push({ path: p, msg: '许可、来源或 depiction 为空' });
        const reg = ctx.assets.find(x => x.asset_id === a.asset_id);
        if (!reg) { issues.push({ path: p, msg: `${a.asset_id} 没有在资产库登记` }); return; }
        if (!usable(reg)) issues.push({ path: p, msg: `${a.asset_id} 在资产库的状态是「${reg.status}」，不能引用`, fix: reg.status === '待采购' ? '移到 pending_assets，并写明到位前不展示' : '换一个已采用的素材' });
        if (reg.license !== a.license || reg.commercial_ok !== a.commercial_ok || reg.realism !== a.realism) issues.push({ path: p, msg: '与资产库登记的许可、可商用或写实等级不一致', fix: '重新运行 dls assemble 从资产库带入' });
        if (/待核验|不明/.test(a.license) && reg.status !== '采用标记') issues.push({ path: p, msg: '许可未核验的素材必须是「采用标记」' });
      });
      return issues;
    },
  },
  {
    id: 'V08', name: '教材映射未核对时不标「已核对本年级」', basis: 'R01 / BL04', level: 'error',
    check: sp => sp.curriculum_mapping.status === '已核对本年级' && !sp.curriculum_mapping.verified_by
      ? [{ path: '$.curriculum_mapping.verified_by', msg: '标了已核对，但没有核对人', fix: '改成「参考·待核对」，或填写核对人' }] : [],
  },
  {
    id: 'V09', name: '有迁移节点，且迁移题不带原主题', basis: 'FR24 / R11', level: 'error',
    check(sp) {
      const tr = sp.activity_graph.filter(n => n.type === 'transfer');
      if (!tr.length) return [{ path: '$.activity_graph', msg: '没有迁移（transfer）节点' }];
      const issues: Issue[] = [];
      tr.forEach(n => {
        const idx = sp.activity_graph.indexOf(n);
        if (!n.no_theme) issues.push({ path: `$.activity_graph[${idx}].no_theme`, msg: '迁移节点必须 no_theme: true' });
        const items = n.items ?? [];
        if (!items.length) issues.push({ path: `$.activity_graph[${idx}].items`, msg: '迁移节点没有题目' });
        for (const id of items) {
          const c = sp.challenges.find(x => x.id === id);
          if (!c) issues.push({ path: `$.activity_graph[${idx}].items`, msg: `题目 ${id} 不存在` });
        }
        if (items.length && items.every(id => sp.challenges.find(x => x.id === id)?.with_theme)) issues.push({ path: `$.activity_graph[${idx}].items`, msg: '迁移题全部带原主题，至少一道要换成不带主题的题' });
      });
      return issues;
    },
  },
  {
    id: 'V10', name: '重教版与上一版相比主表征有实质变化', basis: 'FR24', level: 'error',
    check(sp, ctx) {
      if (!sp.trigger_judgment_ref) return [];
      const prev = ctx.previous;
      if (!prev) return [{ path: '$.previous_version', msg: '这是重教版，但没有提供上一版用于比较', fix: 'dls validate 时用 --previous 指定上一版' }];
      const sig = (s: LessonSpec) => JSON.stringify([s.scene_component_ids, s.activity_graph.map(n => [n.type, n.action ?? ''])]);
      const issues: Issue[] = [];
      if (sig(sp) === sig(prev)) issues.push({ path: '$.activity_graph', msg: '与上一版的组件和活动结构完全相同，没有换教法' });
      if (!sp.activity_graph.some(n => n.type === 'contrast')) issues.push({ path: '$.activity_graph', msg: '重教版需要一个 contrast（对比）节点' });
      return issues;
    },
  },
  {
    id: 'V11', name: '商用发布不得含仅家用素材', basis: 'FR04', level: 'error',
    check: sp => sp.distribution.scope !== 'commercial' ? [] : sp.object_asset_versions.flatMap((a, i) => a.commercial_ok ? [] : [{ path: `$.object_asset_versions[${i}]`, msg: `${a.asset_id} 仅限家用` }]),
  },
  {
    id: 'V12', name: '含仅家用素材时提示：商用前需替换', basis: 'FR04', level: 'warn',
    check: sp => sp.object_asset_versions.flatMap((a, i) => a.commercial_ok ? [] : [{ path: `$.object_asset_versions[${i}]`, msg: `${a.asset_id} 仅限家用，商用前替换` }]),
  },
  {
    id: 'V13', name: '写实底线：无卡通或简化生物；生物只用扫描、实拍或依据照片的 AI 生成；未到位不展示', basis: 'BL14 / R04', level: 'error',
    check(sp) {
      const issues: Issue[] = [];
      sp.object_asset_versions.forEach((a, i) => {
        const p = `$.object_asset_versions[${i}]`;
        if (a.realism === 'stylized') issues.push({ path: p, msg: `${a.asset_id} 是卡通或风格化素材` });
        if (a.kind === 'organism' && !['scan', 'photo', 'ai_from_photo'].includes(a.realism)) issues.push({ path: p, msg: `生物 ${a.asset_id} 的写实等级是 ${a.realism}，只能用 scan、photo 或 ai_from_photo` });
        if (a.realism === 'ai_from_photo') {
          if ((a.reference_photos?.length ?? 0) < 3) issues.push({ path: `${p}.reference_photos`, msg: 'AI 依据照片生成的素材需要至少 3 张参考照片来源' });
          if (!a.checked_by) issues.push({ path: `${p}.checked_by`, msg: 'AI 依据照片生成的素材需要写明核对人' });
          if (!/AI 依据照片生成/.test(a.depiction)) issues.push({ path: `${p}.depiction`, msg: 'depiction 要标注「AI 依据照片生成」' });
        }
      });
      (sp.pending_assets ?? []).forEach((pa, i) => {
        if (!/不展示/.test(pa.until_ready)) issues.push({ path: `$.pending_assets[${i}].until_ready`, msg: '未到位的素材必须写明「不展示」，不能用占位模型代替' });
      });
      return issues;
    },
  },
  {
    id: 'V14', name: '主题来自该孩子的兴趣记录；课末有「下一课心愿」；不含养殖经营', basis: 'BL05 / BL12', level: 'error',
    check(sp, ctx) {
      const issues: Issue[] = [];
      const mine = ctx.interests.filter(x => x.child === sp.for_child && x.tenant_id === sp.tenant_id);
      sp.theme.interest_refs.forEach((id, i) => {
        const rec = ctx.interests.find(x => x.id === id);
        if (!rec) issues.push({ path: `$.theme.interest_refs[${i}]`, msg: `兴趣记录 ${id} 不存在` });
        else if (rec.child !== sp.for_child) issues.push({ path: `$.theme.interest_refs[${i}]`, msg: `${id} 是另一个孩子的兴趣，不能直接套用`, fix: '用这个孩子自己的兴趣记录，或用中性题材并在课末问她自己的心愿' });
        else if (rec.tenant_id !== sp.tenant_id) issues.push({ path: `$.theme.interest_refs[${i}]`, msg: `${id} 属于其他租户` });
      });
      if (!sp.theme.interest_refs.length && !sp.theme.neutral) issues.push({ path: '$.theme', msg: '没有引用兴趣记录，也没有标为中性题材', fix: '引用兴趣记录，或设 neutral: true 并说明原因' });
      const wish = sp.end_chat.questions.find(q => q.kind === 'next_lesson_wish');
      if (!wish) issues.push({ path: '$.end_chat.questions', msg: '课末缺少「下一次课你想学什么」问题' });
      else {
        const child = ctx.children[sp.for_child];
        if (!child) issues.push({ path: '$.for_child', msg: `children.json 里没有 ${sp.for_child}` });
        else {
          // Options come from this child's own list or interests; "还是…" may repeat one of them.
          const own = [...child.wish_fallback_options, ...mine.map(x => x.topic)];
          wish.options.forEach((o, i) => {
            if (!own.some(t => o === t || (o.startsWith('还是') && o.includes(t)))) issues.push({ path: `$.end_chat.questions[${sp.end_chat.questions.indexOf(wish)}].options[${i}]`, msg: `选项「${o}」不是 ${child.name} 自己的兴趣或选项` });
          });
          if (!wish.allow_own_words) issues.push({ path: '$.end_chat', msg: '心愿问题要允许孩子「自己说一个」', fix: 'allow_own_words: true' });
        }
      }
      for (const [path, s] of strings(sp)) if (/养殖|饲养|喂食|经营/.test(s)) issues.push({ path, msg: '出现养殖或经营内容（BL12 不做）' });
      return issues;
    },
  },
  {
    id: 'V19', name: '主题讲的东西要看得到：有主角时，主角的写实画面或 3D 已在素材里或列为待制作', basis: 'BL02 / BL14', level: 'error',
    check(sp) {
      const t = sp.theme, issues: Issue[] = [];
      if (t.id.startsWith('topic-') && !t.subject) issues.push({ path: '$.theme', msg: '这个主题还没有专门场景，要写 theme.subject（主角）', fix: '原样用上下文 suggested_theme 里的 subject' });
      if (!t.subject) return issues;
      const listed = (sp.pending_assets ?? []).some(p => p.asset_id === t.subject!.asset_id) || (sp.object_asset_versions ?? []).some(a => a.asset_id === t.subject!.asset_id);
      if (!listed) issues.push({ path: '$.pending_assets', msg: `主角「${t.subject.name}」（${t.subject.asset_id}）不在素材里`, fix: `在 03-assets 的 pending 里加 ${t.subject.asset_id}，until_ready 写“不展示……”` });
      if (!sp.title.includes(t.subject.name) && !sp.intro?.headline?.includes(t.subject.name)) issues.push({ path: '$.title', msg: `标题或说明页标题里要出现主角「${t.subject.name}」` });
      return issues;
    },
  },
  {
    id: 'V20', name: '挑战题以选择题、应用题和动手题为主，没有选项的填空题最多 1 道，能动手的组件至少 1 道动手题', basis: '家长要求：少出填空，多出选择、应用和动手题', level: 'warn',
    check(sp, ctx) {
      const out: Issue[] = [];
      const fills = sp.challenges.map((c, i) => ({ c, i })).filter(x => !x.c.options && !x.c.task);
      const comp = ctx.components[splitId(sp.scene_component_ids[0] ?? '').name];
      if (comp?.handsOn?.build && !sp.challenges.some(c => c.task)) out.push({ path: '$.challenges', msg: '这节课还没有动手题', fix: `加一道 task: { type: "build", start, controls } 的动手题（可以把一道填空题改成动手题），让孩子把场景摆成答案要求的样子；能改的参数：${comp.handsOn.build.join('、')}` });
      fills.slice(1).forEach(({ i }) => out.push({ path: `$.challenges[${i}]`, msg: `第 ${i + 1} 题是填空题，这节课已经有 1 道填空题了`, fix: '改成选择题：写 3–4 个 options，每个错误选项对应一个常见误区；同类题也写 options' }));
      sp.challenges.forEach((c, i) => {
        if (c.options && c.options.length > 4) out.push({ path: `$.challenges[${i}].options`, msg: `第 ${i + 1} 题有 ${c.options.length} 个选项，太多了`, fix: '留 2–4 个，错误选项各对应一个误区' });
      });
      return out;
    },
  },
  {
    id: 'V21', name: '动手题能做：参数是组件允许孩子改的、开始和答案都在范围内、开始时还没做对、同类题也是动手题', basis: '家长要求：动手操作题', level: 'error',
    check(sp, ctx) {
      const out: Issue[] = [];
      const name = splitId(sp.scene_component_ids[0] ?? '').name, comp = ctx.components[name];
      const props = ((comp?.paramsSchema ?? {}) as { properties?: Record<string, { minimum?: number; maximum?: number }> }).properties ?? {};
      const inRange = (k: string, v: number) => Number.isInteger(v) && v >= (props[k]?.minimum ?? -Infinity) && v <= (props[k]?.maximum ?? Infinity);
      const one = (at: string, q: { answers: Challenge['answers']; options?: string[]; task?: HandsOnTask }, label: string) => {
        const t = q.task!, can = comp?.handsOn?.[t.type];
        if (!can) { out.push({ path: `${at}.task`, msg: `${label}：组件 ${name} 不支持 ${t.type} 动手题`, fix: '去掉 task，改成选择题' }); return; }
        const bad = t.controls.filter(k => !can.includes(k));
        if (bad.length) out.push({ path: `${at}.task.controls`, msg: `${label}：${bad.join('、')} 不能让孩子改`, fix: `controls 只能从 ${can.join('、')} 里选` });
        for (const k of can) {
          const v = t.start[k];
          if (v === undefined) out.push({ path: `${at}.task.start`, msg: `${label}：start 缺少 ${k}`, fix: `start 写全 ${can.join('、')}` });
          else if (!inRange(k, v)) out.push({ path: `${at}.task.start.${k}`, msg: `${label}：start 的 ${k} = ${v} 超出组件范围` });
        }
        const fields = q.answers.map(a => a.field).sort().join(','), ctl = [...t.controls].sort().join(',');
        if (fields !== ctl) out.push({ path: `${at}.answers`, msg: `${label}：答案要正好是孩子能改的 ${t.controls.join('、')}`, fix: '每个 control 一条答案，field 就是参数名' });
        for (const a of q.answers) if (typeof a.value !== 'number' || !inRange(a.field, a.value)) out.push({ path: `${at}.answers`, msg: `${label}：答案 ${a.field} = ${a.value} 不是范围内的整数` });
        if (q.answers.every(a => t.start[a.field] === a.value)) out.push({ path: `${at}.task.start`, msg: `${label}：一开始就已经是答案了，孩子不用动手`, fix: '让 start 和答案不一样' });
        if (q.options) out.push({ path: `${at}.options`, msg: `${label}：动手题不要选项` });
      };
      sp.challenges.forEach((c, i) => {
        const at = `$.challenges[${i}]`;
        if (c.task) one(at, c, `第 ${i + 1} 题`);
        if (c.twin && !!c.task !== !!c.twin.task) out.push({ path: `${at}.twin.task`, msg: `第 ${i + 1} 题${c.task ? '是动手题，同类题也要是' : '不是动手题，同类题也不要 task'}` });
        else if (c.twin?.task) one(`${at}.twin`, c.twin, `第 ${i + 1} 题的同类题`);
      });
      return out;
    },
  },
  {
    id: 'V15', name: '同一机制连续 3 次重教未见效时必须换机制', basis: 'FR24', level: 'error',
    check(sp, ctx) {
      if (!sp.trigger_judgment_ref) return [];
      const hist = (ctx.reteach ?? []).filter(h => h.child === sp.for_child && h.concept_id === sp.primary_concept.id && h.outcome !== '待验证');
      let streak = 0;
      const mine = mechanism(sp);
      for (let k = hist.length - 1; k >= 0 && hist[k].outcome === '未见效' && hist[k].mechanism === mine; k--) streak++;
      return streak >= 3 ? [{ path: '$.scene_component_ids', msg: `${mine} 已经连续 ${streak} 次重教未见效`, fix: '换一个组件或表征；没有合适组件时请家长开组件工单' }] : [];
    },
  },
  {
    id: 'V16', name: '每一步都有时间上限，加起来不超过本课预计时长', basis: 'FR10', level: 'error',
    check(sp) {
      const steps = sp.timing?.steps ?? {};
      const max = (sp.learner_profile.est_minutes?.[1] ?? 12) * 60;
      const total = Object.values(steps).reduce((a, b) => a + (b ?? 0), 0);
      return total > max ? [{ path: '$.timing.steps', msg: `各步时间加起来 ${total} 秒，超过预计的 ${max} 秒`, fix: '缩短某一步，或调大 est_minutes' }] : [];
    },
  },
  {
    id: 'V17', name: '每道题都有“错三次就演示一遍，再做一道同类题”', basis: '家长要求：不能卡在一道题上', level: 'error',
    check(sp) {
      const out: Issue[] = [];
      sp.challenges.forEach((c, i) => {
        const at = `$.challenges[${i}]`;
        const steps = c.worked_example?.steps ?? [];
        if (steps.length < 2) out.push({ path: `${at}.worked_example`, msg: `第 ${i + 1} 题没有分步演示`, fix: '写 2–5 步，每步一句孩子听得懂的话，最后一步说出答案' });
        else {
          const last = steps[steps.length - 1];
          const missing = c.answers.filter(a => !last.includes(String(a.value)));
          if (missing.length) out.push({ path: `${at}.worked_example.steps`, msg: `第 ${i + 1} 题演示的最后一步没说出答案 ${missing.map(a => a.value).join('、')}`, fix: '最后一步写“所以……是 X”' });
        }
        if (!c.twin) out.push({ path: `${at}.twin`, msg: `第 ${i + 1} 题没有演示后让孩子自己做的同类题`, fix: '同一个方法，换数字或换情境出一道' });
        else {
          if (c.twin.prompt.trim() === c.prompt.trim()) out.push({ path: `${at}.twin.prompt`, msg: `第 ${i + 1} 题的同类题和原题一样`, fix: '换数字或换情境，孩子要自己用一遍方法，不是照抄答案' });
          const fields = (xs: { field: string }[]) => xs.map(a => a.field).sort().join(',');
          if (fields(c.twin.answers) !== fields(c.answers)) out.push({ path: `${at}.twin.answers`, msg: `第 ${i + 1} 题的同类题要填的空和原题不一样`, fix: '同类题用和原题相同的 field，Pad 才能用同样的输入框' });
          if (!!c.options !== !!c.twin.options) out.push({ path: `${at}.twin.options`, msg: `第 ${i + 1} 题是${c.options ? '选择题' : '填空题'}，同类题也要是`, fix: c.options ? '给同类题写 options' : '去掉同类题的 options' });
          else if (c.twin.options) for (const a of c.twin.answers) if (!c.twin.options.includes(String(a.value))) out.push({ path: `${at}.twin.answers`, msg: `第 ${i + 1} 题同类题的答案“${a.value}”不在选项里`, fix: '把答案写进 options' });
        }
      });
      return out;
    },
  },
  {
    id: 'V18', name: '答错时有给孩子坚持下去的理由', basis: 'BL10 · 家长要求：多给孩子信心', level: 'error',
    check(sp) {
      const p = sp.encouragement?.persist ?? [];
      if (p.length < 2) return [{ path: '$.encouragement.persist', msg: '没写答错时鼓励孩子坚持的话（至少 2 句）', fix: '结合这节课的主题写，例如“螳螂虾的洞也是一点点挖出来的，我们再试一次”' }];
      const empty = p.filter(x => /^(真棒|很棒|你真棒|加油|好)[！!。]?$/.test(x.trim()));
      return empty.length ? [{ path: '$.encouragement.persist', msg: `“${empty[0]}”太空了，孩子听不出为什么要坚持`, fix: '说出一个具体的理由，最好和主题相连' }] : [];
    },
  },
];
