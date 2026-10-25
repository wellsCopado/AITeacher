import { describe, expect, it } from 'vitest';
import { canonical, contentHash, suggestTheme } from '../packages/cli/src/lib.js';
import type { ChildProfile, InterestObservation, LessonSpec, ThemeTable } from '../packages/schema/src/index.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const themes: ThemeTable = JSON.parse(readFileSync(join(root, 'content/themes.json'), 'utf8'));
const children: Record<string, ChildProfile> = JSON.parse(readFileSync(join(root, 'content/children.json'), 'utf8'));
const io = (id: string, child: string, topic: string, state: InterestObservation['state'], on = '2026-10'): InterestObservation =>
  ({ id, tenant_id: 'family-001', child, topic, source: '孩子自述', said: null, observed_on: on, state, lesson_ref: null });
const run = (child: string, interests: InterestObservation[], published: LessonSpec[] = [], component = 'PerimeterArea') =>
  suggestTheme({ child, tenant: 'family-001', component, interests, themes, profile: children[child], published });

describe('theme rotation', () => {
  it('uses the current favourite', () => {
    const s = run('gege', [io('IO-0001', 'gege', '昆虫', '喜欢', '2026-09'), io('IO-0002', 'gege', '螳螂虾', '近期最喜欢')]);
    expect(s.theme.id).toBe('reef');
    expect(s.wish.options[0]).toBe('还是螳螂虾');
  });
  it("puts the child's own next-lesson wish first: without its scene, the robot itself becomes the subject to make", () => {
    const s = run('gege', [io('IO-0002', 'gege', '螳螂虾', '近期最喜欢'), io('IO-0009', 'gege', '机器人', '下一课心愿')]);
    expect(s.notes.join()).toContain('扫地机器人清扫');
    expect(s.theme).toMatchObject({ name: '机器人', skin: 'garden', interest_refs: ['IO-0009'], subject: { name: '机器人', kind: 'object' } });
    expect(s.theme.id).toMatch(/^topic-/);
  });
  it('does what the parent named, for either child, before any interest', () => {
    const worm = run('gege', [io('IO-0003', 'gege', '螳螂虾', '近期最喜欢'), io('IO-0010', 'gege', '博比特虫', '家长指定')]);
    expect(worm.theme).toMatchObject({ name: '博比特虫', interest_refs: ['IO-0010'], subject: { name: '博比特虫', kind: 'organism' } });
    expect(worm.theme.subject!.asset_id).toBe(run('gege', [io('IO-0011', 'gege', '博比特虫', '家长指定')]).theme.subject!.asset_id); // one id per subject
    const robot = run('meimei', [io('IO-0006', 'gege', '机器人', '喜欢'), io('IO-0012', 'meimei', '机器人', '家长指定')], [], 'ArrayMultiplier');
    expect(robot.theme).toMatchObject({ name: '机器人', interest_refs: ['IO-0012'], subject: { kind: 'object' } });
    expect(robot.theme.neutral).toBeUndefined();
  });
  it("never uses a sibling's interests", () => {
    const s = run('meimei', [io('IO-0002', 'gege', '螳螂虾', '近期最喜欢')], [], 'ArrayMultiplier');
    expect(s.theme.neutral).toBe(true);
    expect(s.theme.interest_refs).toEqual([]);
    expect(s.wish.options).not.toContain('螳螂虾');
  });
  it('suggests a change after three lessons on the same theme', () => {
    const pub = [1, 2, 3].map(i => ({ for_child: 'gege', theme: { id: 'reef' }, published_at: `2026-10-0${i}` }) as unknown as LessonSpec);
    expect(run('gege', [io('IO-0002', 'gege', '螳螂虾', '近期最喜欢')], pub).notes.join()).toContain('连续 3 节');
  });
});

describe('freezing', () => {
  it('canonical JSON ignores key order', () => {
    expect(canonical({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonical({ a: [{ c: 3, d: 2 }], b: 1 }));
  });
  it('hash ignores the hash and publish time fields', () => {
    const sp = JSON.parse(readFileSync(join(root, 'content/lessons/L-PA/1.0/lessonspec.json'), 'utf8')) as LessonSpec;
    const h = contentHash(sp);
    expect(contentHash({ ...sp, content_hash: 'x', published_at: 'y' })).toBe(h);
    expect(contentHash({ ...sp, title: sp.title + '！' })).not.toBe(h);
  });
});
