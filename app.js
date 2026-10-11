/* =====================================================================
   SHOLAT APP — PWA realtime  (app.js)
   - Jadwal realtime via koordinat (presisi GPS tinggi)
   - Notifikasi pengingat yang bisa diatur (menit sebelum sholat)
   - Adzan tepat waktu, mengaji Al-Quran, kiblat, kalender, qadar
   - Mode gelap / terang / otomatis

   Catatan arsitektur:
   - Kode dipisah dari index.html agar bisa dipasang CSP ketat
     (script-src 'self') dan mudah di-cache/versi-kan oleh Service Worker.
   - Ditulis sebagai satu IIFE agar tidak mencemari window global.
   ===================================================================== */
(function () {
'use strict';

const $ = id => document.getElementById(id);

/* ---------- Util umum ---------- */
// Escape teks tak terpercaya sebelum dimasukkan ke innerHTML.
// Dipakai untuk data dari API pihak ketiga (equran.id, Nominatim) & nama lokasi.
function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
// Amankan URL sebelum dipakai sebagai src/href (hanya http/https).
function safeUrl(u){
  try {
    const url = new URL(String(u).trim(), location.href);
    return (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : '';
  } catch (e) { return ''; }
}
// "04:05", "4:05", "04:05 (WIB)" -> "04:05"  (lebih aman dari substring)
function parseHM(v){
  const m = String(v == null ? '' : v).match(/(\d{1,2}):(\d{2})/);
  if (!m) return '';
  const h = Math.min(23, parseInt(m[1], 10));
  return String(h).padStart(2, '0') + ':' + m[2];
}
// Buang diakritik: "Ramaḍān" -> "ramadan" (untuk deteksi bulan Hijriah)
function fold(s){
  return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/* ---------- Fetch tahan banting (timeout + 1x retry) ---------- */
async function fetchJSON(url, { timeout = 12000, retry = 1, headers } = {}){
  let lastErr;
  for (let attempt = 0; attempt <= retry; attempt++){
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers, cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(t);
    }
    if (attempt < retry) await new Promise(r => setTimeout(r, 800));
  }
  throw lastErr || new Error('Gagal memuat data');
}

/* ---------- Zona waktu ---------- */
// Offset (menit) sebuah zona IANA pada saat tertentu; null bila tak diketahui.
function tzOffsetMinutes(tz, at = new Date()){
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' });
    const part = fmt.formatToParts(at).find(p => p.type === 'timeZoneName');
    const m = part && part.value.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!m) return (part && part.value === 'GMT') ? 0 : null;
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] || '0', 10));
  } catch (e) { return null; }
}
const deviceTZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } })();

/* ---------- Pemutar media aman ---------- */
// play() selalu mengembalikan Promise di browser modern, tetapi sebagian
// WebView/browser lama mengembalikan undefined -> jangan sampai error tak tertangkap.
function safePlay(el, onFail){
  try {
    const p = el.play();
    if (p && typeof p.then === 'function') p.catch(() => { if (onFail) onFail(); });
  } catch (e) { if (onFail) onFail(); }
}

/* ---------- Notifikasi (kompatibel Android) ---------- */
// Di Android Chrome, `new Notification()` TIDAK didukung (melempar TypeError).
// Satu-satunya cara yang andal: registration.showNotification() dari Service Worker.
function notifSupported(){ return ('Notification' in window) && ('serviceWorker' in navigator); }
async function showNotification(title, opts = {}){
  if (!notifSupported() || Notification.permission !== 'granted') return false;
  const options = {
    body: opts.body || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: opts.tag || 'sholat',
    renotify: !!opts.renotify,
    requireInteraction: !!opts.requireInteraction,
    silent: !!opts.silent,
    data: { url: opts.url || './' },
    vibrate: opts.vibrate || [200, 100, 200],
  };
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(title, options);
    return true;
  } catch (e) {
    // Fallback desktop/browser lama yang masih mendukung konstruktor.
    try { new Notification(title, options); return true; } catch (e2) { return false; }
  }
}

/* ---------- State ---------- */
const state = {
  coords: null,        // {lat,lng}
  method: 20,          // default KEMENAG
  school: 0,           // 0 = Standar (Syafi'i/Maliki/Hanbali), 1 = Hanafi (Ashar)
  locName: null,
  accuracy: null,
  tz: null,            // zona waktu lokasi (dari API), mis. "Asia/Jakarta"
  jadwal: {},          // nama -> waktu "HH:MM"
  todayKey: null,      // YYYY-MM-DD
  hijriInfo: null,     // {day, monthEn, monthAr, year, monthNum}
  notifyOn: true,
  offsets: { Imsak:10, Subuh:10, Dzuhur:10, Ashar:10, Maghrib:10, Isya:10 },
  notifSent: {},       // key YYYYMMDD_Subuh (dipersist agar tidak dobel setelah reload)
  adzanAtTime: true,   // bunyikan adzan + notifikasi tepat saat masuk waktu sholat
  theme: 'auto',
  soundOn: true,       // bunyi adzan/bip saat pengingat
  soundType: 'adzan',  // 'adzan' (bawaan) | 'adzanBilal' (adzan Bilal) | 'beep' | 'custom' (URL sendiri)
  volume: 0.8,
  adzanUrl: '',        // URL MP3 adzan tarannum sendiri (opsional)
  savedLocations: [],  // multi-kota: [{name, lat, lng, tz}]
  quranReciter: '05',  // qari mengaji (index equran.id): 01..06
  dailyReminders: [],  // pengingat harian: [{time:'HH:MM'}]
  remSent: {},         // pengingat harian yang sudah terkirim (per tanggal)
  fcmToken: null,      // token push FCM (bila dikonfigurasi)
};

const PRAYERS = [
  { key:'Subuh', em:'🌅' },
  { key:'Dzuhur', em:'☀️' },
  { key:'Ashar', em:'🌤️' },
  { key:'Maghrib', em:'🌇' },
  { key:'Isya', em:'🌙' },
];

/* Daftar metode resmi Aladhan (aladhan.com/calculation-methods).
   AUDIT: peta lama salah label — mis. id 11 ("Turki/Diyanet") sebenarnya
   MUIS Singapura dan id 9 ("Singapura/MUIS") sebenarnya Kuwait. */
const METHODS = [
  [20, 'KEMENAG — Indonesia (Kemenag RI)'],
  [3,  'Muslim World League (MWL) — global'],
  [2,  'ISNA — Amerika Utara'],
  [1,  'Univ. of Islamic Sciences, Karachi — Pakistan'],
  [4,  'Umm Al-Qura — Makkah'],
  [5,  'Egyptian General Authority of Survey — Mesir'],
  [11, 'MUIS — Singapura'],
  [17, 'JAKIM — Malaysia'],
  [13, 'Diyanet İşleri Başkanlığı — Turki'],
  [9,  'Kuwait'],
  [10, 'Qatar'],
  [8,  'Gulf Region'],
  [16, 'Dubai (tidak resmi)'],
  [15, 'Moonsighting Committee Worldwide'],
  [6,  'Institute of Geophysics, Univ. of Tehran'],
  [18, 'Tunisia'],
  [19, 'Aljazair'],
  [21, 'Maroko'],
  [22, 'Comunidade Islâmica de Lisboa'],
  [23, 'Ministry of Awqaf — Yordania'],
  [0,  'Ja\'fari / Syiah Itsna Asyari'],
];
const SCHOOLS = [ [0, 'Standar (Syafi\'i, Maliki, Hanbali)'], [1, 'Hanafi (Ashar lebih sore)'] ];

/* =====================================================================
   PERSISTENSI
   ===================================================================== */
// Simpan data penting. pruneNotif() mencegah state tumbuh tanpa batas.
function pruneSent(obj, dayKey){
  const out = {};
  const today = dayKey.replace(/-/g,'');
  for (const k of Object.keys(obj || {})){
    if (String(k).startsWith(today)) out[k] = obj[k];
  }
  return out;
}
const save = () => {
  try {
    const dayKey = todayKey();
    state.notifSent = pruneSent(state.notifSent, dayKey);
    state.remSent = pruneSent(state.remSent, dayKey);
    localStorage.setItem('sholatApp', JSON.stringify({
      coords: state.coords, method: state.method, school: state.school, theme: state.theme,
      notifyOn: state.notifyOn, offsets: state.offsets, adzanAtTime: state.adzanAtTime,
      soundOn: state.soundOn, soundType: state.soundType, volume: state.volume,
      adzanUrl: state.adzanUrl,
      savedLocations: state.savedLocations, quranReciter: state.quranReciter,
      dailyReminders: state.dailyReminders, remSent: state.remSent,
      notifSent: state.notifSent, locName: state.locName, tz: state.tz,
    }));
  } catch (e) {
    // Mode privat / kuota penuh: jangan sampai merusak aplikasi.
  }
};
let saveTimer = null;
function saveSoon(){ clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); }

