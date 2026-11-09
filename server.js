/**
 * Aplikasi Web Lokal WhatsApp Penawaran Website (Anti-Banned)
 * Node.js + Express + whatsapp-web.js + Socket.IO
 * 
 * Didesain khusus untuk keamanan pengiriman:
 * - Pairing code tanpa QR (LocalAuth)
 * - Mode pemanasan (warmup) bertahap otomatis (maksimal 10/20/30/40 per hari)
 * - Jeda acak 45-120 detik + istirahat panjang 5-10 menit tiap 8-12 pesan
 * - Pembatasan jam kirim 09.00-17.00
 * - Simulasi sedang mengetik manusia
 * - Dukungan Spintax & rotasi varian template
 * - Cek nomor terdaftar di WA sebelum kirim
 * - Pesan pertama tanpa tautan & tanpa lampiran
 * - Auto blacklist jika penerima membalas STOP / BERHENTI / TIDAK
 * - Circuit breaker: pemutus darurat jika 3x gagal berturut-turut
 * - Pencatatan log lengkap ke activity.log
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const XLSX = require('xlsx');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const supabaseDb = require('./supabase');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const LOG_FILE = path.join(__dirname, 'activity.log');
const AUTH_DIR = path.join(__dirname, '.wwebjs_auth');

// Pencegah Crash akibat file lock (EBUSY) pada Windows / Puppeteer
process.on('unhandledRejection', (reason) => {
  console.warn('⚠️ [UnhandledRejection prevented]:', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.warn('⚠️ [UncaughtException prevented]:', err && err.message ? err.message : err);
});

// Middleware parsing body
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// 1. MANAJEMEN PENYIMPANAN DATA (data.json)
// ==========================================

let dataStore = {
  warmupStartDate: new Date().toISOString().split('T')[0],
  blacklist: [],
  sentHistory: {},
  dailyStats: {},
  templates: {},
  queueItems: [],
  enforceWorkingHours: false,
  enableQuotaLimit: false,
  users: [],
  sessions: {}
};

const defaultUsers = [
  { id: 'usr_admin', name: 'Super Admin', username: 'prajalinks@gmail.com', password: 'prajalinks0123', role: 'super_admin', status: 'active', createdAt: '2026-10-26T00:00:00.000Z' }
];

/**
 * Muat data dari file data.json
 */
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      dataStore = Object.assign(dataStore, JSON.parse(raw));
    } else {
      saveData();
    }
    // Pastikan sessions object tersedia
    if (!dataStore.sessions || typeof dataStore.sessions !== 'object') {
      dataStore.sessions = {};
    }
    // Pastikan daftar user selalu ada
    if (!Array.isArray(dataStore.users) || dataStore.users.length === 0) {
      dataStore.users = defaultUsers;
      saveData();
    }
  } catch (err) {
    console.error('Gagal memuat data.json:', err.message);
  }
}

/**
 * Simpan data ke data.json secara aman
 */
function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(dataStore, null, 2), 'utf8');
  } catch (err) {
    console.error('Gagal menyimpan data.json:', err.message);
  }
}

// Inisialisasi awal pemuatan data
loadData();

/**
 * Sinkronisasi awal dengan Supabase Cloud Database (Multi-Operator)
 */
async function initSupabaseSync() {
  try {
    const health = await supabaseDb.checkHealth();
    if (health.tablesReady) {
      logActivity('INFO', 'Sinkronisasi data dengan Supabase Cloud dimulai...');
      // 1. Sinkron Users
      const remoteUsers = await supabaseDb.fetchUsers();
      if (remoteUsers && remoteUsers.length > 0) {
        dataStore.users = remoteUsers;
      } else if (dataStore.users && dataStore.users.length > 0) {
        for (const u of dataStore.users) {
          await supabaseDb.upsertUser(u);
        }
      }

      // 2. Sinkron Sent History (Anti-Kirim Ulang Lintas Karyawan)
      const remoteSent = await supabaseDb.fetchSentHistory();
      if (remoteSent) {
        dataStore.sentHistory = Object.assign({}, dataStore.sentHistory, remoteSent);
      }

      // 3. Sinkron Blacklist (Daftar Blokir Bersama)
      const remoteBlacklist = await supabaseDb.fetchBlacklist();
      if (remoteBlacklist) {
        dataStore.blacklist = Array.from(new Set([...dataStore.blacklist, ...remoteBlacklist]));
      }

      if (typeof syncQueueWithSentHistory === 'function') {
        syncQueueWithSentHistory();
      } else {
        saveData();
      }
      logActivity('SUCCESS', 'Sinkronisasi Supabase Cloud berhasil dimuat.');
    } else {
      console.log('ℹ️ Supabase terhubung:', health.message);
    }
  } catch (err) {
    console.warn('Gagal sinkronisasi Supabase:', err.message);
  }
}
initSupabaseSync();

// ==========================================
// 1.1 HELPER AUTENTIKASI & KEAMANAN SESI
// ==========================================

/**
 * Parsing HTTP Cookie header
 */
function parseCookies(req) {
  const list = {};
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    let [name, ...rest] = cookie.split('=');
    name = name?.trim();
    if (!name) return;
    const value = rest.join('=').trim();
    list[name] = decodeURIComponent(value);
  });
  return list;
}

/**
 * Ambil data pengguna dari sesi aktif (Cookie atau Header)
 */
function getSessionUser(req) {
  const cookies = parseCookies(req);
  const token = req.headers['x-session-token'] || 
    (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.slice(7).trim() : null) ||
    cookies['session_token'];

  if (!token) return null;
  if (!dataStore.sessions || !dataStore.sessions[token]) return null;

  const sess = dataStore.sessions[token];
  if (Date.now() > sess.expiresAt) {
    delete dataStore.sessions[token];
    saveData();
    return null;
  }

  // Verifikasi bahwa akun user masih terdaftar dan aktif
  const user = (dataStore.users || []).find(u => u.id === sess.userId);
  if (!user || user.status === 'inactive') {
    delete dataStore.sessions[token];
    saveData();
    return null;
  }

  return {
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.role,
    status: user.status
  };
}

/**
 * Middleware: Wajib Login
 */
function requireAuth(req, res, next) {
  const user = getSessionUser(req);
  if (!user) {
    return res.status(401).json({ success: false, message: 'Sesi Anda telah berakhir atau belum terotentikasi. Silakan login kembali.' });
  }
  req.user = user;
  next();
}

/**
 * Middleware: Khusus Super Admin
 */
function requireSuperAdmin(req, res, next) {
  const user = getSessionUser(req);
  if (!user) {
    return res.status(401).json({ success: false, message: 'Akses ditolak. Silakan login terlebih dahulu.' });
  }
  if (user.role !== 'super_admin') {
    return res.status(403).json({ success: false, message: 'Akses khusus Super Admin.' });
  }
  req.user = user;
  next();
}

// ==========================================
// 1.2 RUTE HALAMAN UTAMA & LOGIN
// ==========================================

