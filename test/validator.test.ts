import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evalExpr, ExprError, isNewLesson, loadContext, validate } from '../packages/validator/src/index.js';
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
  it('哥哥 L-PA@1.0 passes; written before the question-type and picture rules, it only warns about them (V20, V23)', () => {
    const r = validate(load('L-PA', '1.0'), ctx());
    expect(r.ok).toBe(true);
    expect(r.results.filter(x => !x.ok).map(x => x.id)).toEqual(['V20', 'V23']);
    expect(isNewLesson('L-PA@1.0')).toBe(false);
  });
  it('妹妹 L-ARR@1.0 passes and warns about the family-only wood texture (and, written before them, the question types and pictures)', () => {
    const r = validate(load('L-ARR', '1.0'), ctx());
    expect(r.ok).toBe(true);
    expect(r.results.filter(x => !x.ok).map(x => x.id)).toEqual(['V12', 'V20', 'V23']);
  });
  it('the example L-PA@1.1 has every question type and picture, and passes with nothing to warn about', () => {
    const r = validate(load('L-PA', '1.1'), ctx(), { newLesson: true });
    expect(r.results.filter(x => !x.ok).map(x => x.id)).toEqual([]);
  });
  it('a new lesson must follow the question-type and picture rules: V20 and V23 are errors for it', () => {
    const r = validate(load('L-PA', '1.0'), ctx(), { newLesson: isNewLesson('L-PA-9@1.0') });
    expect(r.ok).toBe(false);
    expect(r.results.filter(x => !x.ok && x.level === 'error').map(x => x.id)).toEqual(['V20', 'V23']);
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
  it('V29 a scene the parent judged not photoreal is never shown to the child', () => {
    expect(failed(base)).not.toContain('V29');
    const sp = clone(base); sp.theme.skin = 'robot_factory';
    const r = validate(sp, ctx()).results.find(x => x.id === 'V29')!;
    expect(r.ok).toBe(false);
    expect(r.level).toBe('error');
    expect(r.issues[0].fix).toContain('探索课');
  });

  it('V28 lines the child hears are written to be read aloud, not looked at', () => {
    expect(failed(base)).not.toContain('V28');
    const issues = (sp: LessonSpec) => validate(sp, ctx()).results.find(r => r.id === "V28")!.issues.map(i => i.msg).join(' | ');
    const sp = clone(base);
    sp.intro.paragraphs[0] = '太棒了！！！我们出发吧~';
    sp.challenges[0].hints = ['想一想……长是 3.5m，宽是 1/4 那么多'];
    const msg = issues(sp);
    expect(msg).toContain('连用了几个');
    expect(msg).toContain('~ 或表情');
    expect(msg).toContain('省略号');
    expect(msg).toContain('单位或分数');
    expect(validate(sp, ctx()).results.find(r => r.id === "V28")!.level).toBe('warn');
    // English narration and answer expressions are left alone
    const sp2 = clone(base); sp2.challenges[0].answers = [{ ...sp2.challenges[0].answers[0] }];
    expect(issues(sp2)).toBe('');
  });
  /** L-PA with a hands-on first question (size the survey area 5 × 3 m) and choice questions after it. */
  const handsOn = () => {
    const sp = clone(base);
    const [c0, c1, c2] = sp.challenges;
    Object.assign(c0, { prompt: '把调查区摆成长 5 米、宽 3 米。', task: { type: 'build', start: { a: 2, b: 2 }, controls: ['a', 'b'] },
      answers: [{ field: 'a', label: '长', value: 5, unit: '米' }, { field: 'b', label: '宽', value: 3, unit: '米' }],
      worked_example: { steps: ['先把长拉到 5 米。', '再把宽拉到 3 米：长 5 米、宽 3 米。'] },
      twin: { prompt: '把调查区摆成长 6 米、宽 2 米。', task: { type: 'build', start: { a: 1, b: 1 }, controls: ['a', 'b'] },
        answers: [{ field: 'a', label: '长', value: 6, unit: '米' }, { field: 'b', label: '宽', value: 2, unit: '米' }] } });
    delete c0.options;
    for (const c of [c1, c2]) {
      c.answers = [{ field: 'P', value: '16 米' }]; c.options = ['16 米', '15 米', '31 米'];
      c.worked_example = { steps: ['一圈是 5 + 3 + 5 + 3。', '所以是 16 米。'] };
      c.twin = { prompt: `${c.prompt}（换一块）`, answers: [{ field: 'P', value: '12 米' }], options: ['12 米', '8 米', '20 米'] };
    }
    return sp;
  };
  it('V20 mostly choice and hands-on questions, at most one fill-in, a hands-on one when the scene allows (warnings)', () => {
    const sp = handsOn();
    expect(failed(sp)).not.toContain('V20');
    const v20 = (x: LessonSpec) => validate(x, ctx()).results.find(r => r.id === 'V20')!;
    const noHands = clone(sp); delete noHands.challenges[0].task; delete noHands.challenges[0].twin!.task;
    expect(v20(noHands).level).toBe('warn');
    expect(v20(noHands).issues.map(i => i.msg)).toEqual(['这节课还没有动手题']);
    const fills = clone(sp); delete fills.challenges[1].options; delete fills.challenges[2].options;
    expect(v20(fills).issues).toHaveLength(1);
    const many = clone(sp); many.challenges[1].options = ['1', '2', '3', '4', '5'];
    expect(v20(many).issues).toHaveLength(1);
  });
  it('V24 the subject lives where the scene is: a cricket is never on the sea floor, and nothing is copied from the example', () => {
    // the 螳螂虾 lesson itself has no subject of its own: the reef is its scene, nothing to check
    expect(failed(clone(base))).not.toContain('V24');
    const cricket = (skin: string) => {
      const sp = clone(base);
      sp.theme = { ...sp.theme, id: 'topic-1234abcd', name: '蟋蟀', skin, subject: { name: '蟋蟀', asset_id: 'S-1234abcd', kind: 'organism' } };
      (sp.component_params.PerimeterArea as { theme: string }).theme = skin;
      return sp;
    };
    // what kenking got: a cricket lesson on the reef, still talking about the mantis shrimp and the sea floor
    const wrong = validate(cricket('reef'), ctx()).results.find(r => r.id === 'V24')!;
    expect(wrong.ok).toBe(false);
    expect(wrong.issues[0]).toMatchObject({ path: '$.theme.skin', msg: '「蟋蟀」生活在院子和草丛，场景「珊瑚礁样方调查」却在海里' });
    expect(wrong.issues[0].fix).toContain('garden');
    expect(wrong.issues.some(i => i.msg.includes('写了螳螂虾'))).toBe(true);
    expect(wrong.issues.some(i => i.msg.includes('海底、珊瑚或潜水'))).toBe(true);
    // on grass it still fails while the words are the example's
    const grass = cricket('garden');
    expect(validate(grass, ctx()).results.find(r => r.id === 'V24')!.issues.every(i => !i.path.includes('skin') && !i.path.includes('theme'))).toBe(true);
    const clean = JSON.parse(JSON.stringify(grass).replace(/螳螂虾|mantis shrimp|珊瑚礁|珊瑚|海底|潜到|sea floor/gi, '蟋蟀'));
    clean.theme = grass.theme; clean.end_chat = grass.end_chat;
    expect(failed(clean)).not.toContain('V24');
    // the scene the 3D engine draws and the theme's scene have to be the same one
    const split = clone(clean); (split.component_params.PerimeterArea as { theme: string }).theme = 'reef';
    expect(validate(split, ctx()).results.find(r => r.id === 'V24')!.issues.map(i => i.msg).join()).toContain('两个要一样');
    // a sea animal on the reef is right
    const worm = JSON.parse(JSON.stringify(clone(base)).replaceAll('螳螂虾', '博比特虫').replace(/mantis shrimp/gi, 'bobbit worm'));
    worm.theme = { ...worm.theme, id: 'topic-5678abcd', name: '博比特虫', subject: { name: '博比特虫', asset_id: 'S-5678abcd', kind: 'organism' } };
    worm.end_chat = base.end_chat;
    expect(failed(worm)).not.toContain('V24');
    // blocks show only blocks: an animal lesson there would only name it
    const onBlocks = clone(clean); onBlocks.theme.skin = 'blocks';
    expect(validate(onBlocks, ctx()).results.find(r => r.id === 'V24')!.issues[0].msg).toContain('只有积木，孩子看不到它');
  });

  it('V26 a lesson names only what its own scene shows: no tape and quadrats in the garden, no blocks in the robot factory', () => {
    expect(failed(clone(base))).not.toContain('V26');
    expect(failed(load('L-ARR', '1.0'))).not.toContain('V26');
    const garden = clone(base); garden.theme.skin = 'garden';
    const issues = validate(garden, ctx()).results.find(r => r.id === 'V26')!.issues;
    expect(issues.map(i => i.msg).join()).toContain('场景「花园围栏与铺砖」里没有「卷尺」');
    expect(issues.some(i => /tape|quadrat/i.test(i.msg))).toBe(true); // the English lines too
    expect(issues[0].fix).toContain('测距轮');
    const factory = load('L-ARR', '1.0'); factory.theme.skin = 'robot_factory';
    expect(validate(factory, ctx()).results.find(r => r.id === 'V26')!.issues.map(i => i.msg).join()).toContain('没有「积木」');
  });

  it('V25 the subject runs through the lesson: the intro talks about it, one hotspot is about it, its facts have a source', () => {
    const cricket = JSON.parse(JSON.stringify(clone(base)).replace(/螳螂虾|mantis shrimp|珊瑚礁|珊瑚|海底|潜到|sea floor/gi, '蟋蟀')) as LessonSpec;
    cricket.theme = { ...base.theme, id: 'topic-1234abcd', name: '蟋蟀', skin: 'garden', subject: { name: '蟋蟀', asset_id: 'S-1234abcd', kind: 'organism' } };
    (cricket.component_params.PerimeterArea as { theme: string }).theme = 'garden';
    cricket.end_chat = base.end_chat;
    expect(failed(cricket)).not.toContain('V25');
    expect(failed(clone(base))).not.toContain('V25'); // the example has no subject of its own
    const msgs = (f: (sp: LessonSpec) => void) => { const sp = clone(cricket); f(sp); return validate(sp, ctx()).results.find(r => r.id === 'V25')!.issues.map(i => i.msg).join(' | '); };
    // only the title names it: change the name and the lesson would still stand
    expect(msgs(sp => { sp.intro.paragraphs = ['调查员要量一块地。', '卷尺和样方不一样。']; })).toContain('说明页正文没讲「蟋蟀」');
    expect(msgs(sp => { sp.hotspots = sp.hotspots.filter(h => h.anchor !== 'shrimp'); })).toContain('孩子在演示里看不到它');
    expect(msgs(sp => { const h = sp.hotspots.find(x => x.anchor === 'shrimp')!; h.label = '洞口'; h.language_pack.zh = '这是一个洞口。'; })).toContain('讲的不是「蟋蟀」');
    expect(msgs(sp => { delete sp.hotspots.find(x => x.anchor === 'shrimp')!.facts; })).toContain('没写 facts');
    expect(msgs(sp => { sp.hotspots.find(x => x.anchor === 'shrimp')!.facts![0].ref = ' '; })).toContain('没写出处');
    // multiplication has no place for an animal on stage: only the intro is checked
    expect(msgs(sp => { sp.scene_component_ids = ['ArrayMultiplier@1.0']; sp.hotspots = []; })).toBe('');
  });

  it('V21 a hands-on question can be done: allowed params, in range, not solved at the start, twin hands-on too', () => {
    expect(failed(handsOn())).not.toContain('V21');
    const msgs = (f: (sp: LessonSpec) => void) => { const sp = handsOn(); f(sp); return validate(sp, ctx()).results.find(r => r.id === 'V21')!.issues.map(i => i.msg).join(' | '); };
    expect(msgs(sp => { sp.challenges[0].task!.controls = ['rows', 'a', 'b']; })).toContain('rows 不能让孩子改');
    expect(msgs(sp => { delete sp.challenges[0].task!.start.b; })).toContain('start 缺少 b');
    expect(msgs(sp => { sp.challenges[0].task!.start = { a: 5, b: 3 }; })).toContain('一开始就已经是答案了');
    expect(msgs(sp => { sp.challenges[0].answers[0].value = 11; })).toContain('不是范围内的整数');
    expect(msgs(sp => { sp.challenges[0].task!.controls = ['a']; })).toContain('答案要正好是孩子能改的');
    expect(msgs(sp => { delete sp.challenges[0].twin!.task; })).toContain('同类题也要是');
    expect(msgs(sp => { sp.scene_component_ids = ['ArrayMultiplier@1.0']; })).toContain('不能让孩子改');
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
