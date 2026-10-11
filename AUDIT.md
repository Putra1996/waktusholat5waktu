# 🔍 Audit Mendalam — Sholat App (PWA)

Tanggal audit: 11 Oktober 2026 · Basis kode: commit `9303853` (sebelum perubahan) → hasil perbaikan ada di commit setelahnya.
Ruang lingkup: **seluruh berkas** (`index.html`, `sw.js`, `manifest.webmanifest`, `firebase-messaging-sw.js`, `fcm-config.js`, aset ikon/audio) + migrasi deploy dari Netlify ke Vercel.

---

## 1. Ringkasan eksekutif

| Aspek | Sebelum | Sesudah |
| --- | --- | --- |
| Notifikasi di Android (fitur inti) | ❌ tidak pernah tampil (`new Notification()` tidak didukung Chrome Android, error ditelan `try/catch`) | ✅ memakai `registration.showNotification()` dari Service Worker |
| Ketepatan label metode perhitungan | ❌ banyak label tertukar (mis. pilihan "Turki/Diyanet" memanggil metode Singapura) | ✅ mengikuti daftar resmi Aladhan (diverifikasi 2 sumber independen) |
| Ketahanan pengingat | ⚠️ terlewat bila tab di-throttle browser / HP baru dibangunkan | ✅ jendela susulan 15 menit + refresh saat aplikasi aktif |
| Mode offline saat push FCM aktif | ❌ Service Worker offline tertimpa & mati | ✅ FCM SW mengimpor `sw.js` |
| Keamanan (XSS, CSP, header) | ⚠️ data pihak ketiga di-`innerHTML` mentah, tanpa header keamanan | ✅ escape menyeluruh, CSP + HSTS + `nosniff` + Permissions-Policy |
| Aksesibilitas | ⚠️ tombol ikon tanpa label, tab tanpa status, tanpa skip-link | ✅ `aria-*`, skip-link, `noscript`, focus-visible, reduced-motion |
| Struktur berkas | 1 berkas HTML 86 KB berisi CSS + JS inline | `index.html` 38 KB + `app.js` terpisah (CSP ketat & cache terpisah) |
| Deploy | Netlify | ✅ Vercel (`vercel.json`) + dokumen migrasi |
| Uji otomatis | tidak ada | ✅ 31/31 uji render (jsdom) + 5/5 uji notifikasi, 0 error runtime |

Total temuan: **28** (4 kritis, 12 tinggi, 12 sedang/rendah) — **semuanya diperbaiki**, sisa keterbatasan didaftarkan sebagai roadmap di bagian 12.

---

## 2. Metode audit

1. **Pembacaan kode penuh** seluruh 1.774 baris `index.html` (CSS + JS inline) dan 3 berkas Service Worker/manifest.
2. **Pencarian pola berisiko**: `innerHTML`, `localStorage`, `fetch`, `new Notification`, `eval`, event listener, ID yang dirujuk JS vs yang ada di HTML, referensi aset.
3. **Verifikasi silang data eksternal**: daftar metode Aladhan dicek ke dokumentasi OpenAPI resmi dan ke implementasi klien pihak ketiga (`Khiro95/Awqat-Salaat`, `AlAdhanMethod.cs`) → mengungkap salah label pada aplikasi.
4. **Uji runtime otomatis (jsdom)**: memuat `index.html` + `app.js` dengan API tiruan, lalu memverifikasi render jadwal, tab, kalender, kiblat, karaoke, dan jalur notifikasi (0 error runtime).
5. **Uji statis**: `node --check` 4 berkas JS, validasi JSON, pengecekan keberadaan semua aset yang dirujuk HTML & daftar precache SW, pencocokan 84 ID yang dipakai JS dengan 93 ID di HTML.
6. **Uji kontras warna** WCAG untuk token warna utama.

---

## 3. Temuan kritis (fitur inti)

### K1 — Notifikasi tidak pernah muncul di Android Chrome
**Bukti:** `checkNotifications()` dan `testNotifBtn` memakai `new Notification(...)`.
Di Chrome Android, konstruktor `Notification` **tidak diimplementasikan** (spesifikasi hanya mewajibkannya lewat Service Worker), sehingga baris tersebut melempar `TypeError`. Karena dibungkus `try { } catch(e){}`, kegagalan terjadi **diam-diam** — pengguna merasa aplikasi "sudah diatur" padahal tidak ada notifikasi.
**Perbaikan:** helper `showNotification()` memakai `navigator.serviceWorker.ready → registration.showNotification()` (dengan fallback konstruktor untuk desktop lama), dipakai untuk pengingat, adzan tepat waktu, pengingat harian, uji notifikasi, dan pesan FCM foreground.

