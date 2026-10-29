// Checks for a LearningJudgment (J01–J09): facts come only from items the parent checked, guesses carry
// confidence and a way to verify, nothing about the child's character or future grades (BL07), mastery
// states need the right kind of evidence, and corrections keep the old guess (BL08).
import Ajv2020 from 'ajv/dist/2020.js';
import type { CheckedItem, LearningJudgment } from '../../schema/src/index.js';
import { judgmentSchema, recognitionSchema } from '../../schema/src/index.js';
import type { Concept, Issue } from './rules.js';

export interface JudgmentCtx {
  concepts: Record<string, Concept>;
  /** The homework's items after the parent's check. */
  items: CheckedItem[];
  /** Earlier judgments for the same child, with ids. */
  previous: LearningJudgment[];
}
export interface JudgmentRule { id: string; name: string; basis: string; level: 'error' | 'warn'; check(j: LearningJudgment, ctx: JudgmentCtx): Issue[] }
export interface JudgmentReport { ok: boolean; errors: number; warnings: number; results: { id: string; name: string; basis: string; level: 'error' | 'warn'; ok: boolean; issues: Issue[] }[] }

const ajv = new (Ajv2020 as unknown as typeof Ajv2020.default)({ allErrors: true, strict: false });
const validateSchema = ajv.compile(judgmentSchema);
export const validateRecognition = ajv.compile(recognitionSchema);

/** Words that judge the child rather than the work, or promise results. */
export const CHARACTER_WORDS = ['懒', '笨', '粗心', '马虎', '不认真', '不用心', '态度', '性格', '天赋', '天生', '聪明', '智商', '多动', '注意力缺陷', '学习障碍', '没救'];
export const PROMISE_WORDS = ['保证', '一定能', '肯定能', '提分', '满分', '考高分', '包会'];
const CERTAIN_WORDS = ['肯定是', '一定是', '必然', '毫无疑问'];
const GUESS_WORDS = ['可能', '也许', '大概', '应该是', '估计', '猜'];
export const LESSON_EVIDENCE = /^lesson:[A-Za-z0-9-]+@\d+\.\d+$/;

function texts(j: LearningJudgment): [string, string][] {
  return [
    ...j.facts.map((f, i) => [`$.facts[${i}]`, f.text] as [string, string]),
    ...j.gaps.map((g, i) => [`$.gaps[${i}]`, g.text] as [string, string]),
    ...j.unknowns.map((u, i) => [`$.unknowns[${i}]`, u] as [string, string]),
    ...j.next.map((n, i) => [`$.next[${i}]`, n.text] as [string, string]),
    ...Object.entries(j.parent_card ?? {}).map(([k, v]) => [`$.parent_card.${k}`, String(v)] as [string, string]),
  ];
}
const found = (s: string, words: string[]) => words.filter(w => s.includes(w));

