// Lesson player: renders one frozen LessonSpec with the pre-reviewed components.
// Used by `dls preview` (with the parent side panel) and by the Pad app (`kid: true`, events sent to the server).
import type { Challenge, LessonSpec } from '../../schema/src/index.js';
import { mount, mountHost, type Host, type Instance } from '../../components/src/index.js';
import { pointerKey, utterance } from './language.js';
import { checkAttempt, type Attempt } from './check.js';
import { answerText, DEMO_AFTER, encourageWrong, findGood, praiseRight, workedSteps } from './encourage.js';
import { createVoice, readingTime, type FetchAudio } from './voice.js';
import { budget, Countdown, fmt, STEP_KEYS } from './timing.js';

export interface LessonEvent { at: string; type: string; [k: string]: unknown }

const ACTION_LABELS: Record<string, Record<string, string>> = {
  reef: { walk: '拉卷尺围一圈', fill: '放样方', focus: '看看螳螂虾的洞' },
  garden: { walk: '测距轮走一圈', fill: '铺地砖' },
  blocks: { reveal: '一行一行摆', rotate: '转个方向' },
  robot_factory: { reveal: '机械臂一行一行摆', rotate: '转台转 90°' },
};
const STEPS = ['说明', '互动演示', '挑战', '聊聊（可跳过）'];
const STEP_GUIDE = [
  '先听一听今天要做什么，看完点「开始演示」。',
  '跟着提示一件一件做，时间到了会自动进入挑战。',
  '把下面的题做一做，做不出来可以点「提示」。时间到了会自动去聊聊。',
  '说不说都可以，时间到了这节课就结束。',
];

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const h = (html: string) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };

/** Real photos, videos or scans the parent registered for an organism that has no photoreal model yet. */
export interface OrganismMedia {
  id: string; asset_id: string; kind: 'photo' | 'video' | 'model' | 'cutout'; origin?: string; url: string; credit: string; license: string;
  caption?: string | null; length_cm?: number | null;
  /** cutout only: the jointed relief rig built from it (height and part map, part list). */
  rig?: string; rig_meta?: string;
}

export interface PlayOptions {
  childName?: string; /** Pad mode: no parent side panel. */ kid?: boolean; onExit?: () => void;
  media?: OrganismMedia[];
  /** Speeds up every countdown (tests only). */ timeScale?: number;
  /** Narration audio from the family server's voice; without it the device's own voice is used. */
  audio?: FetchAudio;
}

