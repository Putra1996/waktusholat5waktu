# 🕌 Sholat App — Jadwal & Pengingat Sholat (PWA)

Aplikasi web (PWA) jadwal sholat realtime berbasis GPS presisi tinggi: pengingat notifikasi,
adzan tepat waktu, arah kiblat, kalender Hijriah bulanan, multi-lokasi, mengaji Al-Quran
(teks + terjemahan + audio per ayat & mode karaoke), serta Lailatul Qadar & doa harian.

Dulu di-deploy di Netlify — **sekarang siap di-deploy ke Vercel** (lihat bagian Deploy).

---

## ✨ Fitur utama

| Fitur | Keterangan |
| --- | --- |
| Jadwal sholat | Al-Adhan (Aladhan API), default metode **KEMENAG** (id 20), pilihan mazhab Ashar (Standar/Hanafi) |
| GPS presisi tinggi | `enableHighAccuracy`, dengan fallback mode hemat bila sinyal lemah |
| Pencarian kota | Nominatim (OpenStreetMap), dibatasi wilayah Indonesia |
| Multi-lokasi | Simpan beberapa kota + zona waktunya, beralih cepat |
| Pengingat | Offset per waktu (0–120 menit) + notifikasi susulan bila aplikasi baru dibuka |
| Adzan tepat waktu | Bunyi adzan/bip + notifikasi tepat saat masuk waktu sholat (bisa dimatikan) |
| Suara | Adzan bawaan, Adzan Bilal, MP3 kustom (URL sendiri), atau bip |
| Notifikasi | Lewat Service Worker (`showNotification`) → **jalan di Android Chrome** |
| Arah kiblat | Bearing + jarak ke Ka'bah, kompas perangkat (DeviceOrientation) |
| Kalender | Jadwal + tanggal Hijriah sebulan penuh (tap tanggal untuk detail) |
| Al-Quran | Daftar surat, 6 qari, audio per ayat, mode karaoke per kata |
| Qadar & doa | Penanda malam ganjil Ramadan + 5 doa pilihan |
| PWA | Installable, offline (Service Worker), tema gelap/terang/otomatis |
| Push (opsional) | Firebase Cloud Messaging — nonaktif sampai `fcm-config.js` diisi |

---

## 📁 Struktur berkas

```
index.html                  # Markup + CSS (script dipisah ke app.js)
app.js                      # Seluruh logika aplikasi (IIFE, tanpa variabel global)
sw.js                       # Service Worker: cache offline, notifikasi, klik notifikasi
manifest.webmanifest        # Manifest PWA (id, shortcuts, ikon)
firebase-messaging-sw.js    # SW khusus FCM (mengimpor sw.js agar offline tetap jalan)
fcm-config.js               # Konfigurasi Firebase (default: null / nonaktif)
vercel.json                 # Header keamanan + aturan cache untuk Vercel
robots.txt                  # Izinkan crawler
icons/icon-192.png          # Ikon PWA
icons/icon-512.png
audio/adzan.mp3             # Adzan bawaan
audio/adzan-bilal.mp3       # Adzan Bilal
AUDIT.md                    # Hasil audit mendalam (temuan, perbaikan, rekomendasi)
```

> Tidak ada proses build. Ini situs statis murni — Vercel hanya perlu menyajikan berkas apa adanya.

---

## 🚀 Deploy ke Vercel

### Cara A — dari GitHub (paling mudah)

1. Buka <https://vercel.com/new> → **Import Git Repository** → pilih repo ini.
2. Pada layar konfigurasi:
   - **Framework Preset**: `Other`
   - **Root Directory**: `.` (bawaan)
   - **Build Command**: *kosongkan*
   - **Output Directory**: *kosongkan* (bawaan = root proyek)
   - **Install Command**: *kosongkan* (tidak ada dependensi)
3. Klik **Deploy**. Selesai — tidak ada environment variable yang wajib.

### Cara B — dari terminal (Vercel CLI)

```bash
npm i -g vercel        # sekali saja
cd waktusholat5waktu
vercel login
vercel                 # deploy preview (uji dulu)
vercel --prod          # deploy produksi
```

### Verifikasi setelah deploy

```bash
DOMAIN=https://<domain-anda>
curl -sI $DOMAIN | grep -iE 'content-security-policy|strict-transport|cache-control|x-content-type'
curl -s  $DOMAIN/manifest.webmanifest | head -5
curl -sI $DOMAIN/sw.js | grep -i 'service-worker-allowed'
```

Checklist manual:

- [ ] Chrome DevTools → **Application → Service Workers**: `sw.js` berstatus *activated*.
- [ ] **Application → Manifest**: nama, ikon 192/512, dan *Installability* hijau.
- [ ] Izin notifikasi & GPS muncul saat tombol diminta (butuh HTTPS — Vercel otomatis).
- [ ] **Lighthouse** (mode Mobile) → kategori PWA/Performance tanpa error fatal.
- [ ] Buka di HP Android: pasang ke layar utama, uji tombol **Uji notifikasi** & **Uji suara**.
- [ ] Cek header di <https://securityheaders.com> (harus muncul CSP, HSTS, dll).

