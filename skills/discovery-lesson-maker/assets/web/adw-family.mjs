// AI 探索世界家庭上课规则（adw-family/1）。给这个家庭做的探索课都用它跑流程，复制到课程源码里原样使用。
// 规则（家长定的，课程不能关掉）：步骤按顺序解锁、每步倒计时、到时间自动下一步；孩子要看的话都出字幕并朗读；
// 讲解“一中三英”（每个讲解点第 1 次读中文，第 2–4 次读英文 1–3，再循环）；答错先夸做对的地方，再说看哪里，再给坚持的理由；
// 同一题错 3 次先演示一遍，再做一道同类题。页面只负责三维场景和题目控件，判题结果交给 answer()。
// 课的内容写在 lesson-flow.json（见 references/family-profile.md）；所有要读的话都事先录好，
// 文件名由 lineFile() 算出，scripts/make_family_audio.py 生成，check_package.py 核对。
import PHRASES from './adw-family-phrases.json';

export const FORMAT = 'adw-family/1';
/** 同一题错几次后先演示、再做同类题。 */
export const DEMO_AFTER = 3;
export { PHRASES };

/** 一句话的录音文件（相对网页根目录）：FNV-1a 32 位，和 make_family_audio.py、check_package.py 一致。 */
export function lineFile(lang, text) {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(`${lang}|${text}`)) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return `audio/family/${lang}-${h.toString(16).padStart(8, '0')}.m4a`;
}

const at = (xs, n) => xs[((n % xs.length) + xs.length) % xs.length];
const zh = (text) => ({ lang: 'zh', text });

