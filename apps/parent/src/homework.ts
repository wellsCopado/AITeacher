// Parent views for M4: upload homework, check each recognised item, read and confirm the judgment, edit the
// parent card, keep feedback by source; mastery and reteach; export or delete a child's data.
import { downscale } from './image.js';

export interface Ctx {
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  blob: (path: string) => Promise<Blob>;
  kids: { id: string; name: string }[];
  today: string;
  name: (id: string) => string;
  title: (key: string) => string;
  toast: (m: string, bad?: boolean) => void;
  guard: (fn: () => Promise<unknown>) => () => void;
  view: () => HTMLElement;
}
interface Item { no: string; photo: string; prompt: string; child_answer: string; teacher_mark: string; teacher_note?: string | null; confidence: number; concept_id?: string | null; observation?: string | null; confirmed: boolean; needs_check: boolean; original?: Record<string, unknown> | null }
interface Upload { id: string; child: string; date: string; note: string | null; status: string; ai_consent: boolean; photos: { id: string; mime: string }[]; items?: number; to_check?: number; judgment?: string | null }
interface Judgment {
  facts: { text: string; items: string[] }[];
  gaps: { concept_id: string; text: string; confidence: number; verify_by: string; items: string[] }[];
  unknowns: string[]; next: { kind: string; concept_id?: string | null; text: string }[];
  mastery: { concept_id: string; state: string; evidence: string[] }[];
  corrects?: { judgment_id: string; gap: number; note: string }[];
  parent_card: Card;
}
interface Card { facts: string; child_share: string; unverified: string; talk: string }
interface JRow { id: string; child: string; homework_ref: string; status: string; judgment: Judgment; card: Card | null; card_used: number; corrected: { gap: number; by: string; note: string }[] }
interface Concept { concept_id: string; name: string; state: string; source: string | null; since: string | null }
interface Ticket { id: string; child: string; concept_id: string; judgment_ref: string; attempt: number; status: string; lesson_ref: string | null }

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const MARKS = ['对', '错', '半对', '未批'];
const FIELD: Record<string, string> = { prompt: '题目', child_answer: '孩子写的', teacher_mark: '老师批', teacher_note: '批注', concept_id: '知识点' };
const CARD_PARTS: [keyof Card, string][] = [['facts', '本次事实'], ['child_share', '孩子愿意分享的'], ['unverified', '还没验证的解释'], ['talk', '可以这样聊']];
let concepts: Record<string, { name: string }> = {};
const cname = (id?: string | null) => (id ? concepts[id]?.name ?? id : '');
const STATE_CLASS: Record<string, string> = { 未观察: 's0', 待确认: 's1', 有独立应用证据: 's2', 需再支持: 's3' };

async function loadConcepts(c: Ctx) {
  if (Object.keys(concepts).length) return;
  concepts = await c.api<Record<string, { name: string }>>('/v1/concepts');
}

