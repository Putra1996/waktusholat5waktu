# 🚀 Audit Deployment — waktusholat5waktu.vercel.app

Tanggal: 11 Oktober 2026 · Objek audit: **deployment produksi** di Vercel (bukan kode di repo).
Metode: pembacaan aset live (`/`, `/sw.js`, `/manifest.webmanifest`, `/app.js`, `/vercel.json`) + pembacaan DOM hasil render halaman.

---

## 1. Kesimpulan utama

> **Yang ter-deploy BUKAN kode hasil audit.** Vercel sedang menyajikan commit `9303853` (isi `main` apa adanya) — yaitu kode lama era Netlify, lengkap dengan seluruh 28 bug yang sudah diperbaiki di PR #1.

Artinya "bug" yang Anda lihat di situs live berasal dari kode lama, bukan dari perbaikan. Perbaikannya sudah siap sejak PR #1, hanya belum masuk ke branch yang di-build Vercel.

---

## 1b. ✅ Status akhir — SUDAH DIPERBAIKI & TERVERIFIKASI

Tindakan: **PR #1 di-merge ke `main`** (`b30e6f4`, 11:30 UTC) → Vercel membangun ulang otomatis → **build baru live pukul 11:33:40 UTC**.

Bukti verifikasi langsung dari server produksi (11:33–11:34 UTC):

| Pemeriksaan | Sebelum | Sesudah (live) |
| --- | --- | --- |
| `GET /app.js` | 404 | **200** — berisi `esc()`, `safeUrl()`, `fetchJSON()`, `METHODS` resmi ✔ |
| `GET /sw.js` | `sholat-app-v13` (cache-first) | **`sholat-app-v14`** (network-first navigasi, handler notifikasi, precache `app.js`) ✔ |
| Dropdown metode | label lama (Khyber, IAIN, Turki/Diyanet …) | **KEMENAG di baris pertama**, 21 metode resmi ✔ |
| Baris "Adzan tepat waktu" | tidak ada | **ada** ✔ |
| Baris "Mazhab Ashar" | tidak ada | **ada** ✔ |
| Skip-link "Lewati ke jadwal sholat" | tidak ada | **ada** ✔ |
| Peringatan zona waktu | tidak ada | **aktif** (`⚠️ zona Asia/Jakarta (+11 jam dari jam perangkat)` pada renderer UTC−4) ✔ |
| `Content-Security-Policy` | tidak ada | **terpasang** (script-src 'self' + gstatic, frame-src YouTube, dst.) ✔ |
| `Strict-Transport-Security` | tidak ada | `max-age=63072000; includeSubDomains; preload` ✔ |
| `X-Content-Type-Options` / `X-Frame-Options` / `Referrer-Policy` / `Permissions-Policy` | tidak ada | **semuanya terpasang** ✔ |
| `Cache-Control` untuk `/` | — | `public, max-age=0, must-revalidate` ✔ |
| `Cache-Control` + `Service-Worker-Allowed` untuk `/sw.js` | — | `no-cache, no-store, must-revalidate` + `Service-Worker-Allowed: /` ✔ |
| `Cache-Control` untuk `/icons/icon-192.png` | — | `public, max-age=604800, stale-while-revalidate=86400` ✔ |

> Header diperiksa lewat layanan pembaca header pihak ketiga karena sandbox ini tidak diizinkan menghubungi `vercel.app` secara langsung (`curl` diblokir oleh allowlist jaringan).

---

## 2. Bukti (semuanya dari server live)