export function play(root: HTMLElement, sp: LessonSpec, opts: PlayOptions = {}) {
  const lessonKey = `${sp.lesson_id}@${sp.version}`;
  const events: LessonEvent[] = [];
  const pointers: Record<string, number> = {};
  // Narration is always 1 Chinese then 3 English (BL06); there is no Chinese-only mode.
  const mode = 'cycle' as const;
  const scale = opts.timeScale ?? (Number(new URLSearchParams(typeof location !== 'undefined' ? location.search : '').get('adw_time')) || 1);
  const voice = createVoice(scale, opts.audio);
  const times = budget(sp);
  // The intro is read aloud in full before the child can go on, so its step must be long enough for that.
  times.explain = Math.max(times.explain, Math.ceil([sp.intro.headline, ...sp.intro.paragraphs].reduce((a, t) => a + readingTime(t), 0) * 1.4) + 20);
  /** Bumped on every step change, so narration from a step the child already left stops mattering. */
  let epoch = 0;
  let clock: Countdown | null = null;
  let subClock: Countdown | null = null;
  const startedAt = Date.now();
  let step = 0;
  let scene: Instance | null = null;
  /** The 3D picture of the question on screen, and the robot host of the chat at the end. */
  let pic: Instance | null = null, host: Host | null = null;
  const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hintsUsed: Record<string, number> = {};
  const skin = sp.theme.skin ?? '';
  const organismPending = (sp.pending_assets ?? []).filter(p => p.kind === 'organism');
  const animalMedia = (opts.media ?? []).filter(m => organismPending.some(p => p.asset_id === m.asset_id));
  // the animal the lesson is about (博比特虫…); without one it is the reef's own mantis shrimp
  const subject = sp.theme.subject?.kind === 'organism' ? sp.theme.subject : undefined;
  const animal = subject?.name ?? '螳螂虾', isShrimp = !subject || /螳螂虾/.test(subject.name);

  const log = (type: string, data: Record<string, unknown> = {}) => {
    const e = { at: new Date().toISOString(), type, ...data };
    events.push(e);
    root.dispatchEvent(new CustomEvent('adw:event', { detail: e, bubbles: true }));
    renderLog();
  };

  root.innerHTML = `
  <div class="adw${opts.kid ? ' kid' : ''}">
    <main class="pad">
      <header class="pad-head">
        <div><h1>${esc(sp.title)}</h1><p class="muted">${esc(opts.childName ?? sp.for_child)} · ${esc(sp.primary_concept.name)} · v${esc(sp.version)}</p></div>
        <div class="row"><span class="langtag" title="每个讲解第 1 次中文，第 2 到 4 次英文">讲解 1 中 3 英</span><button class="btn sm" id="mute" aria-label="关掉声音">🔊 声音开</button></div>
      </header>
      <nav class="steps" id="steps"></nav>
      <div class="guide" id="guide"><div class="gtext"><b id="gstep"></b><span id="gtext"></span><span id="gsub" class="gsub"></span></div>
        <p class="cap" id="cap" aria-live="polite" hidden></p>
        <div class="clock" id="clock" role="timer" aria-label="这一步还剩的时间"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15.5" class="track"/><circle cx="18" cy="18" r="15.5" class="arc" id="arc"/></svg><span id="left"></span></div></div>
      <section id="body"></section>
    </main>
    ${opts.kid ? '' : `<aside class="side">
      <h2>家长看</h2>
      <p>${esc(sp.parent_tip)}</p>
      <p class="muted">主题：${esc(sp.theme.name)}（${esc(sp.theme.why)}）</p>
      ${sp.pending_assets?.length ? `<p class="muted">待到位素材：${sp.pending_assets.map(p => esc(p.asset_id)).join('、')}，到位前不展示。</p>` : ''}
      <h2>讲解语言计数</h2><div id="ptr"></div>
      <h2>学习记录</h2><ol id="log" class="log"></ol>
    </aside>`}
  </div>`;
  const $ = (sel: string) => root.querySelector(sel) as HTMLElement;
  $('#mute').onclick = () => {
    voice.muted = !voice.muted; if (voice.muted) voice.stop();
    $('#mute').textContent = voice.muted ? '🔇 声音关' : '🔊 声音开'; log('sound', { on: !voice.muted });
  };
  // A soft tap on every button press, so the child hears that the Pad got it.
  root.addEventListener('click', e => { if ((e.target as HTMLElement).closest('button')) voice.tap(); });

  // the robot host (when one is on screen) talks while a line is read
  const say = (text: string) => { host?.talk(true); const p = voice.speak(text, 'zh'); void p.finally(() => host?.talk(false)); return p; };
  function guide(text: string, speak = true) { $('#gtext').textContent = text; if (speak) void say(text); }
  /** Read lines one after another with a subtitle for each; true if the child is still on this step at the end. */
  async function narrate(lines: { text: string; el?: Element | null }[]) {
    const mine = epoch, cap = $('#cap');
    for (const l of lines) {
      if (epoch !== mine) return false;
      root.querySelectorAll('.reading').forEach(n => n.classList.remove('reading'));
      l.el?.classList.add('reading');
      cap.hidden = false; cap.textContent = l.text;
      await say(l.text);
    }
    if (epoch !== mine) return false;
    root.querySelectorAll('.reading').forEach(n => n.classList.remove('reading'));
    cap.hidden = true;
    return true;
  }
  /** A "go on" button stays locked until this step's part is done. */
  function lock(b: HTMLElement, why: string) { (b as HTMLButtonElement).disabled = true; b.dataset.label = b.textContent ?? ''; b.textContent = why; }
  function unlock(b: HTMLElement) { (b as HTMLButtonElement).disabled = false; if (b.dataset.label) b.textContent = b.dataset.label; b.classList.add('pulse'); }
  function subGuide(text: string) { $('#gsub').textContent = text; }
  function startClock(seconds: number, onEnd: () => void) {
    clock?.stop();
    const arc = root.querySelector('#arc') as SVGCircleElement, C = 2 * Math.PI * 15.5;
    arc.style.strokeDasharray = String(C);
    clock = new Countdown(seconds, scale, {
      tick: left => {
        $('#left').textContent = fmt(Math.ceil(left));
        arc.style.strokeDashoffset = String(C * (1 - left / seconds));
        $('#clock').classList.toggle('low', left <= 15);
      },
      warn: left => { voice.tick(); log('step_warn', { step: STEPS[step], left }); },
      end: () => { voice.chime(); onEnd(); },
    }).start();
  }

  function renderLog() {
    const el = root.querySelector('#log'); if (!el) return;
    el.innerHTML = events.slice(-12).reverse().map(e => `<li><code>${esc(e.at.slice(11, 19))}</code> ${esc(e.type)} ${esc(Object.entries(e).filter(([k]) => k !== 'at' && k !== 'type').map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' '))}</li>`).join('');
  }
  function renderPointers() {
    const ptr = root.querySelector('#ptr'); if (!ptr) return;
    ptr.innerHTML = sp.hotspots.map(hs => {
      const n = pointers[pointerKey(sp.for_child, lessonKey, hs.id)] ?? 0;
      return `<div class="ptr"><span>${esc(hs.label)}</span><span>${n} 次</span></div>`;
    }).join('');
  }

  function playHotspot(anchor: string) {
    const hs = sp.hotspots.find(x => x.anchor === anchor); if (!hs) return;
    const key = pointerKey(sp.for_child, lessonKey, hs.id);
    const u = utterance(mode, pointers[key] ?? 0, hs.language_pack);
    if (u.advance) pointers[key] = (pointers[key] ?? 0) + 1;
    const stage = root.querySelector('.stage');
    if (stage) stageSub(stage as HTMLElement, `<span class="tag">${u.lang === 'zh' ? '中' : 'EN'}</span>${esc(u.text)}${u.fallback ? ' <span class="dimtext">（这条暂时没有英文，先用中文）</span>' : ''}`, voice.speak(u.text, u.lang));
    else void voice.speak(u.text, u.lang);
    if (anchor === 'shrimp' && organismPending.length && stage) {
      if (animalMedia.some(m => m.kind === 'cutout')) organismBar(stage as HTMLElement);
      else showOrganism(stage as HTMLElement);
    }
    log('hotspot', { hotspot: hs.id, lang: u.lang, ...(u.advance ? { count: pointers[key] } : {}), ...(u.fallback ? { fallback: true } : {}) });
    renderPointers();
  }

  // A subtitle over the 3D scene while a line is read; it fades a little after the voice ends so the animal stays in view.
  let subGen = 0;
  function stageSub(stage: HTMLElement, html: string, spoken: Promise<void>) {
    let sub = stage.querySelector('.sub') as HTMLElement | null;
    if (!sub) { sub = h('<div class="sub"></div>'); stage.appendChild(sub); }
    sub.innerHTML = html; sub.classList.remove('gone');
    const mine = ++subGen;
    void spoken.then(() => setTimeout(() => { if (mine === subGen) sub!.classList.add('gone'); }, 2500 / scale));
  }

  // Things to do with the animal in the 3D scene: watch it strike (also slowed down), take it apart, see photos.
  function organismBar(stage: HTMLElement) {
    if (stage.querySelector('.orgbar')) return;
    const bar = h(`<div class="orgbar">
      <button data-org="strike">${isShrimp ? '👊 出拳' : '⚡ 出击'}</button><button data-org="slow">🐢 慢动作${isShrimp ? '出拳' : '出击'}</button>
      <button data-org="anatomy">🔍 拆开看身体</button>${animalMedia.some(m => m.kind === 'photo' || m.kind === 'video') ? '<button data-org="photos">📷 看照片</button>' : ''}
      <button data-org="hide">🏠 回洞</button></div>`);
    bar.querySelectorAll<HTMLButtonElement>('[data-org]').forEach(b => b.onclick = () => {
      const c = b.dataset.org!;
      log('organism', { cmd: c });
      if (c === 'photos') { showOrganism(stage); return; }
      scene?.organism(c === 'anatomy' && scene.organismState()?.exploded ? 'anatomy' : c);
      const sub = (t: string) => stageSub(stage, esc(t), say(t));
      if (c === 'slow') sub(isShrimp ? '慢动作，放慢了 40 倍。真正的一拳只要几毫秒，快到能在水里打出小气泡。' : `慢动作，放慢了 40 倍，看清${animal}是怎么一下子扑出去的。`);
      if (c === 'anatomy') {
        const apart = !b.classList.toggle('on') ? false : true;
        b.textContent = apart ? '🧩 合起来' : '🔍 拆开看身体';
        if (apart) sub(isShrimp ? '拆开看看：两只复眼、触角、触角鳞片、一对捕肢、步足、头胸甲、六节腹节，最后是尾节和尾扇。' : `拆开看看：${animal}的身体从头部到尾部，是一节一节连起来的。`);
      }
      if (c === 'hide') { const a = bar.querySelector('[data-org="anatomy"]') as HTMLElement; a.classList.remove('on'); a.textContent = '🔍 拆开看身体'; }
    });
    stage.appendChild(bar);
  }

  // The real animal, from the photos, videos or scans the parent registered. Never a stand-in model (BL14).
  function showOrganism(stage: HTMLElement) {
    stage.querySelector('.observe,.pending-card')?.remove();
    const media = animalMedia.filter(m => m.kind === 'photo' || m.kind === 'video');
    if (!media.length) {
      stage.appendChild(h(`<div class="pending-card">${esc(animal)}的实拍素材还没到位，家长在「课程库 · 生物素材」加上后会出现在这里<br><span class="dimtext">写实底线：不用卡通或简化模型代替</span></div>`));
      return;
    }
    let k = 0;
    const box = h(`<figure class="observe"><button class="x" aria-label="关上">✕</button><div class="frame"></div><figcaption></figcaption>
      ${media.length > 1 ? '<div class="row"><button class="btn sm" data-prev>‹</button><span class="muted small" data-n></span><button class="btn sm" data-next>›</button></div>' : ''}</figure>`);
    const show = () => {
      const m = media[k];
      (box.querySelector('.frame') as HTMLElement).innerHTML = m.kind === 'video'
        ? `<video src="${esc(m.url)}" autoplay muted loop playsinline controls></video>`
        : `<img src="${esc(m.url)}" alt="${esc(m.caption ?? `${animal}实拍`)}">`;
      (box.querySelector('figcaption') as HTMLElement).innerHTML = `<span class="tag">${esc(!m.origin || m.origin === '实拍' ? (m.kind === 'video' ? '实拍视频' : '实拍照片') : m.origin)}</span>${esc(m.caption ?? '')}${m.length_cm ? ` · 身长约 ${esc(m.length_cm)} 厘米${m.length_cm < 100 ? `，是样方边长 1 米的 ${esc(Math.round(m.length_cm))}/100` : ''}` : ''}<br><span class="dimtext">${esc(m.credit)} · ${esc(m.license)}</span>`;
      const n = box.querySelector('[data-n]'); if (n) n.textContent = `${k + 1}/${media.length}`;
      log('organism_media', { media: m.id, kind: m.kind });
    };
    (box.querySelector('.x') as HTMLButtonElement).onclick = () => box.remove();
    (box.querySelector('[data-prev]') as HTMLButtonElement | null)?.addEventListener('click', () => { k = (k + media.length - 1) % media.length; show(); });
    (box.querySelector('[data-next]') as HTMLButtonElement | null)?.addEventListener('click', () => { k = (k + 1) % media.length; show(); });
    stage.appendChild(box); show();
  }

  function renderSteps() {
    $('#steps').innerHTML = STEPS.map((s, i) => `<button class="step ${i === step ? 'on' : ''} ${i < step ? 'done' : ''}" data-step="${i}" ${opts.kid ? 'disabled' : ''}>${s}<span class="t">${fmt(times[STEP_KEYS[i]])}</span></button>`).join('');
    if (!opts.kid) root.querySelectorAll<HTMLButtonElement>('[data-step]').forEach(b => b.onclick = () => go(Number(b.dataset.step)));
  }

  let demoWatch: ((e: Event) => void) | null = null;
  function go(i: number) {
    scene?.dispose(); scene = null; pic?.dispose(); pic = null; host?.dispose(); host = null;
    if (demoWatch) root.removeEventListener('adw:event', demoWatch); demoWatch = null;
    clock?.stop(); subClock?.stop(); voice.stop(); epoch++;
    const cap = root.querySelector('#cap') as HTMLElement | null; if (cap) cap.hidden = true;
    step = i; renderSteps(); log('step', { step: STEPS[i] ?? '结束' });
    const g = $('#guide');
    g.hidden = i >= STEPS.length;
    if (i < STEPS.length) {
      $('#gstep').textContent = `第 ${i + 1} 步 / 共 ${STEPS.length} 步 · ${STEPS[i]}：`;
      subGuide('');
      guide(STEP_GUIDE[i], i !== 1);
      startClock(times[STEP_KEYS[i]], () => timeUp(i));
    }
    [intro, demo, challenges, chat, finish][i]();
  }

  // Time is up: the step ends by itself so the lesson keeps moving; the last step ends the lesson.
  const onTimeout: Record<number, () => void> = {};
  function timeUp(i: number) {
    if (step !== i) return;
    onTimeout[i]?.();
    log('step_timeout', { step: STEPS[i], next: i + 1 < STEPS.length ? STEPS[i + 1] : '结束' });
    go(i + 1);
    void say(i + 1 < STEPS.length ? `时间到了，我们进入下一步：${STEPS[i + 1].replace(/（.*）/, '')}。` : '时间到了，今天就到这里。');
  }

  // Step 1 is read aloud with subtitles; the demo opens only after the whole intro has been heard.
  function intro() {
    $('#body').innerHTML = `<div class="card"><p class="lead" data-line>${esc(sp.intro.headline)}</p>${sp.intro.paragraphs.map(p => `<p data-line>${esc(p)}</p>`).join('')}${sp.intro.note ? `<p class="muted small">${esc(sp.intro.note)}</p>` : ''}</div>
      <div class="row"><button class="btn primary" id="next">开始演示</button><button class="btn" id="again">🔁 再听一遍</button></div>`;
    const next = $('#next'), lines = [...root.querySelectorAll('[data-line]')];
    next.onclick = () => go(1);
    const read = async () => {
      lock(next, '先听完说明…');
      const ok = await narrate([sp.intro.headline, ...sp.intro.paragraphs].map((text, k) => ({ text, el: lines[k] })));
      if (ok) { unlock(next); log('intro_heard'); guide('听完了，点「开始演示」。'); }
    };
    $('#again').onclick = () => { voice.stop(); epoch++; void read(); };
    void read();
  }

  function demo() {
    const comp = sp.scene_component_ids[0];
    const name = comp.split('@')[0];
    const actions = sp.activity_graph.filter(n => (n.type === 'demo' || n.type === 'contrast') && n.action).flatMap(n => n.action!.split('+'));
    if (sp.hotspots.some(x => x.anchor === 'shrimp')) actions.push('focus');
    const labels: Record<string, string> = { ...(ACTION_LABELS[skin] ?? {}), ...(skin === 'reef' ? { focus: `看看${animal}的洞` } : {}) };
    const predict = sp.activity_graph.find(n => n.type === 'predict');
    $('#body').innerHTML = `
      <div class="demo">
        <div class="stage" id="stage">
          <div class="tools"><button id="zin" aria-label="放大">＋</button><button id="zout" aria-label="缩小">－</button><button id="zreset" aria-label="复位视角">⟲</button><button id="labels" aria-label="隐藏标签">🏷</button></div>
          <span class="badge">写实渲染 · 计算为模拟</span>
        </div>
        <div class="panel">
          <div class="row wrap">${[...new Set(actions)].map(a => `<button class="btn" data-act="${esc(a)}">${esc(labels[a] ?? a)}</button>`).join('')}</div>
          <div class="readout" id="readout">${name === 'PerimeterArea' ? '卷尺 <b id="pv">0</b> 米 · 样方 <b id="sv">0</b> 个' : '已经摆了 <b id="rv">0</b> 行'}</div>
          ${predict ? `<div class="card small"><b>想一想：</b>${esc(predict.prompt)}</div>` : ''}
          <div class="row wrap small"><span class="muted">热点列表：</span>${sp.hotspots.map(x => `<button class="btn sm" data-hs="${esc(x.anchor)}">🔊 ${esc(x.label)}</button>`).join('')}</div>
          <button class="btn primary" id="next">我准备好了，去挑战</button>
        </div>
      </div>`;
    const stage = $('#stage');
    const cut = animalMedia.find(m => m.kind === 'cutout');
    scene = mount(stage, comp, sp.component_params[name] as Record<string, unknown>, {
      organism: cut ? { url: cut.url, rig: cut.rig ?? null, rigMeta: cut.rig_meta ?? null, lengthM: (cut.length_cm ?? (isShrimp ? 16 : 30)) / 100 } : undefined,
      hotspots: sp.hotspots.map(x => ({ anchor: x.anchor, label: x.label })),
      onHotspot: a => playHotspot(a),
      onPick: info => log('pick', info),
      onProgress: (a, v) => {
        const id = a === 'walk' ? '#pv' : a === 'fill' ? '#sv' : '#rv';
        const el = root.querySelector(id); if (el) el.textContent = String(Math.floor(v + 1e-6));
      },
    });
    root.querySelectorAll<HTMLButtonElement>('[data-act]').forEach(b => b.onclick = async () => {
      const a = b.dataset.act!;
      log('action', { action: a, label: b.textContent?.trim() });
      if (a === 'focus') { scene?.focus('shrimp'); playHotspot('shrimp'); return; }
      b.disabled = true; b.dataset.running = '1'; await scene?.run(a); delete b.dataset.running; b.disabled = b.classList.contains('later'); log('action_done', { action: a });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-hs]').forEach(b => b.onclick = () => playHotspot(b.dataset.hs!));
    $('#zin').onclick = () => scene?.zoom(0.85); $('#zout').onclick = () => scene?.zoom(1.18);
    $('#zreset').onclick = () => scene?.reset(); $('#labels').onclick = () => scene?.toggleLabels();
    $('#next').onclick = () => go(2);
    guideDemo(actions.filter((a, i) => actions.indexOf(a) === i), labels, predict?.prompt);
  }

  // One thing at a time: highlight the next button, say what to look for, and if the child
  // doesn't get to it in time, do it for them and move on.
  function guideDemo(actions: string[], labels: Record<string, string>, predict?: string) {
    type Task = { act?: string; text: string };
    const hintFor = (a: string) => sp.activity_graph.find(n => n.action?.split('+').includes(a))?.hints?.[0];
    const tasks: Task[] = actions.map(a => ({ act: a, text: `点「${labels[a] ?? a}」${hintFor(a) ? '，' + hintFor(a) : a === 'focus' ? '，听一听它的故事' : ''}。` }));
    if (predict) tasks.splice(Math.min(tasks.length, 2), 0, { text: `想一想：${predict} 想好了点「想好了」。` });
    const per = Math.max(20, Math.floor(times.demo * 0.8 / Math.max(1, tasks.length)));
    let k = -1;
    lock($('#next'), `先做完这 ${tasks.length} 件事`);
    const next = () => {
      subClock?.stop();
      root.querySelectorAll('.pulse').forEach(n => n.classList.remove('pulse'));
      root.querySelector('#think')?.remove();
      if (step !== 1) return;
      k++;
      // Buttons for later tasks stay locked until their turn, so the child goes in order.
      root.querySelectorAll<HTMLButtonElement>('[data-act]').forEach(b => {
        const later = k < tasks.length && tasks.findIndex(x => x.act === b.dataset.act) > k;
        b.classList.toggle('later', later);
        if (!b.dataset.running) b.disabled = later;
      });
      if (k >= tasks.length) { guide('都看完了！还可以自己转一转、点一点，准备好了就去挑战。'); subGuide(''); unlock($('#next')); log('demo_done'); return; }
      const t = tasks[k];
      guide(`第 ${k + 1} 件事（共 ${tasks.length} 件）：${t.text}`);
      if (t.act) root.querySelector(`[data-act="${t.act}"]`)?.classList.add('pulse');
      else {
        const b = h('<button class="btn primary pulse" id="think">想好了</button>');
        b.onclick = () => { log('predict_ready'); next(); };
        $('#gtext').after(b);
      }
      subClock = new Countdown(per, scale, {
        tick: left => subGuide(`这件事还有 ${fmt(Math.ceil(left))}`),
        end: () => {
          if (step !== 1) return;
          const b = t.act ? root.querySelector<HTMLButtonElement>(`[data-act="${t.act}"]`) : null;
          if (b?.disabled) return; // already running: its own end moves the guide on
          log('task_timeout', { task: t.act ?? 'predict' });
          if (b) { void say('时间到了，我帮你点一下。'); b.click(); }
          else next();
        },
      }, []).start();
    };
    demoWatch = e => {
      const d = (e as CustomEvent<LessonEvent>).detail;
      const t = tasks[k];
      if (step === 1 && t?.act && ((d.type === 'action_done' && d.action === t.act) || (t.act === 'focus' && d.type === 'action' && d.action === 'focus'))) next();
    };
    root.addEventListener('adw:event', demoWatch);
    next();
  }

  type Ask = Pick<Challenge, 'answers' | 'options'>;
  function answerInputs(c: Ask) {
    const units = [...new Set(c.answers.map(a => a.unit).filter(Boolean))] as string[];
    return c.options
      ? `<div class="row wrap">${c.options.map(o => `<button class="btn opt" data-opt="${esc(o)}">${esc(o)}</button>`).join('')}</div>`
      : `<div class="row wrap">${c.answers.map(a => `<label class="field">${esc(a.label ?? '')}<input inputmode="numeric" data-f="${esc(a.field)}" aria-label="${esc(a.label ?? a.field)}">${a.unit ? `<select data-u="${esc(a.field)}"><option value="">单位</option>${units.map(u => `<option>${esc(u)}</option>`).join('')}</select>` : ''}</label>`).join('')}</div>`;
  }
  /** Wires the option buttons of an answer box and returns a reader for what the child entered. */
  function answerBox(box: HTMLElement, c: Ask) {
    let picked = '';
    box.querySelectorAll<HTMLButtonElement>('[data-opt]').forEach(b => b.onclick = () => {
      picked = b.dataset.opt!; box.querySelectorAll('[data-opt]').forEach(x => x.classList.toggle('on', x === b));
    });
    return (): Attempt => {
      const attempt: Attempt = {};
      if (c.options) attempt[c.answers[0].field] = { value: picked };
      else for (const a of c.answers) {
        attempt[a.field] = {
          value: (box.querySelector(`[data-f="${a.field}"]`) as HTMLInputElement).value,
          unit: (box.querySelector(`[data-u="${a.field}"]`) as HTMLSelectElement | null)?.value || undefined,
        };
      }
      return attempt;
    };
  }
  /** Shows the right answer in the boxes (the end of a worked example). */
  function fillAnswer(box: HTMLElement, c: Ask) {
    box.classList.add('shown');
    if (c.options) box.querySelectorAll<HTMLElement>('[data-opt]').forEach(x => x.classList.toggle('on', x.dataset.opt === String(c.answers[0].value)));
    for (const a of c.answers) {
      const f = box.querySelector(`[data-f="${a.field}"]`) as HTMLInputElement | null; if (f) f.value = String(a.value);
      const u = box.querySelector(`[data-u="${a.field}"]`) as HTMLSelectElement | null; if (u && a.unit) u.value = a.unit;
    }
    box.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(x => { x.disabled = true; });
  }
  function challengeCard(c: Challenge, i: number) {
    return `<div class="card" data-ch="${esc(c.id)}" hidden><p data-prompt><b>第 ${i + 1} 题（共 ${sp.challenges.length} 题）</b> ${esc(c.prompt)}</p>
      <div class="cpic"><div class="stage mini" data-pic></div><span class="pictag">按题目里的数摆出来的，可以转着看</span></div><div class="ans">${answerInputs(c)}</div>
      <div class="row"><button class="btn primary" data-chk>检查</button><button class="btn" data-hint>提示</button><button class="btn" data-read>🔊 再读一遍</button><button class="btn primary" data-go hidden>${i + 1 < sp.challenges.length ? '下一题' : '题目做完了'}</button></div>
      <p class="fb" aria-live="polite"></p><div class="worked" hidden></div><div class="twin" hidden></div></div>`;
  }

  // Every question comes with a picture (图文): the lesson's own 3D scene set up with the numbers in the question
  // (rows and gears in a row, a field's length and width). A question that doesn't name the theme still gets the
  // lesson's scene, so a robot lesson never falls back to plain blocks.
  // One picture at a time; it moves on with the question and changes for the child's own try after a demo.
  function pictureParams(text: string) {
    const comp = sp.scene_component_ids[0], name = comp.split('@')[0];
    const p: Record<string, unknown> = { ...(sp.component_params[name] as Record<string, unknown>) };
    const n = (re: RegExp) => { const m = re.exec(text); return m ? Number(m[1] ?? m[2]) : undefined; };
    const nums = (text.match(/\d+/g) ?? []).map(Number);
    const fits = (v: number | undefined, max: number): v is number => v !== undefined && v >= 1 && v <= max && Number.isInteger(v);
    if (name === 'ArrayMultiplier') {
      const rows = n(/(\d+)\s*(?:行|排)/) ?? nums[0], cols = n(/每(?:行|排)\s*(?:有|放|摆)?\s*(\d+)|(\d+)\s*列/) ?? nums[1];
      if (fits(rows, 9) && fits(cols, 9)) Object.assign(p, { rows, cols });
    } else if (name === 'PerimeterArea') {
      const a = n(/长\s*(?:是|为)?\s*(\d+)/) ?? nums[0], b = n(/宽\s*(?:是|为)?\s*(\d+)/) ?? nums[1];
      if (fits(a, 10) && fits(b, 10)) Object.assign(p, { a, b });
    }
    return { comp, p };
  }
  function picture(card: HTMLElement, text: string) {
    const el = card.querySelector<HTMLElement>('[data-pic]'); if (!el) return;
    pic?.dispose(); pic = null;
    const { comp, p } = pictureParams(text);
    try { pic = mount(el, comp, p, { hotspots: [], onHotspot: () => undefined }); pic.still(); log('picture', { params: p }); }
    catch { el.closest('.cpic')?.remove(); }
  }

  // One question at a time: each is shown with a subtitle and read aloud, and the next one opens once this one
  // is done (or its time is up). Every answer gets specific praise for what the child got right; after
  // DEMO_AFTER misses the Pad shows how it's done, step by step, and the child does a similar question alone.
  function challenges() {
    $('#body').innerHTML = sp.challenges.map(challengeCard).join('') + `<div class="row"><button class="btn primary" id="next">去聊聊</button></div>`;
    const next = $('#next');
    lock(next, `先做完这 ${sp.challenges.length} 道题`);
    const per = Math.max(30, Math.floor(times.challenge / Math.max(1, sp.challenges.length)));
    const persist = sp.encouragement?.persist;
    let cur = -1;
    const questionClock = (i: number, seconds: number) => {
      subClock?.stop();
      const mine = epoch, c = sp.challenges[i];
      subClock = new Countdown(seconds, scale, {
        tick: left => subGuide(`这道题还有 ${fmt(Math.ceil(left))}`),
        end: () => { if (epoch !== mine || cur !== i) return; log('question_timeout', { challenge: c.id }); void say('这道题的时间到了，我们看下一题。'); show(i + 1); },
      }, []).start();
    };
    const show = (i: number) => {
      subClock?.stop();
      root.querySelectorAll<HTMLElement>('[data-ch]').forEach((el, k) => { el.hidden = k !== i; });
      cur = i;
      if (i >= sp.challenges.length) {
        root.querySelectorAll<HTMLElement>('[data-ch]').forEach(el => { el.hidden = false; });
        pic?.dispose(); pic = null; root.querySelectorAll('.cpic').forEach(n => n.remove());
        guide('题目都做完了，点「去聊聊」。'); subGuide(''); unlock(next); return;
      }
      const c = sp.challenges[i];
      picture(root.querySelector(`[data-ch="${c.id}"]`) as HTMLElement, c.prompt);
      guide(`第 ${i + 1} 题（共 ${sp.challenges.length} 题）：先听题，再作答。`, false);
      void narrate([{ text: c.prompt, el: root.querySelector(`[data-ch="${c.id}"] [data-prompt]`) }]);
      questionClock(i, per);
    };
    sp.challenges.forEach((c, i) => {
      const card = root.querySelector(`[data-ch="${c.id}"]`) as HTMLElement;
      const q = <T extends HTMLElement>(sel: string) => card.querySelector(sel) as T;
      const chk = q<HTMLButtonElement>('[data-chk]'), hintBtn = q<HTMLButtonElement>('[data-hint]'), go = q<HTMLButtonElement>('[data-go]');
      const fb = q<HTMLElement>('.fb'), ans = q<HTMLElement>('.ans');
      const read = answerBox(ans, c);
      let tries = 0, done = false;
      const finished = () => { done = true; chk.disabled = true; hintBtn.disabled = true; go.hidden = false; go.classList.add('pulse'); };
      const nextHint = () => {
        const n = hintsUsed[c.id] = Math.min((hintsUsed[c.id] ?? 0) + 1, c.hints.length);
        log('hint', { challenge: c.id, level: n });
        return c.hints[n - 1] ?? '';
      };
      q<HTMLButtonElement>('[data-read]').onclick = () => { void narrate([{ text: c.prompt, el: q('[data-prompt]') }]); };
      go.onclick = () => show(i + 1);
      hintBtn.onclick = () => { const t = nextHint(); fb.className = 'fb'; fb.textContent = c.hints.slice(0, hintsUsed[c.id]).join(' '); void narrate([{ text: t }]); };
      chk.onclick = async () => {
        if (done) return;
        const attempt = read(), r = checkAttempt(c, attempt), hints = hintsUsed[c.id] ?? 0;
        log('answer', { challenge: c.id, correct: r.correct, hints, attempt, try: tries + 1 });
        if (r.correct) {
          voice.chime(); finished();
          const t = praiseRight({ tries, hints, seed: i });
          fb.className = 'fb good'; fb.textContent = t; void narrate([{ text: t }]);
          return;
        }
        tries++;
        const t = encourageWrong(c, r, attempt, { tries, persist });
        fb.className = 'fb try'; fb.textContent = t;
        if (tries < DEMO_AFTER) {
          // the second miss brings the next hint by itself
          const hint = tries === 2 && (hintsUsed[c.id] ?? 0) < c.hints.length ? nextHint() : '';
          if (hint) fb.textContent += ` 提示：${hint}`;
          void narrate([{ text: t }, ...(hint ? [{ text: `提示：${hint}` }] : [])]);
          return;
        }
        chk.disabled = true; hintBtn.disabled = true;
        const mine = epoch;
        subClock?.stop(); // watching the demo doesn't use up the child's time
        if (!await narrate([{ text: t }]) || epoch !== mine || cur !== i) return;
        await workedExample(c, i, card, ans, mine);
      };
    });

    async function workedExample(c: Challenge, i: number, card: HTMLElement, ans: HTMLElement, mine: number) {
      log('worked_example', { challenge: c.id });
      const w = card.querySelector('.worked') as HTMLElement, steps = workedSteps(c);
      w.hidden = false;
      w.innerHTML = `<p class="wtitle">👀 一起看一遍怎么做</p><ol>${steps.map(x => `<li hidden>${esc(x)}</li>`).join('')}</ol>`;
      const lis = [...w.querySelectorAll<HTMLElement>('li')];
      for (const [k, li] of lis.entries()) {
        if (epoch !== mine || cur !== i) return;
        li.hidden = false;
        if (k === lis.length - 1) fillAnswer(ans, c);
        await narrate([{ text: steps[k], el: li }]);
      }
      if (epoch !== mine || cur !== i) return;
      // Now the child uses the same method alone, on a similar question.
      const tw = c.twin ?? { prompt: c.prompt, answers: c.answers, options: c.options };
      if (c.twin) picture(card, tw.prompt);
      const box = card.querySelector('.twin') as HTMLElement;
      box.hidden = false;
      box.innerHTML = `<p class="wtitle">✋ 轮到你自己做一次</p><p data-tprompt>${esc(tw.prompt)}</p><div class="ans">${answerInputs(tw)}</div>
        <div class="row"><button class="btn primary" data-tchk>检查</button></div><p class="fb" aria-live="polite"></p>`;
      const tans = box.querySelector('.ans') as HTMLElement, tfb = box.querySelector('.fb') as HTMLElement, tchk = box.querySelector('[data-tchk]') as HTMLButtonElement;
      const read = answerBox(tans, tw);
      const go = card.querySelector('[data-go]') as HTMLButtonElement;
      tchk.onclick = () => {
        const attempt = read(), r = checkAttempt({ ...c, ...tw }, attempt);
        log('answer', { challenge: c.id, twin: true, correct: r.correct, attempt });
        tchk.disabled = true; go.hidden = false; go.classList.add('pulse');
        let t: string;
        if (r.correct) { voice.chime(); t = praiseRight({ tries: 0, hints: 0, afterDemo: true, seed: i }); tfb.className = 'fb good'; }
        else { t = `${findGood(tw, r, attempt)}这道题的答案是：${answerText(tw)}。方法你已经看懂了，下次一定能自己做出来！`; tfb.className = 'fb try'; fillAnswer(tans, tw); }
        tfb.textContent = t; void narrate([{ text: t }]);
      };
      questionClock(i, Math.max(30, Math.round(per * 0.6)));
      void narrate([{ text: '现在轮到你自己做一次。' }, { text: tw.prompt, el: box.querySelector('[data-tprompt]') }]);
    }
    next.onclick = () => go(3);
    show(0);
    onTimeout[2] = () => {
      const tried = new Set(events.filter(e => e.type === 'answer').map(e => e.challenge));
      const left = sp.challenges.filter(c => !tried.has(c.id)).map(c => c.id);
      if (left.length) log('challenges_unanswered', { challenges: left });
    };
  }

  // The chat at the end is hosted by a robot that talks, nods at answers and waves goodbye.
  function withHost(html: string) {
    $('#body').innerHTML = `<div class="hostwrap"><div class="host" id="host" aria-hidden="true"><span class="hostname">机器人助手</span></div><div class="hostside">${html}</div></div>`;
    try { host = mountHost($('#host'), { reduced: reducedMotion }); } catch { $('#host').remove(); }
  }
  function chat() {
    const qs = sp.end_chat.questions;
    withHost(`<div class="card"><p class="muted small">说不说都可以，只用来准备下一次课。</p>
      ${qs.map(q => `<div class="q" data-q="${esc(q.id)}"><p><b>${esc(q.prompt)}</b></p><div class="row wrap">${q.options.map(o => `<button class="btn opt" data-a="${esc(o)}">${esc(o)}</button>`).join('')}${q.allow_own_words ? `<input class="own" maxlength="20" placeholder="我自己说一个（20 字以内）" aria-label="我自己说一个">` : ''}</div></div>`).join('')}
      </div><div class="row"><button class="btn primary" id="done">说完了</button><button class="btn" id="skip">跳过</button></div>`);
    const answers: Record<string, string> = {};
    qs.forEach(q => {
      const box = root.querySelector(`[data-q="${q.id}"]`) as HTMLElement;
      box.querySelectorAll<HTMLButtonElement>('[data-a]').forEach(b => b.onclick = () => {
        answers[q.id] = b.dataset.a!; box.querySelectorAll('[data-a]').forEach(x => x.classList.toggle('on', x === b)); host?.nod();
        const own = box.querySelector('.own') as HTMLInputElement | null; if (own) own.value = '';
      });
      const own = box.querySelector('.own') as HTMLInputElement | null;
      if (own) own.oninput = () => { answers[q.id] = own.value.trim(); box.querySelectorAll('[data-a]').forEach(x => x.classList.remove('on')); };
    });
    const record = () => { for (const q of qs) if (answers[q.id]) log(q.kind === 'next_lesson_wish' ? 'next_lesson_wish' : 'reflection', { question: q.id, answer: answers[q.id], source: '孩子自述' }); };
    $('#done').onclick = () => { record(); go(4); };
    $('#skip').onclick = () => { log('chat_skipped'); go(4); };
    // What the child already picked still counts when time runs out.
    onTimeout[3] = record;
    void narrate([{ text: `${opts.childName ? `${opts.childName}，` : ''}今天辛苦啦！我是机器人助手，想听听你的想法。` }, ...qs.map(q => ({ text: q.prompt, el: root.querySelector(`[data-q="${q.id}"] p`) }))]);
  }

  function finish() {
    // Replaying the demo is fine while the lesson is within its planned time, not after.
    const overTime = (Date.now() - startedAt) / 1000 * scale >= STEP_KEYS.reduce((a, k) => a + times[k], 0);
    const answered = events.filter(e => e.type === 'answer');
    const solved = new Set(answered.filter(e => e.correct).map(e => e.challenge));
    withHost(`<div class="card"><p class="lead">今天的探索结束了。</p>
      <p>${solved.size ? `你做对了 ${solved.size} 道题${[...solved].length < sp.challenges.length ? '，其他的下次再试' : ''}。` : '今天主要在看和试，题目下次再做也可以。'}</p>
      <p class="muted small">这里只说看到的事情，不打分、不排名。</p></div>
      ${sp.offscreen ? `<div class="card"><p><b>可以不做的家里小任务</b></p><p>${esc(sp.offscreen.task)}</p><p class="muted small">${sp.offscreen.adult ? '需要大人陪同 · ' : ''}材料：${esc((sp.offscreen.materials ?? []).join('、'))} · 没材料就跳过。</p></div>` : ''}
      <div class="row">${overTime ? '' : '<button class="btn" id="again">再玩一次演示</button>'}${opts.onExit ? '<button class="btn" id="exit">回到今天的课</button>' : ''}</div>`);
    host?.wave();
    root.querySelector<HTMLButtonElement>('#again')?.addEventListener('click', () => go(1));
    say('今天的探索结束了，下次见！');
    if (opts.onExit) $('#exit').onclick = opts.onExit;
    log('lesson_end', { solved: [...solved] });
  }

  renderPointers();
  // Start with one big tap: it turns sound on (iPad needs a tap first) and the lesson begins with the voice.
  renderSteps();
  $('#guide').hidden = true;
  $('#body').innerHTML = `<div class="startcard"><p class="lead">${esc(sp.title)}</p><p class="muted">一共 ${STEPS.length} 步，每一步都有时间。把声音打开，准备好了就点下面。</p>
    <button class="btn primary big" id="start">🔊 开始上课</button>
    <p class="muted small">点了没有声音：按 iPad 侧面的音量加键，再看控制中心里的静音铃铛是不是开着。</p></div>`;
  $('#start').onclick = () => { voice.unlock(); log('start'); go(0); };
  return { events, get scene() { return scene; }, dispose: () => { scene?.dispose(); pic?.dispose(); host?.dispose(); clock?.stop(); subClock?.stop(); voice.stop(); } };
}

declare global { interface Window { __LESSON__?: LessonSpec; __CHILD_NAME__?: string } }
if (typeof window !== 'undefined' && window.__LESSON__) {
  const el = document.getElementById('app')!;
  (window as unknown as { __player: unknown }).__player = play(el, window.__LESSON__, { childName: window.__CHILD_NAME__ });
}