// Rute Halaman Login Khusus (LOGIN ONLY)
app.get('/login', (req, res) => {
  const user = getSessionUser(req);
  if (user) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Proteksi Halaman Dashboard Utama (Unauthenticated -> Redirect ke /login)
app.get('/', (req, res) => {
  const user = getSessionUser(req);
  if (!user) {
    return res.redirect('/login');
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// File statis (CSS, JS, Assets) - tanpa otomatis melayani index.html di root
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Konfigurasi upload file dengan Multer (simpan di memori)
const upload = multer({ storage: multer.memoryStorage() });

// ==========================================
// 2. SISTEM LOG AKTIVITAS (activity.log)
// ==========================================

/**
 * Catat aktivitas ke file activity.log dan pancarkan ke UI via socket.io
 * @param {string} level - INFO, SUCCESS, WARN, ERROR, BLACKLIST, CIRCUIT_BREAKER
 * @param {string} message - Pesan log
 * @param {string} number - Nomor terkait (opsional)
 */
function logActivity(level, message, number = '-') {
  const timestamp = new Date().toLocaleString('id-ID', { hour12: false });
  const logLine = `[${timestamp}] [${level}] [${number}] ${message}\n`;

  // Tulis ke file log
  fs.appendFile(LOG_FILE, logLine, (err) => {
    if (err) console.error('Gagal menulis ke activity.log:', err.message);
  });

  // Tampilkan di konsol server
  console.log(`[${level}] [${number}] ${message}`);

  // Kirim ke semua klien web yang terhubung
  io.emit('new_log', {
    timestamp,
    level,
    number,
    message
  });
}

// ==========================================
// 3. UTILITAS FORMAT NOMOR & SPINTAX
// ==========================================

/**
 * Bersihkan dan standardisasi format nomor telepon Indonesia
 * Mengubah 08xxx atau 8xxx menjadi 628xxx, hapus spasi, tanda plus, strip
 */
function sanitizePhoneNumber(rawNumber) {
  if (!rawNumber) {
    return { valid: false, number: '', reason: 'Nomor kosong' };
  }

  let cleaned = String(rawNumber).trim().replace(/\D/g, '');

  if (cleaned.startsWith('08')) {
    cleaned = '62' + cleaned.substring(1);
  } else if (cleaned.startsWith('8')) {
    cleaned = '62' + cleaned;
  } else if (cleaned.startsWith('628')) {
    // Sudah berformat benar
  } else {
    return {
      valid: false,
      number: cleaned,
      reason: 'Bukan nomor Indonesia yang valid (harus diawali 08/628)'
    };
  }

  // Standar nomor seluler Indonesia adalah 10 hingga 15 digit (dengan awalan 62)
  if (cleaned.length < 10 || cleaned.length > 15) {
    return {
      valid: false,
      number: cleaned,
      reason: `Panjang nomor tidak lazim (${cleaned.length} digit)`
    };
  }

  return { valid: true, number: cleaned, reason: '' };
}

/**
 * Pecahkan format Spintax {pilihan1|pilihan2|pilihan3} secara acak
 */
function resolveSpintax(text) {
  if (!text) return '';
  const regex = /\{([^{}]+)\}/g;
  let prev;
  let result = text;
  // Perulangan untuk mendukung spintax bersarang jika ada
  do {
    prev = result;
    result = result.replace(regex, (match, choices) => {
      const parts = choices.split('|');
      return parts[Math.floor(Math.random() * parts.length)];
    });
  } while (result !== prev);
  return result;
}

/**
 * Ganti variabel {nama_bisnis} dan {kategori} serta terapkan Spintax
 */
function generatePersonalizedMessage(template, businessName, category) {
  let text = template;
  text = text.replace(/\{nama_bisnis\}/gi, businessName || 'Bapak/Ibu');
  text = text.replace(/\{kategori\}/gi, category || 'bisnis');
  return resolveSpintax(text);
}

// ==========================================
// 4. ATURAN ANTI-BANNED KETAT
// ==========================================

/**
 * Hitung kuota harian berdasarkan hari pemanasan (Warmup)
 * Hari 1-3   : maks 10 pesan/hari
 * Hari 4-7   : maks 20 pesan/hari
 * Hari 8-14  : maks 30 pesan/hari
 * Setelah itu: maks 40 pesan/hari
 * BATAS TIDAK BISA DINAIKKAN LEWAT PENGATURAN!
 */
function getWarmupInfo() {
  const startDate = new Date(dataStore.warmupStartDate || new Date().toISOString().split('T')[0]);
  const now = new Date();
  
  // Hitung selisih hari kalender
  const diffTime = Math.max(0, now.setHours(0,0,0,0) - startDate.setHours(0,0,0,0));
  const dayNumber = Math.floor(diffTime / (1000 * 60 * 60 * 24)) + 1;

  const isEnforced = Boolean(dataStore.enableQuotaLimit);
  let maxDailyLimit = 40;
  if (dayNumber <= 3) maxDailyLimit = 10;
  else if (dayNumber <= 7) maxDailyLimit = 20;
  else if (dayNumber <= 14) maxDailyLimit = 30;
  else maxDailyLimit = 40;

  const todayKey = new Date().toISOString().split('T')[0];
  const todayStats = dataStore.dailyStats[todayKey] || { sent: 0, failed: 0 };
  const todaySent = todayStats.sent || 0;

  return {
    isEnforced,
    startDate: dataStore.warmupStartDate,
    dayNumber,
    maxDailyLimit: isEnforced ? maxDailyLimit : 'Bebas',
    todaySent,
    remainingToday: isEnforced ? Math.max(0, maxDailyLimit - todaySent) : '∞ Bebas',
    todayKey
  };
}

/**
 * Periksa apakah saat ini berada dalam rentang jam operasional (09.00 - 17.00 waktu setempat)
 */
function checkWorkingHours() {
  const now = new Date();
  const hour = now.getHours();
  const isAllowedTime = hour >= 9 && hour < 17;
  const isEnforced = Boolean(dataStore.enforceWorkingHours);

  // Jika pembatasan jam dinonaktifkan pengguna, selalu diizinkan (bisa kirim kapan saja)
  const isAllowed = !isEnforced || isAllowedTime;

  // Hitung waktu menuju jam 09.00 berikutnya
  const nextOpen = new Date(now);
  if (hour >= 17) {
    nextOpen.setDate(nextOpen.getDate() + 1);
  }
  nextOpen.setHours(9, 0, 0, 0);
  const msUntilNextOpen = Math.max(0, nextOpen.getTime() - now.getTime());

  return {
    isAllowed,
    isEnforced,
    isAllowedTime,
    currentHour: hour,
    nextOpenTime: nextOpen.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }),
    msUntilNextOpen
  };
}

// ==========================================
// 5. INISIALISASI WHATSAPP CLIENT (whatsapp-web.js)
// ==========================================

let client = null;
let clientStatus = 'disconnected'; // disconnected | initializing | pairing_ready | authenticated | ready
let connectedNumber = null;
let lastPairingCode = null;
let currentQrDataUrl = null;
let isInitializingClient = false;

function initWhatsAppClient() {
  if (client || isInitializingClient) return;
  isInitializingClient = true;

  logActivity('INFO', 'Menginisialisasi WhatsApp Client (LocalAuth)...');
  clientStatus = 'initializing';
  io.emit('client_status', { status: clientStatus });

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    }
  });

  // Event ketika siap pairing / scan QR (halaman QR/login muncul di WhatsApp Web)
  client.on('qr', async (qr) => {
    isInitializingClient = false;
    clientStatus = 'pairing_ready';
    try {
      currentQrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
      logActivity('INFO', 'QR code WhatsApp siap di-scan langsung dari kamera HP.');
      io.emit('qr_code', { qrDataUrl: currentQrDataUrl });
    } catch (qrErr) {
      console.error('Gagal membuat QR data URL:', qrErr);
    }
    io.emit('client_status', { status: 'pairing_ready' });
  });

  // Event ketika pairing code diterima dari WhatsApp
  client.on('code', (code) => {
    lastPairingCode = code;
    logActivity('INFO', `Kode pairing diterima: ${code}`);
    io.emit('pairing_code', { code });
  });

  // Event layar loading WhatsApp Web
  client.on('loading_screen', (percent, message) => {
    io.emit('client_status', { status: 'authenticated', text: `Menyiapkan obrolan... (${percent}%)` });
  });

  // Event autentikasi berhasil
  client.on('authenticated', () => {
    isInitializingClient = false;
    clientStatus = 'authenticated';
    logActivity('INFO', 'Sesi WhatsApp berhasil diautentikasi. Menyinkronkan chat...');
    io.emit('client_status', { status: 'authenticated', text: 'Autentikasi Berhasil, Menyiapkan...' });

    // Fallback: Beberapa versi WhatsApp Web tidak memicu event 'ready' secara otomatis
    let checkCount = 0;
    const readyCheckInterval = setInterval(async () => {
      checkCount++;
      if (clientStatus === 'ready' || !client) {
        clearInterval(readyCheckInterval);
        return;
      }
      try {
        let userNum = null;
        if (client.info && client.info.wid) {
          userNum = client.info.wid.user;
        } else if (client.pupPage) {
          userNum = await client.pupPage.evaluate(() => {
            try {
              const u = window.require('WAWebUserPrefsMeUser').getMaybeMePnUser() ||
                        window.require('WAWebUserPrefsMeUser').getMaybeMeLidUser();
              return u ? u.user : null;
            } catch(e) {
              return null;
            }
          });
        }

        if (userNum) {
          clearInterval(readyCheckInterval);
          clientStatus = 'ready';
          connectedNumber = userNum;
          currentQrDataUrl = null;
          logActivity('SUCCESS', `WhatsApp terhubung & siap! Nomor Pengirim: +${connectedNumber}`);
          io.emit('client_status', { status: 'ready', connectedNumber });
        }
      } catch (e) {}

      if (checkCount > 30) {
        clearInterval(readyCheckInterval);
      }
    }, 2000);
  });

  // Event WhatsApp siap mengirim pesan
  client.on('ready', async () => {
    isInitializingClient = false;
    clientStatus = 'ready';
    currentQrDataUrl = null;
    const info = client.info;
    connectedNumber = info && info.wid ? info.wid.user : 'Aktif';
    logActivity('SUCCESS', `WhatsApp terhubung & siap! Nomor Pengirim: +${connectedNumber}`);
    io.emit('client_status', { status: 'ready', connectedNumber });
  });

  // Event gagal autentikasi
  client.on('auth_failure', (msg) => {
    isInitializingClient = false;
    clientStatus = 'disconnected';
    logActivity('ERROR', `Autentikasi WhatsApp gagal: ${msg}`);
    io.emit('client_status', { status: 'auth_failure', error: msg });
  });

  // Event terputus (Circuit Breaker darurat jika terputus saat blast)
  client.on('disconnected', async (reason) => {
    isInitializingClient = false;
    clientStatus = 'disconnected';
    connectedNumber = null;
    logActivity('WARN', `Sesi WhatsApp terputus: ${reason}`);
    io.emit('client_status', { status: 'disconnected', reason });

    // Hentikan antrean pengiriman jika sedang berjalan
    if (queueState.isRunning) {
      pauseQueue('Sesi WhatsApp terputus mendadak. Pengiriman dihentikan demi keamanan.');
    }

    try {
      await client.destroy().catch(() => {});
    } catch (e) {}
    client = null;

    // Bersihkan sesi lama dan siapkan instance baru untuk login berikutnya
    setTimeout(() => {
      logActivity('INFO', 'Menyiapkan kembali halaman login WhatsApp Web yang baru & bersih...');
      initWhatsAppClient();
    }, 2500);
  });

  // ==========================================
  // FITUR ANTI-BANNED: DAFTAR BLOKIR OTOMATIS
  // Tangkap balasan penerima STOP / BERHENTI / TIDAK
  // ==========================================
  client.on('message', async (msg) => {
    try {
      if (!msg.body) return;
      const text = msg.body.trim().toUpperCase();
      const stopKeywords = ['STOP', 'BERHENTI', 'TIDAK', 'JANGAN KIRIM', 'BATAL', 'UNSUBSCRIBE'];

      const isOptOut = stopKeywords.some(keyword => {
        return text === keyword || text.startsWith(keyword + ' ') || text.includes(keyword);
      });

      if (isOptOut) {
        // Ambil nomor pengirim
        const sender = (msg.from || '').replace('@c.us', '').replace(/\D/g, '');
        if (sender && !dataStore.blacklist.includes(sender)) {
          dataStore.blacklist.push(sender);
          saveData();
          supabaseDb.addToBlacklist(sender, msg.body.trim());
          logActivity(
            'BLACKLIST',
            `Nomor ${sender} membalas "${msg.body.trim()}" -> Otomatis dimasukkan ke DAFTAR BLOKIR`,
            sender
          );
          io.emit('blacklist_updated', {
            blacklist: dataStore.blacklist,
            added: sender,
            reason: msg.body.trim()
          });
        }
      }
    } catch (err) {
      console.error('Error saat menangani pesan masuk opt-out:', err);
    }
  });

  // Jalankan inisialisasi
  client.initialize().catch((err) => {
    isInitializingClient = false;
    clientStatus = 'disconnected';
    console.error('Inisialisasi WhatsApp gagal:', err.message);
  });
}