const load = () => {
  try {
    const d = JSON.parse(localStorage.getItem('sholatApp'));
    if (d) {
      if (d.coords) state.coords = d.coords;
      if (d.method) state.method = d.method;
      if (typeof d.school === 'number') state.school = d.school;
      if (d.theme) state.theme = d.theme;
      if (typeof d.notifyOn === 'boolean') state.notifyOn = d.notifyOn;
      if (d.offsets) state.offsets = { ...state.offsets, ...d.offsets };
      if (typeof d.adzanAtTime === 'boolean') state.adzanAtTime = d.adzanAtTime;
      if (typeof d.soundOn === 'boolean') state.soundOn = d.soundOn;
      if (d.soundType) state.soundType = d.soundType;
      if (typeof d.volume === 'number') state.volume = d.volume;
      if (typeof d.adzanUrl === 'string') state.adzanUrl = d.adzanUrl;
      if (Array.isArray(d.savedLocations)) state.savedLocations = d.savedLocations;
      if (d.quranReciter) state.quranReciter = d.quranReciter;
      if (Array.isArray(d.dailyReminders)) state.dailyReminders = d.dailyReminders;
      if (d.remSent) state.remSent = d.remSent;
      if (d.notifSent) state.notifSent = d.notifSent;
      if (typeof d.locName === 'string') state.locName = d.locName;
      if (typeof d.tz === 'string') state.tz = d.tz;
    }
  } catch(e){}
  $('notifToggle').checked = state.notifyOn;
  $('soundToggle').checked = state.soundOn;
  $('soundTypeSel').value = state.soundType;
  $('volumeRange').value = state.volume;
  $('adzanUrlInput').value = state.adzanUrl || '';
  $('quranReciterSel').value = state.quranReciter;
  $('themeSel').value = state.theme;
  $('methodSel').value = String(state.method);      // BUGFIX: dulu pilihan metode tidak dipulihkan
  $('adzanAtTimeToggle').checked = state.adzanAtTime;
  if ($('schoolSel')) $('schoolSel').value = String(state.school);
  renderOffsets();                                  // BUGFIX: offset tersimpan kini ikut tampil
  renderSavedLocations();
  renderDailyReminders();
};

/* =====================================================================
   TEMA
   ===================================================================== */
function applyTheme(){
  const t = state.theme === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : state.theme;
  document.body.classList.toggle('light', t === 'light');
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', t === 'light' ? '#eef3fb' : '#0b1020');
  $('themeBtn').textContent = t === 'light' ? '☀️' : '🌙';
}
$('themeBtn').onclick = () => {
  const order = ['auto','dark','light'];
  const idx = order.indexOf(state.theme);
  state.theme = order[(idx+1)%order.length];
  $('themeSel').value = state.theme; applyTheme(); save();
};
$('themeSel').onchange = e => { state.theme = e.target.value; applyTheme(); save(); };
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);

/* =====================================================================
   METODE
   ===================================================================== */
(function fillMethods(){
  const s = $('methodSel');
  // Jika id metode tersimpan tidak ada di daftar (mis. data lama), tambahkan agar tetap terpilih.
  const ids = METHODS.map(m => m[0]);
  if (!ids.includes(Number(state.method))) METHODS.push([Number(state.method) || 20, 'Metode tersimpan (id ' + state.method + ')']);
  for (const [k, v] of METHODS) {
    const o = document.createElement('option'); o.value = k; o.textContent = v; s.appendChild(o);
  }
  s.value = String(state.method);
  const sc = $('schoolSel');
  if (sc) for (const [k, v] of SCHOOLS) {
    const o = document.createElement('option'); o.value = k; o.textContent = v; sc.appendChild(o);
  }
  if (sc) sc.value = String(state.school);
})();
$('methodSel').onchange = e => { state.method = Number(e.target.value); save(); resyncPush(); getJadwal(); };
if ($('schoolSel')) $('schoolSel').onchange = e => { state.school = Number(e.target.value); save(); resyncPush(); getJadwal(); };

/* =====================================================================
   PENGATURAN OFFSET NOTIFIKASI
   ===================================================================== */
function renderOffsets(){
  const c = $('offsetList'); c.innerHTML='';
  [...PRAYERS, {key:'Imsak'}].forEach(p => {
    const div = document.createElement('div'); div.className='off';
    div.innerHTML = `<span>${p.em||''} ${esc(p.key)}</span>
      <input type="number" min="0" max="120" step="5" inputmode="numeric" aria-label="Menit pengingat sebelum ${esc(p.key)}" data-key="${esc(p.key)}">`;
    div.querySelector('input').value = state.offsets[p.key] ?? 10;
    c.appendChild(div);
  });
  c.querySelectorAll('input').forEach(inp => {
    inp.onchange = () => {
      let v = parseInt(inp.value||'10',10); if (isNaN(v)||v<0) v=10; if(v>120) v=120; inp.value=v;
      state.offsets[inp.dataset.key] = v; save();
      resyncPush();
      toast(`Pengingat ${inp.dataset.key}: ${v} menit sebelum`);
    };
  });
}
renderOffsets();

/* =====================================================================
   SETTINGS PANEL TOGGLE
   ===================================================================== */
$('settingsBtn').onclick = () => {
  const p = $('settingsPanel');
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
};
$('helpBtn').onclick = () => {
  const h = $('helpPanel');
  h.style.display = h.style.display === 'none' ? 'block' : 'none';
  // isi status FCM
  const cfg = (typeof window.FCM_CONFIG !== 'undefined') ? window.FCM_CONFIG : null;
  const st = $('fcmStatus');
  if (cfg && cfg.apiKey && cfg.serverUrl) {
    st.textContent = '✅ Push FCM aktif — notifikasi tetap masuk walau aplikasi tertutup.';
    st.classList.remove('off');
  } else if (cfg && cfg.apiKey) {
    st.textContent = '⚠️ FCM terisi tapi belum ada server. Push belum dikirim otomatis.';
    st.classList.remove('off');
  } else {
    st.textContent = 'Push FCM belum dikonfigurasi. Isi fcm-config.js untuk aktif.';
    st.classList.add('off');
  }
};

/* =====================================================================
   PANEL QIBLA & KALENDER (toggle)
   ===================================================================== */
$('qiblaBtn').onclick = () => {
  const p = $('qiblaPanel');
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
  if (p.style.display === 'block') initQibla();
};
$('calBtn').onclick = () => {
  const p = $('calendarPanel');
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
  if (p.style.display === 'block') loadCalendar();
};

/* =====================================================================
   ARAH KIBLAT — kompas
   ===================================================================== */
const KAABA = { lat: 21.4225, lng: 39.8262 };
function bearingToKaaba(lat, lng){
  const φ1 = lat*Math.PI/180, φ2 = KAABA.lat*Math.PI/180;
  const Δλ = (KAABA.lng - lng)*Math.PI/180;
  const y = Math.sin(Δλ)*Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  return (Math.atan2(y,x)*180/Math.PI + 360) % 360;
}
function distanceKm(lat, lng){
  const R=6371, φ1=lat*Math.PI/180, φ2=KAABA.lat*Math.PI/180;
  const Δφ=(KAABA.lat-lat)*Math.PI/180, Δλ=(KAABA.lng-lng)*Math.PI/180;
  const a=Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R*2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
let qiblaBearing = 0, compassHeading = null;
function updateNeedle(){
  if (compassHeading == null) return;
  // rot = arah kiblat dari utara - arah hadap perangkat (utara).
  // Saat device menghadap utara (heading 0), jarum menunjuk ke bearing kiblat.
  const rot = qiblaBearing - compassHeading;
  $('needle').style.transform = `translate(-50%,-50%) rotate(${rot}deg)`;
}
let orientationAttached = false;
function initQibla(){
  if (!state.coords) { $('qiblaInfo').textContent = 'Aktifkan lokasi dulu (📍)'; return; }
  qiblaBearing = bearingToKaaba(state.coords.lat, state.coords.lng);
  const d = distanceKm(state.coords.lat, state.coords.lng);
  $('qiblaInfo').innerHTML = `Kiblat: ${qiblaBearing.toFixed(1)}° dari Utara<small>Jarak ke Ka'bah ±${d.toFixed(0)} km</small>`;

  if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission().then(p => {
      if (p === 'granted') attachOrientation();
      else if ($('qiblaHint')) $('qiblaHint').textContent = 'Izin sensor gerak ditolak. Angka di atas tetap menunjukkan arah kiblat dari Utara.';
    }).catch(()=>{});
  } else if (window.DeviceOrientationEvent) {
    attachOrientation();
  } else {
    // AUDIT: elemen hint punya class "qibla-hint" tanpa id, sehingga kode lama
    // getElementById('qibla-hint') selalu null (pesan tak pernah tampil).
    if ($('qiblaHint')) $('qiblaHint').textContent = 'Perangkat ini tidak memiliki sensor kompas. Gunakan angka arah kiblat di atas bersama kompas biasa.';
    compassHeading = compassHeading == null ? 0 : compassHeading;
    updateNeedle();
  }
}
function attachOrientation(){
  if (orientationAttached) return;
  orientationAttached = true;
  const handle = e => {
    let heading = e.webkitCompassHeading; // iOS
    if (heading == null) {
      const alpha = e.alpha; // Android: alpha utara saat 0
      heading = alpha != null ? 360 - alpha : null;
    }
    if (heading != null) { compassHeading = heading; updateNeedle(); }
  };
  window.addEventListener('deviceorientationabsolute', handle, true);
  window.addEventListener('deviceorientation', handle, true);
}

/* =====================================================================
   KALENDER BULANAN
   ===================================================================== */