### K2 — Label metode perhitungan sholat tertukar (jadwal bisa menyimpang)
**Bukti:** peta lama menulis `11:'Turki / Diyanet'`, `9:'Singapura / MUIS'`, `2:'IAIN (Indonesia)'`, `3:'Umm Al-Qura'`, `4:'Dewan Fatwa Mesir'`, `13:'Jafari / Iran'`.
Berdasarkan dokumentasi resmi Aladhan dan `AlAdhanMethod.cs` (Khiro95/Awqat-Salaat): **11 = MUIS Singapura**, **9 = Kuwait**, **2 = ISNA**, **3 = Muslim World League**, **4 = Umm Al-Qura Makkah**, **13 = Diyanet Turki**, **20 = KEMENAG** (ini satu-satunya yang benar).
Akibatnya pengguna yang memilih "Turki/Diyanet" mendapat metode Singapura, dan seterusnya — selisih Subuh/Isya bisa belasan menit.
**Perbaikan:** daftar diganti dengan urutan resmi (21 metode, KEMENAG di urutan pertama), ditambah tautan "detail metode" di Pengaturan.

### K3 — Service Worker FCM "menimpa" Service Worker offline
**Bukti:** `initFCM()` memanggil `navigator.serviceWorker.register('firebase-messaging-sw.js')` pada **scope yang sama** (`/`) dengan `sw.js`. Registrasi scope yang sama menggantikan worker aktif; berkas FCM lama tidak punya handler `fetch`, sehingga seluruh mode offline hilang begitu FCM diaktifkan.
**Perbaikan:** `firebase-messaging-sw.js` kini `importScripts('./sw.js')` di baris pertama → kemampuan cache offline tetap utuh.

### K4 — Pengingat mudah terlewat permanen
**Bukti:** `checkNotifications()` hanya menyala bila `curMin === target` (tepat pada satu menit). Browser men-throttle timer tab latar (Chrome: 1×/menit, bisa lebih jarang), dan HP yang "tidur"/aplikasi di-resume membuat tick terlewat → notifikasi hilang untuk hari itu.
**Perbaikan:** jendela susulan 15 menit (`target ≤ sekarang ≤ waktu sholat`), anti-duplikat per hari yang **dipersist** di `localStorage`, penyegaran saat `visibilitychange`/`focus`/`online`, serta adzan tepat waktu yang juga punya jendela susulan (tanpa membunyikan adzan terlambat).

---

## 4. Temuan tinggi

| # | Temuan | Bukti | Perbaikan |
| --- | --- | --- | --- |
| T1 | Service Worker menangani **semua metode** termasuk `POST` | Handler `fetch` lama tidak memfilter metode; untuk `POST /register` saat cache-miss, `caches.match()` mengembalikan `undefined` → `respondWith(undefined)` = request gagal | Hanya `GET` ditangani; `POST` langsung ke jaringan |
| T2 | Navigasi memakai **cache-first** | Halaman lama tetap tampil setelah rilis baru (harus muat 2×) | **network-first** untuk navigasi (timeout 4 s) + fallback cache |
| T3 | Daftar precache tidak memuat berkas baru & `addAll` rapuh | `addAll()` gagal total bila 1 berkas gagal | Ditambah `app.js`; precache per berkas (tahan gagal sebagian); `CACHE` naik `v13 → v14` |
| T4 | `localStorage` tanpa penanganan error | Mode privat/kuota penuh → `save()` melempar dan menghentikan alur | `try/catch` di `save()`/`load()`, ditambah `saveSoon()` (debounce 400 ms) |
| T5 | **XSS/HTML injection** dari data pihak ketiga | Nama lokasi (Nominatim/BigDataCloud), teks surat & ayat, serta label Hijriah dimasukkan lewat `innerHTML` mentah | Helper `esc()` dipakai pada semua titik injeksi; `safeUrl()` memvalidasi URL MP3 kustom & `serverUrl` FCM (hanya http/https) |
| T6 | Parsing waktu rapuh | `t.substring(0,5)` mengasumsikan selalu `HH:MM` | `parseHM()` berbasis regex (`4:32`, `04:32 (WIB)` tetap benar) |
| T7 | Tidak ada timeout/retry pada `fetch` | Jaringan lambat → spinner menggantung tanpa batas | `fetchJSON()` dengan `AbortController` (12–20 s), 1× retry, pesan error jelas + tombol "Coba lagi" pada daftar surat/ayat |
| T8 | Deteksi bulan Ramadan selalu gagal | Aladhan mengembalikan `"Ramaḍān"` (berdiakritik) → `includes('ramad')` tidak cocok, banner Lailatul Qadar tidak pernah tampil | Helper `fold()` (normalisasi NFD) sebelum pencocokan |
| T9 | Kartu Imsak selalu redup | Markup `class="card imsak passed"` ditulis hardcode, sementara `tick()` mengecualikan Imsak | Class dihapus, status redup mengikuti waktu |
| T10 | Kompas: huruf E/S/W menumpuk di Utara | CSS `.c-tick` tidak pernah memakai variabel `--r` | Rotasi `--r` + teks di-counter-rotate agar tetap tegak |
| T11 | Preferensi tidak pulih setelah reload | `load()` tidak mengeset `methodSel`; offset tersimpan tidak dirender ulang | `load()` memulihkan metode/mazhab/offset + memanggil `renderOffsets()` |
| T12 | Tanpa fallback GPS | `enableHighAccuracy` gagal → hanya pesan error | Percobaan kedua mode hemat (`maximumAge` 5 menit) sebelum menyerah |

