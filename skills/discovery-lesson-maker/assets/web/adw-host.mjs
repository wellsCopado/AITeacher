// AI 探索世界 App 接口（adw-explore/1）。课程在 App 里打开时（iframe，地址带 ?adw=1），
// 把进度告诉 App、听 App 的暂停；单独打开时什么都不做。复制到课程源码里使用，不要改消息格式。
const params = new URLSearchParams(location.search);
const host = window.parent !== window ? window.parent : null;
/** 在 App 里上课。 */
export const inApp = Boolean(host) && params.get('adw') === '1';
/** App 传来的孩子编号（只用于区分本机记录，不是名字）；单独打开时为空。 */
export const learner = (params.get('learner') || '').replace(/[^\w-]/g, '').slice(0, 40);
/** 本机记录的键：每个孩子一份，家长预览（learner=preview）和制作验收（qa）各自独立。 */
export const storageKey = (base, qa = false) => `${base}:${qa ? 'qa' : learner ? `learner-${learner}` : 'learner'}`;
const post = (msg) => { if (inApp) host.postMessage({ adw: 'explore/1', ...msg }, location.origin); };
/** 场景载入好了。 */
export const ready = () => post({ type: 'ready' });
/** 场景载入失败，App 会告诉孩子先退出。 */
export const failed = (message) => post({ type: 'error', message: String(message).slice(0, 200) });
/**
 * 每次保存记录时调用。tasks 里每项：passed（这次核对通过）、result（independent 独立 / assisted 借助帮助 / corrected 改错后）、
 * helped、wrong（错的次数）。全部 passed 时 App 记这节课学完；帮助和改错照实记，不算独立完成。
 */
export const report = ({ section = 0, sections = 0, tasks = {}, labels = {} }) => {
  const list = Object.entries(tasks).map(([id, t]) => ({ id, label: labels[id] || id, passed: Boolean(t.passed), result: t.passed ? String(t.result || '') : '', helped: Boolean(t.helped), wrong: Math.max(0, Number(t.wrong ?? t.wrongAttempts) || 0) }));
  post({ type: 'progress', section, sections, done: list.filter((t) => t.passed).length, total: list.length, tasks: list });
};
/** App 发来的指令：pause（孩子点了 App 的退出，先停下声音和动画）、resume（孩子选了继续）。 */
export const onHost = (fn) => {
  if (!inApp) return;
  addEventListener('message', (e) => { if (e.source === host && e.origin === location.origin && e.data?.adw === 'explore/1') fn(e.data); });
};