let calOffset = 0;   // 0 = bulan ini
const DOW = ['Min','Sen','Sel','Rab','Kam','Jum','Sab'];
// Nama bulan & hari Hijriah dalam Arab (fallback bila API tak menyediakan)
const AR_MONTHS = ['','Muḥarram','Ṣafar','Rabīʿ al-awwal','Rabīʿ al-ākhir','Jumādā al-ūlā','Jumādā al-ākhirah','Rajab','Shaʿbān','Ramaḍān','Shawwāl','Dhū al-Qaʿdah','Dhū al-Ḥijjah'];
const AR_WEEKDAY = { 0:'الأحد',1:'الاثنين',2:'الثلاثاء',3:'الأربعاء',4:'الخميس',5:'الجمعة',6:'السبت' };
function calMonthDate(){
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth()+calOffset, 1);
  return d;
}
async function loadCalendar(){
  if (!state.coords) { state.coords = { lat:-7.4211, lng:109.2343 }; }
  const d = calMonthDate();
  const yyyy = d.getFullYear(), mm = d.getMonth()+1;
  $('calTitle').innerHTML = d.toLocaleDateString('id-ID',{month:'long',year:'numeric'}) +
    `<small>Hijriah & jadwal harian — tap tanggal</small>`;
  const grid = $('calGrid'); grid.innerHTML = '';
  DOW.forEach(x => grid.innerHTML += `<div class="cal-dow">${x}</div>`);

  const today = new Date();
  const isCur = calOffset === 0;
  const firstDow = new Date(yyyy, mm-1, 1).getDay();
  const daysInMonth = new Date(yyyy, mm, 0).getDate();

  try {
    const url = `https://api.aladhan.com/v1/calendar?latitude=${state.coords.lat}&longitude=${state.coords.lng}&month=${String(mm).padStart(2,'0')}&year=${yyyy}&method=${state.method}&school=${state.school}`;
    const data = await fetchJSON(url, { timeout: 15000, retry: 1 });
    const days = (data && data.data) || [];
    const byDay = {};
    days.forEach(day => {
      const t = day.timings;
      const h = day.date.hijri;
      const mNum = parseInt(h.month.number, 10);
      const monthEn = h.month.en || (AR_MONTHS[mNum] || '');
      const monthAr = h.month.ar || (AR_MONTHS[mNum] || '');
      const wdAr = (h.weekday && h.weekday.ar) || AR_WEEKDAY[day.date.gregorian.weekday?.number ?? new Date(day.date.gregorian.date).getDay()] || '';
      byDay[parseInt(day.date.gregorian.day,10)] = {
        hijri: `${h.day} ${monthEn} ${h.year} H`,
        hijriAr: `${h.day} ${monthAr} ${h.year}هـ`,
        hijriNum: h.day,
        monthAr, monthEn, year: h.year, weekdayAr: wdAr,
        times: { Imsak:parseHM(t.Imsak), Subuh:parseHM(t.Fajr), Dzuhur:parseHM(t.Dhuhr),
                 Ashar:parseHM(t.Asr), Maghrib:parseHM(t.Maghrib), Isya:parseHM(t.Isha) }
      };
    });

    for (let i=0;i<firstDow;i++) grid.innerHTML += `<div class="cal-cell empty"></div>`;
    for (let dd=1; dd<=daysInMonth; dd++){
      const isToday = isCur && dd === today.getDate();
      const info = byDay[dd];
      const cell = document.createElement('div');
      cell.className = 'cal-cell' + (isToday?' today':'') + (info?'':' empty');
      cell.innerHTML = `${dd}${info ? `<div class="mini">${esc(String(info.hijri).split(' ')[0])}</div>`:''}`;
      cell.onclick = () => {
        if (!info) return;
        showCalDetail(dd, info);
        grid.querySelectorAll('.cal-cell').forEach(c=>c.classList.remove('selected'));
        cell.classList.add('selected');
      };
      grid.appendChild(cell);
    }
  } catch(e){
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--muted);padding:16px">Gagal memuat kalender.</div>`;
  }
}
function showCalDetail(dd, info){
  $('calDetail').style.display = 'block';
  $('calDetailTitle').innerHTML =
    `<div style="font-size:15px">${dd} · ${esc(info.hijri)}</div>
     <div style="font-size:22px;font-weight:800;margin:4px 0;text-align:right;direction:rtl;font-family:'Amiri','Scheherazade New',serif">${esc(info.hijriAr)}</div>
     <div style="font-size:12px;color:var(--muted)">${esc(info.weekdayAr)} · ${esc(info.monthAr)} ${esc(info.year)} هـ</div>`;
  const order = [['Imsak','🌄'],['Subuh','🌅'],['Dzuhur','☀️'],['Ashar','🌤️'],['Maghrib','🌇'],['Isya','🌙']];
  $('calDetailTimes').innerHTML = order.map(([n,em]) =>
    `<div class="cal-dt"><span>${em} ${n}</span><b>${esc(info.times[n] || '—')}</b></div>`).join('');
}
$('calPrev').onclick = () => { calOffset--; loadCalendar(); };
$('calNext').onclick = () => { calOffset++; loadCalendar(); };

/* =====================================================================
   TAB NAVIGASI (Lokasi / Al-Quran / Qadar)
   ===================================================================== */
function closeAllPanels(){
  ['locPanel','quranPanel','qadarPanel','ytPanel'].forEach(id => {
    const p=$(id); if(p) { p.style.display='none'; p.setAttribute('aria-hidden','true'); }
  });
  document.querySelectorAll('.tab').forEach(t => { t.classList.remove('on'); t.setAttribute('aria-pressed','false'); });
}
function bindTab(btnId, panelId){
  $(btnId).onclick = () => {
    const p = $(panelId);
    const willOpen = p.style.display !== 'block';
    closeAllPanels();
    if (willOpen) {
      p.style.display='block';
      p.setAttribute('aria-hidden','false');
      $(btnId).classList.add('on');
      $(btnId).setAttribute('aria-pressed','true');
      if (panelId==='quranPanel') loadSurahList();
      if (panelId==='qadarPanel') renderQadar();
    }
  };
}
bindTab('tabLoc','locPanel');
bindTab('tabQuran','quranPanel');
bindTab('tabQadar','qadarPanel');
bindTab('tabYT','ytPanel');

/* =====================================================================
   MULTI-LOKASI
   ===================================================================== */
function saveCurrentLocation(){
  if (!state.coords) { toast('Aktifkan lokasi dulu (📍)'); return; }
  const name = state.locName || `${state.coords.lat.toFixed(3)}, ${state.coords.lng.toFixed(3)}`;
  // cek duplikat
  const dup = state.savedLocations.findIndex(l =>
    Math.abs(l.lat-state.coords.lat)<0.01 && Math.abs(l.lng-state.coords.lng)<0.01);
  if (dup>=0) { toast('Lokasi ini sudah tersimpan'); renderSavedLocations(); return; }
  state.savedLocations.push({ name, lat: state.coords.lat, lng: state.coords.lng, tz: state.tz || null });
  save(); renderSavedLocations(); toast(`📍 "${name}" disimpan`);
}
$('saveLocBtn').onclick = saveCurrentLocation;

function renderSavedLocations(){
  const c = $('savedLocList'); c.innerHTML = '';
  if (!state.savedLocations.length) {
    c.innerHTML = '<div style="font-size:11.5px;color:var(--muted)">Belum ada lokasi tersimpan.</div>'; return;
  }
  state.savedLocations.forEach((loc, i) => {
    const div = document.createElement('div'); div.className='saved-item';
    div.innerHTML = `<span class="nm">${esc(loc.name)}</span>
      <button class="btn2 go" data-i="${i}" aria-label="Pakai lokasi ${esc(loc.name)}">✓ Pakai</button>
      <button class="btn2" data-del="${i}" aria-label="Hapus lokasi ${esc(loc.name)}">🗑</button>`;
    div.querySelector('[data-i]').onclick = () => {
      state.coords = { lat: loc.lat, lng: loc.lng };
      state.locName = loc.name; state.accuracy = null; state.tz = loc.tz || null;
      save();
      setLocStatus('ok',`<b>${esc(loc.name)}</b> · ${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}`);
      getJadwal();
      toast(`Lokasi diaktifkan: ${loc.name}`);
    };
    div.querySelector('[data-del]').onclick = () => {
      state.savedLocations.splice(i,1); save(); renderSavedLocations();
    };
    c.appendChild(div);
  });
}
renderSavedLocations();

/* =====================================================================
   MENG AJI AL-QURAN (teks + terjemahan + audio per-ayat)
   ===================================================================== */
let surahCache = {};      // nomor -> data detail
let activeSurah = null;   // nomor surat yang sedang dibaca

// Map kode qari equran.id -> bagian URL cdn
const QARI_PATH = {
  '01':'Abdullah-Al-Juhany','02':'Abdul-Muhsin-Al-Qasim',
  '03':'Abdurrahman-as-Sudais','04':'Ibrahim-Al-Dossari',
  '05':'Misyari-Rasyid-Al-Afasi','06':'Yasser-Al-Dosari',
};
const QARI_NAME = {
  '01':'Abdullah Al-Juhany','02':'Abdul Muhsin Al-Qasim',
  '03':'Abdurrahman As-Sudais','04':'Ibrahim Al-Dossari',
  '05':'Misyari Rasyid Al-Afasi','06':'Yasser Al-Dosari',
};

function quranAudioUrl(surahNo, qariPath, ayahNo){
  const q = qariPath || QARI_PATH[state.quranReciter] || 'Misyari-Rasyid-Al-Afasi';
  if (ayahNo) {
    return `https://cdn.equran.id/audio-partial/${q}/${String(surahNo).padStart(3,'0')}${String(ayahNo).padStart(3,'0')}.mp3`;
  }
  return `https://cdn.equran.id/audio-full/${q}/${String(surahNo).padStart(3,'0')}.mp3`;
}

