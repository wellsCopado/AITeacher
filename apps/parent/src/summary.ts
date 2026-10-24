// Plain-sentence summary of one learning session for the parent: what was done, where hints were used,
// what the child said. Facts only, no scores or rankings.
export interface Ev { id: string; at: string; type: string; [k: string]: unknown }
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** What happened in one session, in plain sentences. */
export function summarize(evs: Ev[], lesson?: { challenges: { id: string; prompt: string }[] }): string {
  if (!evs.length) return '<p class="muted">没有事件</p>';
  const mins = Math.max(1, Math.round((Date.parse(evs[evs.length - 1].at) - Date.parse(evs[0].at)) / 60000));
  const answers = evs.filter(e => e.type === 'answer');
  const byCh = new Map<string, Ev[]>();
  for (const a of answers) byCh.set(String(a.challenge), [...(byCh.get(String(a.challenge)) ?? []), a]);
  const hotspots = evs.filter(e => e.type === 'hotspot').length;
  const actions = evs.filter(e => e.type === 'action').map(e => e.label ?? e.action);
  const said = evs.filter(e => e.type === 'next_lesson_wish' || e.type === 'reflection');
  const lines = [
    `用了大约 ${mins} 分钟，点开讲解 ${hotspots} 次${actions.length ? `，动手做了：${[...new Set(actions)].map(esc).join('、')}` : ''}。`,
    ...[...byCh].map(([c, all]) => {
      const list = all.filter(a => !a.twin), twin = all.filter(a => a.twin);
      const ok = list.find(a => a.correct);
      const hints = Math.max(0, ...list.map(a => Number(a.hints ?? 0)));
      const i = lesson?.challenges.findIndex(x => x.id === c) ?? -1;
      const name = i >= 0 ? `第 ${i + 1} 题（${lesson!.challenges[i].prompt.slice(0, 24)}${lesson!.challenges[i].prompt.length > 24 ? '…' : ''}）` : `挑战 ${c}`;
      // After three misses the Pad showed how it's done, then the child did a similar question alone.
      const demo = evs.some(e => e.type === 'worked_example' && e.challenge === c);
      const after = demo ? `，看了一遍分步演示${twin.length ? `，同类题${twin.some(a => a.correct) ? '自己做对了' : '还没做对，下次再练'}` : ''}` : '';
      return `${esc(name)}：试了 ${list.length} 次，${ok ? '做对了' : '还没做对'}${hints ? `，用了 ${hints} 级提示` : ''}${after}。`;
    }),
    ...said.map(e => `${e.type === 'next_lesson_wish' ? '下一课想学' : '孩子说'}：“${esc(e.answer)}”`),
    evs.some(e => e.type === 'chat_skipped') ? '课末聊天跳过了。' : '',
    evs.some(e => e.type === 'lesson_end') ? '' : '这节课还没走到最后。',
  ].filter(Boolean);
  return lines.map(l => `<p>${l}</p>`).join('');
}