export async function homeworkView(c: Ctx, open?: string) {
  await loadConcepts(c);
  if (open) return homeworkDetail(c, open);
  const list = await c.api<Upload[]>('/v1/homework');
  c.view().innerHTML = `
    <form id="up" class="card"><h3>上传作业照片</h3>
      <div class="row"><select name="child">${c.kids.map(k => `<option value="${esc(k.id)}">${esc(k.name)}</option>`).join('')}</select>
        <input type="date" name="date" value="${c.today}" required><input name="note" placeholder="说明（可空），如：数学练习册 P23" maxlength="200"></div>
      <p><input type="file" name="photos" accept="image/*" multiple required></p>
      <label class="consent"><input type="checkbox" name="consent"> 同意用 Claude（外部 AI）识别这份作业的照片。照片只存在家里的服务器，识别时由 Skill 下载查看，不做其他用途。</label>
      <p class="muted small">不勾选也可以上传，只是需要家长自己录入题目。</p>
      <button class="btn primary">上传</button></form>
    <table><tr><th>日期</th><th>孩子</th><th>状态</th><th>说明</th><th></th></tr>${list.map(h => `<tr><td>${esc(h.date)}</td><td>${esc(c.name(h.child))}</td>
      <td><span class="badge">${esc(h.status)}</span>${h.to_check ? ` <span class="muted small">待核对 ${h.to_check} 题</span>` : ''}</td><td>${esc(h.note ?? '')}</td>
      <td><button class="btn open" data-id="${esc(h.id)}">打开</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">还没有作业</td></tr>'}</table>`;
  (c.view().querySelector('#up') as HTMLFormElement).onsubmit = e => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const files = [...(f.elements.namedItem('photos') as HTMLInputElement).files ?? []];
    c.guard(async () => {
      if (!files.length) throw new Error('请选照片');
      if (files.length > 8) throw new Error('一次最多 8 张');
      c.toast('正在压缩和上传…');
      const photos = await Promise.all(files.map(downscale));
      const fd = new FormData(f);
      const hw = await c.api<Upload>('/v1/homework', { method: 'POST', body: JSON.stringify({ child: fd.get('child'), date: fd.get('date'), note: fd.get('note'), ai_consent: fd.get('consent') === 'on', photos }) });
      c.toast(`已上传 ${hw.id}。${hw.ai_consent ? '在 Claude Code 里说“看看今天的作业”开始识别。' : ''}`);
      await homeworkView(c);
    })();
  };
  c.view().querySelectorAll<HTMLButtonElement>('.open').forEach(b => b.onclick = c.guard(() => homeworkView(c, b.dataset.id)));
}

