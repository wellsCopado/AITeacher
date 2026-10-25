// The three stage files a lesson is written as (01-target, 02-director, 03-assets), turned into one LessonSpec
// and checked against V01–V20. Shared by the dls command line, the MCP tools and the built-in AI lesson writer.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AssetEntry, LessonSpec } from '../../schema/src/index.js';
import { loadContext, validate, type Ctx, type Report } from '../../validator/src/index.js';
import { STAGE_FILES as F, loadAssets, readJson, writeJson } from '../../cli/src/lib.js';

/** 01-target.json, 02-director.json and 03-assets.json of one lesson. */
export interface Stages { target: Record<string, any>; director: Record<string, any>; assets: Record<string, any> }

export class StageError extends Error {}

/** One LessonSpec from the stage files; asset references are filled in from the asset registry. */
export function assemble(stages: Stages, registry: AssetEntry[]): LessonSpec {
  const { target: t, director: d, assets: a } = stages;
  if (!t || !d || !a) throw new StageError('需要 target、director、assets 三部分（01-target / 02-director / 03-assets）');
  const missing: string[] = [];
  const refs = ((a.use ?? []) as string[]).map(id => {
    const r = registry.find(x => x.asset_id === id);
    if (!r) { missing.push(id); return null; }
    return {
      asset_id: r.asset_id, kind: r.kind, realism: r.realism, ver: r.version, license: r.license,
      commercial_ok: r.commercial_ok, source: r.source, depiction: r.depiction,
      ...(r.reference_photos ? { reference_photos: r.reference_photos } : {}),
      ...(r.checked_by !== undefined ? { checked_by: r.checked_by } : {}),
    };
  }).filter(Boolean);
  if (missing.length) throw new StageError(`资产库里没有：${missing.join('、')}（只能用 content/assets/registry.json 里登记过的素材）`);
  const spec = {
    schema_version: 'lessonspec/1.0',
    lesson_id: t.lesson_id, version: t.version, tenant_id: t.tenant_id, for_child: t.for_child,
    title: d.title,
    ...(t.previous_version ? { previous_version: t.previous_version } : {}),
    ...(t.trigger_judgment_ref ? { trigger_judgment_ref: t.trigger_judgment_ref } : {}),
    primary_concept: t.primary_concept,
    ...(t.prerequisites ? { prerequisites: t.prerequisites } : {}),
    curriculum_mapping: t.curriculum_mapping,
    theme: d.theme,
    intro: d.intro,
    learner_profile: t.learner_profile,
    scene_component_ids: d.scene_component_ids,
    component_params: d.component_params,
    experiment_model_version: d.experiment_model_version,
    activity_graph: d.activity_graph,
    hotspots: d.hotspots,
    challenges: d.challenges,
    end_chat: d.end_chat,
    object_asset_versions: refs,
    ...(a.pending?.length ? { pending_assets: a.pending } : {}),
    assessment_plan: d.assessment_plan,
    ...(d.offscreen ? { offscreen: d.offscreen } : {}),
    parent_tip: d.parent_tip,
    source_refs: d.source_refs,
    ...(d.encouragement ? { encouragement: d.encouragement } : {}),
    ...(d.timing ? { timing: d.timing } : {}),
    distribution: { scope: a.scope ?? 'family', tenant_id: t.tenant_id },
  };
  return spec as LessonSpec;
}

/** The stage files back from a LessonSpec (a draft the parent sent back, to be revised). */
export function disassemble(sp: LessonSpec): Stages {
  const opt = <K extends keyof LessonSpec>(k: K) => (sp[k] !== undefined ? { [k]: sp[k] } : {});
  return {
    target: {
      lesson_id: sp.lesson_id, version: sp.version, tenant_id: sp.tenant_id, for_child: sp.for_child,
      previous_version: sp.previous_version ?? null, trigger_judgment_ref: sp.trigger_judgment_ref ?? null,
      primary_concept: sp.primary_concept, ...opt('prerequisites'), curriculum_mapping: sp.curriculum_mapping, learner_profile: sp.learner_profile,
    },
    director: {
      title: sp.title, intro: sp.intro, theme: sp.theme, scene_component_ids: sp.scene_component_ids, component_params: sp.component_params,
      experiment_model_version: sp.experiment_model_version, activity_graph: sp.activity_graph, hotspots: sp.hotspots, challenges: sp.challenges,
      end_chat: sp.end_chat, assessment_plan: sp.assessment_plan, ...opt('offscreen'), parent_tip: sp.parent_tip, source_refs: sp.source_refs,
      ...opt('encouragement'), ...opt('timing'),
    },
    assets: { scope: sp.distribution?.scope ?? 'family', use: (sp.object_asset_versions ?? []).map(a => a.asset_id), pending: sp.pending_assets ?? [] },
  };
}

export function readStages(dir: string): Stages {
  for (const f of [F.target, F.director, F.assets]) if (!existsSync(join(dir, f))) throw new StageError(`${dir} 缺少 ${f}，先完成前面的阶段`);
  return { target: readJson(join(dir, F.target)), director: readJson(join(dir, F.director)), assets: readJson(join(dir, F.assets)) };
}

export function writeStages(dir: string, s: Stages) {
  writeJson(join(dir, F.target), s.target); writeJson(join(dir, F.director), s.director); writeJson(join(dir, F.assets), s.assets);
}

/** Problems as a flat list, the way a model or a person fixes them. */
export function issues(r: Report) {
  return r.results.filter(x => !x.ok).flatMap(x => x.issues.map(i => ({ rule: x.id, level: x.level, rule_name: x.name, path: i.path, msg: i.msg, fix: i.fix ?? null })));
}

/** Assemble and validate. Stage-level problems (missing parts, unknown assets) come back as a failed report too. */
export function checkStages(root: string, s: Stages, ctx?: Partial<Ctx>): { spec: LessonSpec | null; report: Report; key: string } {
  const key = `${s?.target?.lesson_id ?? '?'}@${s?.target?.version ?? '?'}`;
  let spec: LessonSpec;
  try { spec = assemble(s, loadAssets(root)); }
  catch (e) {
    if (!(e instanceof StageError)) throw e;
    return { spec: null, key, report: { lesson: key, ok: false, errors: 1, warnings: 0, results: [{ id: 'S00', name: '阶段文件能组装成一节课', basis: 'Skill 阶段 4', level: 'error', ok: false, issues: [{ path: '$', msg: e.message }] }] } };
  }
  return { spec, key, report: validate(spec, { ...loadContext(root), ...ctx }) };
}
