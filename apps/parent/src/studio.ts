// AI lesson writing in the parent app: 课程库 → AI 出一节课 (any model, switched here; plan it first in a chat if
// wanted), ChatGPT drawing photoreal pictures in 生物素材, and 设备与数据 → 大模型 / AI 助手接入 (MCP tokens for Codex,
// Claude Code, Qoder, Cursor…). Whatever writes the lesson, it lands in 等你审核 and only the parent's button
// publishes it. API keys are typed in here once and never shown again.
import type { Ctx } from './homework.js';

interface Provider { id: string; label: string; base_url: string; models: string[]; key_url?: string }
interface Model { id: string; label: string; provider: string; base_url: string; model: string; json_mode?: boolean; has_key: boolean; key_tail: string | null }
interface Models { providers: Provider[]; models: Model[]; active: string | null; consent: boolean }
interface Job { id: string; child: string; model: string; status: 'running' | 'done' | 'failed'; log?: { at: string; msg: string }[]; key?: string; title?: string; error?: string; issues?: { rule: string; path: string; msg: string }[] }
/** A planning chat turn or a picture being drawn. */
interface Task { id: string; status: 'running' | 'done' | 'failed'; model: string; reply?: string; brief?: string | null; asset?: string; media_id?: string; error?: string; step?: string }
interface CodexStatus { installed: boolean; version: string | null; logged_in: boolean; detail: string }
type Said = { role: 'user' | 'assistant'; content: string };

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const isLocal = (m: Model) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(m.base_url + '/');
const isCodex = (m: Model) => m.provider === 'codex';

// The cards are drawn first and wired after the page puts them in (wireStudio).
let shown: { models?: Models; running?: Job; tasks?: Task[]; onDone?: () => Promise<void> } = {};
export function wireStudio(c: Ctx) { wireWriter(c); wirePlan(c); wireModels(c); wireAgents(c); }
/** Whether ChatGPT (Codex on the home computer) is set up, so 生物素材 can offer to draw. Known once writerCard ran. */
export const canDraw = () => !!shown.models?.models.some(isCodex);

/** The planning chat lives in this tab until the parent starts over, so leaving the page keeps it. */
type PlanChat = { child: string; messages: Said[]; task?: string };
const planStore = {
  get(): PlanChat | null { try { return JSON.parse(sessionStorage.getItem('adw.plan') ?? 'null'); } catch { return null; } },
  set(p: PlanChat | null) { try { if (p) sessionStorage.setItem('adw.plan', JSON.stringify(p)); else sessionStorage.removeItem('adw.plan'); } catch { /* private mode */ } },
};

/** Ask the server about a task until it ends; stops by itself when the page that shows it is gone. */
function poll(c: Ctx, id: string, alive: () => boolean, end: (t: Task) => Promise<void> | void, each?: (t: Task) => void) {
  const tick = c.guard(async () => {
    if (!alive()) return;
    const t = await c.api<Task>(`/v1/studio/tasks/${id}`);
    if (t.status === 'running') { each?.(t); setTimeout(tick, 2000); return; }
    await end(t);
  });
  tick();
}