/** 一节课的流程状态。不碰 DOM，便于测试；saved 是 snapshot() 存下的内容。 */
export function createFamilyEngine(flow, { saved, emit = () => {} } = {}) {
  if (flow?.format !== FORMAT) throw new Error(`lesson-flow.json 的 format 要写 ${FORMAT}`);
  const steps = flow.steps, tasks = flow.tasks ?? {}, persist = flow.encouragement?.persist ?? [];
  const fresh = () => ({ format: FORMAT, lesson: flow.lesson, step: 0, left: steps[0].seconds, ended: false, pointers: {}, warned: false,
    tasks: Object.fromEntries(Object.keys(tasks).map((id) => [id, { tries: 0, hints: 0, demo: false, twin: false, passed: false, done: false, result: '', timeout: false }])) });
  let s = fresh();
  if (saved?.format === FORMAT && saved.lesson === flow.lesson) s = { ...s, ...saved, tasks: { ...s.tasks, ...saved.tasks }, pointers: { ...saved.pointers } };
  let paused = false, demoing = false;

  const stepTasks = (i = s.step) => steps[i]?.tasks ?? [];
  /** 这一步的题都有了结果（做对，或演示后做过同类题），才能点“下一步”。 */
  const canNext = () => !s.ended && stepTasks().every((id) => s.tasks[id].done);
  function enter(i) {
    s.step = i; s.left = steps[i].seconds; s.warned = false;
    emit('step', { index: i, step: steps[i] });
    for (const id of steps[i].say ?? []) emit('say', { id, lines: [utter(id)] });
  }
  function end() { s.ended = true; emit('say', { lines: [zh(PHRASES.end)] }); emit('end', {}); }
  function next(force = false) {
    if (!force && !canNext()) return false;
    if (s.step + 1 >= steps.length) end(); else enter(s.step + 1);
    return true;
  }
  /** 讲解点的下一句：第 1 次中文，第 2–4 次英文 1–3，然后循环。 */
  function utter(id) {
    const n = flow.narration[id];
    const p = s.pointers[id] ?? 0; s.pointers[id] = p + 1;
    const pos = p % 4;
    return pos === 0 || !n.en?.[pos - 1] ? zh(n.zh) : { lang: 'en', text: n.en[pos - 1] };
  }
  function tick(sec = 1) {
    if (paused || demoing || s.ended) return;
    s.left = Math.max(0, s.left - sec);
    if (!s.warned && s.left <= 60 && steps[s.step].seconds > 90) { s.warned = true; emit('say', { lines: [zh(PHRASES.warn_60)] }); }
    if (s.left > 0) return;
    for (const id of stepTasks()) if (!s.tasks[id].done) Object.assign(s.tasks[id], { done: true, timeout: true });
    if (s.step + 1 < steps.length) emit('say', { lines: [zh(PHRASES.time_up)] });
    next(true);
  }
  const rightAnswer = (task) => task.options?.find((o) => o.right)?.text;
  /**
   * 页面判完一题后调用。r = { ok, option?（选择题选的 id）, good?, look? }；动手题由页面读场景状态给出 good（哪里已经对了）和 look（再看哪里）。
   * 返回要说的话；第 3 次错时还会发出 demo 事件，演示放完页面调用 demoDone()，再按 twin 出同类题。
   */
  function answer(id, r) {
    const task = tasks[id], t = s.tasks[id];
    if (!task || t.done) return [];
    const ask = t.twin ? task.twin : task;
    const opt = r.option ? ask.options?.find((o) => o.id === r.option) : undefined;
    const lines = [];
    if (r.ok) {
      const kind = task.kind === 'choice' ? 'right_first_choice' : task.kind === 'hands_on' ? 'right_first_task' : 'right_first';
      lines.push(zh(at(t.twin ? PHRASES.right_after_demo : t.tries ? PHRASES.right_after_tries : t.hints ? PHRASES.right_after_hint : PHRASES[kind], t.tries + t.hints)));
      Object.assign(t, { passed: true, done: true, result: t.twin || t.hints ? 'assisted' : t.tries ? 'corrected' : 'independent' });
      if (canNext()) lines.push(zh(PHRASES.step_done));
      emit('say', { lines }); emit('task', { id, task: t });
      return lines;
    }
    const good = opt?.good ?? r.good ?? ask.good ?? PHRASES.nothing_good;
    const look = opt?.look ?? r.look ?? ask.look;
    if (t.twin) {
      lines.push(zh(good), zh(PHRASES.twin_miss));
      const right = rightAnswer(ask); if (right) lines.push(zh(PHRASES.answer_is), zh(right));
      Object.assign(t, { done: true, result: 'assisted' });
      if (canNext()) lines.push(zh(PHRASES.step_done));
      emit('say', { lines }); emit('task', { id, task: t });
      return lines;
    }
    t.tries++;
    lines.push(zh(good));
    if (look) lines.push(zh(look));
    if (persist.length) lines.push(zh(at(persist, t.tries - 1)));
    if (t.tries >= DEMO_AFTER) {
      lines.push(zh(PHRASES.demo_intro));
      t.demo = true; demoing = true;
      emit('say', { lines }); emit('demo', { id, steps: task.worked_example.map(zh) });
      return lines;
    }
    if (t.tries === DEMO_AFTER - 1 && task.hints?.[t.hints]) { lines.push(zh(PHRASES.hint_intro), zh(task.hints[t.hints])); t.hints++; }
    else lines.push(zh(PHRASES.try_again));
    emit('say', { lines }); emit('task', { id, task: t });
    return lines;
  }
  /** 演示放完：出同类题，演示时间不算在这一步的倒计时里。 */
  function demoDone(id) {
    demoing = false;
    const t = s.tasks[id]; t.twin = true;
    emit('say', { lines: [zh(PHRASES.twin_intro), zh(tasks[id].twin.ask)] });
    emit('twin', { id, twin: tasks[id].twin });
  }
  /** 孩子主动要提示（记作借助帮助）。 */
  function hint(id) {
    const task = tasks[id], t = s.tasks[id];
    const h = task?.hints?.[t.hints]; if (!h) return [];
    t.hints++; const lines = [zh(PHRASES.hint_intro), zh(h)]; emit('say', { lines }); return lines;
  }
  /** 给 adw-host.mjs 的 report()：只报题目结果。 */
  const report = () => ({ section: s.step, sections: steps.length, labels: Object.fromEntries(Object.entries(tasks).map(([id, x]) => [id, x.label ?? id])),
    tasks: Object.fromEntries(Object.entries(s.tasks).map(([id, t]) => [id, { passed: t.passed, result: t.result, helped: t.hints > 0 || t.demo, wrong: t.tries }])) });
  return {
    get state() { return s; }, get step() { return steps[s.step]; }, get paused() { return paused; },
    start() { if (!saved || saved.format !== FORMAT) enter(0); else emit('step', { index: s.step, step: steps[s.step] }); },
    canNext, next: () => next(false), tick, answer, demoDone, hint, utter,
    say: (id) => { const lines = [utter(id)]; emit('say', { id, lines }); return lines; },
    pause() { paused = true; }, resume() { paused = false; },
    snapshot: () => JSON.parse(JSON.stringify(s)), report,
  };
}

