// Parent preview of a lesson waiting for review (or already published): the full player with the parent
// side panel; nothing is recorded. Opened from the parent app as preview.html#key=…&t=<parent token>.
import type { LessonSpec } from '../../../packages/schema/src/index.js';
import { play } from '../../../packages/player/src/main.js';

const q = new URLSearchParams(location.hash.slice(1));
const key = q.get('key') ?? '', token = q.get('t') ?? '';
history.replaceState(null, '', location.pathname); // keep the token out of the address bar
const app = document.getElementById('app')!;

async function get(path: string): Promise<LessonSpec | null> {
  const r = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
  return r.ok ? r.json() : null;
}
(async () => {
  const sp = (await get(`/v1/drafts/${encodeURIComponent(key)}`)) ?? (await get(`/v1/lessons/${encodeURIComponent(key)}`));
  if (!sp) { app.innerHTML = '<p style="padding:24px">打不开这节课：请从家长端「课程库」点“预览”进入。</p>'; return; }
  document.title = `${sp.title} · 预览`;
  (window as unknown as { __player: unknown }).__player = play(app, sp, {});
})();
