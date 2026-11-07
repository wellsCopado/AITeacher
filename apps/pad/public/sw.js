// App shell and three.js are cached so a lesson that already opened keeps working without Wi-Fi.
// API calls always go to the network; the app keeps its own copy of today's lessons.
const CACHE = 'adw-pad-__BUILD__';
const SHELL = ['./', './index.html', './app.js', './player.css', './pad.css', './assets.js', './manifest.webmanifest', './icon-180.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/v1/')) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request);
    if (hit) return hit;
    const r = await fetch(e.request);
    if (r.ok) c.put(e.request, r.clone());
    return r;
  }));
});
