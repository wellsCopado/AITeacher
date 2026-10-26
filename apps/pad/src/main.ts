// Pad light app: pair once, pick a child, play today's lessons. Events go to a local queue first and are
// sent whenever the server is reachable, so a lesson works through a Wi-Fi drop.
import type { LessonSpec } from '../../../packages/schema/src/index.js';
import { play, type OrganismMedia } from '../../../packages/player/src/main.js';
import { createVoice, type FetchAudio } from '../../../packages/player/src/voice.js';

declare const __BUILD__: string;
/** Narration made by the server Mac's voice, played as ordinary audio on the Pad. */
const audio: FetchAudio = async (text, lang) => {
  const r = await fetch(`/v1/tts?lang=${lang}&text=${encodeURIComponent(text)}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!r.ok) throw new Error(`tts ${r.status}`);
  return r.arrayBuffer();
};
import { Queue, type Store as KV } from './queue.js';
import { installSpeech, native } from './native.js';

installSpeech();

interface Child { id: string; name: string; grade: number }
interface TodayLesson { key: string; title: string; concept: string; reason: string; expires_on: string | null; finished: boolean }

const kv: KV = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: queue stays in memory */ } },
};
const app = document.getElementById('app')!;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const newId = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9-]/g, '');
let token = kv.get('adw.token');
const localToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());

/** Where a child left a lesson today (pause → 退出, or the app was closed): the next start offers to go on from there. */
interface Resume { session: string; step: number; left: number | null; on: string }
const resumes = (child: string): Record<string, Resume> => {
  const all = JSON.parse(kv.get(`adw.resume.${child}`) || '{}') as Record<string, Resume>;
  for (const k of Object.keys(all)) if (all[k].on !== localToday()) delete all[k]; // a new day starts the lesson over
  return all;
};
const setResume = (child: string, key: string, r: Resume | null) => {
  const all = resumes(child);
  if (r) all[key] = r; else delete all[key];
  kv.set(`adw.resume.${child}`, JSON.stringify(all));
};

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers } });
  if (r.status === 401 && token) { token = null; kv.set('adw.token', ''); pairScreen(); throw new Error('设备已被家长移除，需要重新配对'); }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `出错了（${r.status}）`);
  return body as T;
}

const queue = new Queue(kv, async batch => {
  // A request on flaky Wi-Fi can hang; give up after 15 s so the next try can start.
  await api(`/v1/sessions/${batch.session}/events`, { method: 'POST', body: JSON.stringify({ child: batch.child, lesson: batch.lesson, events: batch.events }), signal: AbortSignal.timeout(15_000) });
});
let offline = false;
const syncBadge = () => { const n = queue.pending(); const b = document.getElementById('sync'); if (b) b.textContent = offline && n ? `${n} 条记录等网络恢复后上传` : ''; };
const flush = () => queue.flush().then(() => { offline = false; }, () => { offline = true; }).finally(syncBadge);
addEventListener('online', flush);
(window as unknown as { __pad: unknown }).__pad = { queue, flush };
setInterval(flush, 20_000);

function shell(inner: string) {
  app.innerHTML = `<div class="home">${inner}<p id="sync" class="muted small"></p></div>`;
  syncBadge();
}

// Full screen for learning: Safari's address bar and tabs go away. iPad only allows it from a tap, so every
// button tap asks again while the page isn't full screen (a child who swipes out is back in on the next tap).
// From the home-screen icon, or in the Android tablet app, the page already has the whole screen.
type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => void };
const isFull = () => !!(document.fullscreenElement ?? (document as FsDoc).webkitFullscreenElement);
// display-mode is also "fullscreen" while the browser page itself is full screen, so that doesn't count as the app
const standalone = () => !!native || !!(navigator as Navigator & { standalone?: boolean }).standalone || matchMedia('(display-mode: standalone)').matches || (!isFull() && matchMedia('(display-mode: fullscreen)').matches);
const canFull = () => !standalone() && !!(document.documentElement.requestFullscreen || (document.documentElement as FsEl).webkitRequestFullscreen);
function enterFull() {
  if (isFull() || !canFull()) return;
  const el = document.documentElement as FsEl;
  try { const r = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen?.(); (r as Promise<void> | undefined)?.catch?.(() => undefined); } catch { /* not allowed here */ }
}
function toggleFull() {
  if (!isFull()) return enterFull();
  const d = document as FsDoc;
  void (d.exitFullscreen ? d.exitFullscreen().catch(() => undefined) : d.webkitExitFullscreen?.());
}
let fullWanted = kv.get('adw.full') !== 'off';
addEventListener('click', e => { if (fullWanted && (e.target as HTMLElement).closest('button')) enterFull(); }, true);
// A small corner button to leave or re-enter full screen (a parent may want the browser back).
const fsBtn = document.createElement('button');
fsBtn.className = 'fsbtn'; fsBtn.setAttribute('aria-label', '全屏');
const fsSync = () => { fsBtn.hidden = !canFull(); fsBtn.textContent = isFull() ? '⤡' : '⛶'; document.body.classList.toggle('full', isFull() || standalone()); };
fsBtn.onclick = e => { e.stopPropagation(); fullWanted = !isFull(); kv.set('adw.full', fullWanted ? 'on' : 'off'); toggleFull(); };
for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(ev, fsSync);
document.body.appendChild(fsBtn); fsSync();

async function pairScreen() {
  shell(`<h1>连接家里的服务器</h1><p>请家长打开家长端的“设备与数据”页，输入下面的配对码。</p><p class="code" id="code">…</p><p class="muted" id="msg"></p>${native ? '<p><button class="btn" id="other">换一台 Mac</button></p>' : ''}`);
  const msg = document.getElementById('msg')!;
  if (native) document.getElementById('other')!.onclick = () => native!.changeServer();
  try {
    const { code } = await api<{ code: string }>('/v1/pair/start', { method: 'POST', body: '{}' });
    document.getElementById('code')!.textContent = code.replace(/(\d{3})(\d{3})/, '$1 $2');
    const timer = setInterval(async () => {
      try {
        const r = await api<{ status: string; token?: string }>(`/v1/pair/${code}`);
        if (r.status === 'approved' && r.token) { clearInterval(timer); token = r.token; kv.set('adw.token', r.token); chooseChild(); }
      } catch (e) { clearInterval(timer); msg.innerHTML = `${esc((e as Error).message)} <button class="btn" id="retry">重新开始</button>`; document.getElementById('retry')!.onclick = pairScreen; }
    }, 2000);
  } catch (e) { msg.textContent = `连不上服务器：${(e as Error).message}`; }
}

// Opened in Safari rather than from the home-screen icon: show once how to get the full-screen app.
function installHint() {
  if (standalone()) return '';
  return `<div class="hint"><b>全屏学习：</b>点任何按钮都会自动进入全屏${canFull() ? '（右上角 ⛶ 也可以切换）' : ''}。<b>装成桌面 App 更好：</b>在 Safari 里点顶部的分享按钮 <span class="ico">⬆︎</span>，选“添加到主屏幕”，以后从桌面的“探索世界”图标打开，就像 App 一样，没有地址栏。</div>`;
}

// One tap: a beep, then a Chinese and an English line. Shows which voice is used, so a parent can tell what's wrong.
let testVoice: ReturnType<typeof createVoice> | null = null;
async function soundTest() {
  const out = document.getElementById('sres')!;
  testVoice ??= createVoice(1, audio);
  testVoice.unlock(); testVoice.chime();
  out.textContent = '正在播放…';
  const info = await fetch('/v1/tts/info', { headers: { authorization: `Bearer ${token}` } }).then(r => r.json()).catch(() => null) as { available: boolean } | null;
  const t0 = performance.now();
  await testVoice.speak('你好，声音正常。', 'zh');
  await testVoice.speak('Hello, I can hear you.', 'en');
  out.textContent = `用的是${testVoice.source === 'server' ? '服务器 Mac 的语音' : testVoice.source === 'device' ? '平板自带语音' : '（没有可用的语音）'} · 服务器语音${info?.available ? '可用' : '不可用'} · ${native ? `平板 App ${native.version()}` : standalone() ? '桌面 App 模式' : isFull() ? '浏览器全屏' : '浏览器模式'} · 用时 ${((performance.now() - t0) / 1000).toFixed(1)} 秒 · 版本 ${__BUILD__}。听不到的话：按音量加键，关掉静音。`;
}

async function chooseChild() {
  shell(`<h1>今天谁来学？</h1><div class="kids" id="kids">…</div>${installHint()}
    <div class="soundtest"><button class="btn" id="stest">🔊 声音测试</button><span id="sres" class="muted small"></span></div>`);
  document.getElementById('stest')!.onclick = soundTest;
  try {
    const kids = await api<Child[]>('/v1/children');
    kv.set('adw.children', JSON.stringify(kids));
    renderKids(kids);
  } catch (e) {
    const cached = JSON.parse(kv.get('adw.children') || '[]') as Child[];
    if (cached.length) renderKids(cached); else document.getElementById('kids')!.textContent = (e as Error).message;
  }
}
function renderKids(kids: Child[]) {
  const box = document.getElementById('kids')!;
  box.innerHTML = kids.map(k => `<button class="kidbtn" data-id="${esc(k.id)}">${esc(k.name)}<span>${k.grade} 年级</span></button>`).join('');
  box.querySelectorAll<HTMLButtonElement>('.kidbtn').forEach(b => b.onclick = () => todayScreen(kids.find(k => k.id === b.dataset.id)!));
}

async function todayScreen(child: Child) {
  shell(`<div class="bar"><button class="btn" id="back">换人</button><h1>${esc(child.name)}今天的课</h1></div><div id="list" class="lessons">…</div>`);
  document.getElementById('back')!.onclick = chooseChild;
  const list = document.getElementById('list')!;
  let lessons: TodayLesson[];
  try {
    const r = await api<{ today: string; lessons: TodayLesson[] }>(`/v1/today?child=${encodeURIComponent(child.id)}`);
    lessons = r.lessons;
    kv.set(`adw.today.${child.id}`, JSON.stringify(r));
  } catch (e) {
    // Offline: show what was allowed earlier today, as decided by the server's date.
    const cached = JSON.parse(kv.get(`adw.today.${child.id}`) || 'null') as { today: string; lessons: TodayLesson[] } | null;
    lessons = cached && cached.today === localToday() ? cached.lessons : [];
    if (!lessons.length) { list.innerHTML = `<p>${esc((e as Error).message)}</p>`; return; }
  }
  if (!lessons.length) { list.innerHTML = `<p class="lead">今天没有安排课。</p><p class="muted">想学的话请家长在家长端排课或临时授权。</p>`; return; }
  const left = resumes(child.id);
  list.innerHTML = lessons.map(l => `<button class="lesson" data-key="${esc(l.key)}"><b>${esc(l.title)}</b><span>${esc(l.concept)} · ${esc(l.reason)}${left[l.key]?.step ? ` · 上到第 ${left[l.key].step + 1} 步，可以接着上` : l.finished ? ' · 今天做过了' : ''}</span></button>`).join('');
  list.querySelectorAll<HTMLButtonElement>('.lesson').forEach(b => b.onclick = () => lessonScreen(child, b.dataset.key!));
}

async function lessonScreen(child: Child, key: string) {
  let sp: LessonSpec;
  try {
    sp = await api<LessonSpec>(`/v1/lessons/${encodeURIComponent(key)}?child=${encodeURIComponent(child.id)}`);
    kv.set(`adw.lesson.${key}`, JSON.stringify(sp));
  } catch (e) {
    const cached = kv.get(`adw.lesson.${key}`);
    if (!cached || navigator.onLine) { alert((e as Error).message); return; }
    sp = JSON.parse(cached);
  }
  // Real photos and videos of animals the parent added (shown until a photoreal model exists).
  let media: OrganismMedia[] = [];
  if (sp.pending_assets?.length) {
    try { media = await api<OrganismMedia[]>('/v1/media'); kv.set('adw.media', JSON.stringify(media)); }
    catch { media = JSON.parse(kv.get('adw.media') ?? '[]'); }
  }
  // going on from where the child left today keeps the same learning record
  const before = resumes(child.id)[key];
  let session = before?.session ?? newId();
  app.innerHTML = '<div id="player"></div><p id="sync" class="muted small center"></p>';
  const el = document.getElementById('player')!;
  const onEvent = (ev: Event) => {
    const e = (ev as CustomEvent).detail as { at: string; type: string; n?: number; left?: number; resumed_at?: string };
    // 从头开始 is a new learning record
    if (e.type === 'start' && !e.resumed_at && before) session = newId();
    queue.push({ session, child: child.id, lesson: key }, { ...e, id: newId() });
    flush();
    if (e.type === 'step' && p) { const at = p.progress(); if (at.step < 4) setResume(child.id, key, { session, step: at.step, left: null, on: localToday() }); }
    if (e.type === 'lesson_exit') setResume(child.id, key, { session, step: e.n ?? 0, left: e.left ?? null, on: localToday() });
    if (e.type === 'lesson_end') setResume(child.id, key, null);
  };
  el.addEventListener('adw:event', onEvent);
  let p: ReturnType<typeof play> | null = null;
  p = play(el, sp, { childName: child.name, kid: true, media, audio, startAt: before ? { step: before.step, left: before.left } : undefined,
    onExit: () => { el.removeEventListener('adw:event', onEvent); p!.dispose(); todayScreen(child); } });
  (window as unknown as { __player: unknown }).__player = p;
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(() => undefined);
flush();
if (token) chooseChild(); else pairScreen();