// Inisialisasi WhatsApp saat server dinyalakan
initWhatsAppClient();

// ==========================================
// 6. ANTREAN PENGIRIMAN & SISTEM KONTROL
// ==========================================

const queueState = {
  items: Array.isArray(dataStore.queueItems) ? dataStore.queueItems : [],
  currentIndex: 0,
  isRunning: false,
  isPaused: false,
  consecutiveFailures: 0,
  messagesSinceLongBreak: 0,
  nextLongBreakInterval: Math.floor(Math.random() * (12 - 8 + 1)) + 8, // Tiap 8-12 pesan
  currentWaitTimeout: null,
  pauseReason: '',
  sessionLimit: null,
  sessionSentCount: 0
};

/**
 * Sinkronkan daftar Antrean Kontak dengan seluruh Riwayat Terkirim (sentHistory)
 * agar kontak yang sudah dikirim kemarin/sebelumnya selalu tersimpan & terlihat di tabel Antrean Kontak
 */
function syncQueueWithSentHistory() {
  const existingMap = new Map();

  // 1. Masukkan semua item yang sudah ada di antrean (deduplikasi per nomor)
  if (Array.isArray(queueState.items)) {
    for (const item of queueState.items) {
      if (!item || !item.nomor) continue;
      const num = String(item.nomor).trim();
      const sentInfo = dataStore.sentHistory && dataStore.sentHistory[num];
      if (sentInfo) {
        item.status = 'SUCCESS';
        item.statusText = `Sudah dikirim oleh ${sentInfo.sentBy || 'Super Admin'} pd ${new Date(sentInfo.sentAt).toLocaleDateString('id-ID')}`;
        item.sentBy = sentInfo.sentBy || item.sentBy || 'Super Admin';
        item.sentAt = sentInfo.sentAt || item.sentAt;
        if ((!item.nama_bisnis || item.nama_bisnis === 'Rekan Bisnis') && sentInfo.businessName) {
          item.nama_bisnis = sentInfo.businessName;
        }
        if ((!item.kategori || item.kategori === 'umum') && sentInfo.category) {
          item.kategori = sentInfo.category;
        }
      } else if (dataStore.blacklist && dataStore.blacklist.includes(num)) {
        item.status = 'BLACKLISTED';
        item.statusText = 'Terdaftar di daftar blokir (STOP)';
      }
      if (!existingMap.has(num)) {
        existingMap.set(num, item);
      }
    }
  }

  // 2. Pastikan semua nomor yang pernah terkirim di sentHistory juga ada di daftar Antrean Kontak
  if (dataStore.sentHistory && typeof dataStore.sentHistory === 'object') {
    for (const [num, sentInfo] of Object.entries(dataStore.sentHistory)) {
      if (!num || !sentInfo) continue;
      if (!existingMap.has(num)) {
        existingMap.set(num, {
          id: 0,
          nomor: num,
          rawNomor: num,
          nama_bisnis: sentInfo.businessName || 'Rekan Bisnis',
          kategori: String(sentInfo.category || 'umum').toLowerCase(),
          status: 'SUCCESS',
          statusText: `Sudah dikirim oleh ${sentInfo.sentBy || 'Super Admin'} pd ${new Date(sentInfo.sentAt).toLocaleDateString('id-ID')}`,
          sentBy: sentInfo.sentBy || 'Super Admin',
          sentAt: sentInfo.sentAt
        });
      }
    }
  }

  // 3. Urutkan: yang SUDAH TERKIRIM tetap tersimpan rapi, diikuti yang PENDING, lalu beri nomor urut (id)
  const merged = Array.from(existingMap.values()).map((it, idx) => {
    it.id = idx + 1;
    return it;
  });

  queueState.items = merged;
  dataStore.queueItems = merged;
  saveData();
}

// Jalankan sinkronisasi awal saat startup
syncQueueWithSentHistory();

/**
 * Helper jeda waktu dengan pembatalan jika user menekan Stop
 */
function sleepWithCountdown(seconds, statusMessage) {
  return new Promise((resolve, reject) => {
    let remaining = seconds;
    io.emit('queue_waiting', { remaining, statusMessage });

    const interval = setInterval(() => {
      remaining--;
      if (!queueState.isRunning) {
        clearInterval(interval);
        return reject(new Error('STOPPED'));
      }
      if (queueState.isPaused) {
        // Jika sedang pause, tahan waktu
        io.emit('queue_waiting', { remaining, statusMessage: `${statusMessage} (Dijeda)` });
        return;
      }
      io.emit('queue_waiting', { remaining, statusMessage });
      if (remaining <= 0) {
        clearInterval(interval);
        resolve();
      }
    }, 1000);

    queueState.currentWaitTimeout = interval;
  });
}

/**
 * Loop Utama Pengiriman Pesan
 */
