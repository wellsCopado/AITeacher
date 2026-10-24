import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LessonSpec } from '../../schema/src/index.js';

const pkgs = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const THREE_VERSION = '0.160.0';

/** One self-contained HTML page that plays a lesson with the reviewed components (three.js from jsDelivr). */
export async function buildPreview(sp: LessonSpec, childName: string): Promise<string> {
  const out = await build({
    entryPoints: [join(pkgs, 'player', 'src', 'main.ts')],
    bundle: true, format: 'esm', write: false, target: 'es2020', minify: true,
    external: ['three', 'three/addons/*'], logLevel: 'silent',
  });
  const js = out.outputFiles[0].text;
  const css = readFileSync(join(pkgs, 'player', 'src', 'player.css'), 'utf8');
  const assets = readFileSync(join(pkgs, 'components', 'assets', 'assets.js'), 'utf8');
  const safe = (s: string) => s.replace(/<\/(script)/gi, '<\\/$1');
  const cdn = `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${sp.title.replace(/</g, '&lt;')} · 预览</title>
<style>${css}</style>
<script type="importmap">{"imports":{"three":"${cdn}/build/three.module.js","three/addons/":"${cdn}/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script>${safe(assets)}</script>
<script>window.__LESSON__=${safe(JSON.stringify(sp))};window.__CHILD_NAME__=${JSON.stringify(childName)};</script>
<script type="module">${safe(js)}</script>
</body></html>`;
}