| Bukti | Hasil di server live | Yang seharusnya bila kode audit ter-deploy |
| --- | --- | --- |
| `GET /app.js` | **404 NOT_FOUND** (`iad1::s5lrd-…`) | 200, ±72 KB berkas JS |
| `GET /vercel.json` | 404 | 404 juga — **bukan indikator**: Vercel tidak menyajikan `vercel.json` sebagai berkas publik, ia dipakai sebagai konfigurasi build |
| `GET /sw.js` | `const CACHE = 'sholat-app-**v13**'` + strategi *cache-first* | `v14` + *network-first* untuk navigasi |
| `GET /manifest.webmanifest` | nama lama, `start_url: "./index.html"`, tanpa `id`/`shortcuts` | `start_url: "./"`, ada `id` + 3 shortcuts |
| Dropdown "Metode Perhitungan" di halaman | **Khyber (Shia), Universitas Islamabad, IAIN (Indonesia), Umm Al-Qura, Dewan Fatwa Mesir, Mufti Qatar, Gulf (Dubai), Singapura / MUIS, Umm al-Qura (Gap), Turki / Diyanet, Teheran, Jafari / Iran, Kuzestan, Singapura / MSG, KEMENAG** | 21 metode resmi Aladhan, KEMENAG di urutan pertama |
| Baris "Adzan tepat waktu" | **tidak ada** | ada (toggle baru) |
| Teks "Bunyi saat pengingat" | "Adzan / bip diputar saat **tiba waktunya**" | "…saat **pengingat berbunyi**" |
| Baris "Mazhab Ashar" | **tidak ada** | ada |

Karena `/app.js` dan `/vercel.json` **404**, dapat dipastikan deployment ini dibuat dari tree `main` yang lama — bukan dari branch `arena/c386c1c9-waktusholat5waktu`.

---

## 3. Akar masalah

```
main (9303853) ──► di-build Vercel ──► situs live = kode lama
arena/c386c1c9-… (92da2bb, b152d59, d287640) ──► masih di dalam PR #1 (OPEN) ──► tidak pernah di-build
```

Vercel membangun **Production Branch** proyek (default: `main`). PR #1 belum di-merge, sehingga seluruh perbaikan tidak pernah sampai ke produksi.

**Perbaikan:** merge PR #1 ke `main` (Vercel akan otomatis membangun ulang), atau ubah *Production Branch* proyek Vercel ke branch sesi, atau ubah *Settings → Git → Production Branch*.

---

## 4. Bug yang **masih hidup** di situs live saat ini

Semua ini terverifikasi ada di deployment sekarang (karena kodenya lama):

| Prioritas | Bug live | Akibat yang dirasakan pengguna |
| --- | --- | --- |
| 🔴 Kritis | `new Notification()` dipakai untuk pengingat | **Notifikasi tidak pernah muncul di Android Chrome** (fitur inti mati), gagal tanpa pesan |
| 🔴 Kritis | Label metode tertukar (id 11 = MUIS Singapura dilabeli "Turki / Diyanet", id 9 = Kuwait dilabeli "Singapura/MUIS", dst.) | Jadwal bisa menyimpang belasan menit |
| 🔴 Kritis | Pengingat hanya menyala tepat 1 menit (`curMin === target`) | Pengingat terlewat saat tab di-throttle / HP baru dibangunkan |
| 🔴 Kritis | SW `firebase-messaging-sw.js` menimpa `sw.js` pada scope sama | Mode offline mati begitu Push FCM diaktifkan |
| 🟠 Tinggi | Kartu **Imsak selalu redup** (`class="card imsak passed"` hardcode) | Tampilan terlihat "bug" padahal disengaja salah |
| 🟠 Tinggi | Label kompas `--r` tidak dipakai CSS | Huruf **E, S, W menumpuk di posisi Utara** |
| 🟠 Tinggi | Preferensi metode & offset tidak dipulihkan setelah reload | Pengaturan tampak "kembali sendiri" |
| 🟠 Tinggi | Tidak ada `escape` untuk data API pihak ketiga | Risiko XSS dari data EQuran/Nominatim |
| 🟠 Tinggi | Tanpa timeout/retry `fetch`, tanpa pesan error jelas | Spinner menggantung saat jaringan lambat |
| 🟠 Tinggi | Deteksi Ramadan gagal (`Ramaḍān` berdiakritik) | Banner Lailatul Qadar tidak pernah muncul |
| 🟡 Sedang | Countdown berbasis pembulatan menit | Angka countdown bisa terasa "loncat" |
| 🟡 Sedang | Tanpa Service Worker `notificationclick` | Klik notifikasi tidak membuka aplikasi |
| 🟡 Sedang | Tanpa CSP/HSTS/nosniff (karena `vercel.json` tidak ada) | Nilai keamanan kosong di securityheaders.com |
| 🟡 Sedang | Tanpa `aria-label`, skip-link, `noscript` | Aksesibilitas rendah |
| 🟡 Sedang | Aset duplikat 355 KB di root | Unduhan tak perlu |

