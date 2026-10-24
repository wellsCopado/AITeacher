// AI lesson writing in the parent app: 课程库 → AI 出一节课 (any model, switched here), and 设备与数据 →
// 大模型 / AI 助手接入 (MCP tokens for Codex, Claude Code, Qoder, Cursor…). Whatever writes the lesson, it lands in
// 等你审核 and only the parent's button publishes it. API keys are typed in here once and never shown again.
import type { Ctx } from './homework.js';

interface Provider { id: string; label: string; base_url: string; models: string[]; key_url?: string }
interface Model { id: string; label: string; provider: string; base_url: string; model: string; json_mode?: boolean; has_key: boolean; key_tail: string | null }
interface Models { providers: Provider[]; models: Model[]; active: string | null; consent: boolean }
interface Job { id: string; child: string; model: string; status: 'running' | 'done' | 'failed'; log?: { at: string; msg: string }[]; key?: string; title?: string; error?: string; issues?: { rule: string; path: string; msg: string }[] }

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const isLocal = (m: Model) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(m.base_url + '/');

// The cards are drawn first and wired after the page puts them in (wireStudio).
let shown: { models?: Models; running?: Job; onDone?: () => Promise<void> } = {};
export function wireStudio(c: Ctx) { wireWriter(c); wireModels(c); wireAgents(c); }

// ---- 课程库: write a lesson with one button ----
export async function writerCard(c: Ctx, onDone: () => Promise<void>): Promise<string> {
  const [m, jobs] = await Promise.all([c.api<Models>('/v1/studio/models'), c.api<Job[]>('/v1/studio/jobs')]);
  const running = jobs.find(j => j.status === 'running');
  shown = { ...shown, running, onDone };
  if (!m.models.length) return `<div class="card" id="writer"><h3>AI 出一节课</h3><p class="muted">还没有设置大模型。到「设备与数据 → 大模型」添加一个（DeepSeek、通义千问、Kimi、智谱、豆包、GPT、Claude、Gemini、本机 Ollama 都可以），这里就能一键出课。</p></div>`;
  const active = m.models.find(x => x.id === m.active) ?? m.models[0];
  const needConsent = !m.consent && !isLocal(active);
  return `<div class="card" id="writer"><h3>AI 出一节课</h3>
    <p class="muted small">直接写一句要求就行。想先和 ChatGPT 商量方案：点“复制设计说明”发给 ChatGPT（网页、手机都行），谈好后把它给的【课程方案】整段粘到下面。AI 按 Skill 写课、自己校验并修改，通过后放到“等你审核”，发布还是要你看过、勾完再点。</p>
    <form id="wform"><div class="row"><select name="child">${c.kids.map(k => `<option value="${esc(k.id)}">${esc(k.name)}</option>`).join('')}</select>
      <select name="model">${m.models.map(x => `<option value="${esc(x.id)}" ${x.id === active.id ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>
      <button type="button" class="btn" id="dbtn">复制设计说明（发给 ChatGPT）</button></div>
      <textarea name="wish" rows="3" maxlength="8000" placeholder="一句要求，例如：用大桥做主题、再难一点；或者粘贴在 ChatGPT 里谈好的【课程方案】"></textarea>
      <div class="row"><button class="btn primary" ${running ? 'disabled' : ''}>开始写课</button></div></form>
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
      <td>${esc(x.label)}<div class="muted small">${esc(x.base_url)}</div></td><td>${esc(x.model)}</td>
      <td>${x.has_key ? `••••${esc(x.key_tail)}` : '<span class="muted">无</span>'}</td>
      <td><button class="btn mtest" data-id="${esc(x.id)}">测试</button> <button class="btn medit" data-id="${esc(x.id)}">编辑</button> <button class="btn danger mdel" data-id="${esc(x.id)}">删除</button></td></tr>`).join('')}</table>` : ''}
    <label class="consent"><input type="checkbox" id="consent" ${m.consent ? 'checked' : ''}> 我同意 AI 出课时把孩子的年级、称呼（哥哥 / 妹妹）和兴趣主题（例如“螳螂虾”）发给所选模型。不发真实姓名、作业照片、学习记录和孩子的原话。用本机 Ollama 时不需要勾选。</label>
    <form id="mform" class="mform"><input type="hidden" name="id">
      <label>服务商 <select name="provider">${m.providers.map(p => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('')}</select></label>
      <label>名字 <input name="label" maxlength="40" placeholder="自动生成"></label>
      <label class="wide">接口地址 <input name="base_url" placeholder="https://…/v1" required></label>
      <label>模型 <input name="model" list="mlist" placeholder="点“获取模型列表”或手填" required><datalist id="mlist"></datalist></label>
      <label>API Key <input name="api_key" type="password" autocomplete="off" placeholder="编辑时留空表示不改"></label>
      <label><input type="checkbox" name="json_mode" checked> 要求返回 JSON（不支持时会自动关掉）</label>
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
  const preset = (keepUrl = false) => {
    const p = m.providers.find(x => x.id === el('provider').value)!;
    if (!keepUrl) el('base_url').value = p.base_url;
    fill(p.models);
    if (!keepUrl && p.models[0]) el('model').value = p.models[0];
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