async function loadSurahList(){
  const list = $('surahList');
  if (list.dataset.loaded) return;
  list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--muted)"><span class="loader"></span> Memuat daftar surat…</div>';
  try {
    const d = await fetchJSON('https://equran.id/api/v2/surat', { timeout: 15000, retry: 1 });
    const surats = (d && d.data) || [];
    if (!surats.length) throw new Error('data kosong');
    list.innerHTML = '';
    surats.forEach(s => {
      const div = document.createElement('div');
      div.className = 'surah-item';
      // Semua teks dari API di-escape (pertahanan terhadap data/API pihak ketiga)
      div.innerHTML = `
        <div class="si-num">${esc(s.nomor)}</div>
        <div class="si-info">
          <div class="si-latin">${esc(s.namaLatin)}</div>
          <div class="si-arti">${esc(s.arti)} · ${esc(s.jumlahAyat)} ayat · ${esc(s.tempatTurun)}</div>
        </div>
        <div class="si-arab" dir="rtl" lang="ar">${esc(s.nama)}</div>`;
      div.onclick = () => openSurah(s.nomor, s);
      list.appendChild(div);
    });
    list.dataset.loaded = '1';
  } catch(e){
    list.innerHTML = `<div style="padding:16px;text-align:center;color:var(--danger)">Gagal memuat daftar surat.<br>
      <button class="btn gray" id="surahRetry" style="margin-top:10px;padding:8px 14px">🔁 Coba lagi</button></div>`;
    const r = $('surahRetry');
    if (r) r.onclick = () => { list.dataset.loaded = ''; loadSurahList(); };
  }
}

async function openSurah(nomor, meta){
  $('quranBack').style.display = 'grid';
  $('quranTitle').textContent = meta ? meta.namaLatin : 'Baca Surat';
  $('surahList').style.display = 'none';
  $('surahReader').style.display = 'block';

  const reader = $('ayahList');
  reader.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted)"><span class="loader"></span> Memuat surat…</div>';
  activeSurah = nomor;

  let data;
  if (surahCache[nomor]) { data = surahCache[nomor]; }
  else {
    try {
      const d = await fetchJSON(`https://equran.id/api/v2/surat/${nomor}`, { timeout: 20000, retry: 1 });
      data = d.data; surahCache[nomor] = data;
      if (!data || !data.ayat) throw new Error('data kosong');
    } catch(e){
      reader.innerHTML = `<div style="padding:20px;text-align:center;color:var(--danger)">Gagal memuat surat.<br>
        <button class="btn gray" id="ayahRetry" style="margin-top:10px;padding:8px 14px">🔁 Coba lagi</button></div>`;
      const r = $('ayahRetry');
      if (r) r.onclick = () => { reader.innerHTML = ''; openSurah(nomor, meta); };
      return;
    }
  }

  const qari = QARI_NAME[state.quranReciter] || 'Misyari Rasyid Al-Afasi';
  $('quranMeta').innerHTML =
    `<span class="qm-arab" dir="rtl" lang="ar">${esc(data.nama)}</span>
     <span class="qm-latin">${esc(data.namaLatin)} — ${esc(data.arti)}</span>
     <span class="qm-sub">${esc(data.jumlahAyat)} ayat · ${esc(data.tempatTurun)} · Qari: ${esc(qari)}</span>`;

  reader.innerHTML = '';
  data.ayat.forEach((a, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'ayah';
    wrap.innerHTML = `
      <div class="ayah-body">
        <div class="ayah-arab" dir="rtl" lang="ar">${esc(a.teksArab)} <span class="ayah-num">${esc(a.nomorAyat)}</span></div>
        <div class="ayah-latin">${esc(a.teksLatin)}</div>
        <div class="ayah-id">${esc(a.teksIndonesia)}</div>
      </div>
      <button class="ayah-play" data-s="${esc(nomor)}" data-a="${esc(a.nomorAyat)}" title="Putar ayat" aria-label="Putar ayat ${esc(a.nomorAyat)}">▶</button>`;
    wrap.querySelector('.ayah-play').onclick = (e) => {
      e.stopPropagation();
      playAyah(nomor, a.nomorAyat);
    };
    reader.appendChild(wrap);
  });
}

function playAyah(surahNo, ayahNo){
  const url = quranAudioUrl(surahNo, null, ayahNo);
  const a = $('quranAudio'); a.src = url; a.style.display='block';
  safePlay(a, () => toast('Gagal memutar ayat. Cek internet.'));
}

$('quranPlayFull').onclick = () => {
  const a = $('quranAudio'); a.style.display='block';
  if (activeSurah) {
    a.src = quranAudioUrl(activeSurah, null, null);
    safePlay(a, () => toast('Gagal memutar surat. Cek internet.'));
  } else {
    toast('Buka surat dulu untuk memutar penuh.');
  }
};
$('quranStopFull').onclick = () => { const a=$('quranAudio'); a.pause(); a.currentTime=0; };

$('quranBack').onclick = () => {
  if (karaokeOn) stopKaraoke();
  $('surahList').style.display = 'block';
  $('surahReader').style.display = 'none';
  $('quranBack').style.display = 'none';
  $('quranTitle').textContent = 'Daftar Surat';
  const a = $('quranAudio'); a.pause(); a.currentTime=0; a.style.display='none';
};

$('quranReciterSel').onchange = e => { state.quranReciter = e.target.value; save(); };

/* =====================================================================
   KARAOKE — word-by-word highlighting + auto-scroll (sinron audio)
   ===================================================================== */
let karaokeOn = false, karaokeIdx = 0, karaokeWords = [], karaokeAudio = null;

function karaokeAyatAudio(ayat){
  const obj = ayat.audio || {};
  return obj[state.quranReciter] || Object.values(obj)[0] || null;
}

function setKPlayLabel(playing){
  $('kPlay').textContent = playing ? '⏸' : '▶️';
}

// Pecah teks arab ayat menjadi kata-kata untuk highlight (sumber equran, tanpa API ekstra)
function splitArabic(text){
  return String(text||'').split(/\s+/).filter(Boolean);
}

// RENDER SEKALI seluruh surat: semua ayat (kata-kata + latin + terjemahan)
// ditampilkan langsung, tanpa loading per-ayat. Highlight berjalan di dalam
// ayat yang sedang diputar, lalu auto-scroll ke ayat berikutnya.
// Gulir kontainer karaoke HANYA jika elemen berada DI LUAR area terlihat,
// agar di awal (ayat 1, kata 1) tampilan tetap di atas dan tidak loncat ke bawah.
function centerInBox(box, el){
  if (!el || !box) return;
  const bTop = box.getBoundingClientRect().top;
  const bBottom = bTop + box.clientHeight;
  const eTop = el.getBoundingClientRect().top;
  const eBottom = eTop + el.getBoundingClientRect().height;
  // jika sudah terlihat penuh -> jangan gerakkan scroll
  if (eTop >= bTop && eBottom <= bBottom) return;
  box.scrollTop += (eTop - bTop) - (box.clientHeight / 2) + (el.getBoundingClientRect().height / 2);
}

function renderKaraokeSurah(){
  const data = surahCache[activeSurah];
  if (!data) return;
  const box = $('karaokeAyah');
  // KOSONGKAN dulu + paksa reflow agar browser "menyadari" konten baru
  box.innerHTML = '';
  box.scrollTop = 0;
  // hentikan audio lama & reset semua state
  if (karaokeAudio) { karaokeAudio.pause(); karaokeAudio = null; }

  let html = '';
  data.ayat.forEach((a, idx) => {
    const words = splitArabic(a.teksArab);
    let khtml = '';
    // AUDIT: dulu kata ditulis terbalik di DOM untuk "menipu" urutan LTR.
    // Sekarang urutan asli + CSS .k-verse{direction:rtl} (lebih benar untuk
    // teks Arab multi-baris dan ramah pembaca layar).
    words.forEach((w, i) => {
      khtml += `<span class="k-word" data-v="${idx}" data-i="${i}">${esc(w)}</span>`;
    });
    html += `<div class="k-block" data-v="${idx}">
      <div class="k-verse" dir="rtl" lang="ar">${khtml}</div>
      <div class="k-latin">${esc(a.teksLatin||'')}</div>
      <div class="k-id">${esc(a.teksIndonesia)}</div>
    </div>`;
  });
  box.innerHTML = html;

  // MULAI DARI AYAT 1 (PASTI): label + indeks + kata ayat pertama
  $('kAyahNum').textContent = `Surat ${data.namaLatin} — Ayat ${data.ayat[0].nomorAyat}`;
  karaokeIdx = 0;
  karaokeWords = splitArabic(data.ayat[0].teksArab);

  // Gulir ke ATAS secara berlapis (layout selesai -> beberapa frame -> telat 100ms),
  // memaksa reflow (offsetHeight) agar benar-benar scrollTop=0 walau konten 200+ ayat.
  const forceTop = () => {
    if (box) { box.scrollTop = 0; box.scrollTop = 0; void box.offsetHeight; }
    if (document.documentElement) document.documentElement.scrollTop = 0;
    if (document.body) document.body.scrollTop = 0;
    if (window.scrollTo) window.scrollTo(0, 0);
    const kv = $('karaokeView'); if (kv) kv.scrollTop = 0;
  };
  forceTop();
  requestAnimationFrame(() => {
    forceTop();
    requestAnimationFrame(() => {
      forceTop();
      setTimeout(forceTop, 100);
    });
  });

  // Mulai audio ayat 1 SETELAH scroll dipastikan di atas (delay kecil)
  setTimeout(() => { if (karaokeOn) playKaraokeAudio(data.ayat[0]); }, 120);
}