async function processQueue() {
  while (queueState.currentIndex < queueState.items.length && queueState.isRunning) {
    // 1. Cek Pause
    if (queueState.isPaused) {
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }

    // 2. FITUR ANTI-BANNED: CIRCUIT BREAKER (Pemutus Darurat)
    // Jika 3 pengiriman gagal berturut-turut, hentikan otomatis!
    if (queueState.consecutiveFailures >= 3) {
      pauseQueue('⚠️ PEMUTUS DARURAT DIAKTIFKAN: 3 pengiriman gagal berturut-turut! Pengiriman dihentikan otomatis demi keamanan nomor Anda.');
      logActivity('CIRCUIT_BREAKER', 'Pemutus darurat aktif karena 3 pengiriman gagal berturut-turut.');
      io.emit('circuit_breaker', {
        message: 'Pengiriman dihentikan demi keamanan. Periksa nomor tujuan dan koneksi WhatsApp Anda.'
      });
      break;
    }

    // 3. FITUR ANTI-BANNED: PEMBATASAN JAM KIRIM (09.00 - 17.00)
    const hoursCheck = checkWorkingHours();
    if (!hoursCheck.isAllowed) {
      logActivity('WARN', `Di luar jam kirim aman (09.00 - 17.00). Pengiriman menunggu jam 09.00...`);
      io.emit('outside_working_hours', {
        message: `Saat ini di luar jam operasional (09.00 - 17.00). Pengiriman otomatis menunggu hingga jam 09.00.`
      });
      try {
        await sleepWithCountdown(Math.min(600, Math.floor(hoursCheck.msUntilNextOpen / 1000)), 'Menunggu jam operasional 09.00...');
      } catch (e) {
        break; // Berhenti jika dibatalkan
      }
      continue;
    }

    // 4. CEK KUOTA HARIAN (Jika Diaktifkan Pengguna)
    if (dataStore.enableQuotaLimit) {
      const warmupInfo = getWarmupInfo();
      if (typeof warmupInfo.remainingToday === 'number' && warmupInfo.remainingToday <= 0) {
        pauseQueue(`Batas kuota harian (${warmupInfo.maxDailyLimit} pesan/hari pada hari ke-${warmupInfo.dayNumber}) telah tercapai.`);
        logActivity('WARN', `Kuota hari ini habis (${warmupInfo.todaySent}/${warmupInfo.maxDailyLimit}). Lanjutkan besok.`);
        io.emit('quota_exhausted', {
          dayNumber: warmupInfo.dayNumber,
          maxLimit: warmupInfo.maxDailyLimit
        });
        break;
      }
    }

    // Ambil kontak saat ini
    const item = queueState.items[queueState.currentIndex];

    // Jika kontak sudah pernah terkirim atau di-blacklist atau nomor tidak valid, lewati
    if (item.status === 'SUCCESS' || item.status === 'SKIPPED') {
      queueState.currentIndex++;
      continue;
    }

    // Cek kembali daftar blacklist terbaru
    if (dataStore.blacklist.includes(item.nomor)) {
      item.status = 'SKIPPED';
      item.statusText = 'Nomor ada di daftar blokir (STOP)';
      logActivity('WARN', `Nomor ${item.nomor} dilewati (Terdaftar di Blacklist)`, item.nomor);
      io.emit('item_status_update', { index: queueState.currentIndex, item });
      queueState.currentIndex++;
      continue;
    }

    // Cek kembali riwayat terkirim (tidak boleh dikirim ulang)
    if (dataStore.sentHistory[item.nomor]) {
      item.status = 'SKIPPED';
      item.statusText = 'Sudah pernah dikirimi sebelumnya';
      logActivity('INFO', `Nomor ${item.nomor} dilewati (Sudah ada di riwayat terkirim)`, item.nomor);
      io.emit('item_status_update', { index: queueState.currentIndex, item });
      queueState.currentIndex++;
      continue;
    }

    // Pastikan client WhatsApp siap dan benar-benar terhubung secara online
    if (!client || clientStatus !== 'ready') {
      pauseQueue('WhatsApp terputus atau belum siap.');
      logActivity('ERROR', 'WhatsApp belum siap saat giliran pesan dikirim.');
      break;
    }

    const liveState = await client.getState().catch(() => null);
    if (liveState !== 'CONNECTED') {
      pauseQueue(`Koneksi WhatsApp sedang tidak stabil (${liveState || 'Terputus'}). Pengiriman dijeda.`);
      logActivity('WARN', `Pengiriman ditahan karena status WhatsApp belum CONNECTED (Status: ${liveState})`);
      break;
    }

    try {
      // 5. FITUR ANTI-BANNED: CEK APAKAH NOMOR TERDAFTAR DI WHATSAPP
      io.emit('queue_status_text', { text: `Memeriksa nomor WA: ${item.nomor}...` });
      const contactId = await client.getNumberId(item.nomor);

      if (!contactId) {
        // Nomor tidak terdaftar di WhatsApp
        item.status = 'SKIPPED';
        item.statusText = 'Tidak terdaftar di WhatsApp';
        logActivity('WARN', `Nomor ${item.nomor} tidak terdaftar di WhatsApp, dilewati.`, item.nomor);
        io.emit('item_status_update', { index: queueState.currentIndex, item });
        queueState.currentIndex++;
        continue;
      }

      // 6. PILIH & RAKIT PESAN (SPINTAX + VARIABEL)
      // Ambil template berdasarkan kategori atau gunakan umum / hotel
      const categoryKey = (item.kategori || 'umum').toLowerCase();
      let categoryTemplates = dataStore.templates[categoryKey];
      if (!categoryTemplates || !categoryTemplates.length) {
        categoryTemplates = dataStore.templates['hotel'] || dataStore.templates['homestay'] || dataStore.templates['umum'] || [];
      }

      // Pilih template (jika hanya 1 template, gunakan yang itu tanpa acak)
      const selectedTemplate = categoryTemplates && categoryTemplates.length ? categoryTemplates[0] : '';
      const finalMessage = generatePersonalizedMessage(selectedTemplate, item.nama_bisnis, item.kategori);

      // 7. FITUR ANTI-BANNED: SIMULASI MENGETIK SEPERTI MANUSIA
      // Durasi mengetik singkat & alami (2 - 4 detik)
      const typingSeconds = Math.min(4, Math.max(2, Math.round(finalMessage.length * 0.02)));
      item.status = 'TYPING';
      item.statusText = `Simulasi mengetik (${typingSeconds}s)...`;
      io.emit('item_status_update', { index: queueState.currentIndex, item });

      try {
        const chat = await client.getChatById(contactId._serialized);
        await chat.sendStateTyping();
        await sleepWithCountdown(typingSeconds, `Simulasi mengetik untuk ${item.nama_bisnis}...`);
        await chat.clearState();
      } catch (typingErr) {
        // Jika gagal mengubah presence status, jeda biasa tetap dijalankan
        await sleepWithCountdown(typingSeconds, `Simulasi mengetik untuk ${item.nama_bisnis}...`);
      }

      // 8. KIRIM PESAN KE WHATSAPP
      await client.sendMessage(contactId._serialized, finalMessage);

      // Berhasil dikirim!
      item.status = 'SUCCESS';
      item.statusText = 'Terkirim';
      item.sentAt = new Date().toISOString();
      item.messageContent = finalMessage;
      queueState.consecutiveFailures = 0; // Reset circuit breaker counter
      queueState.messagesSinceLongBreak++;

      // Simpan riwayat pengiriman permanen (tidak boleh dikirim ulang)
      dataStore.sentHistory[item.nomor] = {
        sentAt: item.sentAt,
        businessName: item.nama_bisnis,
        category: item.kategori,
        message: finalMessage,
        sentBy: item.sentBy || 'Super Admin'
      };
      // Sinkronkan ke Supabase Cloud
      supabaseDb.recordSentMessage(item.nomor, dataStore.sentHistory[item.nomor]);

      // Update statistik harian
      const todayKey = new Date().toISOString().split('T')[0];
      if (!dataStore.dailyStats[todayKey]) {
        dataStore.dailyStats[todayKey] = { sent: 0, failed: 0 };
      }
      dataStore.dailyStats[todayKey].sent++;
      saveData();

      logActivity(
        'SUCCESS',
        `Pesan terkirim ke [${item.nama_bisnis}] (${item.nomor}). Pesan: "${finalMessage.substring(0, 45)}..."`,
        item.nomor
      );

      dataStore.queueItems = queueState.items;
      saveData();

      io.emit('item_status_update', { index: queueState.currentIndex, item });
      io.emit('warmup_update', getWarmupInfo());

      // Cek apakah target pengiriman sesi tercapai
      queueState.sessionSentCount++;
      if (queueState.sessionLimit && queueState.sessionSentCount >= queueState.sessionLimit) {
        logActivity('SUCCESS', `🎯 Target kirim sesi ini (${queueState.sessionLimit} nomor) telah tercapai! Antrean otomatis dijeda demi keamanan.`);
        pauseQueue(`Target pengiriman sesi (${queueState.sessionLimit} nomor) selesai tercapai.`);
        io.emit('session_limit_reached', {
          limit: queueState.sessionLimit,
          sent: queueState.sessionSentCount
        });
        queueState.currentIndex++;
        break;
      }

    } catch (sendErr) {
      // Penanganan gagal kirim
      queueState.consecutiveFailures++;
      item.status = 'FAILED';
      item.statusText = `Gagal: ${sendErr.message || 'Error pengiriman'}`;

      const todayKey = new Date().toISOString().split('T')[0];
      if (!dataStore.dailyStats[todayKey]) {
        dataStore.dailyStats[todayKey] = { sent: 0, failed: 0 };
      }
      dataStore.dailyStats[todayKey].failed++;
      dataStore.queueItems = queueState.items;
      saveData();

      logActivity('ERROR', `Gagal mengirim ke ${item.nomor}: ${sendErr.message}`, item.nomor);
      io.emit('item_status_update', { index: queueState.currentIndex, item });
    }

    queueState.currentIndex++;

    // Jika antrean selesai
    if (queueState.currentIndex >= queueState.items.length) {
      queueState.isRunning = false;
      logActivity('INFO', 'Semua nomor dalam antrean telah selesai diproses.');
      io.emit('queue_finished', { message: 'Pengiriman selesai!' });
      break;
    }

    // 9. FITUR ANTI-BANNED: ISTIRAHAT PANJANG & JEDA ACAK
    if (queueState.isRunning && !queueState.isPaused) {
      // Cek apakah saatnya istirahat panjang (tiap 8-12 pesan)
      if (queueState.messagesSinceLongBreak >= queueState.nextLongBreakInterval) {
        const longBreakSeconds = Math.floor(Math.random() * (600 - 300 + 1)) + 300; // 5 - 10 menit
        const longBreakMinutes = (longBreakSeconds / 60).toFixed(1);
        logActivity('INFO', `☕ Istirahat panjang anti-banned selama ${longBreakMinutes} menit setelah ${queueState.messagesSinceLongBreak} pesan.`);

        queueState.messagesSinceLongBreak = 0;
        queueState.nextLongBreakInterval = Math.floor(Math.random() * (12 - 8 + 1)) + 8; // Kocok interval baru

        try {
          await sleepWithCountdown(longBreakSeconds, `☕ Istirahat panjang anti-banned (${longBreakMinutes} menit)...`);
        } catch (e) {
          break; // Jika dibatalkan user
        }
      } else {
        // Jeda acak 15-30 detik setelah pesan terkirim
        const randomDelaySeconds = Math.floor(Math.random() * (30 - 15 + 1)) + 15;
        logActivity('INFO', `⏳ Jeda acak ${randomDelaySeconds} detik sebelum nomor berikutnya.`);
        try {
          await sleepWithCountdown(randomDelaySeconds, `⏳ Jeda (${randomDelaySeconds} detik) sebelum nomor berikutnya...`);
        } catch (e) {
          break; // Jika dibatalkan user
        }
      }
    }
  }

  queueState.isRunning = false;
  io.emit('queue_state', getQueueStatePublic());
}

/**
 * Jeda Antrean
 */
function pauseQueue(reason = 'Dijeda oleh pengguna') {
  queueState.isPaused = true;
  queueState.pauseReason = reason;
  logActivity('WARN', `Pengiriman dijeda: ${reason}`);
  io.emit('queue_paused', { reason });
  io.emit('queue_state', getQueueStatePublic());
}

