// Parent preview of a lesson waiting for review (or already published): the full player with the parent
// side panel; nothing is recorded. Opened from the parent app as preview.html#key=…&t=<parent token>.
import type { LessonSpec } from '../../../packages/schema/src/index.js';
import { play, type OrganismMedia } from '../../../packages/player/src/main.js';

const q = new URLSearchParams(location.hash.slice(1));
const key = q.get('key') ?? '', token = q.get('t') ?? '';
history.replaceState(null, '', location.pathname + location.search); // keep the token out of the address bar
const app = document.getElementById('app')!;

async function get<T = LessonSpec>(path: string): Promise<T | null> {
  const r = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
  return r.ok ? r.json() : null;
}
(async () => {
  const sp = (await get(`/v1/drafts/${encodeURIComponent(key)}`)) ?? (await get(`/v1/lessons/${encodeURIComponent(key)}`));
  if (!sp) { app.innerHTML = '<p style="padding:24px">打不开这节课：请从家长端「课程库」点“预览”进入。</p>'; return; }
  document.title = `${sp.title} · 预览`;
  // pictures still waiting for the parent's check are shown here too, so the 3D can be seen before confirming it
  const media = (await get<OrganismMedia[]>('/v1/media?pending=1')) ?? [];
  const audio = async (text: string, lang: string) => {
    const r = await fetch(`/v1/tts?lang=${lang}&text=${encodeURIComponent(text)}`, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`tts ${r.status}`);
    return r.arrayBuffer();
  };
  (window as unknown as { __player: unknown }).__player = play(app, sp, { media, audio });
})();
