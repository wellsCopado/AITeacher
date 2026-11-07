// The 探索课 Skill's own checks are Python (skills/discovery-lesson-maker/scripts): run their tests with the rest,
// so a change to the hero gate, the topic asset list or the family rules can't pass `pnpm test` while they fail.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', 'skills', 'discovery-lesson-maker');
const python = spawnSync('python3', ['--version']).status === 0;

describe('探索课 Skill checks (Python)', () => {
  it.skipIf(!python)('pass their own tests: hero gate, topic assets, package, family rules', () => {
    const r = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests'], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
    expect(r.status, r.stderr.slice(-3000)).toBe(0);
    expect(r.stderr).toMatch(/OK/);
  }, 130_000);
});