// ---- 课程库: write a lesson with one button ----
export async function writerCard(c: Ctx, onDone: () => Promise<void>): Promise<string> {
  const [m, jobs, tasks] = await Promise.all([c.api<Models>('/v1/studio/models'), c.api<Job[]>('/v1/studio/jobs'), c.api<Task[]>('/v1/studio/tasks')]);
  const running = jobs.find(j => j.status === 'running');
  shown = { ...shown, models: m, running, tasks, onDone };
  if (!m.models.length) return `<div class="card" id="writer"><h3>AI 出一节课</h3><p class="muted">还没有设置大模型。到「设备与数据 → 大模型」添加一个（DeepSeek、通义千问、Kimi、智谱、豆包、GPT、Claude、Gemini、本机 Ollama 都可以），这里就能一键出课。</p></div>`;
  const active = m.models.find(x => x.id === m.active) ?? m.models[0];
  const needConsent = !m.consent && !isLocal(active);
  const plan = planStore.get(), talker = m.models.find(isCodex) ?? active;
  const opts = (sel: Model) => m.models.map(x => `<option value="${esc(x.id)}" ${x.id === sel.id ? 'selected' : ''}>${esc(x.label)}</option>`).join('');
  return `<div class="card" id="writer"><h3>AI 出一节课</h3>
    <p class="muted small">选孩子、写主题（例如“博比特虫”“机器人”），就按你说的做；主题里的动物或东西会作为主角出现在画面里，场景里还没有它时会先做它的写实图。直接写一句要求就能出课。想先把方案谈清楚，就打开下面的“和 AI 商量方案”，谈好后点“用这个方案写课”。AI 按 Skill 写课、自己校验并修改，通过后放到“等你审核”，发布还是要你看过、勾完再点。</p>
    <form id="wform"><div class="row"><label>孩子 <select name="child">${c.kids.map(k => `<option value="${esc(k.id)}" ${plan?.child === k.id ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}</select></label>
      <label>写课用 <select name="model">${opts(active)}</select></label>
      <label>主题 <input name="topic" maxlength="20" placeholder="可选，例如：博比特虫、机器人"></label></div>
      <textarea name="wish" rows="3" maxlength="8000" placeholder="一句要求，例如：用大桥做主题、再难一点；或者粘贴谈好的【课程方案】"></textarea>
      <div class="row"><button class="btn primary" ${running ? 'disabled' : ''}>开始写课</button></div></form>
    <details id="plan" ${plan?.messages.length ? 'open' : ''}><summary>和 AI 商量方案（可选）</summary>
      <p class="muted small">像聊天一样说你想要什么，AI 会问你一两个问题、给几个方向。满意了说一句“好了”，它会写出【课程方案】。${m.models.some(isCodex) ? '用“ChatGPT 账号”商量不花 API 费用，用的是 Plus 套餐的额度。' : '想用 ChatGPT Plus 的额度来商量：在「设备与数据 → 大模型」添加“ChatGPT 账号（本机 Codex）”。'}</p>
      <div class="row"><label>商量用 <select id="pmodel">${opts(talker)}</select></label><button type="button" class="btn" id="pnew">重新开始</button></div>
      <div id="pchat" class="chat"></div>
      <form id="pform"><textarea name="say" rows="2" maxlength="4000" placeholder="例如：哥哥最近迷桥梁，想练面积，难一点"></textarea><div class="row"><button class="btn primary">发送</button></div></form>
    </details>
    <p class="small"><button type="button" class="btn" id="dbtn">复制设计说明（到 ChatGPT 网页或手机 App 里聊）</button></p>
    <div id="dbox" hidden><p class="small">把下面这段发给 ChatGPT，和它谈这节课的方案。谈好后它会输出【课程方案】，整段复制粘到上面的框里，点“开始写课”。</p><textarea readonly rows="8"></textarea></div>
    ${needConsent ? '<p class="toast bad small">还没有同意把年级和兴趣主题发给大模型：到「设备与数据 → 大模型」勾选后才能出课。</p>' : ''}
    <ol id="wlog" class="log small"></ol>${!running && jobs[0] ? `<p class="small muted" id="wlast">上一次（${esc(jobs[0].model)}）：${jobs[0].status === 'done' ? `写好了「${esc(jobs[0].title)}」，在下面等你审核` : `没写成：${esc(jobs[0].error)}`}</p>` : ''}</div>`;
}

/** Copy text, falling back to selecting it (the home server is plain http, where the clipboard API is off). */
async function copyText(t: HTMLTextAreaElement) {
  try { await navigator.clipboard.writeText(t.value); return true; } catch { t.focus(); t.select(); return document.execCommand('copy'); }
}

function wireWriter(c: Ctx) {
  const form = document.getElementById('wform') as HTMLFormElement | null;
  const onDone = shown.onDone ?? (async () => undefined);
  if (form) form.onsubmit = e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    c.guard(async () => { const r = await c.api<{ job: string }>('/v1/studio/generate', { method: 'POST', body: JSON.stringify(f) }); follow(c, r.job, onDone); })();
  };
  const dbtn = document.getElementById('dbtn');
  if (form && dbtn) dbtn.onclick = c.guard(async () => {
    const child = (form.elements.namedItem('child') as HTMLSelectElement).value;
    const r = await c.api<{ text: string }>(`/v1/studio/design-prompt?child=${encodeURIComponent(child)}`);
    const box = document.getElementById('dbox')!, t = box.querySelector('textarea')!;
    t.value = r.text; box.hidden = false;
    c.toast(await copyText(t) ? '设计说明已复制，粘到 ChatGPT 里开始聊' : '设计说明在下面，全选后复制到 ChatGPT');
  });
  if (shown.running && document.getElementById('wlog')) follow(c, shown.running.id, onDone);
}

// ---- 和 AI 商量方案: a chat with the design brief behind it; the agreed 【课程方案】 goes straight to the writer ----
function wirePlan(c: Ctx) {
  const box = document.getElementById('pchat'), form = document.getElementById('pform') as HTMLFormElement | null;
  const wform = document.getElementById('wform') as HTMLFormElement | null;
  if (!box || !form || !wform) return;
  const kid = () => (wform.elements.namedItem('child') as HTMLSelectElement).value;
  const say = form.elements.namedItem('say') as HTMLTextAreaElement, send = form.querySelector('button')!;
  const draw = () => {
    const p = planStore.get(), msgs = p?.messages ?? [];
    const lastAi = [...msgs].reverse().find(x => x.role === 'assistant');
    box.innerHTML = msgs.map(x => `<div class="msg ${x.role === 'user' ? 'me' : 'ai'}">${esc(x.content)}${x === lastAi && x.content.includes('【课程方案】') ? '<div class="row"><button type="button" class="btn primary puse">用这个方案写课</button></div>' : ''}</div>`).join('')
      + (p?.task ? '<div class="msg ai muted">正在想…（ChatGPT 通常要半分钟到两分钟）</div>' : '');
    send.disabled = !!p?.task;
    box.scrollTop = box.scrollHeight;
    box.querySelector<HTMLButtonElement>('.puse')?.addEventListener('click', () => {
      const brief = lastAi!.content.slice(lastAi!.content.indexOf('【课程方案】'));
      (wform.elements.namedItem('wish') as HTMLTextAreaElement).value = brief;
      wform.querySelector<HTMLButtonElement>('button.primary')!.click();
      wform.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };
  const wait = (id: string) => poll(c, id, () => box.isConnected, t => {
    const p = planStore.get();
    if (!p || p.task !== id) return;
    delete p.task;
    if (t.status === 'done') p.messages.push({ role: 'assistant', content: t.reply ?? '' });
    else { const mine = p.messages.pop(); if (mine && !say.value) say.value = mine.content; c.toast(`没回答成：${t.error}`, true); }
    planStore.set(p); draw();
  });
  form.onsubmit = e => {
    e.preventDefault();
    const text = say.value.trim();
    if (!text) return;
    c.guard(async () => {
      const old = planStore.get(), p: PlanChat = old && old.child === kid() ? old : { child: kid(), messages: [] };
      if (p.task) return;
      p.messages.push({ role: 'user', content: text });
      const model = (document.getElementById('pmodel') as HTMLSelectElement).value;
      try {
        const r = await c.api<{ id: string }>('/v1/studio/plan', { method: 'POST', body: JSON.stringify({ child: p.child, model, messages: p.messages }) });
        p.task = r.id; say.value = '';
      } catch (err) { p.messages.pop(); throw err; } finally { planStore.set(p.messages.length ? p : null); draw(); }
      wait(p.task!);
    })();
  };
  document.getElementById('pnew')!.onclick = () => { planStore.set(null); draw(); };
  (wform.elements.namedItem('child') as HTMLSelectElement).addEventListener('change', () => {
    const p = planStore.get();
    if (p?.messages.length && p.child !== kid()) { planStore.set(null); draw(); c.toast('换了孩子，方案对话重新开始'); }
  });
  draw();
  const p = planStore.get();
  if (p?.task) wait(p.task);
}

// ---- 课程库 → 生物素材: ChatGPT draws one photoreal picture from the real photos already there ----
const REAL = ['实拍', '标本扫描'];
export function drawRow(o: { asset_id: string; media: { kind: string; origin: string; pending?: boolean }[] }): string {
  const refs = o.media.filter(m => m.kind === 'photo' && REAL.includes(m.origin) && !m.pending).length;
  const busy = shown.tasks?.some(t => t.status === 'running' && t.asset === o.asset_id);
  return `<div class="row drawrow" data-a="${esc(o.asset_id)}"><input class="dnote" maxlength="300" placeholder="想要的画面（可选），例如：侧面全身，从洞口探出头">
    <button type="button" class="btn draw" ${refs < 3 || busy ? 'disabled' : ''}>让 ChatGPT 依据实拍照片画一张</button>
    <span class="small muted dstat">${busy ? 'ChatGPT 正在画…' : refs < 3 ? `要先有 3 张实拍或标本照片（现在 ${refs} 张）` : `会把这 ${Math.min(refs, 4)} 张实拍照片发给 ChatGPT 作参考`}</span></div>`;
}
export function wireDraw(c: Ctx, reload: () => Promise<void>) {
  const done = async (t: Task, stat: HTMLElement) => {
    if (t.status === 'done') { await reload(); c.toast('画好了：在这种生物下面标着“等你确认”。对照实拍照片核对形态，没问题再点“确认可用”。'); }
    else { stat.textContent = `没画成：${t.error}`; stat.className = 'small toast bad dstat'; stat.parentElement?.querySelector<HTMLButtonElement>('.draw')?.removeAttribute('disabled'); }
  };
  document.querySelectorAll<HTMLElement>('.drawrow').forEach(row => {
    const asset = row.dataset.a!, stat = row.querySelector<HTMLElement>('.dstat')!, btn = row.querySelector<HTMLButtonElement>('.draw')!;
    const watch = (id: string) => poll(c, id, () => row.isConnected, t => done(t, stat));
    btn.onclick = c.guard(async () => {
      const r = await c.api<{ id: string }>('/v1/studio/image', { method: 'POST', body: JSON.stringify({ asset, note: row.querySelector<HTMLInputElement>('.dnote')!.value }) });
      btn.disabled = true; stat.textContent = 'ChatGPT 正在画（通常 1–3 分钟），可以先做别的'; stat.className = 'small muted dstat';
      watch(r.id);
    });
    const running = shown.tasks?.find(t => t.status === 'running' && t.asset === asset);
    if (running) watch(running.id);
  });
}

// ---- 课程库: a lesson's animal made by ChatGPT start to finish: real photos from the web → photoreal top view → moving 3D ----
export function makeRow(o: { asset_id: string; name: string; media: { kind: string }[] }): string {
  const busy = shown.tasks?.find(t => t.status === 'running' && t.asset === o.asset_id), again = o.media.some(m => m.kind === 'cutout');
  return `<div class="row makerow" data-a="${esc(o.asset_id)}"><button type="button" class="btn ${again ? '' : 'primary'} make" ${busy ? 'disabled' : ''}>${again ? `让 ChatGPT 重新做「${esc(o.name)}」的 3D` : `让 ChatGPT 自动做「${esc(o.name)}」：找实拍照片 → 画写实俯视图 → 课里变成会动的 3D`}</button>
    <span class="small muted mstat">${busy ? `ChatGPT 正在${esc(busy.step ?? '做')}…` : '大约 3–10 分钟；做好后在“生物素材”里对照照片核对，再确认'}</span></div>`;
}
export function wireMake(c: Ctx, reload: () => Promise<void>) {
  document.querySelectorAll<HTMLElement>('.makerow').forEach(row => {
    const asset = row.dataset.a!, stat = row.querySelector<HTMLElement>('.mstat')!, btn = row.querySelector<HTMLButtonElement>('.make')!;
    const watch = (id: string) => poll(c, id, () => row.isConnected, async t => {
      if (t.status === 'done') { await reload(); c.toast('做好了：先点这节课的“预览”看会动的 3D，再在“生物素材”里对照实拍照片核对，没问题就确认。'); }
      else { stat.textContent = `没做成：${t.error}`; stat.className = 'small toast bad mstat'; btn.disabled = false; }
    }, t => { stat.textContent = `ChatGPT 正在${t.step ?? '做'}…（可以先做别的）`; });
    btn.onclick = c.guard(async () => {
      const r = await c.api<{ id: string }>('/v1/studio/subject', { method: 'POST', body: JSON.stringify({ asset }) });
      btn.disabled = true; stat.textContent = 'ChatGPT 正在上网找实拍照片…（可以先做别的）'; stat.className = 'small muted mstat';
      watch(r.id);
    });
    const running = shown.tasks?.find(t => t.status === 'running' && t.asset === asset);
    if (running) watch(running.id);
  });
}

/** Show a writing job's progress until it ends (one poller per job, whichever page draws the log). */
const following = new Set<string>();
export function follow(c: Ctx, id: string, onDone: () => Promise<void>) {
  if (following.has(id)) return;
  following.add(id);
  const tick = c.guard(async () => {
    const j = await c.api<Job>(`/v1/studio/jobs/${id}`);
    const box = document.getElementById('wlog');
    if (!box) { following.delete(id); return; } // the parent left the page; the server keeps writing
    box.innerHTML = (j.log ?? []).map(l => `<li>${esc(l.at.slice(11, 19))} ${esc(l.msg)}</li>`).join('')
      + (j.status === 'failed' ? `<li class="toast bad">没写成：${esc(j.error)}${j.issues?.length ? `<ul>${j.issues.map(i => `<li>${esc(i.rule)} ${esc(i.msg)}</li>`).join('')}</ul>` : ''}</li>` : '');
    document.querySelector<HTMLButtonElement>('#wform button.primary')?.toggleAttribute('disabled', j.status === 'running');
    if (j.status === 'running') { setTimeout(tick, 1500); return; }
    following.delete(id);
    if (j.status === 'done') { await onDone(); c.toast(`写好了：${j.title}。在“等你审核”里先预览，再勾选审核。`); }
  });
  tick();
}

// ---- 设备与数据 → 大模型: add, test and switch models ----
export async function modelsCard(c: Ctx): Promise<string> {
  const m = await c.api<Models>('/v1/studio/models');
  shown.models = m;
  return `<div class="card" id="models"><h3>大模型（AI 出课用）</h3>
    <p class="muted small">可以接任何 OpenAI 兼容接口的大模型，随时切换。API Key 只存在家里这台服务器上，保存后不会再显示。</p>
    ${m.models.length ? `<table><tr><th>用这个</th><th>名字</th><th>模型</th><th>Key</th><th></th></tr>${m.models.map(x => `<tr>
      <td><input type="radio" name="active" value="${esc(x.id)}" ${x.id === m.active ? 'checked' : ''} aria-label="使用 ${esc(x.label)}"></td>
      <td>${esc(x.label)}<div class="muted small">${isCodex(x) ? '这台服务器电脑上的 Codex' : esc(x.base_url)}</div></td><td>${isCodex(x) && !x.model ? '<span class="muted">默认</span>' : esc(x.model)}</td>
      <td>${isCodex(x) ? 'ChatGPT 账号' : x.has_key ? `••••${esc(x.key_tail)}` : '<span class="muted">无</span>'}</td>
      <td><button class="btn mtest" data-id="${esc(x.id)}">测试</button> <button class="btn medit" data-id="${esc(x.id)}">编辑</button> <button class="btn danger mdel" data-id="${esc(x.id)}">删除</button></td></tr>`).join('')}</table>` : ''}
    <label class="consent"><input type="checkbox" id="consent" ${m.consent ? 'checked' : ''}> 我同意 AI 出课和商量方案时把孩子的年级、称呼（哥哥 / 妹妹）和兴趣主题（例如“螳螂虾”）发给所选模型；让 ChatGPT 画图时，把那种生物的实拍照片发给 ChatGPT。不发真实姓名、作业照片、学习记录和孩子的原话。用本机 Ollama 时不需要勾选。</label>
    <form id="mform" class="mform"><input type="hidden" name="id">
      <label>服务商 <select name="provider">${m.providers.map(p => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('')}</select></label>
      <label>名字 <input name="label" maxlength="40" placeholder="自动生成"></label>
      <div class="wide small" id="cxhint" hidden><p>用你的 ChatGPT 账号（Plus 套餐包含 Codex），不用 API Key，也不按用量另付费。只要在运行服务器的这台电脑上做一次：</p>
        <ol><li>打开“终端”，运行 <code>npm i -g @openai/codex</code> 安装 Codex。</li><li>运行 <code>codex login</code>，在打开的网页里用 ChatGPT 账号登录。</li><li>回到这里点“测试”。</li></ol>
        <p>之后商量方案、写课、画图都在家长端点按钮，不用打开 Codex。</p><p id="cxstat"></p></div>
      <label class="wide api">接口地址 <input name="base_url" placeholder="https://…/v1" required></label>
      <label>模型 <input name="model" list="mlist" placeholder="点“获取模型列表”或手填" required><datalist id="mlist"></datalist></label>
      <label class="api">API Key <input name="api_key" type="password" autocomplete="off" placeholder="编辑时留空表示不改"></label>
      <label class="api"><input type="checkbox" name="json_mode" checked> 要求返回 JSON（不支持时会自动关掉）</label>
      <div class="row wide"><button type="button" class="btn" id="mlistbtn">获取模型列表</button><button type="button" class="btn" id="mtry">测试</button>
        <button class="btn primary">保存</button><button type="button" class="btn" id="mclear">清空</button><a id="keyurl" class="small" target="_blank" rel="noopener"></a></div>
    </form><p id="mresult" class="small"></p></div>`;
}

function wireModels(c: Ctx) {
  const form = document.getElementById('mform') as HTMLFormElement | null, m = shown.models;
  if (!form || !m) return;
  const out = document.getElementById('mresult')!;
  const el = (n: string) => form.elements.namedItem(n) as HTMLInputElement;
  const fill = (list: string[]) => { document.getElementById('mlist')!.innerHTML = list.map(x => `<option value="${esc(x)}">`).join(''); };
  const codexCheck = c.guard(async () => {
    const st = document.getElementById('cxstat')!;
    st.textContent = '正在检查 Codex…';
    const r = await c.api<CodexStatus>('/v1/studio/codex');
    st.innerHTML = r.installed && r.logged_in ? `<span class="toast">已装好 Codex ${esc(r.version)}，已登录 ChatGPT 账号。点“保存”就能用了。</span>` : `<span class="toast bad">${esc(r.detail)}</span>`;
  });
  const preset = (keepUrl = false) => {
    const p = m.providers.find(x => x.id === el('provider').value)!, cx = p.id === 'codex';
    form.querySelectorAll<HTMLElement>('.api').forEach(x => { x.hidden = cx; });
    document.getElementById('cxhint')!.hidden = !cx;
    document.getElementById('mlistbtn')!.hidden = cx;
    el('base_url').required = !cx; el('model').required = !cx;
    el('model').placeholder = cx ? '留空 = Codex 默认的模型' : '点“获取模型列表”或手填';
    if (cx) codexCheck();
    if (!keepUrl) el('base_url').value = p.base_url;
    fill(p.models);
    if (!keepUrl && (p.models[0] || cx)) el('model').value = p.models[0] ?? '';
    const a = document.getElementById('keyurl') as HTMLAnchorElement;
    a.textContent = p.key_url ? `去 ${p.label} 拿 API Key` : ''; a.href = p.key_url ?? '#';
  };
  const body = () => { const f = Object.fromEntries(new FormData(form)) as Record<string, string>; return { ...f, id: f.id || undefined, json_mode: el('json_mode').checked }; };
  el('provider').onchange = () => preset();
  preset();
  const reload = async () => { document.getElementById('models')!.outerHTML = await modelsCard(c); wireModels(c); };

  form.onsubmit = e => { e.preventDefault(); c.guard(async () => { await c.api('/v1/studio/models', { method: 'POST', body: JSON.stringify(body()) }); await reload(); c.toast('已保存'); })(); };
  document.getElementById('mclear')!.onclick = () => { form.reset(); el('id').value = ''; preset(); out.textContent = ''; };
  document.getElementById('mlistbtn')!.onclick = c.guard(async () => {
    out.textContent = '正在获取…';
    const r = await c.api<{ models: string[] | null; list_error: string | null }>('/v1/studio/models/test', { method: 'POST', body: JSON.stringify({ ...body(), list_only: true }) });
    if (r.models?.length) { fill(r.models); out.textContent = `可以用的模型：${r.models.join('、')}`; } else out.textContent = r.list_error ?? '这个接口没有给出模型列表，请手填模型名';
  });
  const test = (b: object) => c.guard(async () => {
    out.textContent = '正在测试…';
    const r = await c.api<{ ok: boolean; reply?: string; ms?: number; error?: string }>('/v1/studio/models/test', { method: 'POST', body: JSON.stringify(b) });
    out.innerHTML = r.ok ? `<span class="toast">能用（${((r.ms ?? 0) / 1000).toFixed(1)} 秒）：${esc(r.reply)}</span>` : `<span class="toast bad">${esc(r.error)}</span>`;
  })();
  document.getElementById('mtry')!.onclick = () => test(body());
  document.querySelectorAll<HTMLButtonElement>('#models .mtest').forEach(b => b.onclick = () => test({ id: b.dataset.id }));
  document.querySelectorAll<HTMLButtonElement>('#models .medit').forEach(b => b.onclick = () => {
    const x = m.models.find(y => y.id === b.dataset.id)!;
    el('id').value = x.id; el('provider').value = x.provider; preset(true);
    el('label').value = x.label; el('base_url').value = x.base_url; el('model').value = x.model; el('api_key').value = ''; el('json_mode').checked = x.json_mode !== false;
    out.textContent = `正在编辑「${x.label}」。Key 留空就不改。`; form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  document.querySelectorAll<HTMLButtonElement>('#models .mdel').forEach(b => b.onclick = c.guard(async () => {
    if (!confirm('删除这个模型设置（连同 Key）？')) return;
    await c.api(`/v1/studio/models/${encodeURIComponent(b.dataset.id!)}`, { method: 'DELETE' }); await reload();
  }));
  document.querySelectorAll<HTMLInputElement>('#models input[name=active]').forEach(r => r.onchange = c.guard(async () => {
    await c.api('/v1/studio/settings', { method: 'PUT', body: JSON.stringify({ active: r.value }) }); c.toast('已切换，之后出课用这个模型');
  }));
  (document.getElementById('consent') as HTMLInputElement).onchange = e => c.guard(async () => {
    await c.api('/v1/studio/settings', { method: 'PUT', body: JSON.stringify({ consent: (e.target as HTMLInputElement).checked }) }); c.toast('已保存');
  })();
}

// ---- 设备与数据 → AI 助手接入: MCP tokens and ready-to-paste settings ----
export async function agentsCard(c: Ctx): Promise<string> {
  const list = await c.api<{ label: string; created_at: string }[]>('/v1/agents');
  return `<div class="card" id="agents"><h3>AI 助手接入（MCP）</h3>
    <p class="muted small">让 Codex、Claude Code、Qoder、Cursor 等 AI 助手用同一套 Skill 给孩子写课。它们只能读做课规则和孩子的年级、兴趣主题，并把课交到“等你审核”；不能发布，看不到学习记录、作业和照片。每个助手一个令牌，随时可以移除。</p>
    <form id="aform" class="row"><input name="label" maxlength="40" placeholder="助手名字，例如 Codex" required><button class="btn primary">生成令牌</button></form>
    <div id="asnip"></div>
    <ul>${list.map(a => `<li>${esc(a.label)} · ${esc(a.created_at.slice(0, 10))} <button class="btn arevoke" data-l="${esc(a.label)}">移除</button></li>`).join('') || '<li class="muted">还没有接入的助手</li>'}</ul></div>`;
}

function wireAgents(c: Ctx) {
  const form = document.getElementById('aform') as HTMLFormElement | null;
  const redraw = async () => { document.getElementById('agents')!.outerHTML = await agentsCard(c); wireAgents(c); };
  if (form) form.onsubmit = e => {
    e.preventDefault();
    c.guard(async () => {
      const r = await c.api<{ label: string; token: string }>('/v1/agents', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      await redraw();
      document.getElementById('asnip')!.innerHTML = snippets(r.label, r.token);
      wireCopy();
    })();
  };
  document.querySelectorAll<HTMLButtonElement>('#agents .arevoke').forEach(b => b.onclick = c.guard(async () => {
    if (!confirm(`移除「${b.dataset.l}」？它的令牌马上失效。`)) return;
    await c.api(`/v1/agents/${encodeURIComponent(b.dataset.l!)}`, { method: 'DELETE' });
    await redraw();
  }));
}

function snippets(label: string, token: string) {
  const url = `${location.origin}/mcp`, slug = 'adw';
  const block = (title: string, text: string, note = '') => `<div class="snip"><div class="row"><b>${esc(title)}</b><button type="button" class="btn copy">复制</button></div>${note ? `<p class="muted small">${note}</p>` : ''}<textarea readonly rows="${text.split('\n').length}">${esc(text)}</textarea></div>`;
  return `<p class="toast">「${esc(label)}」的令牌只显示这一次，复制到对应工具的设置里：</p>
    ${block('令牌', token)}
    ${block('Codex（~/.codex/config.toml）', `[mcp_servers.${slug}]\nurl = "${url}"\nhttp_headers = { "Authorization" = "Bearer ${token}" }`, '保存后重开 Codex，输入 /mcp 能看到 adw。')}
    ${block('Claude Code（终端里运行）', `claude mcp add --transport http ${slug} ${url} --header "Authorization: Bearer ${token}"`)}
    ${block('Cursor / Qoder / 其他（mcp.json）', JSON.stringify({ mcpServers: { [slug]: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2), '多数工具用这个格式；如果字段名不同，以该工具的 MCP 设置说明为准。')}
    <p class="muted small">然后对助手说：“用 adw 给哥哥做下一节课”。它会读 Skill、拿孩子的兴趣、写课、自己校验，最后交给你审核。</p>`;
}

function wireCopy() {
  document.querySelectorAll<HTMLButtonElement>('#asnip .copy').forEach(b => b.onclick = async () => {
    const t = b.closest('.snip')!.querySelector('textarea')!;
    await copyText(t);
    b.textContent = '已复制'; setTimeout(() => { b.textContent = '复制'; }, 1500);
  });
}
