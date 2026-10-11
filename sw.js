/* =====================================================================
   SHOLAT APP — Service Worker
   - Cache offline untuk aplikasi inti (HTML, JS, ikon, audio adzan)
   - Navigasi: network-first (agar versi terbaru cepat masuk) + fallback cache
   - Aset statis: stale-while-revalidate
   - API pihak ketiga (Aladhan / EQuran): network-first + fallback cache
   - Penanganan klik notifikasi (fokus/buka aplikasi)

   Catatan versi: naikkan CACHE setiap merilis perubahan besar agar
   cache lama dibersihkan saat activate.
   ===================================================================== */
const CACHE = 'sholat-app-v14';
const OFFLINE_URL = './index.html';

const ASSETS = [
  './',
  'index.html',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'audio/adzan.mp3',
  'audio/adzan-bilal.mp3',
];

// API yang boleh di-cache sebagai fallback offline (GET saja)
const API_HOSTS = [
  'api.aladhan.com',
  'equran.id',
  'api.bigdatacloud.net',
  'nominatim.openstreetmap.org',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // addAll() gagal total bila satu berkas gagal -> dipakai satu per satu.
    await Promise.all(ASSETS.map(async (url) => {
      try { await cache.add(new Request(url, { cache: 'reload' })); }
      catch (err) { /* berkas opsional (mis. audio) boleh gagal */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.disable(); } catch (err) {}
    }
    await self.clients.claim();
  })());
});

function isApiRequest(url) {
  return API_HOSTS.includes(url.hostname);
}

async function networkFirst(request, event, timeoutMs = 4000) {
  const cache = await caches.open(CACHE);
  try {
    const preload = event && event.preloadResponse ? await event.preloadResponse : null;
    const res = preload || await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    if (res && res.ok && res.type === 'basic') cache.put(request, res.clone());
    else if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const fallback = await cache.match(OFFLINE_URL) || await cache.match('./');
      if (fallback) return fallback;
    }
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then((res) => {
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  return cached || network || fetch(request);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // AUDIT: dulu semua metode (termasuk POST ke server FCM) ikut ditangani dan
  // bisa menghasilkan respondWith(undefined) -> request gagal. Kini hanya GET.
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  // Permintaan audio dengan Range (streaming) dilewatkan langsung ke jaringan
  if (req.headers.get('range')) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, event));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  if (isApiRequest(url)) {
    event.respondWith(networkFirst(req, event, 8000));
  }
  // origin lain (YouTube, gstatic, dsb.) tidak di-cache
});

/* ---------- Notifikasi: klik membuka/memfokuskan aplikasi ---------- */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of list) {
      if ('focus' in client) {
        try { await client.focus(); } catch (err) {}
        if ('navigate' in client) { try { await client.navigate(target); } catch (err) {} }
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

/* ---------- Pesan dari halaman (mis. perintah lewati waiting) ---------- */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
