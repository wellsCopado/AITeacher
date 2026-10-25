import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { utterance } from '../packages/player/src/language.js';
import { checkAttempt, describe as say } from '../packages/player/src/check.js';
import { DEMO_AFTER, encourageWrong, findGood, praiseRight, workedSteps } from '../packages/player/src/encourage.js';
import type { Challenge } from '../packages/schema/src/index.js';

const root = join(import.meta.dirname, '..');

describe('component whitelist matches the code', () => {
  it('versions, anchors and actions agree with content/components.json', async () => {
    // Importing index.ts would pull in three.js; read the definitions from source instead.
    const src = readFileSync(join(root, 'packages/components/src/index.ts'), 'utf8');
    const json = JSON.parse(readFileSync(join(root, 'content/components.json'), 'utf8'));
    for (const [name, def] of Object.entries<{ versions: string[]; hotspotAnchors: string[]; actions: string[]; handsOn?: { build?: string[] }; paramsSchema: { properties: Record<string, { minimum: number; maximum: number }> } }>(json)) {
      const block = src.slice(src.indexOf(`  ${name}: {`), src.indexOf('\n  },\n', src.indexOf(`  ${name}: {`)));
      // what a hands-on question may change, with the same ranges as the params
      for (const k of def.handsOn?.build ?? []) expect(block, `${name}.${k}`).toMatch(new RegExp(`${k}: \\{ engine: '\\w+', min: ${def.paramsSchema.properties[k].minimum}, max: ${def.paramsSchema.properties[k].maximum} \\}`));
      expect(block, name).toContain(`version: '${def.versions.at(-1)}'`);
      expect(block).toContain(`hotspotAnchors: [${def.hotspotAnchors.map(a => `'${a}'`).join(', ')}]`);
      expect(block).toContain(`actions: [${def.actions.map(a => `'${a}'`).join(', ')}]`);
    }
  });
  it('the rejected procedural shrimp is gone from the engine (BL14)', () => {
    const eng = readFileSync(join(root, 'packages/components/src/engine.js'), 'utf8');
    expect(eng).not.toMatch(/buildShrimp|procedural/);
  });
});

describe('language state machine (FR12)', () => {
  const pack = { zh: '中', en: ['e1', 'e2', 'e3'] };
  it('cycles 中 → 英 1–3 → 中 and advances only when counting', () => {
    expect([0, 1, 2, 3, 4].map(p => utterance('cycle', p, pack).text)).toEqual(['中', 'e1', 'e2', 'e3', '中']);
    expect(utterance('cycle', 2, pack, 'zh')).toMatchObject({ lang: 'zh', advance: false });
    expect(utterance('zh', 3, pack)).toMatchObject({ lang: 'zh', advance: false });
  });
  it('falls back to Chinese when an English line is missing, still counting', () => {
    expect(utterance('cycle', 2, { zh: '中', en: ['e1', null, 'e3'] })).toMatchObject({ lang: 'zh', fallback: true, advance: true });
  });
});

describe('challenge checking', () => {
  const c: Challenge = { id: 'c1', prompt: '', with_theme: false, hints: [], answers: [
    { field: 'P', label: '卷尺', value: 16, unit: '米' }, { field: 'S', label: '样方', value: 15, unit: '平方米' }] };
  it('separates wrong numbers from wrong units', () => {
    const r = checkAttempt(c, { P: { value: '16', unit: '米' }, S: { value: '15', unit: '米' } });
    expect(r.correct).toBe(false);
    expect(say(r)).toBe('样方的数对了，单位再看一看。');
    expect(say(checkAttempt(c, { P: { value: '20', unit: '米' }, S: { value: '15', unit: '平方米' } }))).toBe('卷尺的数再算一算。');
    expect(checkAttempt(c, { P: { value: ' 16 ', unit: '米' }, S: { value: '15', unit: '平方米' } }).correct).toBe(true);
  });
  it('checks choice answers by text', () => {
    const ch: Challenge = { id: 'c2', prompt: '', with_theme: false, hints: [], options: ['一样多', '不一样'], answers: [{ field: 'choice', value: '一样多' }] };
    expect(checkAttempt(ch, { choice: { value: '一样多' } }).correct).toBe(true);
    expect(checkAttempt(ch, { choice: { value: '' } }).correct).toBe(false);
  });
});

describe('praise and help after wrong answers', () => {
  const c: Challenge = { id: 'c1', prompt: '', with_theme: false, hints: ['5+3+5+3。'], answers: [
    { field: 'P', label: '卷尺', value: 16, unit: '米' }, { field: 'S', label: '样方', value: 15, unit: '平方米' }] };
  const wrong = (a: Record<string, { value: string; unit?: string }>, tries: number, persist?: string[]) => encourageWrong(c, checkAttempt(c, a), a, { tries, persist });
  it('a wrong answer starts with what the child really got right', () => {
    expect(wrong({ P: { value: '16', unit: '米' }, S: { value: '15', unit: '米' } }, 1)).toBe('卷尺完全做对了，很了不起！样方的数对了，单位再看一看。再试一次！');
    const a = { P: { value: '16', unit: '平方米' }, S: { value: '15', unit: '米' } };
    expect(findGood(c, checkAttempt(c, a), a)).toBe('卷尺、样方的数算对了，计算很棒！');
    const u = { P: { value: '20', unit: '米' }, S: { value: '9', unit: '平方米' } };
    expect(findGood(c, checkAttempt(c, u), u)).toBe('卷尺、样方的单位选对了，说明你知道它在量什么。');
    const typed = { P: { value: '3' }, S: { value: '4' } };
    expect(findGood(c, checkAttempt(c, typed), typed)).toContain('你动手算了');
    expect(findGood(c, checkAttempt(c, {}), {})).toContain('写错也没关系');
  });
  it('gives a reason to keep going, from the lesson when it has one, and offers the demo on the third miss', () => {
    const none = {};
    expect(wrong(none, 2, ['螳螂虾的洞也是一点一点挖出来的。', '再瞄准一次。'])).toContain('螳螂虾的洞也是一点一点挖出来的。');
    expect(wrong(none, DEMO_AFTER)).toContain('我们一起看一遍怎么做');
    expect(DEMO_AFTER).toBe(3);
  });
  it('praise matches how the answer was reached', () => {
    expect(praiseRight({ tries: 0, hints: 0 })).toContain('一次就做对了');
    expect(praiseRight({ tries: 2, hints: 1 })).toContain('没有放弃');
    expect(praiseRight({ tries: 0, hints: 1 })).toContain('提示');
    expect(praiseRight({ tries: 0, hints: 0, afterDemo: true })).toContain('自己做出来了');
  });
  it('the worked example comes from the lesson, or from the hints and the answer', () => {
    expect(workedSteps({ ...c, worked_example: { steps: ['a', 'b'] } })).toEqual(['a', 'b']);
    expect(workedSteps(c)).toEqual(['5+3+5+3。', '所以答案是：卷尺 16 米，样方 15 平方米。']);
  });
});
