// 探索课的家庭上课流程（skills/discovery-lesson-maker/assets/web/adw-family.mjs）：
// 顺序解锁、倒计时自动前进、一中三英、夸奖三段式、错 3 次演示后做同类题、暂停、记录给 App。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(__dirname, '..', 'skills', 'discovery-lesson-maker');
const FLOW = JSON.parse(readFileSync(join(dir, 'examples', 'lesson-flow.example.json'), 'utf8'));
const modPath = join(dir, 'assets', 'web', 'adw-family.mjs');
const load = async () => (await import(modPath)) as any;

async function engine(saved?: unknown) {
  const { createFamilyEngine } = await load();
  const events: { type: string; d: any }[] = [];
  const e = createFamilyEngine(JSON.parse(JSON.stringify(FLOW)), { saved, emit: (type: string, d: any) => events.push({ type, d }) });
  e.start();
  const said = () => events.filter(x => x.type === 'say').flatMap(x => x.d.lines.map((l: any) => l.text));
  return { e, events, said };
}

describe('adw-family 上课流程', () => {
  it('录音文件名和 Python 的 family_flow.line_file 一样', async () => {
    const { lineFile } = await load();
    expect(lineFile('zh', '桥')).toBe('audio/family/zh-220756d3.m4a');
    expect(lineFile('en', 'Look.')).toBe('audio/family/en-3dde783d.m4a');
  });

  it('一进第一步就读讲解；一中三英按次数循环', async () => {
    const { e, said } = await load().then(() => engine());
    expect(said()).toEqual([FLOW.narration.intro.zh, FLOW.tasks.which.ask]);
    expect(e.say('intro')[0]).toEqual({ lang: 'en', text: FLOW.narration.intro.en[0] });
    e.say('intro'); e.say('intro');
    expect(e.say('intro')[0]).toEqual({ lang: 'zh', text: FLOW.narration.intro.zh });
  });

  it('题没做完不能下一步；做对后才解锁', async () => {
    const { e } = await engine();
    expect(e.next()).toBe(false);
    expect(e.state.step).toBe(0);
    e.answer('which', { ok: true, option: 'a' });
    expect(e.state.tasks.which.result).toBe('independent');
    expect(e.next()).toBe(true);
    expect(e.state.step).toBe(1);
  });

  it('答错：先夸做对的地方、再说看哪里、再给坚持的理由；第 2 次给提示', async () => {
    const { e } = await engine();
    const first = e.answer('which', { ok: false, option: 'b' }).map((l: any) => l.text);
    expect(first.slice(0, 3)).toEqual([FLOW.tasks.which.options[1].good, FLOW.tasks.which.options[1].look, FLOW.encouragement.persist[0]]);
    const second = e.answer('which', { ok: false, option: 'c' }).map((l: any) => l.text);
    expect(second).toContain(FLOW.tasks.which.hints[0]);
  });

  it('错 3 次先演示，倒计时停住；演示完出同类题，同类题做对记“借助帮助”', async () => {
    const { e, events } = await engine();
    for (let i = 0; i < 3; i++) e.answer('which', { ok: false, option: 'b' });
    const demo = events.find(x => x.type === 'demo');
    expect(demo?.d.steps.map((l: any) => l.text)).toEqual(FLOW.tasks.which.worked_example);
    const left = e.state.left;
    e.tick(30);
    expect(e.state.left).toBe(left);
    e.demoDone('which');
    expect(events.find(x => x.type === 'twin')?.d.twin.ask).toBe(FLOW.tasks.which.twin.ask);
    e.answer('which', { ok: true, option: 'l' });
    expect(e.state.tasks.which).toMatchObject({ passed: true, result: 'assisted', demo: true });
    expect(e.report().tasks.which).toEqual({ passed: true, result: 'assisted', helped: true, wrong: 3 });
  });

  it('同类题还错：告诉答案，这题结束，不无限重试', async () => {
    const { e, said } = await engine();
    for (let i = 0; i < 3; i++) e.answer('which', { ok: false, option: 'b' });
    e.demoDone('which');
    e.answer('which', { ok: false, option: 'r' });
    expect(e.state.tasks.which).toMatchObject({ passed: false, done: true });
    expect(said()).toContain('左边');
    expect(e.canNext()).toBe(true);
  });

  it('时间到自动进下一步，没做完的题记超时；最后一步到时间就下课；暂停时不计时', async () => {
    const { e, events } = await engine();
    e.pause(); e.tick(1000); expect(e.state.step).toBe(0);
    e.resume(); e.tick(FLOW.steps[0].seconds);
    expect(e.state.step).toBe(1);
    expect(e.state.tasks.which).toMatchObject({ done: true, timeout: true, passed: false });
    e.tick(FLOW.steps[1].seconds); e.tick(FLOW.steps[2].seconds);
    expect(e.state.ended).toBe(true);
    expect(events.some(x => x.type === 'end')).toBe(true);
    // 下课时告诉 App：课走完了（有题超时也算），App 接着问下一课心愿，给孩子点选的主题来自 lesson-flow.json
    expect(e.report()).toMatchObject({ ended: true, wish: FLOW.wish.options });
  });

  it('退出再进从存下的地方接着上', async () => {
    const a = await engine();
    a.e.answer('which', { ok: true, option: 'a' }); a.e.next();
    const b = await engine(a.e.snapshot());
    expect(b.e.state.step).toBe(1);
    expect(b.e.state.tasks.which.passed).toBe(true);
  });

  it('lesson-flow.json 不是家庭格式时直接报错', async () => {
    const { createFamilyEngine } = await load();
    expect(() => createFamilyEngine({ ...FLOW, format: 'x' })).toThrow('adw-family/1');
  });
});
