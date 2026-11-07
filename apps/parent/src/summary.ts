// Plain-sentence summary of one learning session for the parent: what was done, where hints were used,
// what the child said. Facts only, no scores or rankings.
export interface Ev { id: string; at: string; type: string; [k: string]: unknown }
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const RESULT: Record<string, string> = { independent: '独立答对', assisted: '借助帮助完成', corrected: '改错后完成' };
interface Progress { done: number; total: number; tasks: { label: string; passed: boolean; result: string }[] }

/** What happened in one session, in plain sentences. An 探索课 (kind explore) reports what the child checked in the page. */
export function summarize(evs: Ev[], lesson?: { kind?: string; challenges?: { id: string; prompt: string }[] }): string {
  if (!evs.length) return '<p class="muted">没有事件</p>';
  // time spent in the lesson: the gaps after a pause or an exit (until the child came back) don't count
  const ms = evs.slice(1).reduce((a, e, i) => (/^(pause|lesson_exit)$/.test(evs[i].type) ? a : a + Date.parse(e.at) - Date.parse(evs[i].at)), 0);
  const mins = Math.max(1, Math.round(ms / 60000));
  const exits = evs.filter(e => e.type === 'lesson_exit');
  const answers = evs.filter(e => e.type === 'answer');
  const byCh = new Map<string, Ev[]>();
  for (const a of answers) byCh.set(String(a.challenge), [...(byCh.get(String(a.challenge)) ?? []), a]);
  const hotspots = evs.filter(e => e.type === 'hotspot').length;
  const actions = evs.filter(e => e.type === 'action').map(e => e.label ?? e.action);
  const said = evs.filter(e => e.type === 'next_lesson_wish' || e.type === 'reflection');
  const prog = [...evs].reverse().find(e => e.type === 'explore_progress') as (Ev & Progress) | undefined;
  const checked = prog?.tasks.filter(t => t.passed) ?? [], open = prog?.tasks.filter(t => !t.passed) ?? [];
  const lines = [
    lesson?.kind === 'explore' ? `用了大约 ${mins} 分钟。` : `用了大约 ${mins} 分钟，点开讲解 ${hotspots} 次${actions.length ? `，动手做了：${[...new Set(actions)].map(esc).join('、')}` : ''}。`,
    prog ? `核对了 ${prog.done}/${prog.total} 项${checked.length ? `：${checked.map(t => `${esc(t.label)}（${RESULT[t.result] ?? '已核对'}）`).join('、')}` : ''}${open.length ? `；还没核对：${open.map(t => esc(t.label)).join('、')}` : ''}。` : '',
    ...[...byCh].map(([c, all]) => {
      const list = all.filter(a => !a.twin), twin = all.filter(a => a.twin);
      const ok = list.find(a => a.correct);
      const hints = Math.max(0, ...list.map(a => Number(a.hints ?? 0)));
      const i = lesson?.challenges?.findIndex(x => x.id === c) ?? -1;
      const name = i >= 0 ? `第 ${i + 1} 题（${lesson!.challenges![i].prompt.slice(0, 24)}${lesson!.challenges![i].prompt.length > 24 ? '…' : ''}）` : `挑战 ${c}`;
      // After three misses the Pad showed how it's done, then the child did a similar question alone.
      const demo = evs.some(e => e.type === 'worked_example' && e.challenge === c);
      const after = demo ? `，看了一遍分步演示${twin.length ? `，同类题${twin.some(a => a.correct) ? '自己做对了' : '还没做对，下次再练'}` : ''}` : '';
      return `${esc(name)}：试了 ${list.length} 次，${ok ? '做对了' : '还没做对'}${hints ? `，用了 ${hints} 级提示` : ''}${after}。`;
    }),
    ...said.map(e => `${e.type === 'next_lesson_wish' ? '下一课想学' : '孩子说'}：“${esc(e.answer)}”`),
    evs.some(e => e.type === 'chat_skipped') ? '课末聊天跳过了。' : '',
    exits.length ? `中途退出 ${exits.length} 次（在「${exits.map(e => esc(String(e.step ?? '').replace(/（.*）/, ''))).join('」「')}」）。` : '',
    evs.some(e => e.type === 'lesson_end') ? '' : '这节课还没走到最后。',
  ].filter(Boolean);
  return lines.map(l => `<p>${l}</p>`).join('');
}