/**
 * Lanjutkan Antrean
 */
function resumeQueue() {
  if (!queueState.isRunning) {
    queueState.isRunning = true;
    queueState.isPaused = false;
    processQueue();
  } else {
    queueState.isPaused = false;
  }
  logActivity('INFO', 'Pengiriman dilanjutkan.');
  io.emit('queue_resumed');
  io.emit('queue_state', getQueueStatePublic());
}

/**
 * Hentikan Antrean Sepenuhnya
 */
function stopQueue() {
  queueState.isRunning = false;
  queueState.isPaused = false;
  if (queueState.currentWaitTimeout) {
    clearInterval(queueState.currentWaitTimeout);
    queueState.currentWaitTimeout = null;
  }
  logActivity('INFO', 'Pengiriman dihentikan sepenuhnya.');
  io.emit('queue_stopped');
  io.emit('queue_state', getQueueStatePublic());
}

function getQueueStatePublic() {
  return {
    total: queueState.items.length,
    currentIndex: queueState.currentIndex,
    isRunning: queueState.isRunning,
    isPaused: queueState.isPaused,
    pauseReason: queueState.pauseReason,
    consecutiveFailures: queueState.consecutiveFailures
  };
}

// ==========================================
// 7. REST API ENDPOINTS
// ==========================================

/**
 * Autentikasi Pengguna (Login - LOGIN ONLY, NO REGISTER)
 */
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username / Email dan password wajib diisi!' });
  }

  const cleanUser = String(username).trim().toLowerCase();
  const user = (dataStore.users || []).find(u => 
    u.username.trim().toLowerCase() === cleanUser && 
    String(u.password) === String(password)
  );

  if (!user) {
    return res.status(401).json({ success: false, message: 'Username/Email atau password yang Anda masukkan salah.' });
  }

  if (user.status === 'inactive') {
    return res.status(403).json({ success: false, message: 'Akun Anda dinonaktifkan oleh Super Admin. Silakan hubungi administrator.' });
  }

  // Buat sesi acak berkekuatan kriptografis (64 hex characters)
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + (30 * 24 * 60 * 60 * 1000); // 30 hari

  if (!dataStore.sessions || typeof dataStore.sessions !== 'object') {
    dataStore.sessions = {};
  }

  dataStore.sessions[sessionToken] = {
    token: sessionToken,
    userId: user.id,
    username: user.username,
    role: user.role,
    name: user.name,
    createdAt: new Date().toISOString(),
    expiresAt
  };
  saveData();

  // Simpan cookie HttpOnly untuk otentikasi browser yang aman
  res.cookie('session_token', sessionToken, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/'
  });

  logActivity('INFO', `Pengguna "${user.name}" (${user.role}) berhasil masuk ke sistem.`);
  res.json({
    success: true,
    token: sessionToken,
    user: {
      id: user.id,
      name: user.name,
      username: user.username,
      role: user.role,
      status: user.status
    }
  });
});

/**
 * Cek Sesi Pengguna Aktif
 */
app.get('/api/auth/me', (req, res) => {
  const user = getSessionUser(req);
  if (!user) {
    return res.status(401).json({ success: false, message: 'Sesi tidak valid atau telah berakhir.' });
  }
  res.json({ success: true, user });
});

/**
 * Logout Pengguna
 */
app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req);
  const token = req.headers['x-session-token'] || 
    (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.slice(7).trim() : null) ||
    cookies['session_token'];

  if (token && dataStore.sessions && dataStore.sessions[token]) {
    delete dataStore.sessions[token];
    saveData();
  }

  res.clearCookie('session_token', { path: '/' });
  res.json({ success: true, message: 'Berhasil keluar.' });
});

/**
 * Kelola Daftar Karyawan (Super Admin)
 */
app.get('/api/users', requireAuth, (req, res) => {
  const stats = {};
  Object.values(dataStore.sentHistory || {}).forEach(item => {
    const by = item.sentBy || 'Super Admin';
    stats[by] = (stats[by] || 0) + 1;
  });

  const list = (dataStore.users || []).map(u => ({
    id: u.id,
    name: u.name,
    username: u.username,
    role: u.role,
    status: u.status,
    totalSent: stats[u.name] || 0,
    createdAt: u.createdAt
  }));

  res.json({ success: true, users: list });
});

/**
 * Tambah Karyawan Baru (Super Admin Only)
 */
app.post('/api/users', requireSuperAdmin, (req, res) => {
  const { name, username, password, role } = req.body;
  if (!name || !username || !password) {
    return res.status(400).json({ success: false, message: 'Nama, username, dan password wajib diisi' });
  }

  const cleanUsername = String(username).trim().toLowerCase();
  const exists = (dataStore.users || []).some(u => u.username.toLowerCase() === cleanUsername);
  if (exists) {
    return res.status(400).json({ success: false, message: `Username "${username}" sudah digunakan!` });
  }

  const newUser = {
    id: 'usr_' + Date.now(),
    name: String(name).trim(),
    username: cleanUsername,
    password: String(password).trim(),
    role: role === 'super_admin' ? 'super_admin' : 'karyawan',
    status: 'active',
    createdAt: new Date().toISOString()
  };

  dataStore.users.push(newUser);
  saveData();
  supabaseDb.upsertUser(newUser);

  logActivity('INFO', `Karyawan baru ditambahkan: ${newUser.name} (${newUser.username})`);
  res.json({ success: true, user: newUser });
});

/**
 * Perbarui Data Karyawan (Super Admin Only)
 */
app.put('/api/users/:id', requireSuperAdmin, (req, res) => {
  const userId = req.params.id;
  const { name, password, role, status } = req.body;

  const user = (dataStore.users || []).find(u => u.id === userId);
  if (!user) {
    return res.status(404).json({ success: false, message: 'Pengguna tidak ditemukan' });
  }

  if (name) user.name = String(name).trim();
  if (password) user.password = String(password).trim();
  if (role) user.role = role;
  if (status) user.status = status;

  saveData();
  supabaseDb.upsertUser(user);
  logActivity('INFO', `Data karyawan ${user.name} berhasil diperbarui.`);
  res.json({ success: true, user });
});

/**
 * Hapus Karyawan (Super Admin Only)
 */
app.delete('/api/users/:id', requireSuperAdmin, (req, res) => {
  const userId = req.params.id;
  const user = (dataStore.users || []).find(u => u.id === userId);
  if (!user) {
    return res.status(404).json({ success: false, message: 'Karyawan tidak ditemukan' });
  }

  if (userId === 'usr_admin' || user.role === 'super_admin') {
    return res.status(400).json({ success: false, message: 'Akun Super Admin tidak boleh dihapus!' });
  }

  dataStore.users = dataStore.users.filter(u => u.id !== userId);
  saveData();
  supabaseDb.deleteUser(userId);
  logActivity('INFO', `Akun karyawan "${user.name}" (${user.username}) dihapus.`);
  res.json({ success: true, message: 'Karyawan berhasil dihapus' });
});

/**
 * Status sistem saat ini
 */
