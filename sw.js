/* Brake Test Recorder — offline support.
 * App files: network first (so updates arrive), falling back to the saved copy with no signal.
 * Slip reader and fonts from the CDN: saved the first time, then served from the phone. */
const APP_CACHE = 'btr-app-v2';
const LIB_CACHE = 'btr-libs-v1';
const APP_FILES = ['./', './index.html', './core.js', './ocr-worker.js', './pdf-lib.min.js', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './form.pdf'];
const LIB_HOSTS = ['cdn.jsdelivr.net', 'tessdata.projectnaptha.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(APP_CACHE).then(cache =>
    Promise.all(APP_FILES.map(f => cache.add(f).catch(() => null))) // form.pdf is optional
  ).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== APP_CACHE && k !== LIB_CACHE).map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});

function timeout(ms) { return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)); }

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(APP_CACHE);
      try {
        // Skip the browser's own cache so a new upload shows up straight away.
        const res = await Promise.race([fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }), timeout(6000)]);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch (e) {
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
        if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
        return Response.error();
      }
    })());
    return;
  }

  if (LIB_HOSTS.includes(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(LIB_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    })());
  }
});
