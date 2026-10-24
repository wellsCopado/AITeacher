// Lesson player: renders one frozen LessonSpec with the pre-reviewed components.
// Used by `dls preview` now and by the Pad app in M3, which will also send the recorded events to the server.
import type { Challenge, LessonSpec } from '../../schema/src/index.js';
import { mount, type Instance } from '../../components/src/index.js';
import { pointerKey, utterance, type LangMode } from './language.js';
import { checkAttempt, describe, type Attempt } from './check.js';

export interface LessonEvent { at: string; type: string; [k: string]: unknown }

const ACTION_LABELS: Record<string, Record<string, string>> = {
  reef: { walk: '拉卷尺围一圈', fill: '放样方', focus: '看看螳螂虾的洞' },
  garden: { walk: '测距轮走一圈', fill: '铺地砖' },
  blocks: { reveal: '一行一行摆', rotate: '转个方向' },
};
const STEPS = ['说明', '互动演示', '挑战', '聊聊（可跳过）'];

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const h = (html: string) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };

export function play(root: HTMLElement, sp: LessonSpec, opts: { childName?: string } = {}) {
  const lessonKey = `${sp.lesson_id}@${sp.version}`;
  const events: LessonEvent[] = [];
  const pointers: Record<string, number> = {};
  let mode: LangMode = sp.learner_profile.language.cycle_enabled ? 'cycle' : 'zh';
  let step = 0;
  let scene: Instance | null = null;
  const hintsUsed: Record<string, number> = {};
  const skin = sp.theme.skin ?? '';
  const organismPending = (sp.pending_assets ?? []).filter(p => p.kind === 'organism');

  const log = (type: string, data: Record<string, unknown> = {}) => {
    const e = { at: new Date().toISOString(), type, ...data };
    events.push(e);
    root.dispatchEvent(new CustomEvent('adw:event', { detail: e, bubbles: true }));
    renderLog();
  };

  root.innerHTML = `
  <div class="adw">
    <main class="pad">
      <header class="pad-head">
        <div><h1>${esc(sp.title)}</h1><p class="muted">${esc(opts.childName ?? sp.for_child)} · ${esc(sp.primary_concept.name)} · v${esc(sp.version)}</p></div>
        <label class="lang">讲解语言 <select id="lang"><option value="zh">中文</option><option value="cycle">1 中 3 英循环</option></select></label>
      </header>
      <nav class="steps" id="steps"></nav>
      <section id="body"></section>
    </main>
    <aside class="side">
      <h2>家长看</h2>
      <p>${esc(sp.parent_tip)}</p>
      <p class="muted">主题：${esc(sp.theme.name)}（${esc(sp.theme.why)}）</p>
      ${sp.pending_assets?.length ? `<p class="muted">待到位素材：${sp.pending_assets.map(p => esc(p.asset_id)).join('、')}，到位前不展示。</p>` : ''}
      <h2>讲解语言计数</h2><div id="ptr"></div>
      <h2>学习记录</h2><ol id="log" class="log"></ol>
    </aside>
  </div>`;
  const $ = (sel: string) => root.querySelector(sel) as HTMLElement;
  ($('#lang') as HTMLSelectElement).value = mode;
  ($('#lang') as HTMLSelectElement).onchange = e => { mode = (e.target as HTMLSelectElement).value as LangMode; log('language_mode', { mode }); };

  function renderLog() {
    const el = root.querySelector('#log'); if (!el) return;
    el.innerHTML = events.slice(-12).reverse().map(e => `<li><code>${esc(e.at.slice(11, 19))}</code> ${esc(e.type)} ${esc(Object.entries(e).filter(([k]) => k !== 'at' && k !== 'type').map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' '))}</li>`).join('');
  }
  function renderPointers() {
    $('#ptr').innerHTML = sp.hotspots.map(hs => {
      const n = pointers[pointerKey(sp.for_child, lessonKey, hs.id)] ?? 0;
      return `<div class="ptr"><span>${esc(hs.label)}</span><span>${n} 次</span></div>`;
    }).join('');
  }

  function playHotspot(anchor: string, override?: 'zh') {
    const hs = sp.hotspots.find(x => x.anchor === anchor); if (!hs) return;
    const key = pointerKey(sp.for_child, lessonKey, hs.id);
    const u = utterance(mode, pointers[key] ?? 0, hs.language_pack, override);
    if (u.advance) pointers[key] = (pointers[key] ?? 0) + 1;
    const stage = root.querySelector('.stage');
    if (stage) {
      let sub = stage.querySelector('.sub') as HTMLElement | null;
      if (!sub) { sub = h('<div class="sub"></div>'); stage.appendChild(sub); }
      sub.innerHTML = `<span class="tag">${u.lang === 'zh' ? '中' : 'EN'}</span>${esc(u.text)}${u.fallback ? ' <span class="dimtext">（这条暂时没有英文，先用中文）</span>' : ''}`;
    }
    if (anchor === 'shrimp' && organismPending.length && stage && !stage.querySelector('.pending-card')) {
      stage.appendChild(h(`<div class="pending-card">螳螂虾的写实模型还没到位，到位后会出现在洞口<br><span class="dimtext">写实底线：不用卡通或简化模型代替</span></div>`));
    }
    log('hotspot', { id: hs.id, lang: u.lang, ...(u.advance ? { count: pointers[key] } : {}), ...(override ? { override } : {}), ...(u.fallback ? { fallback: true } : {}) });
    renderPointers();
  }

  function renderSteps() {
    $('#steps').innerHTML = STEPS.map((s, i) => `<button class="step ${i === step ? 'on' : ''} ${i < step ? 'done' : ''}" data-step="${i}">${s}</button>`).join('');
    root.querySelectorAll<HTMLButtonElement>('[data-step]').forEach(b => b.onclick = () => go(Number(b.dataset.step)));
  }

  function go(i: number) {
    scene?.dispose(); scene = null;
    step = i; renderSteps(); log('step', { step: STEPS[i] ?? '结束' });
    [intro, demo, challenges, chat, finish][i]();
  }

  function intro() {
    $('#body').innerHTML = `<div class="card"><p class="lead">${esc(sp.intro.headline)}</p>${sp.intro.paragraphs.map(p => `<p>${esc(p)}</p>`).join('')}${sp.intro.note ? `<p class="muted small">${esc(sp.intro.note)}</p>` : ''}</div>
      <div class="row"><button class="btn primary" id="next">开始演示</button></div>`;
    $('#next').onclick = () => go(1);
  }

  function demo() {
    const comp = sp.scene_component_ids[0];
    const name = comp.split('@')[0];
    const actions = sp.activity_graph.filter(n => (n.type === 'demo' || n.type === 'contrast') && n.action).flatMap(n => n.action!.split('+'));
    if (sp.hotspots.some(x => x.anchor === 'shrimp')) actions.push('focus');
    const labels = ACTION_LABELS[skin] ?? {};
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
          <div class="row wrap small"><span class="muted">热点列表：</span>${sp.hotspots.map(x => `<button class="btn sm" data-hs="${esc(x.anchor)}">${esc(x.label)}</button><button class="btn sm ghost" data-zh="${esc(x.anchor)}" title="现在听中文，不计数">中</button>`).join('')}</div>
          <button class="btn primary" id="next">我准备好了，去挑战</button>
        </div>
      </div>`;
    const stage = $('#stage');
    scene = mount(stage, comp, sp.component_params[name] as Record<string, unknown>, {
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
      log('action', { action: a });
      if (a === 'focus') { scene?.focus('shrimp'); playHotspot('shrimp'); return; }
      b.disabled = true; await scene?.run(a); b.disabled = false; log('action_done', { action: a });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-hs]').forEach(b => b.onclick = () => playHotspot(b.dataset.hs!));
    root.querySelectorAll<HTMLButtonElement>('[data-zh]').forEach(b => b.onclick = () => playHotspot(b.dataset.zh!, 'zh'));
    $('#zin').onclick = () => scene?.zoom(0.85); $('#zout').onclick = () => scene?.zoom(1.18);
    $('#zreset').onclick = () => scene?.reset(); $('#labels').onclick = () => scene?.toggleLabels();
    $('#next').onclick = () => go(2);
  }

  function challengeCard(c: Challenge, i: number) {
    const units = [...new Set(c.answers.map(a => a.unit).filter(Boolean))] as string[];
    const inputs = c.options
      ? `<div class="row wrap">${c.options.map(o => `<button class="btn opt" data-opt="${esc(o)}">${esc(o)}</button>`).join('')}</div>`
      : `<div class="row wrap">${c.answers.map(a => `<label class="field">${esc(a.label ?? '')}<input inputmode="numeric" data-f="${esc(a.field)}" aria-label="${esc(a.label ?? a.field)}">${a.unit ? `<select data-u="${esc(a.field)}"><option value="">单位</option>${units.map(u => `<option>${esc(u)}</option>`).join('')}</select>` : ''}</label>`).join('')}</div>`;
    return `<div class="card" data-ch="${esc(c.id)}"><p><b>${i + 1}.</b> ${esc(c.prompt)}</p>${inputs}
      <div class="row"><button class="btn primary" data-chk>检查</button><button class="btn" data-hint>提示</button></div>
      <p class="fb" aria-live="polite"></p></div>`;
  }

  function challenges() {
    $('#body').innerHTML = sp.challenges.map(challengeCard).join('') + `<div class="row"><button class="btn primary" id="next">去聊聊</button></div>`;
    sp.challenges.forEach(c => {
      const card = root.querySelector(`[data-ch="${c.id}"]`) as HTMLElement;
      const fb = card.querySelector('.fb') as HTMLElement;
      let picked = '';
      card.querySelectorAll<HTMLButtonElement>('[data-opt]').forEach(b => b.onclick = () => {
        picked = b.dataset.opt!; card.querySelectorAll('[data-opt]').forEach(x => x.classList.toggle('on', x === b));
      });
      (card.querySelector('[data-hint]') as HTMLButtonElement).onclick = () => {
        const n = hintsUsed[c.id] = Math.min((hintsUsed[c.id] ?? 0) + 1, c.hints.length);
        fb.textContent = c.hints.slice(0, n).join(' ');
        log('hint', { challenge: c.id, level: n });
      };
      (card.querySelector('[data-chk]') as HTMLButtonElement).onclick = () => {
        const attempt: Attempt = {};
        if (c.options) attempt[c.answers[0].field] = { value: picked };
        else for (const a of c.answers) {
          attempt[a.field] = {
            value: (card.querySelector(`[data-f="${a.field}"]`) as HTMLInputElement).value,
            unit: (card.querySelector(`[data-u="${a.field}"]`) as HTMLSelectElement | null)?.value || undefined,
          };
        }
        const r = checkAttempt(c, attempt);
        fb.textContent = describe(r);
        log('answer', { challenge: c.id, correct: r.correct, hints: hintsUsed[c.id] ?? 0, attempt });
      };
    });
    $('#next').onclick = () => go(3);
  }

  function chat() {
    const qs = sp.end_chat.questions;
    $('#body').innerHTML = `<div class="card"><p class="muted small">说不说都可以，只用来准备下一次课。</p>
      ${qs.map(q => `<div class="q" data-q="${esc(q.id)}"><p><b>${esc(q.prompt)}</b></p><div class="row wrap">${q.options.map(o => `<button class="btn opt" data-a="${esc(o)}">${esc(o)}</button>`).join('')}${q.allow_own_words ? `<input class="own" maxlength="20" placeholder="我自己说一个（20 字以内）" aria-label="我自己说一个">` : ''}</div></div>`).join('')}
      </div><div class="row"><button class="btn primary" id="done">说完了</button><button class="btn" id="skip">跳过</button></div>`;
    const answers: Record<string, string> = {};
    qs.forEach(q => {
      const box = root.querySelector(`[data-q="${q.id}"]`) as HTMLElement;
      box.querySelectorAll<HTMLButtonElement>('[data-a]').forEach(b => b.onclick = () => {
        answers[q.id] = b.dataset.a!; box.querySelectorAll('[data-a]').forEach(x => x.classList.toggle('on', x === b));
        const own = box.querySelector('.own') as HTMLInputElement | null; if (own) own.value = '';
      });
      const own = box.querySelector('.own') as HTMLInputElement | null;
      if (own) own.oninput = () => { answers[q.id] = own.value.trim(); box.querySelectorAll('[data-a]').forEach(x => x.classList.remove('on')); };
    });
    $('#done').onclick = () => {
      for (const q of qs) if (answers[q.id]) log(q.kind === 'next_lesson_wish' ? 'next_lesson_wish' : 'reflection', { question: q.id, answer: answers[q.id], source: '孩子自述' });
      go(4);
    };
    $('#skip').onclick = () => { log('chat_skipped'); go(4); };
  }

  function finish() {
    const answered = events.filter(e => e.type === 'answer');
    const solved = new Set(answered.filter(e => e.correct).map(e => e.challenge));
    $('#body').innerHTML = `<div class="card"><p class="lead">今天的探索结束了。</p>
      <p>${solved.size ? `你做对了 ${solved.size} 道题${[...solved].length < sp.challenges.length ? '，其他的下次再试' : ''}。` : '今天主要在看和试，题目下次再做也可以。'}</p>
      <p class="muted small">这里只说看到的事情，不打分、不排名。</p></div>
      ${sp.offscreen ? `<div class="card"><p><b>可以不做的家里小任务</b></p><p>${esc(sp.offscreen.task)}</p><p class="muted small">${sp.offscreen.adult ? '需要大人陪同 · ' : ''}材料：${esc((sp.offscreen.materials ?? []).join('、'))} · 没材料就跳过。</p></div>` : ''}
      <div class="row"><button class="btn" id="again">再玩一次演示</button></div>`;
    $('#again').onclick = () => go(1);
    log('lesson_end', { solved: [...solved] });
  }

  renderPointers();
  go(0);
  return { events, dispose: () => scene?.dispose() };
}

declare global { interface Window { __LESSON__?: LessonSpec; __CHILD_NAME__?: string } }
if (typeof window !== 'undefined' && window.__LESSON__) {
  const el = document.getElementById('app')!;
  (window as unknown as { __player: unknown }).__player = play(el, window.__LESSON__, { childName: window.__CHILD_NAME__ });
}
