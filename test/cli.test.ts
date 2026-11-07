import { describe, expect, it } from 'vitest';
import { canonical, contentHash, habitatOf, scenesShowing, suggestTheme } from '../packages/cli/src/lib.js';
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
  it("puts the child's own next-lesson wish first: no ready scene depicts a robot (a whole one), so the robot is the subject of its own 探索课", () => {
    const s = run('gege', [io('IO-0002', 'gege', '螳螂虾', '近期最喜欢'), io('IO-0009', 'gege', '机器人', '下一课心愿')]);
    expect(s.notes.join()).toContain('「机器人」没有现成的 3D 场景');
    expect(s.notes.join()).toContain('做成探索课');
    // no scene: the server makes it an 探索课 with its own scene and pictures, never the robot arm or the garden
    expect(s.theme).toMatchObject({ name: '机器人', interest_refs: ['IO-0009'], subject: { name: '机器人', kind: 'object' } });
    expect(s.theme.skin).toBeUndefined();
    expect(s.theme.id).toMatch(/^topic-/);
  });
  it('puts a topic only in a scene that depicts it (写啥主题就做啥图片): where it lives is not enough', () => {
    expect(['蟋蟀', '博比特虫', '小龙虾', '金鱼', '鳄鱼', '熊猫', '螳螂', '上海中心'].map(t => habitatOf(themes, t, 'organism')))
      .toEqual(['yard', 'sea', 'fresh', 'fresh', 'wild', 'wild', 'yard', 'city']);
    expect(habitatOf(themes, '某种没听过的动物', 'organism')).toBe('wild'); // unknown animals aren't guessed into the yard
    const named = (topic: string, component = 'PerimeterArea') => run('gege', [io('IO-0002', 'gege', '螳螂虾', '近期最喜欢'), io('IO-0012', 'gege', topic, '家长指定')], [], component).theme;
    // the garden is where crickets live, but it shows a fence and tiles, not a cricket; the reef shows a 螳螂虾, not a bobbit worm
    for (const t of ['蟋蟀', '博比特虫', '金鱼', '狮子', '火箭发射', '蜜蜂', '火山']) expect(named(t), t).toMatchObject({ name: t, subject: { name: t } });
    for (const t of ['蟋蟀', '博比特虫', '金鱼', '狮子', '火箭发射', '蜜蜂', '火山']) expect(named(t).skin, t).toBeUndefined();
    expect(named('金鱼', 'ArrayMultiplier').skin).toBeUndefined(); // blocks show only blocks: never a stand-in for an animal
    expect(named('螳螂虾')).toMatchObject({ id: 'reef', skin: 'reef' });
    expect(named('孔雀螳螂虾')).toMatchObject({ skin: 'reef' }); // a kind of what the reef shows
    expect(scenesShowing(themes, '花园里的蜜蜂')).toEqual([]); // the garden is in it, the bee isn't in the garden's pictures
    expect(scenesShowing(themes, '火箭发射')).toEqual([]);
    expect(scenesShowing(themes, '螳螂虾和海底')).toEqual(['reef']);
  });
  it('does what the parent named, for either child, before any interest', () => {
    const worm = run('gege', [io('IO-0003', 'gege', '螳螂虾', '近期最喜欢'), io('IO-0010', 'gege', '博比特虫', '家长指定')]);
    expect(worm.theme).toMatchObject({ name: '博比特虫', interest_refs: ['IO-0010'], subject: { name: '博比特虫', kind: 'organism' } });
    expect(worm.theme.subject!.asset_id).toBe(run('gege', [io('IO-0011', 'gege', '博比特虫', '家长指定')]).theme.subject!.asset_id); // one id per subject
    // 妹妹's robot-arm lesson: the code-built robot factory is off (parent: 像动画片, gaps G1), so the arm is its own subject,
    // never put on blocks or in the old scene; the App makes it an 探索课 with a CAD or scanned arm (hero-production.md)
    const arm = run('meimei', [io('IO-0006', 'gege', '机器人', '喜欢'), io('IO-0012', 'meimei', '工厂里的机械臂', '家长指定')], [], 'ArrayMultiplier');
    expect(arm.theme).toMatchObject({ name: '工厂里的机械臂', interest_refs: ['IO-0012'] });
    expect(arm.theme.skin).not.toBe('robot_factory');
    expect(run('meimei', [io('IO-0013', 'meimei', '机器人工厂', '家长指定')], [], 'ArrayMultiplier').theme.skin).not.toBe('robot_factory');
    // a robot is not a robot arm (the parent: “机器人” is a whole humanoid robot): it is its own subject, for either component
    expect(run('meimei', [io('IO-0012', 'meimei', '机器人', '家长指定')], [], 'ArrayMultiplier').theme).toMatchObject({ name: '机器人', subject: { kind: 'object' } });
    expect(run('meimei', [io('IO-0012', 'meimei', '机器人', '家长指定')]).theme).toMatchObject({ name: '机器人', subject: { kind: 'object' } });
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