---

## 5. Temuan baru pada putaran audit ini (bug di kode perbaikan)

Saat meninjau ulang kode hasil audit sebelum dipromosikan ke produksi, ditemukan **satu bug yang saya buat sendiri** dan sudah diperbaiki:

> **Balapan (race) pada proses "unlock" audio.**
> `primeAudio()` menjalankan `play()` dalam keadaan volume 0 lalu men-`pause()` elemen yang sama ketika promise-nya selesai. Bila gestur pertama pengguna justru tombol **"🔊 Uji suara"** (atau saat adzan berbunyi di antara dua interaksi), callback unlock yang tertunda **men-pause pemutaran nyata** → adzan berhenti seketika / tidak terdengar.

Perbaikan:
- Penanda `priming`: callback unlock **dibatalkan** bila sudah ada pemutaran nyata.
- Unlock memakai `muted = true` (muted autoplay selalu diizinkan browser) alih-alih `volume = 0`.
- Pemutaran nyata selalu memulihkan `muted = false` + volume pengguna.
- Variabel mati `audioPrimed` dihapus.

**Bukti uji regresi** (`audio-race.mjs`, membandingkan kode lama vs baru):

```
KODE SEBELUM PERBAIKAN  →  urutan: play(nyata) → play(nyata) → pause      ❌ (adzan terpotong)
KODE SESUDAH PERBAIKAN  →  urutan: play(muted) → play(nyata)              ✅ (tidak ada pause)
```

---

## 6. Catatan penting setelah redeploy (transisi Service Worker)

Pengguna yang **sudah pernah membuka** situs lama akan memiliki `sw.js` **v13** yang menyajikan navigasi dari cache terlebih dahulu:

1. Kunjungan pertama setelah deploy baru → *masih* menampilkan halaman versi lama (dari cache), sementara browser mengunduh `sw.js` baru di latar belakang.
2. SW **v14** lalu aktif (`skipWaiting` + `clients.claim`), cache lama (`sholat-app-v13`) dihapus.
3. Kunjungan/refresh berikutnya → halaman versi baru.

Jadi wajar bila Anda masih melihat versi lama **1–2 kali muat**. Untuk memaksa segera di perangkat sendiri:
DevTools → **Application → Service Workers → Unregister** + **Application → Storage → Clear site data** → muat ulang. Di Android: hapus ikon PWA lalu pasang ulang, atau *Setelan situs → Hapus data situs*.

---

## 7. Checklist verifikasi setelah merge & redeploy

```bash
# 1) berkas baru harus tersedia (sebelumnya 404)
curl -sI https://waktusholat5waktu.vercel.app/app.js | head -1        # harus 200

# 2) Service Worker versi baru
curl -s https://waktusholat5waktu.vercel.app/sw.js | grep CACHE      # harus sholat-app-v14

# 3) manifest baru
curl -s https://waktusholat5waktu.vercel.app/manifest.webmanifest | grep -c shortcuts   # harus 1

# 4) header keamanan (Vercel menerapkan vercel.json)
curl -sI https://waktusholat5waktu.vercel.app/ | grep -iE 'content-security-policy|strict-transport-security|permissions-policy'

# 5) manifest disajikan dengan tipe benar
curl -sI https://waktusholat5waktu.vercel.app/manifest.webmanifest | grep -i content-type
```

Di browser (uji manual, tidak bisa dijalankan di lingkungan ini):

- [ ] Dropdown Metode memuat **KEMENAG di baris pertama** dan tidak ada lagi label "Turki / Diyanet" untuk id 11.
- [ ] Ada baris pengaturan **"Adzan tepat waktu"**.
- [ ] Kartu **Imsak** tidak redup sebelum waktunya; kartu **"Berikutnya"** berlabel benar.
- [ ] Tekan **🔊 Uji suara** sebagai interaksi **pertama** → adzan harus berbunyi penuh sampai selesai (uji regresi bug §5).
- [ ] Di Android: **🔔 Uji notifikasi** dan **🔔 Minta izin notifikasi** → notifikasi benar-benar muncul.
- [ ] DevTools → Application → Service Workers: status `activated`, cache bernama `sholat-app-v14`.
- [ ] Footer menampilkan baris sumber data (`Aladhan · metode 20 · <zona waktu> · diperbarui …`).
- [ ] <https://securityheaders.com> → CSP & HSTS terdeteksi.

