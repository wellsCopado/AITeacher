import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evalExpr, ExprError, loadContext, validate } from '../packages/validator/src/index.js';
import type { LessonSpec } from '../packages/schema/src/index.js';

const root = join(import.meta.dirname, '..');
const load = (id: string, ver: string): LessonSpec =>
  JSON.parse(readFileSync(join(root, 'content/lessons', id, ver, 'lessonspec.json'), 'utf8'));
const ctx = (previous?: LessonSpec) => loadContext(root, previous);
const failed = (sp: LessonSpec, c = ctx()) => validate(sp, c).results.filter(r => !r.ok).map(r => r.id);
const clone = <T>(x: T): T => structuredClone(x);

describe('safe formulas', () => {
  it('evaluates arithmetic with variables', () => {
    expect(evalExpr('2*(a+b)', { a: 6, b: 4 })).toBe(20);
    expect(evalExpr('a*b - -1', { a: 3, b: 3 })).toBe(10);
  });
  it('rejects anything that is not arithmetic', () => {
    for (const bad of ['process.exit()', 'a;b', 'a**2', '`x`', 'Math.max(a,b)']) expect(() => evalExpr(bad, { a: 1, b: 2 })).toThrow(ExprError);
    expect(() => evalExpr('a/0', { a: 1 })).toThrow('除以零');
  });
});

describe('sample lessons', () => {
  it('哥哥 L-PA@1.0 passes; written before the question-type rule, it only warns about its fill-ins (V20)', () => {
    const r = validate(load('L-PA', '1.0'), ctx());
    expect(r.ok).toBe(true);
    expect(r.results.filter(x => !x.ok).map(x => x.id)).toEqual(['V20']);
  });
  it('妹妹 L-ARR@1.0 passes and warns about the family-only wood texture', () => {
    const r = validate(load('L-ARR', '1.0'), ctx());
    expect(r.ok).toBe(true);
    expect(r.results.filter(x => !x.ok).map(x => x.id)).toEqual(['V12']);
  });
});

