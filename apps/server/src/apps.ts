// The installed apps: the Android tablet app finds this server with GET /v1/hello and is downloaded from /app/;
// the parent app shows the address and a QR code from GET /v1/server-info.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';

export const APK = 'ai-discovery-world-pad.apk';

export interface ApkInfo { file: string; size: number; version: string | null; built: string | null }

/** The tablet app shipped in the repo (apps/android/release), or null before the first build. */
export function apkInfo(root: string): ApkInfo | null {
  const dir = join(root, 'apps', 'android', 'release'), file = join(dir, APK);
  if (!existsSync(file)) return null;
  let meta: { versionName?: string; built?: string } = {};
  try { meta = JSON.parse(readFileSync(join(dir, 'version.json'), 'utf8')); } catch { /* no version file */ }
  return { file, size: statSync(file).size, version: meta.versionName ?? null, built: meta.built ?? null };
}

/** IPv4 addresses on the home network (Wi-Fi or cable), the ones a tablet can reach. */
export function lanAddresses(): string[] {
  return Object.values(networkInterfaces()).flat()
    .filter(a => a && a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address))
    .map(a => a!.address);
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

function landing(apk: ApkInfo | null) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>安装 AI 探索世界</title><style>
body{margin:0;background:#0e1a20;color:#e8f0f2;font:17px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif}
main{max-width:560px;margin:0 auto;padding:40px 20px}img{border-radius:22px}h1{font-size:24px;margin:16px 0}
.btn{display:inline-block;background:#4fb3a9;color:#08181a;text-decoration:none;font-weight:600;padding:14px 26px;border-radius:12px;font-size:19px}
.muted{color:#93aab0;font-size:14px}ol{padding-left:22px}li{margin:8px 0}a{color:#7fd6cc}
</style></head><body><main>
<img src="/pad/icon-180.png" width="96" height="96" alt="">
<h1>AI 探索世界 · 平板 App</h1>
<div id="android">${apk ? `
<p><a class="btn" href="/app/${APK}" download>下载安装包（安卓平板）</a></p>
<p class="muted">版本 ${esc(apk.version ?? '')} · ${mb(apk.size)}</p>
<ol><li>点上面的按钮下载。</li>
<li>下载完点「打开」安装。第一次安装时平板会问“是否允许安装未知应用”，选允许。</li>
<li>桌面上出现「AI探索世界」后打开它。它会自己在家里的 Wi-Fi 里找到这台 Mac。</li>
<li>第一次打开会显示 6 位配对码：在 Mac 上的「AI 探索世界」→ 设备与数据，输入配对码并批准。</li></ol>`
    : '<p>平板安装包还没有放到这台 Mac 上。请在 Mac 上的「AI 探索世界」菜单里点「检查更新」，更新后再扫码。</p>'}
</div>
<div id="ipad" hidden><p>这是 iPad，iPad 装不了安卓安装包。请用 Safari 打开 <a href="/pad/">这个页面</a>，点顶部的分享按钮，选“添加到主屏幕”，以后从桌面图标打开。</p></div>
</main><script>
if (/iPad|iPhone/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
  document.getElementById('android').hidden = true; document.getElementById('ipad').hidden = false;
}
</script></body></html>`;
}

export function appRoutes(app: FastifyInstance, d: { root: string; parent: { preHandler: (req: FastifyRequest) => Promise<void> } }) {
  // No sign-in: the tablet asks every address on the Wi-Fi this before it is paired.
  app.get('/v1/hello', async () => ({ app: 'ai-discovery-world', name: hostname().replace(/\.local$/, '') }));
  app.get('/v1/server-info', d.parent, async (req: FastifyRequest) => {
    const apk = apkInfo(d.root);
    return { name: hostname().replace(/\.local$/, ''), addresses: lanAddresses(), port: req.socket.localPort ?? 8787, apk: apk && { size: apk.size, version: apk.version, built: apk.built } };
  });
  app.get('/app', async (_req, reply: FastifyReply) => reply.redirect('/app/'));
  app.get('/app/', async (_req, reply: FastifyReply) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(landing(apkInfo(d.root))));
  app.get(`/app/${APK}`, async (_req, reply: FastifyReply) => {
    const apk = apkInfo(d.root);
    if (!apk) return reply.code(404).send({ error: '平板安装包还没有放到这台 Mac 上' });
    return reply.type('application/vnd.android.package-archive').header('content-length', apk.size)
      .header('content-disposition', `attachment; filename="${APK}"`).header('cache-control', 'no-store').send(createReadStream(apk.file));
  });
}
