import Ajv2020 from 'ajv/dist/2020.js';
import type {
  AssetEntry, ChildProfile, ComponentDef, InterestObservation, LessonSpec, ReteachHistory,
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
];
