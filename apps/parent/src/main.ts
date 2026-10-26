// Parent web app: schedule lessons, give temporary access, read learning records, keep interests and
// next-lesson wishes, and approve Pads. Everything here calls the family server; nothing is stored locally but the login.
import { summarize, type Ev } from './summary.js';
import { dataSection, homeworkView, masteryView, type Ctx } from './homework.js';
import { downscale } from './image.js';
import { agentsCard, canDraw, drawRow, follow, makeRow, modelsCard, wireDraw, wireMake, wireStudio, writerCard } from './studio.js';
import qrcode from 'qrcode-generator';

interface Child { id: string; name: string; grade: number }
interface Lesson { key: string; for_child: string; title: string; content_hash: string; published_at: string }
interface Session { key: string; child: string; lesson_key: string; started_on: string; updated_at: string; finished: number; events: number }
interface Draft {
  key: string; title: string; child: string; status: string; note: string | null; concept: string; theme: { name: string; why: string };
  challenges: { prompt: string; with_theme: boolean; answers: string[] }[]; pending_assets: string[]; offscreen: string | null;
  /** The earlier version this one replaces in the automatic schedule. */
  replaces: string | null;
  ok: boolean; issues: { rule: string; level: string; msg: string }[]; submitted_by: string;
  /** What the lesson is about and must show; it can't be published before its picture is confirmed. */
  subject: { name: string; asset_id: string; kind: string; ready: boolean } | null;
}
interface Organism {
  asset_id: string; name: string; status: string; real_scale: string | null;
  /** Set when it is what a lesson is about rather than an animal of the registry. */
  subject: 'organism' | 'object' | null;
  /** What ChatGPT looked up about it, for the parent to check. */
  facts: { scientific_name: string | null; length_cm: number | null; habitat: string | null; facts: string[] } | null;
  media: { id: string; kind: 'photo' | 'video' | 'model' | 'cutout'; origin: string; builtin?: boolean; url: string; credit: string; license: string; source_url: string | null; caption: string | null; length_cm: number | null; pending?: boolean; refs?: string[] | null; added_by?: string }[];
}
interface PlanDay { date: string; kids: { child: string; mode: 'auto' | 'manual' | 'planned' | 'none'; lessons: { key: string; title: string; finished: boolean }[] }[] }
interface Plan { auto: boolean; today: string; days: PlanDay[]; grants: { child: string; lesson_key: string; expires_on: string }[] }
interface Interest { id: string; child: string; topic: string; source: string; said: string | null; observed_on: string; state: string; lesson_ref: string | null }
/** 下一课准备单: a child's wish turned into the next lesson's topic, and how far its scene and subject are. */
interface Prep {
  id: string; child: string; topic: string; said: string | null; status: '等你确认主题' | '准备中' | '已安排' | '已跳过'; wished: string; lesson_from: string | null; lesson_ref: string | null;
  scenes: { name: string; realism?: string }[]; planned: string[]; subject: { name: string; kind: string; state: string } | null; ready: boolean; log: { at: string; msg: string }[];
}

const app = document.getElementById('app')!;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const ss = { get: (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } } };
let token = ss.get('adw.parent');
let kids: Child[] = [];
let lessons: Lesson[] = [];
let today = '';
const TABS = ['排课', '课程库', '学习记录', '作业', '掌握与重教', '兴趣与心愿', '设备与数据'] as const;
type Tab = typeof TABS[number];
let tab: Tab = '排课';
let justPublished: Lesson | null = null;

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  // no content-type without a body: the server refuses an empty JSON body (DELETE 移除 buttons)
  const r = await fetch(path, { ...init, headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  const body = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/v1/auth/login') { token = null; ss.set('adw.parent', ''); login(); }
  if (!r.ok) throw new Error(body.error ?? `出错了（${r.status}）`);
  return body as T;
}
const name = (id: string) => kids.find(k => k.id === id)?.name ?? id;
const title = (key: string) => lessons.find(l => l.key === key)?.title ?? key;
const toast = (m: string, bad = false) => { const t = document.getElementById('toast'); if (t) { t.textContent = m; t.className = bad ? 'toast bad' : 'toast'; } };
const guard = (fn: () => Promise<unknown>) => () => { fn().catch(e => toast((e as Error).message, true)); };
async function blob(path: string): Promise<Blob> {
  const r = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!r.ok) throw new Error(`下载失败（${r.status}）`);
  return r.blob();
}
const ctx = (): Ctx => ({ api, blob, kids, today, name, title, toast, guard, view: () => document.getElementById('view')! });

function login() {
  app.innerHTML = `<div class="login card"><h1>家长端</h1><p class="muted">输入家长 PIN</p>
    <form id="f"><input id="pin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="12"><button class="btn primary">进入</button></form><p id="toast" class="toast"></p></div>`;
  (document.getElementById('f') as HTMLFormElement).onsubmit = e => {
    e.preventDefault();
    guard(async () => {
      const r = await api<{ token: string }>('/v1/auth/login', { method: 'POST', body: JSON.stringify({ pin: (document.getElementById('pin') as HTMLInputElement).value }) });
      token = r.token; ss.set('adw.parent', r.token); await main();
    })();
  };
}