async function homeworkDetail(c: Ctx, id: string) {
  const hw = await c.api<Upload & { items: Item[]; judgments: JRow[] }>(`/v1/homework/${id}`);
  const rows = (await c.api<JRow[]>(`/v1/judgments?child=${hw.child}`)).filter(j => j.homework_ref === id);
  const fb = (await c.api<{ source: string; said: string; kind: string; context: string | null; ref: string | null; created_at: string }[]>(`/v1/feedback?child=${hw.child}`)).filter(f => f.ref === id);
  const locked = hw.status === '已判断';
  const sure = hw.items.filter(i => !i.confirmed && !i.needs_check).length;
  c.view().innerHTML = `<p><button class="btn" id="back">← 作业列表</button></p>
    <div class="card"><h3>${esc(c.name(hw.child))} · ${esc(hw.date)} · ${esc(hw.id)} <span class="badge">${esc(hw.status)}</span></h3>
      ${hw.note ? `<p>${esc(hw.note)}</p>` : ''}<div class="photos" id="photos"></div>
      ${hw.ai_consent ? '' : '<p class="muted small">没有同意 AI 识别。</p>'}</div>
    ${hw.items.length ? `<div class="card"><h3>逐题核对</h3><p class="muted small">先看照片，再确认每一题。识别不准的直接改，改前的识别值会保留。标“请核对”的题必须一题一题看。</p>
      ${!locked && sure ? `<p><button class="btn" id="sure">确认所有把握大的题（${sure} 题）</button></p>` : ''}
      <table class="items"><tr><th>题</th><th>题目</th><th>孩子写的</th><th>老师批</th><th>知识点</th><th></th></tr>
      ${hw.items.map(i => `<tr data-no="${esc(i.no)}" class="${i.confirmed ? 'done' : i.needs_check ? 'check' : ''}">
        <td>${esc(i.no)}${i.needs_check && !i.confirmed ? '<div class="badge warn">请核对</div>' : ''}<div class="muted small">${Math.round(i.confidence * 100)}%</div></td>
        <td><textarea name="prompt" rows="2" ${locked ? 'disabled' : ''}>${esc(i.prompt)}</textarea>${i.observation ? `<div class="muted small">看到：${esc(i.observation)}</div>` : ''}</td>
        <td><input name="child_answer" value="${esc(i.child_answer)}" ${locked ? 'disabled' : ''}></td>
        <td><select name="teacher_mark" ${locked ? 'disabled' : ''}>${MARKS.map(m => `<option ${m === i.teacher_mark ? 'selected' : ''}>${m}</option>`).join('')}</select>
          <input name="teacher_note" placeholder="批注" value="${esc(i.teacher_note ?? '')}" ${locked ? 'disabled' : ''}></td>
        <td><select name="concept_id" ${locked ? 'disabled' : ''}><option value="">（不确定）</option>${Object.entries(concepts).map(([k, v]) => `<option value="${esc(k)}" ${k === i.concept_id ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select></td>
        <td>${i.confirmed ? `已确认${i.original ? `<div class="muted small">改过：${Object.entries(i.original).map(([k, v]) => `${esc(FIELD[k] ?? k)}原为「${esc(k === 'concept_id' ? cname(v as string) : v ?? '空')}」`).join('；')}</div>` : ''}` : ''}
          ${locked ? '' : `<button class="btn ok" data-no="${esc(i.no)}">${i.confirmed ? '保存修改' : '确认'}</button>`}</td></tr>`).join('')}</table></div>`
      : `<div class="card muted">${hw.ai_consent ? '等 Skill 识别：在 Claude Code 里说“看看今天的作业”。' : '还没有识别结果。'}</div>`}
    <div id="judgment"></div>
    <div class="card"><h3>大家怎么说（分来源保存）</h3>
      <ul>${fb.map(f => `<li><b>${esc(f.source)}</b> · ${esc(f.kind)}：“${esc(f.said)}”${f.context ? ` <span class="muted">（${esc(f.context)}）</span>` : ''}</li>`).join('') || '<li class="muted">还没有</li>'}</ul>
      <form id="fb" class="row"><select name="source"><option>老师</option><option>孩子</option><option>家长</option></select>
        <select name="kind"><option>事实</option><option>解释</option><option>推测</option></select>
        <input name="said" placeholder="原话，如：老师说面积单位常写错" maxlength="500" required><input name="context" placeholder="情境（可空）" maxlength="200"><button class="btn">记下</button></form></div>`;
  c.view().querySelector<HTMLButtonElement>('#back')!.onclick = c.guard(() => homeworkView(c));
  // Photos need the parent token, so they are fetched as blobs.
  const ph = c.view().querySelector('#photos')!;
  for (const p of hw.photos) {
    const url = URL.createObjectURL(await c.blob(`/v1/homework/${id}/photos/${p.id}`));
    ph.insertAdjacentHTML('beforeend', `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="作业照片 ${esc(p.id)}"></a>`);
  }
  c.view().querySelector<HTMLButtonElement>('#sure')?.addEventListener('click', c.guard(async () => {
    const r = await c.api<{ confirmed: number }>(`/v1/homework/${id}/confirm-sure`, { method: 'POST', body: '{}' });
    c.toast(`已确认 ${r.confirmed} 题`); await homeworkDetail(c, id);
  }));
  c.view().querySelectorAll<HTMLButtonElement>('.items .ok').forEach(b => b.onclick = c.guard(async () => {
    const tr = b.closest('tr')!;
    const set: Record<string, string | null> = {};
    for (const el of tr.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[name]')) set[el.name] = el.value === '' && el.name === 'concept_id' ? null : el.value;
    await c.api(`/v1/homework/${id}/items/${encodeURIComponent(b.dataset.no!)}`, { method: 'PATCH', body: JSON.stringify({ set }) });
    await homeworkDetail(c, id);
  }));
  (c.view().querySelector('#fb') as HTMLFormElement).onsubmit = e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target as HTMLFormElement));
    c.guard(async () => { await c.api('/v1/feedback', { method: 'POST', body: JSON.stringify({ ...f, child: hw.child, ref: id }) }); await homeworkDetail(c, id); })();
  };
  renderJudgment(c, id, hw, rows[rows.length - 1]);
}

function renderJudgment(c: Ctx, id: string, hw: Upload, row?: JRow) {
  const box = c.view().querySelector('#judgment')!;
  if (!row) {
    box.innerHTML = hw.status === '已核对' ? '<div class="card muted">已核对完。在 Claude Code 里说“判断一下这份作业”，Skill 会写判断。</div>' : '';
    return;
  }
  const j = row.judgment;
  const corrected = (g: number) => row.corrected.filter(x => x.gap === g);
  box.innerHTML = `<div class="card judgment"><h3>判断 ${esc(row.id)} <span class="badge">${esc(row.status)}</span></h3>
    <div class="cols">
      <section><h4>事实</h4><ul>${j.facts.map(f => `<li>${esc(f.text)}</li>`).join('')}</ul></section>
      <section><h4>可能的缺口（推测）</h4><ul>${j.gaps.map((g, i) => `<li class="${corrected(i).length ? 'struck' : ''}">${esc(g.text)} <span class="muted small">把握 ${Math.round(g.confidence * 100)}% · 依据第 ${g.items.map(esc).join('、')} 题 · 验证：${esc(g.verify_by)}</span>
        ${corrected(i).map(x => `<div class="badge">已更正</div> <span class="small">${esc(x.note)}（${esc(x.by)}）</span>`).join('')}</li>`).join('') || '<li class="muted">没有</li>'}</ul></section>
      <section><h4>还不知道的</h4><ul>${j.unknowns.map(u => `<li>${esc(u)}</li>`).join('') || '<li class="muted">没有</li>'}</ul></section>
      <section><h4>下一课建议</h4><ul>${j.next.map(n => `<li><b>${esc(n.kind)}</b>${n.concept_id ? ` · ${esc(cname(n.concept_id))}` : ''}：${esc(n.text)}</li>`).join('')}</ul></section>
    </div>
    <h4>掌握状态</h4><ul>${j.mastery.map(m => `<li>${esc(cname(m.concept_id))}：<span class="state ${STATE_CLASS[m.state] ?? ''}">${esc(m.state)}</span> <span class="muted small">证据：${m.evidence.map(e => e.startsWith('lesson:') ? esc(c.title(e.slice(7))) : `第 ${esc(e)} 题`).join('、')}</span></li>`).join('')}</ul>
    ${row.status === '草稿' ? `<p class="muted small">确认后才生效：掌握状态更新，“需再支持”会生成重教需求。</p><button class="btn primary" id="confirmJ">我看过了，确认这条判断</button>` : ''}</div>
    ${row.status === '已确认' ? `<form class="card" id="card"><h3>家长卡</h3><p class="muted small">这是草稿，改成你自己的话；不会自动发给任何人。</p>
      ${CARD_PARTS.map(([k, label]) => `<label class="cardpart">${label}<textarea name="${k}" rows="2">${esc((row.card ?? j.parent_card)[k])}</textarea></label>`).join('')}
      <div class="row"><button class="btn primary">保存</button><button type="button" class="btn" id="copy">复制全文</button>
        <label><input type="checkbox" id="used" ${row.card_used ? 'checked' : ''}> 已经和孩子聊过</label></div></form>` : ''}`;
  box.querySelector<HTMLButtonElement>('#confirmJ')?.addEventListener('click', c.guard(async () => {
    const r = await c.api<{ tickets: string[] }>(`/v1/judgments/${row.id}/confirm`, { method: 'POST', body: '{}' });
    c.toast(r.tickets.length ? `已确认，生成了重教需求 ${r.tickets.join('、')}` : '已确认');
    await homeworkDetail(c, id);
  }));
  const form = box.querySelector<HTMLFormElement>('#card');
  if (form) {
    form.onsubmit = e => { e.preventDefault(); c.guard(async () => { await c.api(`/v1/judgments/${row.id}/card`, { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(form))) }); c.toast('家长卡已保存'); })(); };
    form.querySelector<HTMLButtonElement>('#copy')!.onclick = c.guard(async () => {
      const fd = new FormData(form);
      await navigator.clipboard.writeText(CARD_PARTS.map(([k, l]) => `${l}：${fd.get(k)}`).join('\n'));
      c.toast('已复制');
    });
    form.querySelector<HTMLInputElement>('#used')!.onchange = e => c.guard(() => c.api(`/v1/judgments/${row.id}/card/used`, { method: 'POST', body: JSON.stringify({ used: (e.target as HTMLInputElement).checked }) }))();
  }
}

export async function masteryView(c: Ctx) {
  await loadConcepts(c);
  const tickets = await c.api<Ticket[]>('/v1/tickets');
  const per = await Promise.all(c.kids.map(k => c.api<Concept[]>(`/v1/mastery?child=${k.id}`)));
  c.view().innerHTML = `<p class="muted">课内答对只算“待确认”；之后的真实作业里独立做对，才算“有独立应用证据”。“需再支持”会生成重教需求，重教课上线后用下一次作业验证。</p>
    ${c.kids.map((k, i) => `<div class="card"><h3>${esc(k.name)}</h3>
      <table><tr><th>知识点</th><th>状态</th><th>依据</th></tr>${per[i].filter(m => m.state !== '未观察').map(m => `<tr><td>${esc(m.name)}</td><td><span class="state ${STATE_CLASS[m.state]}">${esc(m.state)}</span></td>
        <td class="small">${m.source ? (m.source.startsWith('lesson:') ? `课内：${esc(c.title(m.source.slice(7)))}` : `判断 ${esc(m.source)}`) : ''} ${esc(m.since ?? '')}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">还没有观察</td></tr>'}</table>
      <h4>重教需求</h4><ul>${tickets.filter(t => t.child === k.id).map(t => `<li>${esc(t.id)} · ${esc(cname(t.concept_id))} · 第 ${t.attempt} 次 · <span class="badge">${esc(t.status)}</span>${t.lesson_ref ? ` · ${esc(c.title(t.lesson_ref))}` : ''} <span class="muted small">依据 ${esc(t.judgment_ref)}</span></li>`).join('') || '<li class="muted">没有</li>'}</ul>
      ${tickets.some(t => t.child === k.id && t.status === '需求登记') ? '<p class="muted small">在 Claude Code 里说“按重教需求做一节课”，Skill 会换一种教法重做。</p>' : ''}</div>`).join('')}`;
}

/** BL11: export or delete one child's data. */
export function dataSection(c: Ctx): string {
  setTimeout(() => {
    c.view().querySelectorAll<HTMLButtonElement>('.export').forEach(b => b.onclick = c.guard(async () => {
      const blob = await c.blob(`/v1/children/${b.dataset.c}/export`);
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${b.dataset.c}-${c.today}.json`; a.click();
    }));
    c.view().querySelectorAll<HTMLButtonElement>('.wipe').forEach(b => b.onclick = c.guard(async () => {
      const nm = c.name(b.dataset.c!);
      const confirm = prompt(`删除${nm}的全部学习记录、作业、判断、兴趣和反馈，无法恢复。课程本身保留。\n确认请输入「${nm}」：`);
      if (confirm === null) return;
      const pin = prompt('再输一次家长 PIN：');
      if (pin === null) return;
      const r = await c.api<{ deleted_homework: number }>(`/v1/children/${b.dataset.c}/data`, { method: 'DELETE', body: JSON.stringify({ confirm, pin }) });
      c.toast(`已删除${nm}的数据（作业 ${r.deleted_homework} 份）`);
    }));
  });
  return `<div class="card"><h3>孩子的数据</h3><p class="muted small">可以随时导出或删除某个孩子的全部数据（学习记录、作业、判断、兴趣、反馈）。</p>
    <ul>${c.kids.map(k => `<li>${esc(k.name)} <button class="btn export" data-c="${esc(k.id)}">导出</button> <button class="btn danger wipe" data-c="${esc(k.id)}">删除</button></li>`).join('')}</ul></div>`;
}