---

## 5. Temuan sedang & rendah

| # | Temuan | Perbaikan |
| --- | --- | --- |
| S1 | Countdown berbasis pembulatan menit (bisa loncat/aneh saat pergantian) | Dihitung dari `Date` target secara presisi detik (`fmtDuration(ms)`) |
| S2 | `getJadwal()` mengubah `document.title` menjadi "memuat…" dan tidak dipulihkan bila gagal | Diarahkan ke indikator `#dataInfo` (sumber, metode, zona, waktu perbarui) + peringatan bila data kedaluwarsa |
| S3 | Teks notifikasi "sholat Imsak" (Imsak bukan sholat) | Kalimat khusus imsak; ditambah fitur **adzan tepat waktu** (toggle, default aktif) |
| S4 | Input `type=time`, `type=url`, `type=range` tidak bergaya & tidak ikut tema | Aturan CSS ditambah + `color-scheme: dark light` |
| S5 | Karaoke membalik urutan kata di DOM untuk menipu LTR | Urutan alami + `.k-verse{direction:rtl}`; `lang="ar"` & `dir="rtl"` pada teks Arab |
| S6 | Elemen hint kiblat tidak punya `id` yang dicari JS → pesan tak pernah tampil | `id="qiblaHint"` + pesan untuk perangkat tanpa sensor/izin ditolak |
| S7 | Slider volume menulis `localStorage` setiap event `input` | `saveSoon()` (debounce) |
| S8 | `Intl.DateTimeFormat` dibuat ulang **setiap detik** | Formatter dibuat sekali (hemat CPU/baterai) |
| S9 | Tidak ada penanganan online/offline | Toast "offline/online" + penyegaran jadwal saat kembali online |
| S10 | `<audio>` memakai `preload="auto"` sejak awal (77 KB terunduh tiap kunjungan) dan bisa diblokir autoplay | `preload="none"` + "unlock" audio pada interaksi pertama (`primeAudio`) |
| S11 | Manifest kurang lengkap | Ditambah `id`, `display_override`, `shortcuts` (Al-Quran/Qadar/Lokasi), `prefer_related_applications`, `dir`, `start_url: "./"` |
| S12 | Tidak ada meta SEO/Open Graph/canonical | Ditambah OG/Twitter + `canonical` & `og:url`/`og:image` diisi runtime dari origin (aman di domain apa pun) |
| S13 | Aset duplikat di root (ikon & 2 MP3, 355 KB) | Dihapus setelah dipastikan identik (md5) dan tidak lagi dirujuk |
| R1 | Kode mati (`quranListView`, `getHijriToday`, variabel `sel`) | Dihapus |
| R2 | Ruang lingkup: font Arab (`Amiri`) dirujuk tapi tidak dimuat | Dicatat sebagai roadmap (butuh keputusan ukuran unduhan) |

---

## 6. Keamanan