function playKaraokeAudio(ayat){
  if (karaokeAudio) { karaokeAudio.pause(); karaokeAudio = null; }
  const url = karaokeAyatAudio(ayat);
  setKPlayLabel(true);
  // JANGAN otomatis lanjut bila tidak ada audio: tetap tampil di ayat ini.
  if (!url) { return; }
  const a = new Audio(url);
  karaokeAudio = a;
  safePlay(a);
  let advanced = false;
  const advanceOnce = () => { if (!advanced) { advanced = true; advanceKaraoke(); } };
  a.ontimeupdate = () => {
    if (!a.duration || !karaokeWords.length || advanced) return;
    const n = Math.floor((a.currentTime / a.duration) * karaokeWords.length);
    highlightKaraoke(karaokeIdx, n);
  };
  a.onended = advanceOnce;
  a.onerror = () => { /* biarkan tampil tanpa audio, jangan lompat */ };
}

function highlightKaraoke(v, n){
  const box = $('karaokeAyah');
  // tandai ayat aktif
  box.querySelectorAll('.k-block').forEach(b => b.classList.toggle('active', Number(b.dataset.v) === v));
  // Highlight memakai data-i (indeks kata asli). Kata indeks 0 diletakkan paling
  // kanan (RTL), sehingga kata menyala dari kanan ke kiri mengikuti urutan bacaan.
  const words = box.querySelectorAll(`.k-block[data-v="${v}"] .k-word`);
  words.forEach(el => {
    const wi = Number(el.dataset.i);
    el.classList.toggle('lit', wi < n);
    el.classList.toggle('cur', wi === n);
  });
  const cur = box.querySelector(`.k-block[data-v="${v}"] .k-word[data-i="${n}"]`);
  if (cur) centerInBox(box, cur);
}

function advanceKaraoke(){
  if (!karaokeOn) return;
  karaokeIdx++;
  const data = surahCache[activeSurah];
  if (data && karaokeIdx < data.ayat.length) {
    const ayat = data.ayat[karaokeIdx];
    karaokeWords = splitArabic(ayat.teksArab);
    $('kAyahNum').textContent = `Surat ${data.namaLatin} — Ayat ${ayat.nomorAyat}`;
    // scroll ke blok ayat aktif (tanpa me-render ulang)
    const blk = $('karaokeAyah').querySelector(`.k-block[data-v="${karaokeIdx}"]`);
    if (blk) centerInBox($('karaokeAyah'), blk);
    playKaraokeAudio(ayat);
  } else {
    stopKaraoke(); toast('Selesai tilawah surat ini 🎉');
  }
}

function toggleKaraoke(){
  if (!activeSurah) { toast('Buka surat dulu untuk karaoke'); return; }
  if (karaokeOn) { stopKaraoke(); return; }
  karaokeOn = true;
  $('ayahList').style.display = 'none';
  $('karaokeView').style.display = 'block';
  $('karaokeToggle').textContent = '⏹ Keluar Mode Karaoke';
  const a = $('quranAudio'); a.pause(); a.currentTime=0;
  renderKaraokeSurah();
}

function stopKaraoke(){
  karaokeOn = false;
  if (karaokeAudio) { karaokeAudio.pause(); karaokeAudio = null; }
  $('ayahList').style.display = 'block';
  $('karaokeView').style.display = 'none';
  $('karaokeToggle').textContent = '🎤 Mode Karaoke (per kata)';
  setKPlayLabel(false);
}

$('karaokeToggle').onclick = toggleKaraoke;
$('kPrev').onclick = () => {
  if (karaokeOn && karaokeIdx>0){
    karaokeIdx--;
    const data = surahCache[activeSurah];
    if (data){
      karaokeWords = splitArabic(data.ayat[karaokeIdx].teksArab);
      $('kAyahNum').textContent = `Surat ${data.namaLatin} — Ayat ${data.ayat[karaokeIdx].nomorAyat}`;
      const blk = $('karaokeAyah').querySelector(`.k-block[data-v="${karaokeIdx}"]`);
      if (blk) centerInBox($('karaokeAyah'), blk);
      playKaraokeAudio(data.ayat[karaokeIdx]);
    }
  }
};
$('kNext').onclick = () => { if (karaokeOn) advanceKaraoke(); };
$('kPlay').onclick = () => {
  if (!karaokeAudio) { renderKaraokeSurah(); return; }
  if (karaokeAudio.paused) { safePlay(karaokeAudio); setKPlayLabel(true); }
  else { karaokeAudio.pause(); setKPlayLabel(false); }
};

/* =====================================================================
   LAILATUL QADAR & DOA HARIAN
   ===================================================================== */
const DOAS = [
  { title:'Doa Lailatul Qadar',
    ar:'اللَّهُمَّ إِنَّكَ عَفُوٌّ تُحِبُّ الْعَفْوَ فَاعْفُ عَنِّي',
    latin:"Allahumma innaka 'afuwwun tuhibbul 'afwa fa'fu 'anni",
    meaning:'Ya Allah, sesungguhnya Engkau Maha Pemaaf dan menyukai maaf, maka maafkanlah aku.' },
  { title:'Doa Mohon Ampunan',
    ar:'رَبِّ اغْفِرْ لِي وَتُبْ عَلَيَّ إِنَّكَ أَنْتَ التَّوَّابُ الرَّحِيمُ',
    latin:"Rabbighfir lii wa tub 'alayya innaka antat-tawwabur-rahim",
    meaning:'Ya Tuhanku, ampunilah aku dan terimalah taubatku. Sesungguhnya Engkau Maha Penerima taubat lagi Maha Penyayang.' },
  { title:'Doa Kebaikan Dunia Akhirat',
    ar:'رَبَّنَا آتِنَا فِي الدُّنْيَا حَسَنَةً وَفِي الْآخِرَةِ حَسَنَةً وَقِنَا عَذَابَ النَّارِ',
    latin:"Rabbanaa aatinaa fid-dunya hasanah wa fil-aakhirati hasanah wa qinaa 'adzaban-naar",
    meaning:'Ya Tuhan kami, berilah kami kebaikan di dunia dan kebaikan di akhirat, serta lindungilah kami dari siksa neraka.' },
  { title:'Doa Memohon Keteguhan',
    ar:'يَا مُقَلِّبَ الْقُلُوبِ ثَبِّتْ قَلْبِي عَلَى دِينِكَ',
    latin:"Yaa muqallibal-quluub tsabbit qalbii 'alaa diinik",
    meaning:'Wahai Pembolak-balik hati, teguhkanlah hatiku di atas agama-Mu.' },
  { title:'Doa Keselamatan',
    ar:'اللَّهُمَّ إِنِّي أَسْأَلُكَ الْعَافِيَةَ فِي الدُّنْيَا وَالْآخِرَةِ',
    latin:"Allahumma inni as'alukal-'afiyah fid-dunya wal-akhirah",
    meaning:'Ya Allah, aku memohon kepada-Mu keselamatan di dunia dan akhirat.' },
];
let doaIndex = 0;
function renderQadar(){
  const banner = $('qadarBanner');
  const hi = state.hijriInfo;
  // AUDIT: deteksi Ramadan dulu gagal karena nama bulan API memakai diakritik
  // ("Ramaḍān") sehingga includes('ramad') tidak pernah cocok -> dipakai fold().
  const isRamadan = !!(hi && fold(hi.monthEn).includes('ramad'));
  const oddNight = isRamadan && [21,23,25,27,29].includes(parseInt(hi.day, 10));
  if (isRamadan && oddNight) {
    banner.className = 'qadar-banner';
    banner.innerHTML = `<div class="big">🌙 Malam Lailatul Qadar (diharapkan)</div>
      <div class="sub">Hijriah ${esc(hi.day)} Ramadan ${esc(hi.year)} H — malam ganjil. Perbanyak ibadah & doa.</div>`;
  } else if (isRamadan) {
    banner.className = 'qadar-banner normal';
    banner.innerHTML = `<div class="big">🌙 Bulan Ramadan ${esc(hi.year)} H</div>
      <div class="sub">Hari ini ${esc(hi.day)} Ramadan. Malam ganjil (21, 23, 25, 27, 29) berpeluang Lailatul Qadar — dihitung setelah Maghrib.</div>`;
  } else {
    banner.className = 'qadar-banner normal';
    banner.innerHTML = `<div class="big">📿 Doa Harian</div>
      <div class="sub">Hijriah: ${hi ? esc(hi.day + ' ' + hi.monthEn + ' ' + hi.year) + ' H' : '—'} · Sepuluh malam terakhir Ramadan = Lailatul Qadar.</div>`;
  }
  showDoa();
}
function showDoa(){
  const d = DOAS[doaIndex % DOAS.length];
  $('doaTitle').textContent = d.title;
  $('doaAr').textContent = d.ar;
  $('doaLatin').textContent = d.latin;
  $('doaMeaning').textContent = d.meaning;
}
$('doaNext').onclick = () => { doaIndex++; showDoa(); };

/* =====================================================================
   PENGINGAT HARIAN
   ===================================================================== */
function renderDailyReminders(){
  const c = $('remList'); c.innerHTML='';
  if (!state.dailyReminders.length) {
    c.innerHTML = '<div style="font-size:11.5px;color:var(--muted)">Belum ada pengingat harian.</div>'; return;
  }
  state.dailyReminders.forEach((r,i) => {
    const div = document.createElement('div'); div.className='saved-item';
    div.innerHTML = `<span class="nm">⏰ ${r.time}</span><button class="btn2" data-rem="${i}">🗑</button>`;
    div.querySelector('[data-rem]').onclick = () => { state.dailyReminders.splice(i,1); save(); renderDailyReminders(); };
    c.appendChild(div);
  });
}
$('addRemBtn').onclick = () => {
  const v = $('remTimeInput').value;
  if (!v) { toast('Pilih jam dulu'); return; }
  if (state.dailyReminders.some(r=>r.time===v)) { toast('Jam ini sudah ada'); return; }
  state.dailyReminders.push({ time: v });
  state.dailyReminders.sort((a,b)=>a.time.localeCompare(b.time));
  save(); renderDailyReminders(); toast(`Pengingat harian ${v} ditambahkan ⏰`);
};

