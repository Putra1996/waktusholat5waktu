/* =====================================================================
   FCM SERVICE WORKER — menangani push notification saat aplikasi
   sedang tertutup / berjalan di background.
   ===================================================================== */
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');
importScripts('./fcm-config.js');

if (self.FCM_CONFIG && self.FCM_CONFIG.apiKey) {
  try {
    firebase.initializeApp(self.FCM_CONFIG);
    const messaging = firebase.messaging();

    messaging.onBackgroundMessage((payload) => {
      const data = payload.data || {};
      const notif = payload.notification || {};
      const title = notif.title || data.title || '⏰ Waktu Sholat';
      const body = notif.body || data.body || 'Segera tunaikan sholat.';
      self.registration.showNotification(title, {
        body: body,
        icon: './icons/icon-192.png',
        badge: './icons/icon-192.png',
        tag: data.tag || 'sholat',
        renotify: true,
        vibrate: [200, 100, 200],
        data: { url: data.url || './' },
      });
    });

    self.addEventListener('notificationclick', (event) => {
      event.notification.close();
      const url = (event.notification.data && event.notification.data.url) || './';
      event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
          for (const c of list) { if ('focus' in c) return c.focus(); }
          return clients.openWindow(url);
        })
      );
    });
  } catch (e) {
    console.warn('FCM init gagal:', e);
  }
}
