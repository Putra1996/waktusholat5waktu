/* =====================================================================
   KONFIGURASI FIREBASE / FCM (PUSH NOTIFICATION)
   ---------------------------------------------------------------------
   ISI KONFIGURASI DI BAWAH INI dengan project Firebase Anda sendiri.

   Cara membuat:
   1. Buka https://console.firebase.google.com  -> "Add project"
   2. Di project, menu ⚙️ Project settings  ->  tab "General"
      -> di bagian "Your apps" klik ikon </> (Web).
      Beri nama (mis. "Sholat App") lalu Register.
      Salin objek firebaseConfig dari situ ke bawah (apiKey, authDomain,
      projectId, storageBucket, messagingSenderId, appId).
   3. Di tab "Cloud Messaging":
      - Salin "Web configuration" -> "Web push certificates" -> "Key pair"
        itu adalah VAPID key. Tempel ke VAPID_KEY di bawah.
   4. Download file "service account" (Project settings -> Service accounts
      -> Generate new private key). Simpan sebagai
      backend/serviceAccountKey.json (dipakai server FCM).
   5. Deploy backend (lihat backend/README) lalu set SERVER_URL ke
      alamat server Anda.

   Jika file ini TIDAK diisi (null), aplikasi tetap berfungsi normal
   dengan notifikasi lokal + Service Worker biasa (tanpa push dari server).
   ===================================================================== */

window.FCM_CONFIG = null; // atau isi seperti contoh di bawah:

/*
window.FCM_CONFIG = {
  apiKey: "AIzaSy...",
  authDomain: "xxx.firebaseapp.com",
  projectId: "xxx",
  storageBucket: "xxx.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:xxxxxxxx",
  // Tambahan untuk push:
  vapidKey: "BExxxxxx...",
  serverUrl: "https://your-backend.com"   // endpoint yang menerima token & lokasi
};
*/