### Setelan di `vercel.json`

| Berkas | Cache-Control | Alasan |
| --- | --- | --- |
| `index.html`, `/`, `app.js` | `max-age=0, must-revalidate` | agar rilis baru langsung terpakai |
| `sw.js`, `firebase-messaging-sw.js` | `no-store` + `Service-Worker-Allowed: /` | Service Worker wajib selalu segar |
| `manifest.webmanifest` | `max-age=3600` | jarang berubah |
| `*.png`, `*.mp3`, `*.svg` … | `max-age=604800, stale-while-revalidate` | hemat kuota, tetap bisa diperbarui |

Header keamanan yang dipasang: `Content-Security-Policy` (script hanya dari origin sendiri +
gstatic untuk FCM), `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, `Permissions-Policy` (geolocation/accelerometer/gyroscope/magnetometer
diizinkan untuk origin sendiri; kamera & mikrofon diblokir).

> Catatan: `Permissions-Policy` **wajib** mengizinkan `accelerometer`, `gyroscope`, dan
> `magnetometer` untuk origin sendiri — jika tidak, fitur kompas kiblat akan mati.

---

## 🔄 Pindahan dari Netlify (penting)

Aplikasi lama punya Service Worker yang menyimpan salinan offline di
`waktusholat5waktu.netlify.app`. Setelah pindah ke Vercel, pilih salah satu:

1. **Hapus situs Netlify** (paling sederhana) — pengguna lama akan otomatis memakai Vercel
   setelah membuka aplikasi dalam keadaan online.
2. **Alihkan 301 ke Vercel** — buat `netlify.toml` di situs Netlify:

   ```toml
   [[redirects]]
     from = "/*"
     to = "https://DOMAIN-VERCEL-ANDA.vercel.app/:splat"
     status = 301
     force = true
   ```

   Kecualikan `sw.js` bila ingin PWA lama memperbarui dirinya dari Netlify:
   tambahkan blok `[[redirects]]` sebelum blok di atas dengan
   `from = "/sw.js"`, `to = "/sw.js"`, `status = 200` (sama untuk `firebase-messaging-sw.js`),
   lalu deploy ulang berkas versi baru ini ke Netlify sekali.

3. Bagikan tautan Vercel ke pengguna, lalu pantau pemakaian Netlify sebelum dimatikan.

> PWA yang sudah terpasang dari domain Netlify tidak bisa "dipaksa" pindah domain dari sisi
> server; mereka akan memakai Vercel begitu membuka aplikasi dalam keadaan online
> (atau setelah tautan baru dibuka).

---

## 🔧 Konfigurasi

### Ganti suara adzan
Pengaturan → **Suara Pengingat** → *Jenis suara*: bawaan / Adzan Bilal / MP3 kustom (tempel URL
`https://…`).

### Metode perhitungan & mazhab
Pengaturan → **Metode Perhitungan**. Pilihan disimpan di `localStorage` dan dikirim sebagai
parameter `method` + `school` ke Aladhan API (0 = standar/Syafi'i, 1 = Hanafi).

### Push notification (opsional, butuh server sendiri)
1. Isi `fcm-config.js` dengan konfigurasi Firebase Anda (`apiKey`, `vapidKey`, `serverUrl`).
2. Server Anda harus menyediakan `POST {serverUrl}/register` untuk menerima token + preferensi.
3. Simpan kunci akun layanan Firebase di server (jangan pernah di dalam repo ini).
4. Tanpa langkah di atas aplikasi tetap berfungsi normal memakai notifikasi lokal.

---

## 🧪 Pengembangan lokal

Service Worker & notifikasi butuh secure context, jadi pakai `localhost`:

```bash
cd waktusholat5waktu
python3 -m http.server 8080      # lalu buka http://localhost:8080
```

Uji cepat berkas JS: `node --check app.js && node --check sw.js`.

---

## 🔒 Privasi

- Koordinat hanya dikirim ke penyedia data yang diperlukan: Aladhan (jadwal sholat),
  BigDataCloud & Nominatim (nama tempat), EQuran.id (Al-Quran).
- Preferensi (lokasi tersimpan, offset, tema, suara) hanya tersimpan di `localStorage` perangkat.
- Tidak ada analytics, pelacak iklan, atau cookie pihak ketiga.

---

## 📜 Lisensi & kredit data

- Jadwal sholat: [Al-Adhan / Aladhan API](https://aladhan.com) — gratis, tanpa kunci API.
- Teks & audio Al-Quran: [EQuran.id](https://equran.id).
- Pencarian kota: OpenStreetMap Nominatim · Nama tempat: BigDataCloud.
- Video adzan: YouTube (streaming resmi, tidak membundel berkas milik pihak ketiga).

Lihat `AUDIT.md` untuk daftar lengkap temuan audit & perbaikannya.
