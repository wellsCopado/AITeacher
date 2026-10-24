import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { utterance } from '../packages/player/src/language.js';
import { checkAttempt, describe as say } from '../packages/player/src/check.js';
import type { Challenge } from '../packages/schema/src/index.js';

const root = join(import.meta.dirname, '..');

describe('component whitelist matches the code', () => {
  it('versions, anchors and actions agree with content/components.json', async () => {
    // Importing index.ts would pull in three.js; read the definitions from source instead.
    const src = readFileSync(join(root, 'packages/components/src/index.ts'), 'utf8');
    const json = JSON.parse(readFileSync(join(root, 'content/components.json'), 'utf8'));
    for (const [name, def] of Object.entries<{ versions: string[]; hotspotAnchors: string[]; actions: string[] }>(json)) {
      const block = src.slice(src.indexOf(`  ${name}: {`), src.indexOf('},\n', src.indexOf(`  ${name}: {`)));
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