/** One child's prep lists: the queue (the first one is the next lesson), words waiting for a topic, and what was done. */
function prepCard(list: Prep[]) {
  const queue = list.filter(p => p.status === '准备中'), ask = list.filter(p => p.status === '等你确认主题'), done = list.filter(p => p.status === '已安排' || p.status === '已跳过');
  if (!list.length) return '';
  const said = (p: Prep) => `${esc(p.wished)}说${p.said && p.said !== p.topic ? `：“${esc(p.said)}”` : `想学「${esc(p.topic)}」`}`;
  const where = (p: Prep) => [
    ...p.scenes.map(s => `场景：${esc(s.name)}${s.realism ? `（${esc(s.realism)}）` : '（已有）'}`),
    ...(p.subject ? [`主角「${esc(p.subject.name)}」：${esc(p.subject.state)}`] : []),
  ].join(' · ');
  // the latest step, unless it only repeats the scene line above
  const last = (p: Prep) => { const m = p.log[p.log.length - 1]?.msg; return m && !m.startsWith('用现成的 3D 场景') ? `<span class="small muted">${esc(m)}</span>` : ''; };
  return `<div class="prep"><h4>下一课准备单</h4>
    ${queue.length ? `<ol>${queue.map((p, i) => `<li><b>${esc(p.topic)}</b>${i === 0 ? ' <span class="badge">下一节课按它出</span>' : ''} · ${said(p)}<br><span class="small">${where(p)}${p.ready ? ' · <b>素材已备好</b>' : ''}</span><br>${last(p)}
      <div class="row"><button class="btn primary" data-pgen="${esc(p.id)}">现在按它出课</button><button class="btn" data-pprep="${esc(p.id)}">再准备一次</button><button class="btn" data-pskip="${esc(p.id)}">跳过</button></div></li>`).join('')}</ol>` : '<p class="muted small">没有排着的心愿</p>'}
    ${ask.map(p => `<form class="ptopic row" data-p="${esc(p.id)}"><span>${said(p)}：认不出是哪个主题，确认前不会发给任何模型</span><input name="topic" maxlength="20" value="${esc(p.topic)}" required><button class="btn primary">确认主题</button><button type="button" class="btn" data-pskip="${esc(p.id)}">跳过</button></form>`).join('')}
    ${done.length ? `<details><summary class="small">已安排或跳过的 ${done.length} 条</summary><ul class="small">${done.map(p => `<li>${esc(p.topic)} · ${said(p)} · ${esc(p.status)}${p.lesson_ref ? `：${esc(title(p.lesson_ref))}` : ''}</li>`).join('')}</ul></details>` : ''}</div>`;
}

async function main() {
  [kids, lessons, { today }] = await Promise.all([api<Child[]>('/v1/children'), api<Lesson[]>('/v1/lessons'), api<{ today: string }>('/v1/time')]);
  app.innerHTML = `<div class="wrap"><header class="top"><h1>家长端</h1><span class="muted">今天 ${esc(today)}（北京时间）</span></header>
    <nav class="tabs">${TABS.map(t => `<button data-t="${t}" class="${t === tab ? 'on' : ''}">${t}</button>`).join('')}</nav>
    <p id="toast" class="toast"></p><section id="view"></section></div>`;
  app.querySelectorAll<HTMLButtonElement>('.tabs button').forEach(b => b.onclick = () => { tab = b.dataset.t as Tab; main(); });
  await guard(VIEWS[tab])();
}
const view = () => document.getElementById('view')!;
const kidOptions = (sel?: string) => kids.map(k => `<option value="${esc(k.id)}" ${k.id === sel ? 'selected' : ''}>${esc(k.name)}</option>`).join('');