- **CSP** ditambahkan di `vercel.json`: `default-src 'self'`; `script-src 'self' https://www.gstatic.com`;
  `connect-src` dibatasi ke Aladhan, EQuran, BigDataCloud, Nominatim, dan endpoint Firebase;
  `frame-src` hanya YouTube; `object-src 'none'`; `base-uri 'none'`; `form-action 'none'`;
  `frame-ancestors 'self'`; `upgrade-insecure-requests`.
  Ini **dimungkinkan** karena script inline dipindah ke `app.js` (sebelumnya tidak mungkin tanpa `'unsafe-inline'`).
  Sisa: `style-src` masih `'unsafe-inline'` karena ada 53 atribut `style="…"` di markup → roadmap.
- **Header lain**: `Strict-Transport-Security` (2 tahun, preload), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy` (kamera/mikrofon/pembayaran diblokir; **sensor gerak & geolokasi tetap diizinkan** agar kiblat/GPS tidak mati).
- **Tanpa COEP/COOP ketat** secara sengaja: `Cross-Origin-Embedder-Policy: require-corp` akan mematikan
  iframe YouTube dan audio CDN pihak ketiga.
- **Rahasia**: `firebase-messaging-sw.js` mengimpor `fcm-config.js` (kunci web FCM memang publik),
  tetapi **service account** tidak boleh ada di repo → sudah masuk `.gitignore` (`serviceAccountKey.json`, `.env*`).
- Tidak ada `target="_blank"` tanpa `rel="noopener noreferrer"`; tidak ada `eval`/`document.write`
  (fungsi masuk DILARANG ini tidak ada di kode); tidak ada cookie maupun pelacak.

---

## 7. Performa

- `index.html` turun dari 86 KB → 38 KB; `app.js` (71 KB) kini punya entri cache sendiri sehingga
  pembaruan UI tidak memaksa unduh ulang seluruh logika.
- `preconnect`/`dns-prefetch` ke 5 host API (handshake lebih awal).
- Formatter tanggal/waktu tidak lagi dibuat ulang tiap detik; DOM kartu hanya diperbarui bila perlu.
- Audio adzan tidak lagi diunduh sebelum diperlukan; video YouTube memakai `youtube-nocookie.com` (privasi + menghindari cookie pihak ketiga sampai diputar).
- Cache aset statis 7 hari + `stale-while-revalidate`; HTML/JS `must-revalidate` agar rilis baru cepat sampai.

---

## 8. Aksesibilitas

- Tombol ikon diberi `aria-label`; tab diberi `aria-pressed`; panel ditandai `aria-hidden` saat tertutup.
- Toast `role="status" aria-live="polite"`; info kiblat `aria-live="polite"`; kompas `aria-hidden="true"` (informasinya tersedia sebagai teks).
- Skip-link "Lewati ke jadwal sholat", `<noscript>` dengan penjelasan, `:focus-visible` yang jelas,
  dukungan `prefers-reduced-motion`.
- Semua input memiliki label (label pembungkus atau `aria-label` pada input offset/cari).
- Kontras terverifikasi: teks sekunder `#8b93b0` pada `#0b1020` = **6,2:1** (lulus WCAG AA),
  aksen `#34d399` pada latar gelap = **9,9:1**.

---

## 9. PWA & Service Worker

- Strategi baru: navigasi **network-first** (fallback cache `index.html`), aset lokal **stale-while-revalidate**,
  API pihak ketiga **network-first** (fallback cache → jadwal/terjemahan tetap ada saat offline),
  origin lain (YouTube/gstatic) tidak di-cache, permintaan **Range** (streaming audio) dilewatkan.
- Cache lama dihapus otomatis saat `activate` (naik versi `v13 → v14`).
- `notificationclick` memfokuskan jendela aplikasi (atau membukanya) — sebelumnya klik notifikasi tidak melakukan apa pun.
- Handler `message` `SKIP_WAITING` tersedia agar pembaruan bisa dipicu dari halaman bila diinginkan.

---

## 10. Akurasi & catatan fiqh

- **Mazhab Ashar** kini bisa dipilih (Standar/Hanafi) dan dikirim sebagai parameter `school` — sebelumnya selalu standar.
- **Zona waktu**: bila kota yang dipilih berada di zona waktu berbeda dari jam perangkat, UI menampilkan peringatan (mis. "⚠️ zona Asia/Jakarta (+7 jam dari jam perangkat)") agar countdown tidak menyesatkan.
- **Ihtiyati Kemenag (±2 menit)**: jadwal Aladhan tidak otomatis menambahkan ihtiyati seperti jadwal resmi Kemenag; disarankan menyesuaikan lewat offset pengingat. Sudah dicatat di UI Pengaturan.
- **Lailatul Qadar**: penanda malam ganjil (21/23/25/27/29) dihitung pada tanggal Hijriah berjalan; secara syar'i malam dimulai setelah Maghrib — teks UI kini menjelaskan hal ini.