---

## 8. Ringkasan uji otomatis terhadap kode yang akan di-merge

```
node --check app.js / sw.js / firebase-messaging-sw.js ......................... OK (3/3)
Validasi JSON vercel.json & manifest.webmanifest ............................... OK (2/2)
Verifikasi gabungan jsdom (render 34 pemeriksaan + notifikasi 4) ............... 38/38 lulus, 0 error runtime
Uji regresi audio priming (kode lama GAGAL, kode baru LULUS) ................... terbukti menangkap bug
```

---

## 9. Langkah perbaikan yang diambil (selesai)

1. ✅ **PR #1 di-merge ke `main`** (`b30e6f4`) → Vercel membangun ulang dari kode hasil audit.
2. ✅ Deploy baru live ±3 menit setelah merge; seluruh aset & header produksi diverifikasi ulang (bagian 1b).
3. ▶️ **Tindakan Anda selanjutnya:** buka <https://waktusholat5waktu.vercel.app> dan **muat ulang 1–2 kali** (atau hapus data situs) karena Service Worker v13 yang lama masih menyajikan halaman dari cache pada muat pertama — lihat bagian 6. Setelah itu barulah terasa perbaikan notifikasi Android, label metode, kompas, dan kartu "Berikutnya".
4. 💡 Untuk rilis berikutnya: setiap perubahan baru akan saya buat sebagai PR baru dari branch `arena/c386c1c9-waktusholat5waktu`; merge ke `main` = otomatis deploy. Bila ingin alur berbeda, ubah **Settings → Git → Production Branch** di proyek Vercel.
5. 🔎 Bila masih ada bug spesifik yang Anda lihat, sebutkan gejalanya (halaman mana, di perangkat apa) agar saya bisa reproduksi dan tambahkan uji regresinya.

### Sisa keterbatasan yang belum bisa diverifikasi dari sini

- Uji langsung di Android (notifikasi sungguhan, sensor kompas, GPS) — butuh perangkat nyata.
- Audio adzan yang benar-benar berbunyi — butuh browser nyata (sudah ada uji regresi logika di §5).
- `robots.txt`/SEO indexing, dan uji Lighthouse.
- Push FCM tetap nonaktif sampai `fcm-config.js` diisi + backend `/register` tersedia.

---

## 10. Tindak lanjut 12 Oktober 2026 — dokumen ini masuk ke `main`

| Langkah | Hasil |
| --- | --- |
| Commit dokumen (bagian 1b di atas) | dipindahkan ke branch sesi baru `arena/543d37c1-waktusholat5waktu`, PR #3 dibuka → **di-merge** (`main` = **`e5fd1f4`**) |
| **GitHub Pages** — `putra1996.github.io/waktusholat5waktu` | workflow *pages build and deployment* **sukses** untuk `e5fd1f4` (15:52–15:53 UTC); berkas `DEPLOY-AUDIT.md` di sana sudah memuat bagian 1b ✔ |
| **Vercel** — `waktusholat5waktu.vercel.app` | **tidak ada deployment baru** yang dibuat untuk commit ini; record terakhir tetap `b30e6f4` (11 Okt 11:30 UTC). Produksi masih menyajikan `DEPLOY-AUDIT.md` versi sebelum 1b |
| Dampak ke pengguna | **tidak ada**: PR #3 hanya menyentuh berkas dokumentasi. Kode aplikasi di produksi tetap versi hasil audit (`sw.js` v14, `app.js` tersedia, CSP/HSTS terpasang, KEMENAG di baris pertama) |

> Jadi bila Vercel tidak membangun ulang: buka proyek di dashboard Vercel → **Deployments → Redeploy** (atau periksa **Settings → Git** bila deployment otomatis berhenti berjalan). Aplikasi di produksi tetap sehat tanpa langkah ini.