const VIEWS: Record<Tab, () => Promise<void>> = {
  async 排课() {
    const plan = await api<Plan>('/v1/schedule/plan?days=8');
    const WD = '日一二三四五六';
    const wd = (d: string) => `周${WD[new Date(d + 'T00:00:00Z').getUTCDay()]}`;
    const MODE = { auto: '自动排的', manual: '你排的', planned: '自动（预计）', none: '' } as const;
    const mine = (c: string) => lessons.filter(l => l.for_child === c);
    const day0 = plan.days[0];
    const todayKid = (k: Child) => {
      const kd = day0.kids.find(x => x.child === k.id)!;
      const grants = plan.grants.filter(g => g.child === k.id);
      return `<div class="todaykid" data-c="${esc(k.id)}"><b>${esc(k.name)}</b>
        <div class="pills">${kd.lessons.map(l => `<span class="pill">${esc(l.title)}${l.finished ? ' · 学完了 ✓' : ''} <span class="badge">${MODE[kd.mode]}</span></span>`).join('') || '<span class="muted">今天没有课</span>'}
        ${grants.map(g => `<span class="pill">${esc(title(g.lesson_key))} <span class="badge">临时授权到 ${esc(g.expires_on)}</span></span>`).join('')}</div>
        <div class="row">${mine(k.id).length ? `<select class="pick" data-d="${day0.date}" data-c="${esc(k.id)}"><option value="">${kd.lessons.length ? '换一节…' : '排一节…'}</option>${mine(k.id).map(l => `<option value="${esc(l.key)}">${esc(l.title)}</option>`).join('')}</select>` : '<span class="muted small">还没有发布的课，先到「课程库」出课和审核</span>'}
          ${kd.lessons.length ? `<button class="btn skip" data-d="${day0.date}" data-c="${esc(k.id)}">今天不上</button>` : ''}
          ${kd.mode === 'manual' && plan.auto ? `<button class="btn reauto" data-d="${day0.date}" data-c="${esc(k.id)}">恢复自动</button>` : ''}</div></div>`;
    };
    const daySelect = (date: string, k: Child) => {
      const kd = plan.days.find(d => d.date === date)!.kids.find(x => x.child === k.id)!;
      const manual = kd.mode === 'manual', one = manual && kd.lessons.length === 1 ? kd.lessons[0].key : '';
      const autoLabel = plan.auto ? (kd.mode === 'manual' ? '自动' : `自动：${kd.lessons[0]?.title ?? '没有新课了'}`) : '不排';
      return `<label class="kidsel"><b>${esc(k.name)}</b><select class="daypick" data-d="${date}" data-c="${esc(k.id)}">
        <option value="__auto" ${manual ? '' : 'selected'}>${esc(autoLabel)}</option>
        ${mine(k.id).map(l => `<option value="${esc(l.key)}" ${one === l.key ? 'selected' : ''}>${esc(l.title)}</option>`).join('')}
        ${manual && kd.lessons.length > 1 ? `<option selected disabled>${esc(kd.lessons.map(l => l.title).join('、'))}</option>` : ''}
        <option value="__none" ${manual && !kd.lessons.length ? 'selected' : ''}>这天不上</option></select></label>`;
    };
    view().innerHTML = `<div class="card todaycard"><h3>今天 ${esc(day0.date)}（${wd(day0.date)}）</h3>
        <label class="consent"><input type="checkbox" id="auto" ${plan.auto ? 'checked' : ''}> 自动排课：每天给每个孩子排一节还没学完的课（按发布的先后）。不满意就在这里换一节或今天不上，点了马上生效。</label>
        ${kids.map(todayKid).join('')}</div>
      <h3>接下来一周</h3><p class="muted small">选了马上生效。选“自动”就交给自动排课。</p>
      <div class="grid">${plan.days.slice(1).map(d => `<div class="card day"><h3>${esc(d.date.slice(5))}（${wd(d.date)}）</h3>${kids.map(k => daySelect(d.date, k)).join('')}</div>`).join('')}</div>`;
    const put = (date: string, child: string, keys: string[]) => api('/v1/schedule', { method: 'PUT', body: JSON.stringify({ date, child, lessons: keys }) });
    const back = (date: string, child: string) => api(`/v1/schedule/${date}/${encodeURIComponent(child)}`, { method: 'DELETE' });
    const done = async (msg: string) => { await VIEWS.排课(); toast(msg); };
    (document.getElementById('auto') as HTMLInputElement).onchange = e => guard(async () => {
      const on = (e.target as HTMLInputElement).checked;
      await api('/v1/schedule/auto', { method: 'PUT', body: JSON.stringify({ on }) });
      await done(on ? '已打开自动排课' : '已关闭自动排课：之后只有你排的课孩子才看得到');
    })();
    view().querySelectorAll<HTMLSelectElement>('.pick').forEach(sel => sel.onchange = () => guard(async () => {
      if (!sel.value) return;
      await put(sel.dataset.d!, sel.dataset.c!, [sel.value]); await done(`${name(sel.dataset.c!)}今天改上「${title(sel.value)}」`);
    })());
    view().querySelectorAll<HTMLButtonElement>('.skip').forEach(b => b.onclick = guard(async () => { await put(b.dataset.d!, b.dataset.c!, []); await done(`${name(b.dataset.c!)}今天不上课了`); }));
    view().querySelectorAll<HTMLButtonElement>('.reauto').forEach(b => b.onclick = guard(async () => { await back(b.dataset.d!, b.dataset.c!); await done('已交回自动排课'); }));
    view().querySelectorAll<HTMLSelectElement>('.daypick').forEach(sel => sel.onchange = () => guard(async () => {
      const { d, c } = sel.dataset as { d: string; c: string };
      if (sel.value === '__auto') await back(d, c); else await put(d, c, sel.value === '__none' ? [] : [sel.value]);
      await done(`${d.slice(5)} ${name(c)}：已改好`);
    })());
  },

  async 课程库() {
    const [grants, drafts, checklist, organisms, writer] = await Promise.all([
      api<{ child: string; lesson_key: string; expires_on: string; granted_by: string }[]>('/v1/grants'),
      api<Draft[]>('/v1/drafts'),
      api<Record<string, string[]>>('/v1/review-checklist'),
      api<Organism[]>('/v1/organisms'),
      writerCard(ctx(), () => VIEWS.课程库()),
    ]);
    const preview = (key: string) => `/pad/preview.html#key=${encodeURIComponent(key)}&t=${encodeURIComponent(token ?? '')}`;
    const jp = justPublished;
    view().innerHTML = `${jp ? `<div class="card justpub" id="jp"><b>刚发布「${esc(jp.title)}」（${esc(name(jp.for_child))}）。</b>什么时候上？
        <div class="row"><button class="btn primary when" data-n="0">今天就上</button><button class="btn when" data-n="1">明天上</button><button class="btn when" data-n="-1">按顺序自动排</button></div></div>` : ''}${writer}
      ${drafts.length ? `<h3>等你审核（${drafts.length}）</h3><p class="muted">先点“预览”把课走一遍，再逐项勾选四类审核。全部勾上才能发布；发布后内容冻结，孩子在排课当天才看得到。</p>` : ''}
      ${drafts.map(d => `<div class="card draft" data-k="${esc(d.key)}"><h3>${esc(d.title)} <span class="badge">${esc(d.status)}</span></h3>
        <p class="muted small">${esc(name(d.child))} · ${esc(d.concept)} · ${esc(d.key)} · 主题「${esc(d.theme.name)}」：${esc(d.theme.why)} · 由 ${esc(d.submitted_by)} 交来</p>
        ${d.replaces ? `<p class="small replaces">这是 ${esc(d.replaces)} 的新版本。发布后自动排课只排新版；孩子上过旧版就算上过这节课，想再上可以在「排课」里手动加。</p>` : ''}
        ${d.note ? `<p class="toast bad">你退回时写的：${esc(d.note)} <button class="btn revise">让 AI 按意见改</button></p>` : ''}
        <ol>${d.challenges.map(c => `<li>${esc(c.prompt)} <span class="muted small">答案：${c.answers.map(esc).join('，')}${c.with_theme ? '' : ' · 不带主题的迁移题'}</span></li>`).join('')}</ol>
        ${d.subject ? d.subject.ready ? `<p class="small">主角「${esc(d.subject.name)}」的画面已确认。</p>` : `<p class="toast bad small">主角「${esc(d.subject.name)}」还没有确认的画面，发布前要先有：${canDraw() && d.subject.kind === 'organism' ? '点下面的按钮让 ChatGPT 自动做，或' : ''}到下面「生物素材 → ${esc(d.subject.name)}」加实拍照片，核对后确认。</p>${canDraw() && d.subject.kind === 'organism' ? makeRow(organisms.find(o => o.asset_id === d.subject!.asset_id) ?? { asset_id: d.subject.asset_id, name: d.subject.name, media: [] }) : ''}` : ''}
        ${d.pending_assets.filter(a => a !== d.subject?.asset_id).length ? `<p class="small">还没到位、不展示的素材：${d.pending_assets.filter(a => a !== d.subject?.asset_id).map(esc).join('、')}</p>` : ''}
        ${d.offscreen ? `<p class="small">家里的小任务：${esc(d.offscreen)}</p>` : ''}
        ${d.issues.length ? `<ul class="small">${d.issues.map(i => `<li class="${i.level === 'error' ? 'toast bad' : ''}">${esc(i.rule)} ${i.level === 'warn' ? '提示' : '错误'}：${esc(i.msg)}</li>`).join('')}</ul>` : ''}
        <p><a class="btn" href="${preview(d.key)}" target="_blank" rel="noopener">预览这节课</a></p>
        <div class="checks">${Object.entries(checklist).map(([cat, items]) => `<fieldset><legend>${esc(cat)}</legend>${items.map(i => `<label><input type="checkbox" data-cat="${esc(cat)}" value="${esc(i)}"> ${esc(i)}</label>`).join('')}</fieldset>`).join('')}</div>
        <div class="row"><button class="btn primary approve" ${d.ok && (!d.subject || d.subject.ready) ? '' : 'disabled'}>审核通过并发布</button>
          <input class="note" placeholder="要改的地方（退回时必填）" maxlength="500"><button class="btn reject">退回修改</button></div></div>`).join('')}
      <h3>已发布</h3><p class="muted">发布后内容冻结，改动要升版本号重新审核。</p>
      <table><tr><th>课程</th><th>给谁</th><th>发布时间</th><th>临时授权</th></tr>${lessons.map(l => `<tr><td>${esc(l.title)}<div class="muted small">${esc(l.key)} · <a href="${preview(l.key)}" target="_blank" rel="noopener">预览</a></div></td><td>${esc(name(l.for_child))}</td><td>${esc(l.published_at.slice(0, 16).replace('T', ' '))}</td>
        <td><select data-k="${esc(l.key)}"><option value="1">今天</option><option value="3">3 天</option><option value="7">7 天</option></select> <button class="btn grant" data-k="${esc(l.key)}" data-c="${esc(l.for_child)}">授权</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">还没有发布的课</td></tr>'}</table>
      <h3>授权记录</h3><ul>${grants.map(g => `<li>${esc(name(g.child))} · ${esc(title(g.lesson_key))} · 到 ${esc(g.expires_on)}${g.expires_on < today ? '（已过期）' : ''}</li>`).join('') || '<li class="muted">没有</li>'}</ul>
      <h3>生物素材</h3><p class="muted">写实模型还没到位的动物，课里会打开“实拍观察窗”，放这里加的照片或视频。只能用实拍、标本扫描，或依据实拍照片做的写实模型，不用卡通和绘画。每条都写上作者和授权。${canDraw() ? '有 3 张实拍照片后，可以让 ChatGPT 依据它们画写实图，画好等你核对确认。' : ''}</p>
      ${organisms.map(o => `<div class="card organism" data-a="${esc(o.asset_id)}"><h3>${esc(o.name)} <span class="badge">${esc(o.status)}</span></h3>
        ${o.facts ? `<p class="small">ChatGPT 查到：${[o.facts.scientific_name && `学名 <i>${esc(o.facts.scientific_name)}</i>`, o.facts.length_cm && `成体常见约 ${esc(o.facts.length_cm)} 厘米`].filter(Boolean).join(' · ')}${o.facts.facts.length ? `<ul>${o.facts.facts.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}</p>` : ''}
        ${o.media.some(m => m.pending) ? `<p class="small toast bad">有 ${o.media.filter(m => m.pending).length} 条素材等你确认：对照实拍照片核对形态，${o.media.some(m => m.kind === 'cutout' && m.pending) ? '可以先点课程的“预览”看会动的 3D，' : ''}没问题点“确认可用”，孩子才看得到。${o.media.filter(m => m.pending).length > 1 ? ' <button class="btn sm primary confirmall">都核对过了，全部确认</button>' : ''}</p>` : ''}
        <div class="media-list">${o.media.map(m => `<figure class="media${m.pending ? ' pending' : ''}">${m.kind === 'video' ? `<video src="${esc(m.url)}" muted playsinline controls preload="metadata"></video>` : m.kind === 'model' ? '<div class="glb">三维扫描 .glb</div>' : `<img src="${esc(m.url)}" alt="" ${m.kind === 'cutout' ? 'class="cutout"' : ''}>`}
          <figcaption class="small"><span class="badge">${esc(m.kind === 'cutout' ? `${m.origin} · 放进三维海底` : m.origin)}</span> ${esc(m.caption ?? '')}${m.length_cm ? ` · 约 ${esc(m.length_cm)} 厘米` : ''}<br><span class="muted">${esc(m.credit)} · ${esc(m.license)}</span>${m.source_url ? ` · <a href="${esc(m.source_url)}" target="_blank" rel="noopener">来源</a>` : ''}</figcaption>
          ${m.pending ? `<div class="small"><span class="badge warn">等你确认</span> 由 ${esc(m.added_by)} 传来${m.refs?.length ? `，参考照片：<ol class="refs">${m.refs.map(r => `<li>${/^https?:\/\//.test(r) ? `<a href="${esc(r)}" target="_blank" rel="noopener">${esc(r)}</a>` : esc(r)}</li>`).join('')}</ol>` : ''}</div><button class="btn sm primary confirm" data-id="${esc(m.id)}">确认可用</button> ` : ''}${m.builtin ? '<span class="muted small">随程序自带</span>' : `<button class="btn sm del" data-id="${esc(m.id)}">删除</button>`}</figure>`).join('') || '<p class="muted small">还没有素材，孩子在课里只能看到洞口和讲解。</p>'}</div>
        ${canDraw() && o.subject !== 'object' && !o.media.some(m => m.kind === 'cutout' && m.builtin) ? makeRow(o) : ''}
        ${canDraw() ? drawRow(o) : ''}
        <form class="addmedia"><label>文件 <input type="file" name="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm,.glb" required></label>
          <label>类型 <select name="origin"><option>实拍</option><option>标本扫描</option><option>AI 写实图</option></select></label>
          <label>说明 <input name="caption" maxlength="120" placeholder="例如 洞口探出头的孔雀螳螂虾"></label>
          <label>身长（厘米） <input name="length_cm" inputmode="decimal" size="5" placeholder="${esc((o.real_scale ?? '').replace(/[^\d.]/g, ''))}"></label>
          <label>作者或来源 <input name="credit" required maxlength="200" placeholder="例如 维基共享资源 · 拍摄者名字"></label>
          <label>授权 <input name="license" required maxlength="100" placeholder="例如 CC BY-SA 4.0 / 自己拍的"></label>
          <label>来源链接 <input name="source_url" type="url" placeholder="https://…"></label>
          <label class="wide"><input type="checkbox" name="real" required> 我确认这是写实的（实拍、标本扫描或 AI 写实图），不是卡通或绘画；形态我核对过</label>
          <button class="btn primary">加到素材</button></form></div>`).join('')}`;
    view().querySelectorAll<HTMLElement>('.organism').forEach(card => {
      const asset = card.dataset.a!;
      card.querySelectorAll<HTMLButtonElement>('.confirm').forEach(b => b.onclick = guard(async () => {
        await api(`/v1/media/${encodeURIComponent(b.dataset.id!)}/confirm`, { method: 'POST' }); await VIEWS.课程库(); toast('已确认，孩子在课里能看到了');
      }));
      card.querySelector<HTMLButtonElement>('.confirmall')?.addEventListener('click', guard(async () => {
        const r = await api<{ confirmed: number }>(`/v1/organisms/${encodeURIComponent(asset)}/confirm`, { method: 'POST' }); await VIEWS.课程库(); toast(`已确认 ${r.confirmed} 条，孩子在课里能看到了`);
      }));
      card.querySelectorAll<HTMLButtonElement>('.del').forEach(b => b.onclick = guard(async () => {
        if (!confirm('删除这条素材？')) return;
        await api(`/v1/media/${encodeURIComponent(b.dataset.id!)}`, { method: 'DELETE' }); await VIEWS.课程库(); toast('已删除');
      }));
      const form = card.querySelector<HTMLFormElement>('.addmedia')!;
      form.onsubmit = e => {
        e.preventDefault();
        guard(async () => {
          const f = new FormData(form), file = f.get('file') as File;
          const mime = /\.glb$/i.test(file.name) ? 'model/gltf-binary' : file.type;
          toast('正在上传…');
          const data = mime.startsWith('image/') ? (await downscale(file)).data : await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error('读不了这个文件')); r.readAsDataURL(file); });
          await api(`/v1/organisms/${encodeURIComponent(asset)}/media`, { method: 'POST', body: JSON.stringify({
            mime: mime.startsWith('image/') ? 'image/jpeg' : mime, data: data.slice(data.indexOf(',') + 1),
            caption: f.get('caption'), length_cm: f.get('length_cm'), credit: f.get('credit'), license: f.get('license'), source_url: f.get('source_url') || null, real: f.get('real') === 'on', origin: f.get('origin'),
          }) });
          await VIEWS.课程库(); toast('已加入。孩子在课里点洞口就能看到。');
        })();
      };
    });
    wireStudio(ctx());
    wireDraw(ctx(), () => VIEWS.课程库());
    wireMake(ctx(), () => VIEWS.课程库());
    view().querySelectorAll<HTMLButtonElement>('#jp .when').forEach(b => b.onclick = guard(async () => {
      const n = Number(b.dataset.n), p = justPublished!;
      justPublished = null;
      if (n >= 0) {
        const date = new Date(Date.parse(today + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
        await api('/v1/schedule', { method: 'PUT', body: JSON.stringify({ date, child: p.for_child, lessons: [p.key] }) });
      }
      document.getElementById('jp')?.remove();
      toast(n < 0 ? '好的，按顺序自动排。可以在「排课」里看和改。' : `已排到${n ? '明天' : '今天'}，${name(p.for_child)}${n ? '明天' : '现在'}就能在 Pad 上看到。`);
    }));
    view().querySelectorAll<HTMLElement>('.draft').forEach(card => {
      const key = card.dataset.k!;
      card.querySelector<HTMLButtonElement>('.approve')!.onclick = guard(async () => {
        const checked: Record<string, string[]> = {};
        card.querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked').forEach(c => (checked[c.dataset.cat!] ??= []).push(c.value));
        await api(`/v1/drafts/${encodeURIComponent(key)}/approve`, { method: 'POST', body: JSON.stringify({ checked }) });
        lessons = await api<Lesson[]>('/v1/lessons');
        justPublished = lessons.find(l => l.key === key) ?? null;
        await VIEWS.课程库();
        toast('已发布。');
      });
      card.querySelector<HTMLButtonElement>('.reject')!.onclick = guard(async () => {
        await api(`/v1/drafts/${encodeURIComponent(key)}/reject`, { method: 'POST', body: JSON.stringify({ note: card.querySelector<HTMLInputElement>('.note')!.value }) });
        await VIEWS.课程库();
        toast('已退回。可以点“让 AI 按意见改”，或者对接入的 AI 助手说“看看家长退回的课”。');
      });
      const revise = card.querySelector<HTMLButtonElement>('.revise');
      if (revise) revise.onclick = guard(async () => {
        const r = await api<{ job: string }>('/v1/studio/generate', { method: 'POST', body: JSON.stringify({ revise: key }) });
        document.getElementById('writer')?.scrollIntoView({ behavior: 'smooth' });
        follow(ctx(), r.job, () => VIEWS.课程库());
      });
    });
    view().querySelectorAll<HTMLButtonElement>('.grant').forEach(b => b.onclick = guard(async () => {
      const days = Number(view().querySelector<HTMLSelectElement>(`select[data-k="${b.dataset.k}"]`)!.value);
      const r = await api<{ expires_on: string }>('/v1/grants', { method: 'POST', body: JSON.stringify({ child: b.dataset.c, lesson: b.dataset.k, days }) });
      toast(`已授权到 ${r.expires_on}`); await VIEWS.课程库();
    }));
  },

  async 学习记录() {
    const list = await api<Session[]>('/v1/sessions');
    view().innerHTML = `<p class="muted">这里只记录看到的事情：做了什么、哪里用了提示、孩子说了什么。不打分、不排名。</p>
      <table><tr><th>日期</th><th>孩子</th><th>课程</th><th>状态</th><th></th></tr>${list.map(s => `<tr><td>${esc(s.started_on)}</td><td>${esc(name(s.child))}</td><td>${esc(title(s.lesson_key))}</td><td>${s.finished ? '学完了' : '没学完'} · ${s.events} 条</td><td><button class="btn open" data-k="${esc(s.key)}">看看</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">还没有学习记录</td></tr>'}</table><div id="detail"></div>`;
    view().querySelectorAll<HTMLButtonElement>('.open').forEach(b => b.onclick = guard(async () => {
      const s = list.find(x => x.key === b.dataset.k)!;
      const [evs, sp] = await Promise.all([api<Ev[]>(`/v1/sessions/${s.key}/events`), api<{ challenges: { id: string; prompt: string }[] }>(`/v1/lessons/${encodeURIComponent(s.lesson_key)}`)]);
      document.getElementById('detail')!.innerHTML = `<div class="card"><h3>${esc(name(s.child))} · ${esc(title(s.lesson_key))} · ${esc(s.started_on)}</h3>${summarize(evs, sp)}</div>`;
    }));
  },

  async 兴趣与心愿() {
    const [list, progress, preps] = await Promise.all([api<Interest[]>('/v1/interests'), api<Record<string, string>>('/v1/progress'), api<Prep[]>('/v1/preps')]);
    view().innerHTML = `<p class="muted">你在「AI 出一节课」里指定的主题最优先；没指定时用这个孩子自己的兴趣，不拿另一个孩子的套用。孩子在课末说的“下一课想学什么”会马上记在这里，变成下一课的准备单，按先后排队，下一节课按排第一的出。</p>
      ${kids.map(k => `<div class="card"><h3>${esc(k.name)}</h3>${prepCard(preps.filter(p => p.child === k.id))}
        <form class="progress row" data-c="${esc(k.id)}"><label class="grow">课内数学进度 <input name="text" maxlength="300" value="${esc(progress[k.id] ?? '')}" placeholder="例如：第二单元 表内乘法（一），刚学完 5 的乘法。不填就按年级和月份推断"></label><button class="btn">保存</button></form>
        <ul>${list.filter(x => x.child === k.id).map(x => `<li><b>${esc(x.topic)}</b> · ${esc(x.state)} · ${esc(x.source)}${x.said && x.said !== x.topic ? `：“${esc(x.said)}”` : ''} · ${esc(x.observed_on)}${x.lesson_ref ? ` · 来自 ${esc(title(x.lesson_ref))}` : ''}</li>`).join('') || '<li class="muted">还没有记录</li>'}</ul></div>`).join('')}
      <form id="add" class="card row"><select name="child">${kidOptions()}</select><input name="topic" placeholder="兴趣，例如：机器人" maxlength="40" required>
        <select name="state"><option>喜欢</option><option>近期最喜欢</option><option>下一课心愿</option><option>曾经喜欢</option></select>
        <select name="source"><option>家长报告</option><option>孩子自述</option></select><input name="said" placeholder="孩子原话（可空）" maxlength="200"><button class="btn primary">记下</button></form>`;
    (document.getElementById('add') as HTMLFormElement).onsubmit = e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target as HTMLFormElement));
      guard(async () => { await api('/v1/interests', { method: 'POST', body: JSON.stringify(f) }); await VIEWS.兴趣与心愿(); toast('已记下'); })();
    };
    view().querySelectorAll<HTMLFormElement>('form.ptopic').forEach(f => f.onsubmit = e => {
      e.preventDefault();
      guard(async () => { await api(`/v1/preps/${f.dataset.p}/topic`, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(f))) }); await VIEWS.兴趣与心愿(); toast('主题定好了，开始准备'); })();
    });
    view().querySelectorAll<HTMLButtonElement>('button[data-pskip]').forEach(b => b.onclick = guard(async () => {
      await api(`/v1/preps/${b.dataset.pskip}/skip`, { method: 'POST', body: '{}' }); await VIEWS.兴趣与心愿(); toast('跳过了，这个兴趣还留着');
    }));
    view().querySelectorAll<HTMLButtonElement>('button[data-pprep]').forEach(b => b.onclick = guard(async () => {
      await api(`/v1/preps/${b.dataset.pprep}/prepare`, { method: 'POST', body: '{}' }); await VIEWS.兴趣与心愿();
    }));
    view().querySelectorAll<HTMLButtonElement>('button[data-pgen]').forEach(b => b.onclick = guard(async () => {
      await api('/v1/studio/generate', { method: 'POST', body: JSON.stringify({ prep: b.dataset.pgen }) });
      tab = '课程库'; await main(); toast('开始按这张准备单写课了，写好后在下面“等你审核”');
    }));
    view().querySelectorAll<HTMLFormElement>('form.progress').forEach(f => f.onsubmit = e => {
      e.preventDefault();
      guard(async () => { await api(`/v1/progress/${f.dataset.c}`, { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(f))) }); toast(`已保存${name(f.dataset.c!)}的课内进度，下一节课按它出`); })();
    });
  },

  async 作业() { await homeworkView(ctx()); },
  async 掌握与重教() { await masteryView(ctx()); },

  async 设备与数据() {
    const list = await api<{ label: string; created_at: string }[]>('/v1/devices');
    const tts = await api<{ available: boolean; current: Record<'zh' | 'en', string> | null; options: VoiceOption[] }>('/v1/tts/voices').catch(() => null);
    const [models, agents, server] = await Promise.all([modelsCard(ctx()), agentsCard(ctx()), api<ServerInfo>('/v1/server-info').catch(() => null)]);
    view().innerHTML = `${tabletCard(server)}<div class="card"><h3>添加孩子的平板</h3><p class="muted">平板 App 第一次打开时（iPad 是在 Safari 里打开 /pad/ 时），屏幕会显示 6 位配对码。</p>
      <form id="pair" class="row"><input name="code" inputmode="numeric" placeholder="配对码" maxlength="7" required><input name="label" placeholder="设备名，例如：哥哥的平板" maxlength="40"><button class="btn primary">批准</button></form></div>${voiceCard(tts)}
      <div class="card"><h3>已配对的设备</h3><ul>${list.map(d => `<li>${esc(d.label)} · ${esc(d.created_at.slice(0, 10))} <button class="btn revoke" data-l="${esc(d.label)}">移除</button></li>`).join('') || '<li class="muted">没有</li>'}</ul></div>
      ${models}${agents}
      ${dataSection(ctx())}`;
    (document.getElementById('pair') as HTMLFormElement).onsubmit = e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target as HTMLFormElement)) as Record<string, string>;
      guard(async () => { await api(`/v1/pair/${f.code.replace(/\D/g, '')}/approve`, { method: 'POST', body: JSON.stringify({ label: f.label }) }); await VIEWS.设备与数据(); toast('已批准，Pad 几秒内会自动连上'); })();
    };
    wireVoices();
    wireStudio(ctx());
    view().querySelectorAll<HTMLButtonElement>('.revoke').forEach(b => b.onclick = guard(async () => {
      if (!confirm(`移除「${b.dataset.l}」？这台 Pad 需要重新配对。`)) return;
      await api(`/v1/devices/${encodeURIComponent(b.dataset.l!)}`, { method: 'DELETE' }); await VIEWS.设备与数据();
    }));
  },
};

