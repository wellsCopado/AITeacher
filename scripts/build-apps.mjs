// Build the Pad and parent apps into apps/{pad,parent}/dist (served by the family server).
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stamp = Date.now().toString(36);
for (const name of ['pad', 'parent']) {
  const dir = join(root, 'apps', name), dist = join(dir, 'dist');
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  cpSync(join(dir, 'public'), dist, { recursive: true });
  await build({
    entryPoints: [join(dir, 'src', 'main.ts')], outfile: join(dist, 'app.js'),
    bundle: true, format: 'esm', target: 'es2020', minify: true, external: ['three', 'three/addons/*'], logLevel: 'warning',
  });
  if (name === 'pad') {
    await build({
      entryPoints: [join(dir, 'src', 'preview.ts')], outfile: join(dist, 'preview.js'),
      bundle: true, format: 'esm', target: 'es2020', minify: true, external: ['three', 'three/addons/*'], logLevel: 'warning',
    });
    cpSync(join(root, 'packages', 'player', 'src', 'player.css'), join(dist, 'player.css'));
    cpSync(join(root, 'packages', 'components', 'assets', 'assets.js'), join(dist, 'assets.js'));
    const sw = join(dist, 'sw.js');
    writeFileSync(sw, readFileSync(sw, 'utf8').replace('__BUILD__', stamp));
  }
  console.log(`✓ apps/${name}/dist`);
}