function checkDailyReminders(now){
  const curHM = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const dayKey = todayKey();
  state.remSent = state.remSent || {};
  state.dailyReminders.forEach(r => {
    const key = `${dayKey}_${r.time}`;
    if (r.time !== curHM || state.remSent[key]) return;
    state.remSent[key] = true; save();
    // Pengingat harian dibuat sengaja oleh pengguna -> bunyi & notifikasi
    // (notifikasi hanya bila izin sudah diberikan).
    playReminder();
    showNotification('⏰ Pengingat Harian', { body: `Pengingat pukul ${r.time}.`, tag: key });
  });
}

/* =====================================================================
   TOAST
   ===================================================================== */
let toastTimer;
function toast(msg){
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(()=>t.classList.remove('show'), 3200);
}

/* =====================================================================
   LOKASI
   ===================================================================== */
function setLocStatus(kind, text){
  const d = $('locDot'); d.className = 'dot' + (kind? ' '+kind:'');
  $('locText').innerHTML = text;
}
// Peringatan bila zona waktu lokasi berbeda dengan jam perangkat
// (agar countdown tidak menyesatkan saat memilih kota di zona lain).
function tzNote(){
  if (!state.tz || !deviceTZ) return '';
  const a = tzOffsetMinutes(state.tz), b = tzOffsetMinutes(deviceTZ);
  if (a == null || b == null || a === b) return '';
  const jam = Math.round(((a - b) / 60) * 100) / 100;
  return ` <span class="tz-warn">⚠️ zona ${esc(state.tz)} (${jam > 0 ? '+' : ''}${jam} jam dari jam perangkat)</span>`;
}
function coordsText(prec){ return `${state.coords.lat.toFixed(prec)}, ${state.coords.lng.toFixed(prec)}`; }