// ---- 平板 App: a QR code the tablet scans to download the Android app from this Mac ----
interface ServerInfo { name: string; addresses: string[]; port: number; apk: { size: number; version: string | null; built: string | null } | null }
function tabletCard(info: ServerInfo | null) {
  if (!info) return '';
  const host = info.addresses[0] ?? location.hostname, url = `http://${host}:${info.port}/app/`;
  const qr = qrcode(0, 'M');
  qr.addData(url); qr.make();
  return `<div class="card tablet"><h3>孩子的平板 App</h3><div class="row top">
    <div class="qr" title="${esc(url)}">${qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}</div>
    <div class="grow"><p>用平板的相机或浏览器扫这个码，下载安装「AI探索世界」（安卓）。装好后打开，它会自己在家里的 Wi-Fi 里找到这台 Mac；屏幕上出现配对码时，在下面输入并批准。</p>
    <p class="small">扫不了码就在平板浏览器里输入 <b>${esc(url)}</b>${info.addresses.length > 1 ? `（这台 Mac 的其他地址：${info.addresses.slice(1).map(esc).join('、')}）` : ''}</p>
    <p class="small muted">${info.apk ? `安装包版本 ${esc(info.apk.version ?? '')}。` : '安装包还没放到这台 Mac 上：点菜单「AI 探索世界 → 检查更新」后再扫。'}iPad 装不了安卓安装包，iPad 用 Safari 打开 http://${esc(host)}:${info.port}/pad/ 再“添加到主屏幕”。</p></div></div></div>`;
}

