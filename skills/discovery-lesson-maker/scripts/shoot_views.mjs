// 用无头浏览器打开课程网页，按 views.json 逐个机位截实时画面（和预渲染图、实拍照片并排做对照图用）。
// 用法：node shoot_views.mjs <网页地址> <输出目录> <views.json> [宽x高]
// 页面约定：载入完设 window.__ready = true；提供 window.adwSetView(view) 切到机位（参数是 views.json 的一项）。
// 需要 playwright（在装了它的目录下运行，或 NODE_PATH 指向它）。没有 GPU 时用软件渲染，慢但截图有效。
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [, , url, out, viewsFile, size = '1280x750'] = process.argv;
if (!url || !out || !viewsFile) {
  console.error('用法：node shoot_views.mjs <网页地址> <输出目录> <views.json> [宽x高]');
  process.exit(2);
}
const data = JSON.parse(readFileSync(viewsFile, 'utf8'));
const views = Array.isArray(data) ? data : data.views;
const { chromium } = createRequire(resolve(process.cwd(), 'noop.js'))('playwright');
const [width, height] = size.split('x').map(Number);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width, height } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
const hasSetter = await page.evaluate(() => typeof window.adwSetView === 'function');
if (!hasSetter) {
  console.error('页面没有 window.adwSetView(view)：加上它，截图才能和预渲染用同一个机位');
  await browser.close();
  process.exit(1);
}
for (const v of views) {
  await page.evaluate((view) => window.adwSetView(view), v);
  await page.waitForTimeout(3000); // 等阴影、水面、渐进效果稳定
  // 页面截图在软件渲染下常超时；直接读画布（渲染器要开 preserveDrawingBuffer，或在 adwSetView 里同步渲染一帧）
  const png = await page.evaluate(() => {
    const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    return c ? c.toDataURL('image/png') : null;
  });
  if (!png) throw new Error('页面上没有画布');
  writeFileSync(join(out, `${v.name}.png`), Buffer.from(png.split(',')[1], 'base64'));
  console.log('shot', v.name, v.media || 'realtime');
}
if (errors.length) console.log('页面报错：\n' + errors.slice(0, 5).join('\n'));
await browser.close();
