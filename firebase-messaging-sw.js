/* =====================================================================
   FCM SERVICE WORKER — menangani push notification saat aplikasi
   tertutup / di background.

   PENTING: berkas ini didaftarkan pada scope yang sama ('/') dengan sw.js,
   sehingga ia MENGGANTIKAN sw.js sebagai service worker aktif. Karena itu
   sw.js diimpor lebih dulu di sini agar kemampuan offline tetap utuh
   (dulu tidak diimpor -> aplikasi kehilangan mode offline begitu FCM aktif).
   ===================================================================== */
importScripts('./sw.js');

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');
importScripts('./fcm-config.js');

const cfg = self.FCM_CONFIG;

if (cfg && cfg.apiKey) {
  try {
    if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(cfg);
    const messaging = firebase.messaging();

    messaging.onBackgroundMessage((payload) => {
      const data = payload.data || {};
      const notif = payload.notification || {};
      const title = notif.title || data.title || '⏰ Waktu Sholat';
      const body = notif.body || data.body || 'Segera tunaikan sholat.';
      return self.registration.showNotification(title, {
        body: body,
        icon: './icons/icon-192.png',
        badge: './icons/icon-192.png',
        tag: data.tag || 'sholat',
        renotify: true,
        vibrate: [200, 100, 200],
        data: { url: data.url || './' },
      });
    });
  } catch (e) {
    console.warn('FCM init gagal:', e);
  }
} else {
  console.info('FCM belum dikonfigurasi (fcm-config.js) — push server tidak aktif.');
}

/* Handler notificationclick ditangani di sw.js (diimpor di atas) agar
   klik notifikasi tetap berfungsi baik FCM aktif maupun tidak. */