export const JUDGMENT_RULES: JudgmentRule[] = [
  {
    id: 'J01', name: '结构完整', basis: 'Spec §10', level: 'error',
    check: j => validateSchema(j) ? [] : (validateSchema.errors ?? []).map(e => ({ path: '$' + e.instancePath.replace(/\//g, '.'), msg: e.message ?? '' })),
  },
  {
    id: 'J02', name: '只引用家长核对过的题', basis: 'Spec §10', level: 'error',
    check(j, ctx) {
      const byNo = new Map(ctx.items.map(i => [i.no, i]));
      const refs: [string, string][] = [
        ...j.facts.flatMap((f, i) => f.items.map(n => [`$.facts[${i}]`, n] as [string, string])),
        ...j.gaps.flatMap((g, i) => g.items.map(n => [`$.gaps[${i}]`, n] as [string, string])),
        ...j.mastery.flatMap((m, i) => m.evidence.filter(e => !LESSON_EVIDENCE.test(e)).map(n => [`$.mastery[${i}]`, n] as [string, string])),
      ];
      return refs.flatMap(([path, no]) => {
        const it = byNo.get(no);
        if (!it) return [{ path, msg: `没有第 ${no} 题`, fix: '题号用识别结果里的 no' }];
        if (!it.confirmed) return [{ path, msg: `第 ${no} 题家长还没核对，不能进入判断`, fix: '请家长在家长端核对后再判断' }];
        return [];
      });
    },
  },
  {
    id: 'J03', name: '不评价孩子本人、不保证成绩', basis: 'BL07', level: 'error',
    check: j => texts(j).flatMap(([path, s]) => {
      const bad = [...found(s, CHARACTER_WORDS), ...found(s, PROMISE_WORDS)];
      return bad.length ? [{ path, msg: `出现「${bad.join('、')}」`, fix: '写看到的做题行为（如“第 3 题面积单位写成了米”），不评价孩子本人，也不承诺成绩' }] : [];
    }),
  },
  {
    id: 'J04', name: '推测写成推测：带置信度和验证方式，不用确定口吻', basis: 'BL08', level: 'error',
    check: j => j.gaps.flatMap((g, i) => {
      const out: Issue[] = [];
      const c = found(g.text, CERTAIN_WORDS);
      if (c.length) out.push({ path: `$.gaps[${i}].text`, msg: `推测用了确定口吻「${c.join('、')}」`, fix: '改成“可能…”，并写清怎么验证' });
      if (g.confidence > 0.9) out.push({ path: `$.gaps[${i}].confidence`, msg: '一次作业得出的推测置信度不超过 0.9', fix: '降低置信度，或把它当事实写进 facts（需要有题为证）' });
      if (!g.items.length) out.push({ path: `$.gaps[${i}].items`, msg: '推测要指出依据的题号' });
      return out;
    }),
  },
  {
    id: 'J05', name: '掌握状态与证据相符', basis: 'Spec §10', level: 'error',
    check(j, ctx) {
      const byNo = new Map(ctx.items.map(i => [i.no, i]));
      return j.mastery.flatMap((m, i) => {
        const path = `$.mastery[${i}]`;
        const hw = m.evidence.filter(e => !LESSON_EVIDENCE.test(e)).map(n => byNo.get(n)).filter((x): x is CheckedItem => !!x && x.confirmed);
        const own = hw.filter(x => !x.concept_id || x.concept_id === m.concept_id);
        switch (m.state) {
          case '未观察': return m.evidence.length ? [{ path, msg: '有证据就不是“未观察”' }] : [];
          case '待确认': return m.evidence.length ? [] : [{ path, msg: '“待确认”至少要有一条证据（课内或作业）' }];
          case '有独立应用证据':
            return own.some(x => x.teacher_mark === '对') ? [] : [{ path, msg: '“有独立应用证据”需要真实作业里独立做对的题；课内答对只算“待确认”', fix: '在 evidence 里写作业里做对的题号，或改成“待确认”' }];
          case '需再支持':
            return own.some(x => x.teacher_mark === '错' || x.teacher_mark === '半对') ? [] : [{ path, msg: '“需再支持”需要作业里做错或半对的题为证' }];
        }
      });
    },
  },
  {
    id: 'J06', name: '需再支持的知识点要有重教建议', basis: 'FR24', level: 'error',
    check: j => j.mastery.flatMap((m, i) => m.state === '需再支持' && !j.next.some(n => n.kind === '重教' && n.concept_id === m.concept_id)
      ? [{ path: `$.mastery[${i}]`, msg: `${m.concept_id} 需再支持，但 next 里没有对应的“重教”建议`, fix: '加一条 { kind: "重教", concept_id, text }' }] : []),
  },
  {
    id: 'J07', name: '知识点在知识点表里', basis: 'Spec §4', level: 'error',
    check(j, ctx) {
      const ids: [string, string | null | undefined][] = [
        ...j.gaps.map((g, i) => [`$.gaps[${i}].concept_id`, g.concept_id] as [string, string]),
        ...j.mastery.map((m, i) => [`$.mastery[${i}].concept_id`, m.concept_id] as [string, string]),
        ...j.next.map((n, i) => [`$.next[${i}].concept_id`, n.concept_id] as [string, string | null | undefined]),
      ];
      const out: Issue[] = ids.filter(([, c]) => c && !ctx.concepts[c]).map(([path, c]) => ({ path, msg: `${c} 不在 concepts.json` }));
      j.gaps.forEach((g, i) => { if (g.misconception && ctx.concepts[g.concept_id] && !ctx.concepts[g.concept_id].misconceptions.includes(g.misconception)) out.push({ path: `$.gaps[${i}].misconception`, msg: `${g.misconception} 不属于 ${g.concept_id}` }); });
      return out;
    },
  },
  {
    id: 'J08', name: '更正旧推测时保留原文', basis: 'BL08', level: 'error',
    check: (j, ctx) => (j.corrects ?? []).flatMap((c, i) => {
      const prev = ctx.previous.find(p => p.id === c.judgment_id);
      if (!prev) return [{ path: `$.corrects[${i}]`, msg: `没有判断记录 ${c.judgment_id}` }];
      if (prev.child !== j.child) return [{ path: `$.corrects[${i}]`, msg: '只能更正同一个孩子的判断' }];
      if (!prev.gaps[c.gap]) return [{ path: `$.corrects[${i}]`, msg: `${c.judgment_id} 没有第 ${c.gap} 条推测` }];
      return [];
    }),
  },
  {
    id: 'J09', name: '事实栏和家长卡的“本次事实”不夹带推测', basis: 'BL08', level: 'warn',
    check: j => [
      ...j.facts.map((f, i) => [`$.facts[${i}]`, f.text] as [string, string]),
      ['$.parent_card.facts', j.parent_card?.facts ?? ''] as [string, string],
    ].flatMap(([path, s]) => { const g = found(s, GUESS_WORDS); return g.length ? [{ path, msg: `事实里出现推测词「${g.join('、')}」`, fix: '推测移到 gaps 或家长卡“还没验证的解释”' }] : []; }),
  },
];

export function checkJudgment(j: LearningJudgment, ctx: JudgmentCtx): JudgmentReport {
  const schemaOk = validateSchema(j);
  const results = JUDGMENT_RULES.map(r => {
    let issues: Issue[];
    if (!schemaOk && r.id !== 'J01') issues = [];
    else { try { issues = r.check(j, ctx); } catch (e) { issues = [{ path: '$', msg: `规则执行出错：${(e as Error).message}` }]; } }
    return { id: r.id, name: r.name, basis: r.basis, level: r.level, ok: issues.length === 0, issues };
  });
  const errors = results.filter(r => !r.ok && r.level === 'error').length;
  return { ok: errors === 0, errors, warnings: results.filter(r => !r.ok && r.level === 'warn').length, results };
}

/** Items below this confidence are marked 请核对 for the parent. */
export const CHECK_BELOW = 0.8;

/** Starting point for a judgment: one fact per checked item, mastery per concept from the marks. The Skill edits it. */
export function draftJudgment(homework_ref: string, child: string, items: CheckedItem[]): LearningJudgment {
  const ok = items.filter(i => i.confirmed);
  const facts = ok.map(i => ({ text: `第 ${i.no} 题：孩子写「${i.child_answer || '（空）'}」，老师批「${i.teacher_mark}」${i.teacher_note ? `，批注「${i.teacher_note}」` : ''}。`, items: [i.no] }));
  const concepts = [...new Set(ok.map(i => i.concept_id).filter((c): c is string => !!c))];
  const mastery = concepts.map(c => {
    const mine = ok.filter(i => i.concept_id === c);
    const wrong = mine.filter(i => i.teacher_mark === '错' || i.teacher_mark === '半对');
    return wrong.length
      ? { concept_id: c, state: '需再支持' as const, evidence: wrong.map(i => i.no) }
      : { concept_id: c, state: '有独立应用证据' as const, evidence: mine.filter(i => i.teacher_mark === '对').map(i => i.no) };
  }).filter(m => m.evidence.length);
  return {
    homework_ref, child, facts, gaps: [], unknowns: [],
    next: mastery.filter(m => m.state === '需再支持').map(m => ({ kind: '重教' as const, concept_id: m.concept_id, text: '（写清换什么表征或教法）' })),
    mastery, corrects: [],
    parent_card: { facts: '', child_share: '', unverified: '', talk: '' },
  };
}
