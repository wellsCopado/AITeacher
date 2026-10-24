// What the child hears after checking an answer. Every time it names something the child really did well
// (BL10: praise only what happened, never an empty "真棒"), then says what to look at again, then gives a
// reason to keep going. Wrong answers are where confidence is won or lost, so they get the most care.
import type { Challenge } from '../../schema/src/index.js';
import type { Attempt, CheckResult } from './check.js';
import { describe } from './check.js';

/** Wrong tries on one question before the Pad shows how it's done and then lets the child try a similar one. */
export const DEMO_AFTER = 3;

/** Reasons to keep going when the lesson doesn't bring its own (LessonSpec `encouragement.persist`). */
export const DEFAULT_PERSIST = [
  '真正的科学家也是一次次试出来的，多试一次，你就离答案更近一步。',
  '做错的时候，大脑正在长新本领，再来一次！',
  '你已经找对了一部分，再坚持一下，剩下的也能找到。',
];

const at = <T>(xs: T[], n: number) => xs[((n % xs.length) + xs.length) % xs.length];
const join = (xs: string[]) => xs.join('、');

/** Praise for a right answer, matched to how the child got there. */
export function praiseRight(ctx: { tries: number; hints: number; afterDemo?: boolean; seed?: number }): string {
  const n = ctx.seed ?? 0;
  if (ctx.afterDemo) return at(['你自己做出来了！刚才看懂的方法，你马上就会用了，这就是真本领。', '这次全靠你自己！看一遍就学会，说明你听得特别认真。'], n);
  if (ctx.tries > 0) return `前面没对，你没有放弃，又试了一次就做对了！这就是坚持的力量。`;
  if (ctx.hints > 0) return at(['用了提示，自己想通了，这就是会学习的样子！', '提示只是一把钥匙，门是你自己打开的，做对了！'], n);
  return at(['一次就做对了！你先想清楚再写，这个习惯特别棒。', '全对！数和单位都清清楚楚，像真正的调查员一样。', '做对了！你算得又稳又准。'], n);
}

/** Something the child really got right in a wrong answer, or the effort itself when nothing is right yet. */
export function findGood(c: Pick<Challenge, 'answers' | 'options'>, r: CheckResult, attempt: Attempt): string {
  const unitOf = (f: string) => c.answers.find(a => a.field === f)?.unit;
  const full = r.fields.filter(f => f.valueOk && f.unitOk).map(f => f.label);
  const num = r.fields.filter(f => f.valueOk && !f.unitOk).map(f => f.label);
  const unit = r.fields.filter(f => !f.valueOk && unitOf(f.field) && f.unitOk && attempt[f.field]?.unit).map(f => f.label);
  if (full.length && full.length < r.fields.length) return `${join(full)}完全做对了，很了不起！`;
  if (num.length) return `${join(num)}的数算对了，计算很棒！`;
  if (unit.length) return `${join(unit)}的单位选对了，说明你知道它在量什么。`;
  const typed = Object.values(attempt).some(v => (v?.value ?? '').trim());
  if (c.options) return typed ? '你认真想了，还勇敢地做了选择，这很好。' : '先选一个你觉得对的，选错也没关系。';
  return typed ? '你动手算了，还把答案写了出来，这一步很重要。' : '先试着写一个答案，写错也没关系，我们一起看。';
}

/** Feedback for a wrong answer: what's good, what to look at again, and a reason to go on. */
export function encourageWrong(c: Pick<Challenge, 'answers' | 'options'>, r: CheckResult, attempt: Attempt, ctx: { tries: number; persist?: string[] }): string {
  const persist = ctx.persist?.length ? ctx.persist : DEFAULT_PERSIST;
  const fix = describe(r).replace(/。$/, '');
  const next = ctx.tries >= DEMO_AFTER ? '没关系，我们一起看一遍怎么做。' : ctx.tries === 1 ? '再试一次！' : at(persist, ctx.tries);
  return `${findGood(c, r, attempt)}${fix ? `${fix}。` : ''}${next}`;
}

/** The steps shown and read when the child has missed a question DEMO_AFTER times. Built from the hints and
 *  the answer when the lesson has no worked example of its own. */
export function workedSteps(c: Challenge): string[] {
  if (c.worked_example?.steps.length) return c.worked_example.steps;
  return [...c.hints, `所以答案是：${answerText(c)}。`];
}

export const answerText = (c: Pick<Challenge, 'answers'>) =>
  c.answers.map(a => `${a.label ? `${a.label} ` : ''}${a.value}${a.unit ? ` ${a.unit}` : ''}`).join('，');