---

## 11. Privasi

- Lokasi hanya dipakai untuk perhitungan jadwal & dikirim ke penyedia yang diperlukan (Aladhan, BigDataCloud, Nominatim).
- Data preferensi hanya di `localStorage`; tidak ada server pihak ketiga milik aplikasi, tanpa analytics.
- FCM (opsional) mengirim token + preferensi **ke server milik pemilik aplikasi** (`serverUrl`), bukan ke pihak lain; nonaktif selama `fcm-config.js` bernilai `null`.

---

## 12. Keterbatasan & roadmap (belum dikerjakan)

1. **Push FCM belum diuji end-to-end** — butuh project Firebase + backend `/register`; repo ini belum menyertakan backend.
2. **Uji perangkat nyata** belum bisa dijalankan di lingkungan ini (tanpa browser); sudah disediakan checklist di `README.md`.
3. **`style-src` belum bisa diperketat** — perlu memindahkan CSS ke berkas terpisah dan menghapus 53 atribut `style="…"`, lalu ganti ke kelas utilitas.
4. **Font Arab** belum di-self-host (Amiri/Noto Naskh) sehingga tampilan ayat bergantung font sistem.
5. **Karaoke** masih memakai estimasi waktu proporsional per kata (bukan timestamp per kata); bisa ditingkatkan dengan data timing per ayat.
6. **Ihtiyati Kemenag** bisa dijadikan opsi otomatis (+2 menit) alih-alih catatan manual.
7. **`screenshots` pada manifest** belum ada (butuh tangkapan layar asli) — akan meningkatkan kualitas "rich install".
8. **Sitemap XML** belum dibuat karena domain final belum ditentukan.
9. **File `netlify.toml`** sengaja tidak ditambahkan otomatis (agar tidak salah mengalihkan domain); contohnya ada di `README.md` bagian "Pindahan dari Netlify".

---

## 13. Hasil pengujian

```
node --check app.js / sw.js / firebase-messaging-sw.js / fcm-config.js ......... OK (4/4)
Validasi JSON vercel.json & manifest.webmanifest .............................. OK (2/2)
Referensi aset lokal di index.html ............................................ OK (0 hilang)
Daftar precache Service Worker ................................................ OK (0 hilang)
ID yang dipakai JS vs ID di HTML .............................................. OK (84 vs 93, hanya 2 ID dinamis)
Uji render jsdom (jadwal, tab, Quran, karaoke, kalender, kiblat, tema) ........ 31/31 lulus, 0 error runtime
Uji notifikasi (jalur registration.showNotification) .......................... 5/5 lulus
```

Uji notifikasi nyata yang tertangkap: `⏰ Subuh 10 menit lagi` — `tag` anti-duplikat `20261011_Subuh`.

---

## 14. Berkas yang berubah pada audit ini

| Berkas | Status | Keterangan |
| --- | --- | --- |
| `app.js` | **baru** | seluruh logika aplikasi (dipisah dari HTML) + perbaikan K1–K4, T1–T12, S1–S10 |
| `index.html` | diubah | CSP-friendly (tanpa script inline), meta SEO/OG, aksesibilitas, perbaikan CSS, baris pengaturan baru |
| `sw.js` | ditulis ulang | cache v14, network-first navigasi, filter non-GET/Range, notifikasi klik |
| `firebase-messaging-sw.js` | diubah | mengimpor `sw.js` + inisialisasi Firebase yang aman |
| `manifest.webmanifest` | diubah | `id`, `display_override`, `shortcuts`, `start_url` |
| `vercel.json` | **baru** | header keamanan + aturan cache untuk Vercel |
| `robots.txt`, `.vercelignore`, `.gitignore` | **baru** | kesiapan produksi |
| `README.md` | **baru** | panduan deploy Vercel, konfigurasi, verifikasi, migrasi Netlify |
| `AUDIT.md` | **baru** | dokumen ini |
| `adzan.mp3`, `adzan-bilal.mp3`, `icon-192.png`, `icon-512.png` (root) | dihapus | duplikat md5-identik & tidak dirujuk (versi kanonik ada di `audio/` dan `icons/`) |
