// Service worker (MTB 12 Team): cache the app shell so it opens offline. Data calls to GitHub are never cached.
// Caches are shared with the two-person app on the same site, so only this app's own caches (mtbteam-shell-*) are ever removed.
const CACHE = 'mtbteam-shell-team-2.3.2';
const SHELL = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'icons/team-icon-192.png', 'icons/team-icon-512.png', 'icons/team-apple-touch-180.png', 'icons/team-favicon-32.png', 'icons/team-rider.svg', 'qrcode.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('mtbteam-shell-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
