/* Sholat App — Service Worker: cache offline */
const CACHE = 'sholat-app-v8';
const ASSETS = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'audio/adzan.mp3', 'audio/adzan-bilal.mp3'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Navigasi & aset lokal: dari cache dulu, update di belakang
  if (e.request.mode === 'navigate' || url.origin === self.location.origin) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        const net = fetch(e.request).then(res => {
          const clone = res.clone();
          if (res && res.ok) caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        }).catch(() => cached);
        return cached || net;
      })
    );
    return;
  }
  // API eksternal: network-first, fallback ke cache
  e.respondWith(
    fetch(e.request).then(res => {
      const clone = res.clone();
      if (res && res.ok) caches.open(CACHE).then(c => c.put(e.request, clone));
      return res;
    }).catch(() => caches.match(e.request))
  );
});