function useGPS(){
  if (!navigator.geolocation) { setLocStatus('err','GPS tidak didukung browser ini'); return; }
  const btn = $('gpsBtn'); btn.disabled = true;
  setLocStatus('busy','<span class="loader"></span> Mencari lokasi presisi tinggi…');
  const onOk = async pos => {
    btn.disabled = false;
    const { latitude, longitude, accuracy } = pos.coords;
    state.coords = { lat: latitude, lng: longitude };
    state.accuracy = accuracy;
    setLocStatus('ok',`GPS akurat ±${Math.round(accuracy)} m · ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`);
    save();
    await reverseGeocode();
    getJadwal();
  };
  const onErr = err => {
    // Bila GPS presisi tinggi gagal/timeout, coba sekali lagi dalam mode hemat
    if (err && (err.code === 2 || err.code === 3)) {
      setLocStatus('busy','<span class="loader"></span> Sinyal GPS lemah — mencoba mode hemat…');
      navigator.geolocation.getCurrentPosition(onOk, err2 => { btn.disabled = false; gpsError(err2); },
        { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
      return;
    }
    btn.disabled = false;
    gpsError(err);
  };
  navigator.geolocation.getCurrentPosition(onOk, onErr,
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
}
function gpsError(err){
  let msg = 'Gagal akses GPS';
  if (err && err.code === 1) msg = 'Izin GPS ditolak. Perbolehkan akses lokasi.';
  else if (err && err.code === 3) msg = 'Waktu GPS habis. Coba lagi.';
  setLocStatus('err', msg);
}
$('gpsBtn').onclick = useGPS;

async function reverseGeocode(){
  if (!state.coords) return;
  try {
    const d = await fetchJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${state.coords.lat}&longitude=${state.coords.lng}&localityLanguage=id`, { timeout: 9000, retry: 0 });
    state.locName = [d.city || d.locality, d.principalSubdivision || d.principalSubdivisionCode].filter(Boolean).join(', ') || 'Lokasi GPS';
    setLocStatus('ok',`<b>${esc(state.locName)}</b> · ${coordsText(5)}${tzNote()}`);
  } catch(e){ state.locName = 'Lokasi GPS'; }
}

async function cariKota(){
  const q = $('inputKota').value.trim();
  if (!q) { toast('Ketik nama kota dulu'); return; }
  const btn = $('cariBtn'); btn.disabled = true;
  setLocStatus('busy','<span class="loader"></span> Mencari kota…');
  try {
    const list = await fetchJSON(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=1&accept-language=id&countrycodes=id`,
      { timeout: 10000, retry: 0, headers: { 'Accept': 'application/json' } }
    );
    if (list && list[0]) {
      state.coords = { lat: parseFloat(list[0].lat), lng: parseFloat(list[0].lon) };
      state.locName = String(list[0].display_name || q).split(',').slice(0,3).join(',').trim();
      state.accuracy = null;
      save();
      setLocStatus('ok',`<b>${esc(state.locName)}</b> · ${coordsText(4)}${tzNote()}`);
      getJadwal();
    } else { setLocStatus('err','Kota tidak ditemukan'); }
  } catch(e){ setLocStatus('err','Gagal mencari kota. Periksa internet lalu coba lagi.'); }
  finally { btn.disabled = false; }
}
$('cariBtn').onclick = cariKota;
$('inputKota').addEventListener('keydown', e => { if (e.key==='Enter') cariKota(); });

/* =====================================================================
   JADWAL
   ===================================================================== */
const todayKey = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD

function setDataInfo(msg, warn){
  const el = $('dataInfo');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('warn', !!warn);
}

async function getJadwal(){
  if (!state.coords) {
    // default ke koordinat user (Purwokerto, Jawa Tengah) jika belum ada lokasi
    state.coords = { lat: -7.4211, lng: 109.2343 };
    if (!state.locName) {
      state.locName = 'Purwokerto, Jawa Tengah';
      setLocStatus('ok', `<b>${esc(state.locName)}</b> · ketuk 📍 untuk presisi GPS`);
    }
  }
  try {
    const now = new Date();
    const dd = String(now.getDate()).padStart(2,'0');
    const mm = String(now.getMonth()+1).padStart(2,'0');
    const yyyy = now.getFullYear();
    // school: 0 = standar (Syafi'i), 1 = Hanafi
    const url = `https://api.aladhan.com/v1/timings/${dd}-${mm}-${yyyy}?latitude=${state.coords.lat}&longitude=${state.coords.lng}&method=${state.method}&school=${state.school}`;
    const data = await fetchJSON(url, { timeout: 12000, retry: 1 });
    const t = (data && data.data && data.data.timings) || {};
    state.jadwal = {
      Imsak: parseHM(t.Imsak || ''),
      Subuh: parseHM(t.Fajr || ''),
      Dzuhur: parseHM(t.Dhuhr || ''),
      Ashar: parseHM(t.Asr || ''),
      Maghrib: parseHM(t.Maghrib || ''),
      Isya: parseHM(t.Isha || ''),
    };
    state.todayKey = todayKey();
    // Zona waktu lokasi (untuk peringatan bila beda dengan jam perangkat)
    const meta = (data && data.data && data.data.meta) || {};
    state.tz = meta.timezone || null;

    // Hijriah
    try {
      const hd = data.data.date.hijri;
      const mNum = parseInt(hd.month.number, 10);
      const monthEn = hd.month.en;
      const monthAr = hd.month.ar || (AR_MONTHS[mNum] || hd.month.en);
      state.hijriInfo = { day: hd.day, monthEn, monthAr, year: hd.year, monthNum: mNum };
      $('hijri').innerHTML = `${esc(hd.day)} ${esc(monthEn)} ${esc(hd.year)} H
        <span dir="rtl" style="font-family:'Amiri','Scheherazade New',serif;font-size:15px;color:var(--accent)">${esc(hd.day)} ${esc(monthAr)} ${esc(hd.year)}هـ</span>`;
    } catch(e){ state.hijriInfo = null; }

    if (state.locName) setLocStatus('ok', `<b>${esc(state.locName)}</b> · ${coordsText(4)}${tzNote()}`);
    else setLocStatus('ok', `<b>${coordsText(4)}</b>${tzNote()}`);

    renderJadwal();
    save();
    lastFetchAt = Date.now();
    setDataInfo(`Aladhan · metode ${state.method} · ${state.tz || 'zona lokal'} · diperbarui ${timeFmt.format(new Date())}`, false);
  } catch(e) {
    lastFetchAt = Date.now();
    const hasOld = Object.keys(state.jadwal).length > 0;
    const stale = state.todayKey !== todayKey();
    toast(hasOld && !navigator.onLine
      ? 'Tidak ada internet — memakai jadwal tersimpan.'
      : 'Gagal ambil jadwal. Periksa internet lalu coba lagi.');
    if (hasOld) {
      renderJadwal();
      setDataInfo(stale ? '⚠️ Jadwal mungkin sudah kedaluwarsa (offline)' : '⚠️ Gagal memperbarui jadwal — memakai data tersimpan', true);
    } else {
      setDataInfo('⚠️ Jadwal belum tersedia — periksa koneksi internet', true);
    }
  }
}

function renderJadwal(){
  const g = $('jadwal'); g.innerHTML = '';
  // AUDIT: kartu Imsak dulu selalu ber-class "passed" (selalu redup).
  if (state.jadwal.Imsak) {
    g.innerHTML += `<div class="card imsak" data-k="Imsak"><div class="name"><span class="em">🌄</span>Imsak</div><div class="time">${esc(state.jadwal.Imsak)}</div><div class="tag">Awal puasa</div></div>`;
  }
  PRAYERS.forEach(p => {
    const t = state.jadwal[p.key];
    if (!t) return;
    const div = document.createElement('div');
    div.className = 'card';
    div.dataset.k = p.key;
    div.innerHTML = `<div class="name"><span class="em">${p.em}</span>${p.key}</div><div class="time">${esc(t)}</div><div class="tag">—</div>`;
    g.appendChild(div);
  });
}

/* =====================================================================
   JAM + COUNTDOWN (tick tiap detik)
   ===================================================================== */
function toMin(s){ const [h,m]=String(s).split(':').map(Number); return (h||0)*60+(m||0); }
function pad(n){ return String(n).padStart(2,'0'); }
// Formatter dibuat sekali (dulu dibuat ulang tiap detik -> membuang CPU/baterai).
const timeFmt = new Intl.DateTimeFormat('id-ID', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
const dateFmt = new Intl.DateTimeFormat('id-ID', { weekday:'long', day:'numeric', month:'long', year:'numeric' });

// Waktu sholat sebagai objek Date (hari ini, atau besok bila sudah lewat)
function prayerDate(time, now){
  const d = new Date(now);
  const [h, m] = String(time).split(':').map(Number);
  d.setHours(h || 0, m || 0, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return d;
}
function fmtDuration(ms){
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(total/3600))}:${pad(Math.floor((total%3600)/60))}:${pad(total%60)}`;
}

function tick(){
  const now = new Date();
  const curMin = now.getHours()*60 + now.getMinutes();

  // jam & tanggal
  $('jam').textContent = timeFmt.format(now);
  $('tanggal').textContent = dateFmt.format(now);

  if (Object.keys(state.jadwal).length === 0) {
    $('nextPray').textContent = '—';
    $('countdown').textContent = '--:--:--';
    $('nextAt').textContent = '—';
    return;
  }

  // cari sholat berikutnya — presisi detik (bukan pembulatan menit)
  let next = null, bestMs = Infinity;
  for (const [name, time] of Object.entries(state.jadwal)) {
    if (!/^\d{2}:\d{2}$/.test(time)) continue;      // lewati data rusak
    const at = prayerDate(time, now);
    const ms = at - now;
    if (ms > 0 && ms < bestMs) { bestMs = ms; next = { name, time, at }; }
  }

  if (next) {
    $('nextPray').textContent = next.name;
    $('countdown').textContent = fmtDuration(bestMs);
    $('nextAt').textContent = `Pukul ${next.time}`;
  } else {
    $('nextPray').textContent = '—';
    $('countdown').textContent = '--:--:--';
    $('nextAt').textContent = 'Menunggu jadwal';
  }

  // highlight: aktif (terlewat hari ini) & berikutnya
  document.querySelectorAll('.card').forEach(c => {
    const k = c.dataset.k, t = state.jadwal[k];
    if (!t) return;
    const passed = toMin(t) <= curMin;
    const isNext = !!next && k === next.name;
    c.classList.toggle('passed', passed && !isNext);
    c.classList.toggle('next', isNext);
    const tag = c.querySelector('.tag');
    if (tag) tag.textContent = isNext ? 'Berikutnya' : (passed ? 'Sudah lewat' : (k === 'Imsak' ? 'Awal puasa' : ''));
  });

  // notifikasi
  if (state.notifyOn) checkNotifications(now);
  checkDailyReminders(now);
}

/* =====================================================================
   NOTIFIKASI
   ===================================================================== */
function updateNotifStatus(){
  const st = $('notifStatus');
  if (!('Notification' in window)) { st.textContent = 'Notifikasi tidak didukung browser ini.'; st.classList.add('off'); return; }
  if (!('serviceWorker' in navigator)) { st.textContent = '⚠️ Browser tanpa Service Worker: notifikasi hanya saat aplikasi terbuka.'; st.classList.add('off'); return; }
  if (Notification.permission === 'granted') { st.textContent = '✅ Izin notifikasi aktif — pengingat siap.'; st.classList.remove('off'); }
  else if (Notification.permission === 'denied') { st.textContent = '⛔ Izin ditolak. Aktifkan di pengaturan browser/sistem.'; st.classList.add('off'); }
  else { st.textContent = 'Izin belum diberikan. Ketuk tombol di bawah.'; st.classList.remove('off'); }
}
$('reqPermBtn').onclick = async () => {
  if (!('Notification' in window)) { toast('Notifikasi tidak didukung'); return; }
  try {
    const r = await Notification.requestPermission();
    updateNotifStatus();
    if (r === 'granted') toast('✅ Notifikasi aktif!');
  } catch (e) { toast('Gagal meminta izin notifikasi'); }
};
$('testNotifBtn').onclick = async () => {
  if (!('Notification' in window)) { toast('Notifikasi tidak didukung'); return; }
  if (Notification.permission === 'granted') {
    const ok = await showNotification('🔔 Sholat App', {
      body: 'Ini uji coba notifikasi. Pengingat akan berbunyi sebelum waktu sholat.',
      tag: 'uji',
    });
    toast(ok ? 'Notifikasi uji dikirim ✅' : 'Gagal kirim uji coba');
  } else { toast('Aktifkan izin notifikasi dulu'); updateNotifStatus(); }
};

// Pengingat sebelum sholat + adzan tepat waktu.
// AUDIT: dulu hanya tepat pada menit target (bisa terlewat saat tab di-throttle
// browser atau HP baru dibangunkan). Kini ada jendela susulan 15 menit,
// anti-duplikat, dan jadwal dari tanggal lain tidak dipakai.
function checkNotifications(now){
  if (!notifSupported() || Notification.permission !== 'granted') return;
  if (state.todayKey !== todayKey()) return;
  const curMin = now.getHours()*60 + now.getMinutes();
  const dayKey = todayKey().replace(/-/g,'');
  const CATCHUP = 15;

  for (const [name, time] of Object.entries(state.jadwal)) {
    if (!/^\d{2}:\d{2}$/.test(time)) continue;
    const isImsak = (name === 'Imsak');
    const t = toMin(time);

    // (1) Pengingat sebelum masuk waktu
    const off = state.offsets[name] ?? 10;
    if (off > 0) {
      const target = t - off;
      const key = `${dayKey}_${name}`;
      if (curMin >= target && curMin - target <= CATCHUP && curMin <= t && !state.notifSent[key]) {
        state.notifSent[key] = true; save();
        playReminder();
        showNotification(`⏰ ${isImsak ? 'Imsak' : name} ${off} menit lagi`, {
          body: isImsak ? `Pukul ${time} masuk imsak. Siapkan sahur & niat puasa.`
                        : `Pukul ${time} masuk waktu ${name}. Segera bersiap sholat.`,
          tag: key,
        });
      }
    }

    // (2) Adzan tepat saat masuk waktu (bisa dimatikan di Pengaturan)
    if (state.adzanAtTime && !isImsak) {
      const key2 = `${dayKey}_${name}_adzan`;
      const late = curMin - t;               // 0 = tepat waktu, >0 = susulan
      if (late >= 0 && late <= CATCHUP && !state.notifSent[key2]) {
        state.notifSent[key2] = true; save();
        if (late === 0) playReminder();      // bunyi hanya bila tepat waktu
        showNotification(`🕌 Waktunya sholat ${name}`, {
          body: late === 0
            ? `Telah masuk waktu ${name} (${time}).`
            : `Waktu ${name} (${time}) sudah masuk ${late} menit lalu.`,
          tag: key2,
          requireInteraction: (late === 0),
        });
      }
    }
  }
}

/* =====================================================================
   AUDIO — ADZAN / BIP
   ===================================================================== */
const audioEl = new Audio();
audioEl.preload = 'none';                 // hemat data: baru diunduh saat dibutuhkan
function getAdzanSrc(){
  switch (state.soundType) {
    case 'adzanBilal': return 'audio/adzan-bilal.mp3';
    // AUDIT: URL kustom divalidasi (dulu dipakai apa adanya sebagai src)
    case 'custom': return safeUrl(state.adzanUrl) || 'audio/adzan.mp3';
    default: return 'audio/adzan.mp3';
  }
}
function setupAudio(){
  try {
    audioEl.src = getAdzanSrc();
    audioEl.preload = 'auto';
    audioEl.load();
  } catch (e) {}
}
// "Unlock" audio pada interaksi pertama: kebijakan autoplay browser
// memblokir play() tanpa gestur pengguna, sehingga adzan bisa gagal bunyi.
let audioPrimed = false;
function primeAudio(){
  audioPrimed = true;
  try { if (beepCtx && beepCtx.state === 'suspended') beepCtx.resume(); } catch (e) {}
  setupAudio();
  try {
    audioEl.volume = 0;
    const done = () => { try { audioEl.pause(); audioEl.currentTime = 0; } catch (e) {} audioEl.volume = clampVol(); };
    const p = audioEl.play();
    if (p && typeof p.then === 'function') p.then(done).catch(done); else done();
  } catch (e) {}
}
['pointerdown','touchstart','keydown'].forEach(ev =>
  window.addEventListener(ev, primeAudio, { once: true, passive: true })
);

function clampVol(){ return Math.max(0, Math.min(1, typeof state.volume === 'number' ? state.volume : 0.8)); }
function playReminder(){
  if (!state.soundOn) return;
  try {
    audioEl.volume = clampVol();
    if (state.soundType === 'beep') {
      playBeep();
    } else {
      const src = getAdzanSrc();
      if (audioEl.getAttribute('src') !== src) { audioEl.src = src; audioEl.preload = 'auto'; }
      try { audioEl.currentTime = 0; } catch (e) {}
      safePlay(audioEl);
    }
  } catch(e){}
}
let beepCtx = null;
function playBeep(){
  try {
    if (!beepCtx) beepCtx = new (window.AudioContext||window.webkitAudioContext)();
    if (beepCtx.state === 'suspended') beepCtx.resume();
    const osc = beepCtx.createOscillator(), gain = beepCtx.createGain();
    osc.type = 'sine'; osc.frequency.value = 880;
    gain.gain.value = Math.max(0, Math.min(1, state.volume || 0.8)) * 0.6;
    osc.connect(gain); gain.connect(beepCtx.destination);
    osc.start();
    for (let i = 1; i <= 3; i++){
      const g2 = beepCtx.createGain(), o2 = beepCtx.createOscillator();
      o2.type = 'sine'; o2.frequency.value = 880;
      g2.gain.setValueAtTime(0, beepCtx.currentTime + i*0.6);
      o2.connect(g2); g2.connect(beepCtx.destination);
      o2.start(beepCtx.currentTime + i*0.6); o2.stop(beepCtx.currentTime + i*0.6 + 0.4);
    }
    osc.stop(beepCtx.currentTime + 0.5);
  } catch(e){}
}
$('testSoundBtn').onclick = () => { primeAudioOnGesture(); playReminder(); };
$('soundToggle').onchange = e => { state.soundOn = e.target.checked; save(); };
$('soundTypeSel').onchange = e => { state.soundType = e.target.value; save(); setupAudio(); };
// AUDIT: geser slider tidak lagi menulis localStorage puluhan kali
$('volumeRange').oninput = e => { state.volume = parseFloat(e.target.value); saveSoon(); };
$('adzanUrlInput').onchange = e => {
  const v = e.target.value.trim();
  state.adzanUrl = v;
  if (v && !safeUrl(v)) { toast('URL harus diawali http/https'); }
  save(); setupAudio();
  if (v) toast('MP3 adzan kustom disimpan 🎵');
};
$('adzanAtTimeToggle').onchange = e => { state.adzanAtTime = e.target.checked; save(); };
// Tombol "Uji suara" sudah berupa gestur pengguna: cukup siapkan sumber lalu putar.
function primeAudioOnGesture(){ audioPrimed = true; setupAudio(); }

/* =====================================================================
   ADZAN YOUTUBE (streaming, menghormati hak cipta)
   ===================================================================== */
const YT_ADZAN_ID = 'L6FEUTm20iA';
function loadYTAdzan(wrap, btn){
  if (wrap.style.display === 'block') { wrap.style.display='none'; btn.textContent='▶️ Putar Adzan (YouTube)'; return; }
  if (!wrap.innerHTML) {
    wrap.innerHTML = `<iframe width="100%" height="220" src="https://www.youtube-nocookie.com/embed/${YT_ADZAN_ID}?autoplay=1&rel=0"
      title="Adzan Bilal bin Rabah" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
      allowfullscreen style="display:block;background:#000"></iframe>`;
  }
  wrap.style.display = 'block';
  btn.textContent = '⏹ Tutup Adzan (YouTube)';
}
$('ytPanelBtn').onclick = () => loadYTAdzan($('ytPanelWrap'), $('ytPanelBtn'));
$('ytAdzanBtn').onclick = () => loadYTAdzan($('ytAdzanWrap'), $('ytAdzanBtn'));

/* =====================================================================
   PWA INSTALL
   ===================================================================== */
let deferredPrompt;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); deferredPrompt = e;
  const b = $('installBanner'); b.classList.add('show');
});
$('installBtn').onclick = async () => {
  $('installBanner').classList.remove('show');
  if (deferredPrompt) { deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt=null; }
  else toast('Buka menu browser → "Tambahkan ke layar utama"');
};

/* Service Worker (offline + installability) */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  });
}

/* =====================================================================
   FIREBASE CLOUD MESSAGING (PUSH saat aplikasi tertutup)
   Aktif HANYA jika fcm-config.js diisi. Jika tidak, tetap pakai
   notifikasi lokal.
   ===================================================================== */
function loadScript(src){
  return new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s);
  });
}
async function initFCM(){
  const cfg = (typeof window.FCM_CONFIG !== 'undefined') ? window.FCM_CONFIG : null;
  if (!cfg || !cfg.apiKey) return;                 // FCM belum dikonfigurasi
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return;
  try {
    await Promise.all([
      loadScript('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js'),
      loadScript('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js'),
    ]);
    if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(cfg);
    const messaging = firebase.messaging();

    // Notifikasi foreground (aplikasi terbuka) -> tampilkan lokal.
    // AUDIT: `new Notification()` melempar error di Android Chrome; kini
    // memakai registration.showNotification() lewat showNotification().
    messaging.onMessage((payload) => {
      const n = payload.notification || {};
      const d = payload.data || {};
      showNotification(n.title || d.title || '⏰ Waktu Sholat', {
        body: n.body || d.body || '',
        tag: d.tag || 'sholat',
        url: d.url || './',
      });
    });

    // Daftarkan token ke server
    try {
      const sw = await navigator.serviceWorker.register('firebase-messaging-sw.js');
      const token = await messaging.getToken({
        vapidKey: cfg.vapidKey,
        serviceWorkerRegistration: sw,
      });
      if (token) {
        state.fcmToken = token;
        await sendTokenToServer(token, cfg.serverUrl);
      }
    } catch(e){ console.warn('FCM getToken gagal:', e); }

    // Perbarui token saat izin/registrasi berubah
    messaging.onTokenRefresh(async () => {
      try {
        const sw = await navigator.serviceWorker.ready;
        const token = await messaging.getToken({ vapidKey: cfg.vapidKey, serviceWorkerRegistration: sw });
        if (token) await sendTokenToServer(token, cfg.serverUrl);
      } catch(e){}
    });

    window.__messaging = messaging;
  } catch(e){ console.warn('FCM init gagal:', e); }
}
async function sendTokenToServer(token, serverUrl){
  if (!serverUrl) return;              // tanpa server, push tidak dikirim otomatis
  if (!token) return;                  // AUDIT: dulu token kosong tetap dikirim
  const base = safeUrl(serverUrl);
  if (!base) { console.warn('serverUrl FCM tidak valid'); return; }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    await fetch(base.replace(/\/+$/, '') + '/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        token,
        lat: state.coords ? state.coords.lat : -7.4211,
        lng: state.coords ? state.coords.lng : 109.2343,
        method: state.method,
        school: state.school,
        offsets: state.offsets,
        notifyOn: state.notifyOn,
        adzanAtTime: state.adzanAtTime,
        tz: state.tz || deviceTZ || null,
      }),
    });
    clearTimeout(t);
  } catch(e){ console.warn('Gagal kirim token ke server:', e); }
}
// Panggil saat FCM aktif & data penting berubah (lokasi/metode/offset)
function resyncPush(){
  const cfg = (typeof window.FCM_CONFIG !== 'undefined') ? window.FCM_CONFIG : null;
  if (!cfg || !cfg.apiKey || !cfg.serverUrl || !state.fcmToken) return;
  sendTokenToServer(state.fcmToken, cfg.serverUrl);
}
initFCM();

/* =====================================================================
   INIT
   ===================================================================== */
load();
applyTheme();
$('notifToggle').onchange = e => { state.notifyOn = e.target.checked; save(); updateNotifStatus(); };
updateNotifStatus();

// Meta absolut (og:url, og:image, canonical) diisi dari origin sebenarnya,
// sehingga benar di domain apa pun (Vercel, preview, localhost) tanpa hardcode.
(function absoluteMeta(){
  try {
    const url = location.origin + location.pathname;
    const setContent = (sel, val) => { const el = document.querySelector(sel); if (el) el.setAttribute('content', val); };
    setContent('meta[property="og:url"]', url);
    setContent('meta[property="og:image"]', new URL('icons/icon-512.png', url).href);
    setContent('meta[name="twitter:image"]', new URL('icons/icon-512.png', url).href);
    let link = document.querySelector('link[rel="canonical"]');
    if (!link) { link = document.createElement('link'); link.rel = 'canonical'; document.head.appendChild(link); }
    link.href = url;
  } catch (e) {}
})();

// Pintasan dari manifest PWA (shortcuts): ?tab=quran | qadar | adzan
(function openTabFromQuery(){
  try {
    const p = new URLSearchParams(location.search);
    const map = { quran:'tabQuran', qadar:'tabQadar', adzan:'tabYT', lokasi:'tabLoc' };
    const btn = map[p.get('tab') || ''];
    if (btn && $(btn)) $(btn).click();
  } catch (e) {}
})();

// Bangunkan kembali saat aplikasi kembali aktif (HP dibangunkan / tab dipilih).
// AUDIT: sebelumnya reminder bisa terlewat karena timer di-throttle browser;
// kini jadwal disegarkan & pengingat susulan diperiksa setiap aplikasi aktif.
let reviving = false;
let lastFetchAt = 0;                      // hindari spam API saat tab bolak-balik
function maybeRefresh(maxAgeMs = 5*60*1000){
  if ((Date.now() - lastFetchAt) > maxAgeMs || state.todayKey !== todayKey()) getJadwal();
}
function revive(){
  if (reviving) return;
  reviving = true;
  try { maybeRefresh(); tick(); }
  finally { setTimeout(() => { reviving = false; }, 800); }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) revive(); });
window.addEventListener('focus', revive);
window.addEventListener('online', () => { toast('Kembali online — menyegarkan jadwal'); getJadwal(); });
window.addEventListener('offline', () => toast('Offline — memakai jadwal tersimpan'));

// mulai
getJadwal();
setInterval(() => { // cek pergantian hari
  if (state.todayKey && state.todayKey !== todayKey()) getJadwal();
}, 30000);
tick();
setInterval(tick, 1000);

})();   // akhir IIFE