describe('each rule catches its failure', () => {
  const base = load('L-PA', '1.0');

  it('V01 schema and component params', () => {
    const sp = clone(base); (sp.component_params.PerimeterArea as { a: number }).a = 12;
    expect(failed(sp)).toContain('V01');
    const sp2 = clone(base) as unknown as Record<string, unknown>; delete sp2.parent_tip;
    expect(failed(sp2 as unknown as LessonSpec)).toContain('V01');
  });
  it('V02 wrong expected output, missing boundary case', () => {
    const sp = clone(base); sp.experiment_model_version.reference_cases[0].out = { P: 21, S: 24 };
    expect(failed(sp)).toContain('V02');
    const sp2 = clone(base); sp2.experiment_model_version.reference_cases = sp2.experiment_model_version.reference_cases.filter(c => !c.expect);
    expect(failed(sp2)).toContain('V02');
  });
  it('V03 hotspot without teaches, or teaching something off-target', () => {
    const sp = clone(base); sp.hotspots[2].teaches = null;
    expect(failed(sp)).toContain('V03');
    const sp2 = clone(base); sp2.activity_graph[0].teaches = 'M2.MUL.meaning_groups';
    expect(failed(sp2)).toContain('V03');
  });
  it('V04 / V05 language packs', () => {
    const sp = clone(base); sp.hotspots[0].language_pack.zh = ' ';
    expect(failed(sp)).toContain('V04');
    const sp2 = clone(base); sp2.hotspots[0].language_pack.en = ['only one'];
    expect(failed(sp2)).toContain('V05');
    const sp3 = clone(base); sp3.learner_profile.language.cycle_enabled = false;
    expect(failed(sp3)).toContain('V05');
  });
  it('V16 step time limits fit the lesson', () => {
    const sp = clone(base); sp.learner_profile.est_minutes = [8, 10];
    sp.timing = { steps: { explain: 60, demo: 240, challenge: 240, chat: 60 } };
    expect(failed(sp)).not.toContain('V16');
    sp.timing.steps!.demo = 400;
    expect(failed(sp)).toContain('V16');
  });
  it('V17 every question has a step-by-step demo ending in the answer and a similar question to do alone', () => {
    expect(failed(base)).not.toContain('V17');
    const sp = clone(base); delete sp.challenges[0].worked_example;
    expect(failed(sp)).toContain('V17');
    const sp2 = clone(base); sp2.challenges[0].worked_example = { steps: ['卷尺走一圈。', '所以是 16 米。'] };
    expect(validate(sp2, ctx()).results.find(r => r.id === 'V17')!.issues[0].msg).toContain('没说出答案 15');
    const sp3 = clone(base); sp3.challenges[0].twin = { prompt: sp3.challenges[0].prompt, answers: sp3.challenges[0].answers };
    expect(failed(sp3)).toContain('V17');
    const sp4 = clone(base); sp4.challenges[0].twin!.answers = [{ field: 'X', value: 1 }];
    expect(failed(sp4)).toContain('V17');
    const sp5 = clone(base); delete sp5.challenges[1].twin;
    expect(failed(sp5)).toContain('V17');
  });
  it('V18 a wrong answer comes with a real reason to keep going', () => {
    expect(failed(base)).not.toContain('V18');
    const sp = clone(base); delete sp.encouragement;
    expect(failed(sp)).toContain('V18');
    const sp2 = clone(base); sp2.encouragement = { persist: ['加油！', '螳螂虾的洞也是一点一点挖出来的。'] };
    expect(failed(sp2)).toContain('V18');
  });
  it('V20 challenges are mostly choice questions, at most one fill-in (a warning)', () => {
    const sp = clone(base);
    sp.challenges.forEach(c => { c.options = ['16', '15', '31']; c.answers = [c.answers[0]]; c.answers[0].value = '16'; });
    expect(failed(sp)).not.toContain('V20');
    delete sp.challenges[0].options; delete sp.challenges[1].options;
    const r = validate(sp, ctx()).results.find(x => x.id === 'V20')!;
    expect(r.ok).toBe(false); expect(r.level).toBe('warn'); expect(r.issues).toHaveLength(1);
    sp.challenges[2].options = ['1', '2', '3', '4', '5'];
    expect(validate(sp, ctx()).results.find(x => x.id === 'V20')!.issues).toHaveLength(2);
  });
  it('V06 unknown component, unreviewed version, code in content', () => {
    const sp = clone(base); sp.scene_component_ids = ['FancyGame@1.0'];
    expect(failed(sp)).toContain('V06');
    const sp2 = clone(base); sp2.scene_component_ids = ['PerimeterArea@9.9'];
    expect(failed(sp2)).toContain('V06');
    const sp3 = clone(base); sp3.hotspots[0].language_pack.zh += '<script>alert(1)</script>';
    expect(failed(sp3)).toContain('V06');
  });
  it('V07 unregistered or not-yet-procured asset', () => {
    const sp = clone(base); sp.object_asset_versions.push({ ...sp.object_asset_versions[0], asset_id: 'T-unknown' });
    expect(failed(sp)).toContain('V07');
    const sp2 = clone(base); sp2.object_asset_versions.push({ asset_id: 'M-peacock-mantis-shrimp', kind: 'organism', realism: 'scan', ver: '—', license: '待定', commercial_ok: false, source: 'x', depiction: '写实' });
    expect(failed(sp2)).toContain('V07');
  });
  it('V08 claims verified mapping without a verifier', () => {
    const sp = clone(base); sp.curriculum_mapping.status = '已核对本年级';
    expect(failed(sp)).toContain('V08');
  });
  it('V09 transfer missing or themed', () => {
    const sp = clone(base); sp.activity_graph = sp.activity_graph.filter(n => n.type !== 'transfer');
    expect(failed(sp)).toContain('V09');
    const sp2 = clone(base); sp2.challenges.forEach(c => (c.with_theme = true));
    expect(failed(sp2)).toContain('V09');
  });
  it('V10 reteach must change the teaching', () => {
    const sp = clone(base); sp.version = '1.1'; sp.previous_version = '1.0'; sp.trigger_judgment_ref = 'LJ-0001';
    expect(failed(sp, ctx(base))).toContain('V10');
    expect(failed(sp, ctx())).toContain('V10');
    sp.activity_graph.splice(1, 2, { id: 'n2', type: 'contrast', action: 'walk+fill', teaches: 'MC.perim_area_swap', complete: 'both_viewed' });
    expect(failed(sp, ctx(base))).not.toContain('V10');
  });
  it('V11 commercial release with family-only assets', () => {
    const sp = load('L-ARR', '1.0'); sp.distribution.scope = 'commercial';
    expect(failed(sp)).toContain('V11');
  });
  it('V13 realism floor', () => {
    const sp = clone(base);
    sp.object_asset_versions.push({ asset_id: 'M-peacock-mantis-shrimp-procedural', kind: 'organism', realism: 'stylized', ver: '0.1', license: 'CC0', commercial_ok: true, source: '程序建模', depiction: '看起来像动画片' });
    expect(failed(sp)).toContain('V13');
    const sp2 = clone(base); sp2.pending_assets![0].until_ready = '先用简化模型代替';
    expect(failed(sp2)).toContain('V13');
    const sp3 = clone(base); sp3.object_asset_versions.push({ asset_id: 'X', kind: 'organism', realism: 'ai_from_photo', ver: '1', license: 'CC0', commercial_ok: true, source: 'AI', depiction: '写实' });
    const v13 = validate(sp3, ctx()).results.find(r => r.id === 'V13')!;
    expect(v13.issues.map(i => i.path)).toEqual(expect.arrayContaining(['$.object_asset_versions[4].reference_photos', '$.object_asset_versions[4].checked_by', '$.object_asset_versions[4].depiction']));
  });
  it('V14 sibling interests, missing wish question, husbandry', () => {
    const mei = load('L-ARR', '1.0'); mei.theme.interest_refs = ['IO-0003']; mei.theme.neutral = false;
    expect(failed(mei)).toContain('V14');
    const sp = clone(base); sp.end_chat.questions = sp.end_chat.questions.filter(q => q.kind !== 'next_lesson_wish');
    expect(failed(sp)).toContain('V14');
    const mei2 = load('L-ARR', '1.0'); mei2.end_chat.questions.find(q => q.kind === 'next_lesson_wish')!.options.push('机器人');
    expect(failed(mei2)).toContain('V14');
    const sp2 = clone(base); sp2.offscreen!.task = '在家养殖一只螳螂虾';
    expect(failed(sp2)).toContain('V14');
  });
});