/**
 * 把流程挂到页面上：顶部步骤条和倒计时、“下一步”按钮、字幕条，按顺序播放录好的声音。
 * host = adw-host.mjs 的 { storageKey, report, onHost }；hooks.onStep / onDemoStep / onTwin / onEnd 由页面接三维场景。
 */
export function mountFamilyLesson({ flow, root, host, key, hooks = {}, base = './' }) {
  let saved; try { saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch { saved = null; }
  const queue = []; let playing = null;
  const audio = new Audio();
  root.classList.add('adw-family');
  root.innerHTML = `<div class="adw-family-bar"><ol class="adw-family-steps"></ol><span class="adw-family-time"></span><button class="adw-family-next" disabled>下一步</button></div><div class="adw-family-sub" aria-live="polite"></div>`;
  const $ = (c) => root.querySelector(c);
  const show = (line) => { $('.adw-family-sub').textContent = line ? line.text : ''; $('.adw-family-sub').lang = line?.lang === 'en' ? 'en' : 'zh-CN'; };
  function pump() {
    if (playing || !queue.length) return;
    playing = queue.shift(); show(playing.line);
    audio.src = base + lineFile(playing.line.lang, playing.line.text);
    const done = () => { const p = playing; playing = null; p.resolve(); if (!queue.length) setTimeout(() => !playing && show(null), 1500); pump(); };
    audio.onended = done; audio.onerror = done;
    audio.play().catch(done);
  }
  const speak = (lines) => Promise.all(lines.map((line) => new Promise((resolve) => { queue.push({ line, resolve }); pump(); })));
  let engine;
  const save = () => { try { localStorage.setItem(key, JSON.stringify(engine.snapshot())); } catch { /* 无痕模式等 */ } host?.report?.(engine.report()); render(); };
  function render() {
    const s = engine.state;
    $('.adw-family-steps').innerHTML = flow.steps.map((st, i) => `<li class="${i < s.step ? 'done' : i === s.step ? 'now' : 'locked'}">${i + 1} ${st.title}</li>`).join('');
    $('.adw-family-time').textContent = s.ended ? '' : `${Math.floor(s.left / 60)}:${String(Math.floor(s.left % 60)).padStart(2, '0')}`;
    $('.adw-family-next').disabled = !engine.canNext();
  }
  engine = createFamilyEngine(flow, { saved, emit: async (type, d) => {
    if (type === 'say') speak(d.lines);
    if (type === 'step') hooks.onStep?.(d.step, d.index);
    if (type === 'twin') hooks.onTwin?.(d.id, d.twin);
    if (type === 'end') hooks.onEnd?.();
    if (type === 'demo') {
      // 前面那几句已经排在队里，演示的每一步接着读
      for (const [i, line] of d.steps.entries()) { hooks.onDemoStep?.(d.id, i, line.text); await speak([line]); }
      engine.demoDone(d.id);
    }
    save();
  } });
  $('.adw-family-next').onclick = () => { engine.next(); save(); };
  const timer = setInterval(() => { engine.tick(1); render(); if (engine.state.left % 10 === 0) save(); }, 1000);
  const pause = () => { engine.pause(); audio.pause(); };
  const resume = () => { engine.resume(); if (playing) audio.play().catch(() => {}); };
  document.addEventListener('visibilitychange', () => (document.hidden ? pause() : resume()));
  host?.onHost?.((m) => { if (m.type === 'pause') pause(); if (m.type === 'resume') resume(); });
  engine.start(); render();
  return {
    engine, speak, pause, resume,
    /** 题目判完调用，见 createFamilyEngine 的 answer()。 */
    answer: (id, r) => { const lines = engine.answer(id, r); save(); return lines; },
    hint: (id) => { const lines = engine.hint(id); save(); return lines; },
    say: (id) => engine.say(id),
    stop() { clearInterval(timer); audio.pause(); },
  };
}
