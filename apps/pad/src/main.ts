// Pad light app: pair once, pick a child, play today's lessons. Events go to a local queue first and are
// sent whenever the server is reachable, so a lesson works through a Wi-Fi drop.
import type { LessonSpec } from '../../../packages/schema/src/index.js';
import { play, type OrganismMedia } from '../../../packages/player/src/main.js';
import { Queue, type Store as KV } from './queue.js';

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

async function pairScreen() {
  shell(`<h1>连接家里的服务器</h1><p>请家长打开家长端的“设备”页，输入下面的配对码。</p><p class="code" id="code">…</p><p class="muted" id="msg"></p>`);
  const msg = document.getElementById('msg')!;
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

async function chooseChild() {
  shell(`<h1>今天谁来学？</h1><div class="kids" id="kids">…</div>`);
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
    const localToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    lessons = cached && cached.today === localToday ? cached.lessons : [];
    if (!lessons.length) { list.innerHTML = `<p>${esc((e as Error).message)}</p>`; return; }
  }
  if (!lessons.length) { list.innerHTML = `<p class="lead">今天没有安排课。</p><p class="muted">想学的话请家长在家长端排课或临时授权。</p>`; return; }
  list.innerHTML = lessons.map(l => `<button class="lesson" data-key="${esc(l.key)}"><b>${esc(l.title)}</b><span>${esc(l.concept)} · ${esc(l.reason)}${l.finished ? ' · 今天做过了' : ''}</span></button>`).join('');
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
  const session = newId();
  app.innerHTML = '<div id="player"></div><p id="sync" class="muted small center"></p>';
  const el = document.getElementById('player')!;
  const onEvent = (ev: Event) => {
    queue.push({ session, child: child.id, lesson: key }, { ...(ev as CustomEvent).detail, id: newId() });
    flush();
  };
  el.addEventListener('adw:event', onEvent);
  const p = play(el, sp, { childName: child.name, kid: true, media, onExit: () => { el.removeEventListener('adw:event', onEvent); p.dispose(); todayScreen(child); } });
  (window as unknown as { __player: unknown }).__player = p;
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(() => undefined);
flush();
if (token) chooseChild(); else pairScreen();