app.get('/api/inspect-msg', async (req, res) => {
  if (!client || !client.pupPage) return res.json({ error: 'No client or page' });
  try {
    const data = await client.pupPage.evaluate(() => {
      try {
        const chats = window.Store.Chat.models;
        const result = [];
        for (const c of chats) {
          const msgs = c.msgs ? c.msgs.models : [];
          const lastMsg = msgs[msgs.length - 1];
          if (lastMsg) {
            result.push({
              id: c.id._serialized,
              name: c.name || c.formattedTitle,
              lastMsgBody: lastMsg.body ? lastMsg.body.substring(0, 50) : null,
              ack: lastMsg.ack, // -1=error, 0=pending/clock, 1=server, 2=device, 3=read
              fromMe: lastMsg.id ? lastMsg.id.fromMe : null,
              status: lastMsg.status
            });
          }
        }
        return result;
      } catch(e) {
        return e.message;
      }
    });
    res.json({ data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/debug-wa', async (req, res) => {
  if (!client) return res.json({ error: 'No client' });
  try {
    const state = await client.getState().catch(e => e.message);
    let pageUrl = null;
    let pageTitle = null;
    let chatList = [];
    if (client.pupPage) {
      pageUrl = client.pupPage.url();
      pageTitle = await client.pupPage.title().catch(() => '');
      await client.pupPage.evaluate(() => {
        const item = document.querySelector('div[data-testid="cell-frame-container"]');
        if (item) item.click();
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 1200));
      await client.pupPage.screenshot({ path: 'wa_screen.png' }).catch(() => {});
      const bodySnippet = await client.pupPage.evaluate(() => {
        try {
          const chatItems = document.querySelectorAll('div[data-testid="cell-frame-container"], div[role="listitem"]');
          const list = [];
          chatItems.forEach(el => {
            list.push(el.innerText.replace(/\n+/g, ' | '));
          });
          return list.slice(0, 10);
        } catch(e) {
          return document.body ? document.body.innerText.substring(0, 400) : 'No body';
        }
      }).catch(e => e.message);
      chatList = { bodySnippet };
    }
    res.json({
      clientStatus,
      connectedNumber,
      state,
      pageUrl,
      pageTitle,
      chatList
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', async (req, res) => {
  if (clientStatus === 'authenticated' && client && client.pupPage) {
    try {
      let userNum = null;
      if (client.info && client.info.wid) {
        userNum = client.info.wid.user;
      } else {
        userNum = await client.pupPage.evaluate(() => {
          try {
            const u = window.require('WAWebUserPrefsMeUser').getMaybeMePnUser() ||
                      window.require('WAWebUserPrefsMeUser').getMaybeMeLidUser();
            return u ? u.user : null;
          } catch(e) { return null; }
        });
      }
      if (userNum) {
        clientStatus = 'ready';
        connectedNumber = userNum;
        currentQrDataUrl = null;
        logActivity('SUCCESS', `WhatsApp terhubung & siap! Nomor Pengirim: +${connectedNumber}`);
        io.emit('client_status', { status: 'ready', connectedNumber });
      }
    } catch(e) {}
  }

  res.json({
    clientStatus,
    connectedNumber,
    qrDataUrl: currentQrDataUrl,
    warmup: getWarmupInfo(),
    workingHours: checkWorkingHours(),
    queue: getQueueStatePublic(),
    blacklistCount: dataStore.blacklist.length,
    sentHistoryCount: Object.keys(dataStore.sentHistory).length
  });
});

/**
 * Pengaturan Pembatasan Jam Kerja
 */
app.post('/api/toggle-working-hours', (req, res) => {
  dataStore.enforceWorkingHours = !dataStore.enforceWorkingHours;
  saveData();
  const wh = checkWorkingHours();
  logActivity('INFO', `Pengaturan jam kirim diubah: ${dataStore.enforceWorkingHours ? 'Hanya 09.00-17.00' : 'Bebas (Kirim Kapan Saja)'}`);
  io.emit('working_hours_update', wh);
  res.json({ success: true, enforceWorkingHours: dataStore.enforceWorkingHours, workingHours: wh });
});

/**
 * Pengaturan Batas Kuota Harian (Bebas / Dibatasi)
 */
app.post('/api/toggle-quota-limit', (req, res) => {
  dataStore.enableQuotaLimit = !dataStore.enableQuotaLimit;
  saveData();
  const info = getWarmupInfo();
  logActivity('INFO', `Batas kuota harian diubah: ${dataStore.enableQuotaLimit ? 'Aktif (Dibatasi)' : 'Nonaktif (Tanpa Batas / Bebas)'}`);
  io.emit('warmup_update', info);
  res.json({ success: true, enableQuotaLimit: dataStore.enableQuotaLimit, warmup: info });
});

/**
 * Muat Ulang / Ambil QR Code Baru
 */
app.post('/api/refresh-qr', async (req, res) => {
  try {
    currentQrDataUrl = null;
    if (client && client.pupPage) {
      logActivity('INFO', 'Meminta WhatsApp Web menyegarkan QR code...');
      await client.cancelPairingCode().catch(() => {});
    } else if (!client) {
      initWhatsAppClient();
    }
    res.json({ success: true, message: 'QR Code sedang disegarkan...' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * Permintaan Pairing Code (Tanpa QR)
 */
app.post('/api/request-pairing', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
      return res.status(400).json({ success: false, message: 'Nomor telepon wajib diisi' });
    }

    const sanitized = sanitizePhoneNumber(phoneNumber);
    if (!sanitized.valid) {
      return res.status(400).json({ success: false, message: sanitized.reason });
    }

    // Jika client belum ada atau statusnya terputus/disconnected, restart bersih
    if (!client || clientStatus === 'disconnected') {
      if (client) {
        try { await client.destroy().catch(() => {}); } catch (e) {}
        client = null;
      }
      initWhatsAppClient();
    }

    // Tunggu browser WhatsApp siap jika masih tahap loading (maksimal 25 detik)
    let waited = 0;
    while ((!client.pupPage || clientStatus === 'initializing') && waited < 25000) {
      await new Promise(r => setTimeout(r, 1000));
      waited += 1000;
    }

    if (!client.pupPage) {
      return res.status(500).json({
        success: false,
        message: 'Browser WhatsApp masih tahap pemuatan awal, silakan coba klik lagi dalam beberapa detik.'
      });
    }

    logActivity('INFO', `Meminta pairing code untuk nomor: +${sanitized.number}`);

    // Pastikan PairingCodeLinkUtils siap di halaman WhatsApp Web sebelum memanggil requestPairingCode
    let readyForPairing = false;
    for (let i = 0; i < 6; i++) {
      try {
        const hasUtils = await client.pupPage.evaluate(() => {
          return typeof window.Store !== 'undefined' && typeof window.Store.PairingCodeLinkUtils !== 'undefined';
        });
        if (hasUtils) {
          readyForPairing = true;
          break;
        }
      } catch (e) {}
      await new Promise(r => setTimeout(r, 1500));
    }

    if (!readyForPairing) {
      // Muat ulang halaman login WhatsApp Web jika belum siap
      try {
        await client.pupPage.reload({ waitUntil: 'networkidle0', timeout: 30000 });
        await new Promise(r => setTimeout(r, 3000));
      } catch (e) {}
    }

    // Panggil fungsi bawaan requestPairingCode
    const code = await client.requestPairingCode(sanitized.number);
    lastPairingCode = code;

    logActivity('SUCCESS', `Pairing code berhasil didapatkan: ${code}`);
    res.json({ success: true, code });
  } catch (err) {
    console.error('Error saat requestPairingCode:', err);
    res.status(500).json({
      success: false,
      message: err.message || 'Gagal meminta pairing code. Pastikan WhatsApp client siap.'
    });
  }
});

/**
 * Putus koneksi WhatsApp / Logout
 */
app.post('/api/logout', async (req, res) => {
  try {
    if (client) {
      await client.logout().catch(() => {});
      await client.destroy().catch(() => {});
      client = null;
    }
    clientStatus = 'disconnected';
    connectedNumber = null;
    logActivity('INFO', 'Pengguna melakukan logout dari sesi WhatsApp.');
    io.emit('client_status', { status: 'disconnected' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * Unggah & Parse File Excel/CSV
 */
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'File tidak ditemukan' });
    }

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (!rawRows || rawRows.length === 0) {
      return res.status(400).json({ success: false, message: 'File Excel/CSV kosong' });
    }

    // Pastikan antrean yang ada sudah tersinkron dengan riwayat terkirim kemarin/sebelumnya
    syncQueueWithSentHistory();

    // Gunakan Map agar data kontak lama (yang sudah terkirim maupun belum) TETAP TERSIMPAN & digabungkan tanpa duplikat
    const existingMap = new Map();
    for (const item of queueState.items) {
      if (item && item.nomor) {
        existingMap.set(String(item.nomor).trim(), item);
      }
    }

    const seenNumbersInFile = new Set();
    let countValid = 0;
    let countDuplicate = 0;
    let countBlacklisted = 0;
    let countAlreadySent = 0;
    let countInvalid = 0;

    for (let i = 0; i < rawRows.length; i++) {
      const row = rawRows[i];

      // Normalisasi nama kolom (case insensitive)
      let rawNomor = '';
      let namaBisnis = '';
      let kategori = 'umum';

      for (const key of Object.keys(row)) {
        const lowerKey = key.trim().toLowerCase();
        if (lowerKey === 'nomor' || lowerKey === 'no' || lowerKey === 'no_hp' || lowerKey === 'phone' || lowerKey === 'telepon') {
          rawNomor = row[key];
        } else if (lowerKey === 'nama_bisnis' || lowerKey === 'nama' || lowerKey === 'bisnis' || lowerKey === 'hotel' || lowerKey === 'business_name') {
          namaBisnis = row[key];
        } else if (lowerKey === 'kategori' || lowerKey === 'category' || lowerKey === 'tipe') {
          kategori = row[key];
        }
      }

      const sanitized = sanitizePhoneNumber(rawNomor);

      if (!sanitized.valid) {
        countInvalid++;
        continue;
      }

      const num = sanitized.number;
      if (seenNumbersInFile.has(num)) {
        countDuplicate++;
        continue;
      }
      seenNumbersInFile.add(num);

      const cleanNama = String(namaBisnis).trim();
      const cleanKat = String(kategori).trim().toLowerCase();

      if (dataStore.blacklist.includes(num)) {
        countBlacklisted++;
        const prevItem = existingMap.get(num) || {};
        existingMap.set(num, {
          ...prevItem,
          id: 0,
          nomor: num,
          rawNomor,
          nama_bisnis: cleanNama || prevItem.nama_bisnis || 'Rekan Bisnis',
          kategori: cleanKat || prevItem.kategori || 'umum',
          status: 'BLACKLISTED',
          statusText: 'Terdaftar di daftar blokir (STOP)',
          sentBy: req.body.operatorName || prevItem.sentBy || 'Super Admin'
        });
      } else if (dataStore.sentHistory[num]) {
        countAlreadySent++;
        const prev = dataStore.sentHistory[num];
        const prevItem = existingMap.get(num) || {};
        existingMap.set(num, {
          ...prevItem,
          id: 0,
          nomor: num,
          rawNomor,
          nama_bisnis: cleanNama || prev.businessName || prevItem.nama_bisnis || 'Rekan Bisnis',
          kategori: cleanKat || prev.category || prevItem.kategori || 'umum',
          status: 'SUCCESS',
          statusText: `Sudah dikirim oleh ${prev.sentBy || 'Super Admin'} pd ${new Date(prev.sentAt).toLocaleDateString('id-ID')}`,
          sentBy: prev.sentBy || 'Super Admin',
          sentAt: prev.sentAt
        });
      } else if (existingMap.has(num)) {
        const ex = existingMap.get(num);
        if (ex.status === 'SUCCESS' || ex.status === 'ALREADY_SENT') {
          countAlreadySent++;
        } else {
          if (cleanNama) ex.nama_bisnis = cleanNama;
          if (cleanKat) ex.kategori = cleanKat;
          ex.status = 'READY';
          ex.statusText = 'Pending (Siap Kirim)';
          countValid++;
        }
      } else {
        countValid++;
        existingMap.set(num, {
          id: 0,
          nomor: num,
          rawNomor,
          nama_bisnis: cleanNama || 'Rekan Bisnis',
          kategori: cleanKat || 'umum',
          status: 'READY',
          statusText: 'Pending (Siap Kirim)',
          sentBy: req.body.operatorName || 'Super Admin'
        });
      }
    }

    const mergedRows = Array.from(existingMap.values()).map((it, idx) => {
      it.id = idx + 1;
      return it;
    });

    // Set item antrean gabungan & simpan permanen ke data.json + Supabase
    queueState.items = mergedRows;
    queueState.currentIndex = 0;
    dataStore.queueItems = mergedRows;
    saveData();
    supabaseDb.syncQueueItems(mergedRows);

    const totalSentInQueue = mergedRows.filter(r => r.status === 'SUCCESS' || r.status === 'ALREADY_SENT').length;
    const totalReadyInQueue = mergedRows.filter(r => r.status === 'READY').length;

    logActivity('INFO', `File diimpor & digabungkan: +${rawRows.length} baris dari Excel. Total tersimpan: ${mergedRows.length} kontak (${totalReadyInQueue} belum dikirim, ${totalSentInQueue} sudah terkirim).`);

    res.json({
      success: true,
      summary: {
        total: mergedRows.length,
        valid: totalReadyInQueue,
        duplicate: countDuplicate,
        blacklisted: countBlacklisted,
        alreadySent: totalSentInQueue,
        invalid: countInvalid
      },
      rows: mergedRows
    });
  } catch (err) {
    console.error('Gagal memproses file:', err);
    res.status(500).json({ success: false, message: 'Gagal memproses file: ' + err.message });
  }
});

/**
 * Mulai Pengiriman Semua Kontak
 */
app.post('/api/queue/start', (req, res) => {
  if (queueState.items.length === 0) {
    return res.status(400).json({ success: false, message: 'Belum ada kontak yang diimpor!' });
  }

  if (clientStatus !== 'ready') {
    return res.status(400).json({ success: false, message: 'WhatsApp belum terhubung!' });
  }

  if (dataStore.enableQuotaLimit) {
    const warmup = getWarmupInfo();
    if (typeof warmup.remainingToday === 'number' && warmup.remainingToday <= 0) {
      return res.status(400).json({
        success: false,
        message: `Kuota hari ini sudah penuh (${warmup.todaySent}/${warmup.maxDailyLimit}).`
      });
    }
  }

  const rawLimit = req.body && req.body.limit;
  const parsedLimit = parseInt(rawLimit, 10);
  queueState.sessionLimit = (!isNaN(parsedLimit) && parsedLimit > 0) ? parsedLimit : null;
  queueState.sessionSentCount = 0;

  queueState.isRunning = true;
  queueState.isPaused = false;
  queueState.consecutiveFailures = 0;

  processQueue();

  res.json({
    success: true,
    message: queueState.sessionLimit ? `Pengiriman dimulai (Target: ${queueState.sessionLimit} nomor)` : 'Pengiriman dimulai'
  });
});

/**
 * Pause / Lanjutkan / Stop
 */
app.post('/api/queue/pause', (req, res) => {
  pauseQueue('Dijeda oleh pengguna');
  res.json({ success: true });
});

app.post('/api/queue/resume', (req, res) => {
  resumeQueue();
  res.json({ success: true });
});

app.post('/api/queue/stop', (req, res) => {
  stopQueue();
  res.json({ success: true });
});

/**
 * Ambil Daftar Kontak Antrean yang Tersimpan
 */
app.get('/api/queue', (req, res) => {
  syncQueueWithSentHistory();
  res.json({
    success: true,
    rows: queueState.items,
    state: getQueueStatePublic()
  });
});

/**
 * Tambah Kontak Baru Secara Manual (Input Sendiri)
 */
app.post('/api/queue/add', (req, res) => {
  try {
    const { nomor, nama_bisnis, kategori } = req.body;
    if (!nomor) {
      return res.status(400).json({ success: false, message: 'Nomor WhatsApp wajib diisi' });
    }

    const sanitized = sanitizePhoneNumber(nomor);
    let status = 'READY';
    let statusText = 'Pending (Siap Kirim)';

    if (!sanitized.valid) {
      status = 'INVALID';
      statusText = sanitized.reason;
    } else if (dataStore.blacklist.includes(sanitized.number)) {
      status = 'BLACKLISTED';
      statusText = 'Terdaftar di daftar blokir (STOP)';
    } else if (dataStore.sentHistory[sanitized.number]) {
      const prev = dataStore.sentHistory[sanitized.number];
      status = 'ALREADY_SENT';
      statusText = `Sudah dikirim oleh ${prev.sentBy || 'Super Admin'} pd ${new Date(prev.sentAt).toLocaleDateString('id-ID')}`;
    } else if (queueState.items.some(it => it.nomor === sanitized.number)) {
      status = 'DUPLICATE';
      statusText = 'Nomor sudah ada di antrean';
    }

    const newItem = {
      id: queueState.items.length + 1,
      nomor: sanitized.number || String(nomor).trim(),
      rawNomor: nomor,
      nama_bisnis: String(nama_bisnis || '').trim() || 'Rekan Bisnis',
      kategori: String(kategori || 'umum').trim().toLowerCase(),
      status,
      statusText,
      sentBy: req.body.operatorName || 'Super Admin'
    };

    queueState.items.push(newItem);
    dataStore.queueItems = queueState.items;
    saveData();

    logActivity('INFO', `Kontak manual ditambahkan: ${newItem.nama_bisnis} (${newItem.nomor})`, newItem.nomor);
    io.emit('queue_state', getQueueStatePublic());

    res.json({ success: true, item: newItem, rows: queueState.items });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * Kosongkan Seluruh Antrean Kontak
 */
app.delete('/api/queue/clear', (req, res) => {
  if (queueState.isRunning) {
    return res.status(400).json({ success: false, message: 'Tidak dapat mengosongkan antrean saat pengiriman sedang berjalan. Hentikan (Stop) terlebih dahulu.' });
  }
  queueState.items = [];
  queueState.currentIndex = 0;
  dataStore.queueItems = [];
  saveData();
  logActivity('INFO', 'Daftar antrean kontak dikosongkan oleh pengguna.');
  io.emit('queue_state', getQueueStatePublic());
  res.json({ success: true, message: 'Antrean berhasil dikosongkan' });
});

/**
 * Hapus 1 Baris Kontak Tertentu dari Antrean
 */
app.delete('/api/queue/item/:index', (req, res) => {
  const idx = parseInt(req.params.index, 10);
  if (isNaN(idx) || idx < 0 || idx >= queueState.items.length) {
    return res.status(400).json({ success: false, message: 'Indeks tidak valid' });
  }

  const removed = queueState.items.splice(idx, 1)[0];
  if (queueState.currentIndex > idx) {
    queueState.currentIndex--;
  }

  // Perbarui nomor urut id
  queueState.items.forEach((item, i) => { item.id = i + 1; });
  dataStore.queueItems = queueState.items;
  saveData();

  logActivity('INFO', `Kontak ${removed.nama_bisnis} (${removed.nomor}) dihapus dari antrean.`);
  io.emit('queue_state', getQueueStatePublic());
  res.json({ success: true, total: queueState.items.length });
});

/**
 * Kirim Pesan ke 1 Kontak Tertentu (Kirim Satu per Satu)
 */
app.post('/api/queue/send-single', async (req, res) => {
  try {
    const idx = parseInt(req.body.index, 10);
    if (isNaN(idx) || idx < 0 || idx >= queueState.items.length) {
      return res.status(400).json({ success: false, message: 'Kontak tidak ditemukan atau indeks tidak valid' });
    }

    if (queueState.isRunning && !queueState.isPaused) {
      return res.status(400).json({
        success: false,
        message: 'Pengiriman otomatis ("Kirim Semua") sedang berjalan! Klik Pause atau Stop terlebih dahulu jika ingin mengirim manual satu per satu.'
      });
    }

    if (!client || clientStatus !== 'ready') {
      return res.status(400).json({
        success: false,
        message: 'WhatsApp belum terhubung atau belum siap. Pastikan nomor sudah terkoneksi.'
      });
    }

    const item = queueState.items[idx];

    // Cek apakah nomor ada di blacklist
    if (dataStore.blacklist.includes(item.nomor)) {
      item.status = 'BLACKLISTED';
      item.statusText = 'Nomor ada di daftar blokir (STOP)';
      saveData();
      io.emit('item_status_update', { index: idx, item });
      return res.status(400).json({ success: false, message: `Nomor ${item.nomor} ada di daftar blokir (STOP).` });
    }

    // Cek apakah nomor sudah pernah dikirimi (bisa di-override jika user ingin kirim ulang kustom)
    if (dataStore.sentHistory[item.nomor] && !req.body.forceResend) {
      const prev = dataStore.sentHistory[item.nomor];
      item.status = 'ALREADY_SENT';
      item.statusText = `Sudah dikirim oleh ${prev.sentBy || 'Super Admin'}`;
      saveData();
      io.emit('item_status_update', { index: idx, item });
      return res.status(400).json({
        success: false,
        requiresConfirmation: true,
        message: `Nomor ${item.nomor} sudah pernah dikirimi sebelumnya oleh ${prev.sentBy || 'Super Admin'}.`
      });
    }

    // Validasi nomor di WhatsApp
    io.emit('queue_status_text', { text: `[Kirim Manual] Memeriksa nomor WA: ${item.nomor}...` });
    const contactId = await client.getNumberId(item.nomor);
    if (!contactId) {
      item.status = 'SKIPPED';
      item.statusText = 'Tidak terdaftar di WhatsApp';
      saveData();
      io.emit('item_status_update', { index: idx, item });
      return res.status(400).json({ success: false, message: `Nomor ${item.nomor} tidak terdaftar di WhatsApp.` });
    }

    // Ambil & rakit pesan personal atau gunakan customMessage jika disediakan oleh pengguna
    let finalMessage = '';
    if (req.body.customMessage && String(req.body.customMessage).trim().length > 0) {
      finalMessage = String(req.body.customMessage).trim();
    } else {
      const categoryKey = (item.kategori || 'umum').toLowerCase();
      let categoryTemplates = dataStore.templates[categoryKey];
      if (!categoryTemplates || !categoryTemplates.length) {
        categoryTemplates = dataStore.templates['hotel'] || dataStore.templates['homestay'] || dataStore.templates['umum'] || [];
      }
      const selectedTemplate = categoryTemplates && categoryTemplates.length ? categoryTemplates[0] : '';
      finalMessage = generatePersonalizedMessage(selectedTemplate, item.nama_bisnis, item.kategori);
    }

    // Simulasi mengetik manusia (2-4 detik)
    const typingSeconds = Math.min(4, Math.max(2, Math.round(finalMessage.length * 0.02)));
    item.status = 'TYPING';
    item.statusText = `Simulasi mengetik (${typingSeconds}s)...`;
    io.emit('item_status_update', { index: idx, item });

    try {
      const chat = await client.getChatById(contactId._serialized);
      await chat.sendStateTyping();
      await new Promise(r => setTimeout(r, typingSeconds * 1000));
      await chat.clearState();
    } catch (e) {
      await new Promise(r => setTimeout(r, typingSeconds * 1000));
    }

    // Kirim pesan ke WhatsApp
    await client.sendMessage(contactId._serialized, finalMessage);

    const sessUser = getSessionUser(req);
    const operatorName = sessUser ? sessUser.name : (item.sentBy || 'Super Admin');

    item.status = 'SUCCESS';
    item.statusText = 'Terkirim';
    item.sentAt = new Date().toISOString();
    item.messageContent = finalMessage;
    item.sentBy = operatorName;

    // Catat ke riwayat lokal
    dataStore.sentHistory[item.nomor] = {
      sentAt: item.sentAt,
      businessName: item.nama_bisnis,
      category: item.kategori,
      message: finalMessage,
      sentBy: operatorName
    };

    // Update daily stats
    const todayKey = new Date().toISOString().split('T')[0];
    if (!dataStore.dailyStats[todayKey]) {
      dataStore.dailyStats[todayKey] = { sent: 0, failed: 0 };
    }
    dataStore.dailyStats[todayKey].sent++;

    dataStore.queueItems = queueState.items;
    saveData();

    // Simpan ke Supabase Cloud
    supabaseDb.recordSentMessage(item.nomor, dataStore.sentHistory[item.nomor]);

    logActivity(
      'SUCCESS',
      `[Kirim Manual] Pesan terkirim ke [${item.nama_bisnis}] (${item.nomor}) oleh ${operatorName}`,
      item.nomor
    );

    io.emit('item_status_update', { index: idx, item });
    io.emit('warmup_update', getWarmupInfo());

    res.json({
      success: true,
      message: `Pesan berhasil dikirim ke ${item.nama_bisnis} (${item.nomor})!`,
      item
    });
  } catch (err) {
    console.error('Error send-single:', err);
    res.status(500).json({ success: false, message: `Gagal mengirim pesan: ${err.message}` });
  }
});

/**
 * Endpoint Status & Sinkronisasi Supabase
 */
app.get('/api/supabase/status', async (req, res) => {
  const health = await supabaseDb.checkHealth();
  res.json({
    success: true,
    configured: supabaseDb.isConfigured(),
    ...health
  });
});

app.post('/api/supabase/sync', async (req, res) => {
  await initSupabaseSync();
  const health = await supabaseDb.checkHealth();
  res.json({
    success: true,
    message: health.tablesReady ? 'Sinkronisasi Supabase berhasil!' : health.message,
    health
  });
});

/**
 * Ambil & Simpan Template Pesan
 */
app.get('/api/templates', (req, res) => {
  res.json({ success: true, templates: dataStore.templates });
});

app.post('/api/templates', (req, res) => {
  const { templates } = req.body;
  if (!templates || typeof templates !== 'object') {
    return res.status(400).json({ success: false, message: 'Format template tidak valid' });
  }

  dataStore.templates = templates;
  saveData();
  logActivity('INFO', 'Template pesan berhasil diperbarui');
  res.json({ success: true, message: 'Template berhasil disimpan!' });
});

/**
 * Preview Spintax Pesan
 */
app.post('/api/preview-message', (req, res) => {
  const { template, nama_bisnis, kategori } = req.body;
  const rendered = generatePersonalizedMessage(template, nama_bisnis, kategori);
  res.json({ success: true, rendered });
});

/**
 * Kelola Blacklist (Daftar Blokir)
 */
app.get('/api/blacklist', (req, res) => {
  res.json({ success: true, blacklist: dataStore.blacklist });
});

app.post('/api/blacklist', (req, res) => {
  const { number } = req.body;
  const sanitized = sanitizePhoneNumber(number);
  if (!sanitized.valid) {
    return res.status(400).json({ success: false, message: sanitized.reason });
  }

  if (!dataStore.blacklist.includes(sanitized.number)) {
    dataStore.blacklist.push(sanitized.number);
    saveData();
    supabaseDb.addToBlacklist(sanitized.number, 'Manual Add');
    logActivity('BLACKLIST', `Nomor ${sanitized.number} ditambahkan ke blacklist secara manual`, sanitized.number);
  }
  res.json({ success: true, blacklist: dataStore.blacklist });
});

app.delete('/api/blacklist/:number', (req, res) => {
  const number = req.params.number;
  dataStore.blacklist = dataStore.blacklist.filter(n => n !== number);
  saveData();
  supabaseDb.removeFromBlacklist(number);
  logActivity('INFO', `Nomor ${number} dihapus dari daftar blokir`, number);
  res.json({ success: true, blacklist: dataStore.blacklist });
});

/**
 * Riwayat Nomor yang Pernah Dikirim
 */
app.get('/api/history', (req, res) => {
  res.json({ success: true, history: dataStore.sentHistory });
});

/**
 * Download File Log Aktivitas
 */
app.get('/api/logs/download', (req, res) => {
  if (fs.existsSync(LOG_FILE)) {
    res.download(LOG_FILE, 'activity.log');
  } else {
    res.status(404).send('File log belum ada.');
  }
});

/**
 * Socket.IO Handler
 */
io.on('connection', (socket) => {
  // Kirim status awal ke klien yang baru terhubung
  socket.emit('client_status', { status: clientStatus, connectedNumber });
  if (currentQrDataUrl) {
    socket.emit('qr_code', { qrDataUrl: currentQrDataUrl });
  }
  socket.emit('warmup_update', getWarmupInfo());
  socket.emit('queue_state', getQueueStatePublic());

  // Kirim 50 baris log terakhir
  if (fs.existsSync(LOG_FILE)) {
    fs.readFile(LOG_FILE, 'utf8', (err, data) => {
      if (!err && data) {
        const lines = data.trim().split('\n').slice(-50);
        socket.emit('recent_logs', lines);
      }
    });
  }
});

// Jalankan Server dengan penanganan port otomatis jika 3000 terpakai
let currentPort = PORT;

server.on('listening', () => {
  const address = server.address();
  const actualPort = typeof address === 'string' ? address : address.port;
  console.log(`\n======================================================`);
  console.log(`🚀 WA Website Offer Sender (Anti-Banned) aktif!`);
  console.log(`🌐 Buka di browser: http://localhost:${actualPort}`);
  console.log(`📁 Sesi WhatsApp tersimpan di folder: ${AUTH_DIR}`);
  console.log(`======================================================\n`);
  logActivity('SYSTEM', `Server aplikasi web lokal berjalan pada port ${actualPort}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    currentPort++;
    console.warn(`[INFO] Port ${currentPort - 1} sedang digunakan aplikasi lain. Mencoba port ${currentPort}...`);
    setTimeout(() => {
      server.listen(currentPort);
    }, 500);
  } else {
    console.error('Server error:', err);
  }
});

server.listen(currentPort);