// ---- 朗读声音: which Mac voice reads the lessons; hear one before choosing it ----
interface VoiceOption { name: string; locale: string; lang: 'zh' | 'en'; quality: 'premium' | 'enhanced' | 'standard' | 'system' }
const QUALITY_LABEL = { premium: '高级 · 最像真人', enhanced: '增强', standard: '普通', system: '' };
const SAMPLE = { zh: '你好！今天我们去珊瑚礁，看看螳螂虾的家有多大。', en: 'Hello! Today we visit the coral reef to see how big the mantis shrimp’s home is.' };
function voiceCard(t: { available: boolean; current: Record<'zh' | 'en', string> | null; options: VoiceOption[] } | null) {
  if (!t?.available || !t.current) return `<div class="card"><h3>朗读声音</h3><p class="muted">服务器不在 Mac 上运行，Pad 会用 iPad 自带的声音朗读。</p></div>`;
  const pick = (lang: 'zh' | 'en') => {
    const opts: VoiceOption[] = [...t.options.filter(o => o.lang === lang), { name: 'system', locale: '', lang, quality: 'system' }];
    return `<label class="voicepick">${lang === 'zh' ? '中文' : '英文'}
      <select data-lang="${lang}">${opts.map(o => `<option value="${esc(o.name)}" ${o.name === t.current![lang] ? 'selected' : ''}>${o.name === 'system' ? 'Mac 系统朗读声音（可在 Mac 设置里选 Siri 声音）' : `${esc(o.name)}${QUALITY_LABEL[o.quality] ? ` · ${QUALITY_LABEL[o.quality]}` : ''}`}</option>`).join('')}</select>
      <button class="btn" type="button" data-try="${lang}">▶ 试听</button></label>`;
  };
  const natural = t.options.some(o => o.quality === 'premium' || o.quality === 'enhanced');
  return `<div class="card" id="voices"><h3>朗读声音</h3>
    <p class="muted">孩子上课时听到的声音。选好后点“试听”，满意再保存。</p>
    ${pick('zh')}${pick('en')}
    <div class="row"><button class="btn primary" id="vsave" type="button">保存</button></div>
    ${natural ? '' : '<p class="muted small">这台 Mac 还没有“高级 / 增强”声音，听起来会比较机械。下载方法：系统设置 → 辅助功能 → 朗读内容 → 系统声音 → 管理声音，中文选 Lilian（高级）或婷婷（增强），英文选 Ava（高级）或 Zoe（高级），下载完重启服务。</p>'}
  </div>`;
}
function wireVoices() {
  const box = document.getElementById('voices'); if (!box) return;
  const sel = (lang: string) => box.querySelector<HTMLSelectElement>(`select[data-lang="${lang}"]`)!;
  let playing: HTMLAudioElement | null = null;
  box.querySelectorAll<HTMLButtonElement>('[data-try]').forEach(b => b.onclick = guard(async () => {
    const lang = b.dataset.try as 'zh' | 'en';
    b.disabled = true; b.textContent = '生成中…';
    try {
      const r = await fetch(`/v1/tts?lang=${lang}&voice=${encodeURIComponent(sel(lang).value)}&text=${encodeURIComponent(SAMPLE[lang])}`, { headers: { authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? '试听失败');
      playing?.pause();
      playing = new Audio(URL.createObjectURL(await r.blob())); await playing.play();
    } finally { b.disabled = false; b.textContent = '▶ 试听'; }
  }));
  (document.getElementById('vsave') as HTMLButtonElement).onclick = guard(async () => {
    await api('/v1/tts/voices', { method: 'PUT', body: JSON.stringify({ zh: sel('zh').value, en: sel('en').value }) });
    toast('已保存，Pad 下一句开始用新的声音');
  });
}

token ? main().catch(() => login()) : login();
