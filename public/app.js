/**
 * WA Website Offer Sender - Client Application Logic
 */

const socket = io();

// State Lokal
let currentTemplates = {};
let currentRows = [];
let queueState = { isRunning: false, isPaused: false, currentIndex: 0, total: 0 };
let currentWhatsAppStatus = 'disconnected';
let currentUser = null;

// Cek status autentikasi pengguna saat aplikasi dimuat
document.addEventListener('DOMContentLoaded', () => {
  checkUserAuth();
});

async function checkUserAuth() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.user) {
        currentUser = data.user;
        localStorage.setItem('wa_sender_user', JSON.stringify(currentUser));
        applyUserUI();
        return;
      }
    }
    // Jika tidak valid atau 401: redirect ke /login
    localStorage.removeItem('wa_sender_user');
    window.location.replace('/login');
  } catch (err) {
    console.error('Auth verification error:', err);
    const raw = localStorage.getItem('wa_sender_user');
    if (raw) {
      try {
        currentUser = JSON.parse(raw);
        applyUserUI();
      } catch (e) {
        window.location.replace('/login');
      }
    } else {
      window.location.replace('/login');
    }
  }
}

function applyUserUI() {
  if (!currentUser) return;
  const nameEl = document.getElementById('navUserName');
  const badgeEl = document.getElementById('navUserBadge');
  const btnManage = document.getElementById('btnManageEmployees');

  if (nameEl) {
    nameEl.textContent = `${currentUser.name} (${currentUser.role === 'super_admin' ? 'Super Admin' : 'Karyawan'})`;
  }

  if (badgeEl) {
    if (currentUser.role === 'super_admin') {
      badgeEl.className = 'px-2.5 py-1 bg-amber-400/10 text-amber-300 border border-amber-400/30 rounded-lg text-xs font-bold flex items-center gap-1.5';
      // Hindari teks ganda jika nama akun sudah "Super Admin"
      const adminLabel = /super\s*admin/i.test(currentUser.name) ? currentUser.name : `${currentUser.name} (Super Admin)`;
      badgeEl.innerHTML = `<i class="fa-solid fa-crown text-amber-500"></i><span>${adminLabel}</span>`;
    } else {
      badgeEl.className = 'px-2.5 py-1 bg-sky-400/10 text-sky-300 border border-sky-400/30 rounded-lg text-xs font-bold flex items-center gap-1.5';
      badgeEl.innerHTML = `<i class="fa-solid fa-user-check text-sky-400"></i><span>${currentUser.name} (Karyawan)</span>`;
    }
  }

  // Tombol Kelola Karyawan hanya untuk Super Admin
  if (btnManage) {
    if (currentUser.role === 'super_admin') {
      btnManage.classList.remove('hidden');
    } else {
      btnManage.classList.add('hidden');
    }
  }
}

async function handleUserLogout() {
  if (!confirm('Apakah Anda yakin ingin keluar dari akun?')) return;
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (e) {
    console.warn('Logout API warning:', e);
  }
  currentUser = null;
  localStorage.removeItem('wa_sender_user');
  localStorage.removeItem('wa_sender_token');
  window.location.replace('/login');
}

// ==========================================
// 1. SOCKET.IO EVENT LISTENERS
// ==========================================

socket.on('connect', () => {
  console.log('Terhubung ke WebSocket server');
  fetchInitialData();
});

// Update Status WhatsApp
socket.on('client_status', (data) => {
  currentWhatsAppStatus = data.status;
  updateWhatsAppStatusUI(data);
});

// Update Gambar QR Code dari Server
socket.on('qr_code', (data) => {
  if (data.qrDataUrl) {
    displayQrCodeImage(data.qrDataUrl);
  }
});

// Update Kode Pairing dari Server
socket.on('pairing_code', (data) => {
  if (data.code) {
    showPairingCodeInModal(data.code);
  }
});

// Update Pemanasan & Kuota
socket.on('warmup_update', (warmup) => {
  updateWarmupUI(warmup);
});

// Update Pengaturan Jam Kerja
socket.on('working_hours_update', (wh) => {
  updateWorkingHoursUI(wh);
});

// Update Status Item Antrean Kontak
socket.on('item_status_update', (data) => {
  const { index, item } = data;
  if (currentRows[index]) {
    currentRows[index] = item;
    updateRowUI(index, item);
  }
  updateProgressUI();
});

// Update Countdown Waktu Tunggu / Jeda Acak / Istirahat
socket.on('queue_waiting', (data) => {
  const tickerText = document.getElementById('tickerText');
  const tickerDot = document.getElementById('tickerDot');

  if (tickerText) tickerText.textContent = `${data.statusMessage} (${data.remaining}s)`;
  if (tickerDot) tickerDot.className = 'w-2.5 h-2.5 rounded-full bg-amber-500 animate-ping';
});

// Update Status Ticker
socket.on('queue_status_text', (data) => {
  const tickerText = document.getElementById('tickerText');
  if (tickerText) tickerText.textContent = data.text;
});

// Update Kondisi Antrean (Running, Paused, dsb)
socket.on('queue_state', (state) => {
  queueState = state;
  updateQueueButtonsUI();
  updateProgressUI();
});

// Pemberitahuan Selesai
socket.on('queue_finished', (data) => {
  alert(data.message || 'Semua kontak dalam antrean telah selesai diproses!');
  const tickerText = document.getElementById('tickerText');
  const tickerDot = document.getElementById('tickerDot');
  if (tickerText) tickerText.textContent = 'Pengiriman selesai!';
  if (tickerDot) tickerDot.className = 'w-2.5 h-2.5 rounded-full bg-sky-400';
  loadSentHistory();
});

// Pemutus Darurat (Circuit Breaker)
socket.on('circuit_breaker', (data) => {
  alert('⚠️ PERINGATAN PEMUTUS DARURAT:\n\n' + data.message);
  const tickerText = document.getElementById('tickerText');
  const tickerDot = document.getElementById('tickerDot');
  if (tickerText) tickerText.textContent = '⚠️ Pemutus darurat aktif! Proses dihentikan.';
  if (tickerDot) tickerDot.className = 'w-2.5 h-2.5 rounded-full bg-rose-600 animate-pulse';
});

// Di Luar Jam Operasional
socket.on('outside_working_hours', (data) => {
  const tickerText = document.getElementById('tickerText');
  if (tickerText) tickerText.textContent = data.message;
});

// Target Kirim Sesi Tercapai (Batas Jumlah Kirim)
socket.on('session_limit_reached', (data) => {
  alert(`🎯 TARGET KIRIM TERCAPAI!\n\nSebanyak ${data.sent} nomor telah berhasil dikirimi pesan.\nAntrean otomatis dijeda demi menjaga keamanan akun WhatsApp Anda.`);
  const tickerText = document.getElementById('tickerText');
  const tickerDot = document.getElementById('tickerDot');
  if (tickerText) tickerText.textContent = `Target pengiriman ${data.sent} nomor tercapai. Antrean dijeda.`;
  if (tickerDot) tickerDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400';
  loadSentHistory();
});

// Kuota Pemanasan Hari Ini Habis
socket.on('quota_exhausted', (data) => {
  alert(`🛡️ ATURAN PEMANASAN KETAT:\n\nBatas kuota hari ke-${data.dayNumber} (${data.maxLimit} pesan/hari) telah tercapai.\nSistem otomatis berhenti hari ini demi mencegah pemblokiran nomor.`);
});

// Daftar Blokir Diperbarui
socket.on('blacklist_updated', () => {
  loadBlacklist();
});

// Log Masuk Real-Time
socket.on('new_log', (log) => {
  appendLogToConsole(log);
});

// Log Riwayat Awal
socket.on('recent_logs', (lines) => {
  const consoleBox = document.getElementById('logConsole');
  if (!consoleBox) return;
  consoleBox.innerHTML = '';
  lines.forEach(line => {
    const el = document.createElement('div');
    el.textContent = line;
    colorizeLogElement(el, line);
    consoleBox.appendChild(el);
  });
  consoleBox.scrollTop = consoleBox.scrollHeight;
});

// ==========================================
// 2. FUNGSI INISIALISASI & FETCH DATA
// ==========================================

async function fetchInitialData() {
  try {
    // 1. Status Utama
    const res = await fetch('/api/status');
    const data = await res.json();
    
    updateWhatsAppStatusUI({ status: data.clientStatus, connectedNumber: data.connectedNumber });
    if (data.qrDataUrl) {
      displayQrCodeImage(data.qrDataUrl);
    }
    updateWarmupUI(data.warmup);
    updateWorkingHoursUI(data.workingHours);

    // 2. Muat Template Pesan
    await loadTemplatesFromServer();

    // 3. Muat Antrean Kontak yang Tersimpan
    await loadSavedQueue();

    // 4. Muat Blacklist & Riwayat
    await loadBlacklist();
    await loadSentHistory();

    // 5. Cek Status Supabase Database
    await checkSupabaseStatus();

  } catch (err) {
    console.error('Gagal mengambil data awal:', err);
  }
}

function updateWhatsAppStatusUI(data) {
  const badge = document.getElementById('waStatusBadge');
  const text = document.getElementById('waStatusText');
  const btnPairing = document.getElementById('btnPairingModal');
  const btnLogout = document.getElementById('btnLogout');

  if (!badge || !text) return;

  if (data.status === 'ready') {
    badge.className = 'flex items-center space-x-2 px-3 py-1.5 rounded-full text-xs font-semibold bg-sky-400/10 text-sky-300 border border-sky-400/30';
    text.textContent = `Terhubung: +${data.connectedNumber || 'WhatsApp'}`;
    btnPairing.classList.add('hidden');
    btnLogout.classList.remove('hidden');
  } else if (data.status === 'authenticated') {
    badge.className = 'flex items-center space-x-2 px-3 py-1.5 rounded-full text-xs font-semibold bg-sky-400/10 text-sky-300 border border-sky-400/30';
    text.textContent = data.text || 'Autentikasi Berhasil, Menyiapkan...';
    btnPairing.classList.add('hidden');
    setTimeout(() => { fetchInitialStatus(); }, 2000);
  } else if (data.status === 'pairing_ready') {
    badge.className = 'flex items-center space-x-2 px-3 py-1.5 rounded-full text-xs font-semibold bg-amber-400/10 text-amber-300 border border-amber-400/30';
    text.textContent = 'Siap Pairing (Belum Terhubung)';
    btnPairing.classList.remove('hidden');
    btnLogout.classList.add('hidden');
  } else if (data.status === 'initializing') {
    badge.className = 'flex items-center space-x-2 px-3 py-1.5 rounded-full text-xs font-semibold bg-slate-700/40 text-slate-200 border border-slate-600/40';
    text.textContent = 'Menyiapkan Browser & Sesi...';
  } else {
    badge.className = 'flex items-center space-x-2 px-3 py-1.5 rounded-full text-xs font-semibold bg-rose-500/10 text-rose-300 border border-rose-500/30';
    text.textContent = 'WhatsApp Terputus';
    btnPairing.classList.remove('hidden');
    btnLogout.classList.add('hidden');
  }
}

function updateWarmupUI(warmup) {
  if (!warmup) return;
  const dayEl = document.getElementById('statDayNumber');
  const sentEl = document.getElementById('statSentToday');
  const maxEl = document.getElementById('statMaxLimit');
  const remEl = document.getElementById('statRemainingQuota');
  const subEl = document.getElementById('statRemainingSubtitle');
  const infoEl = document.getElementById('statWarmupInfo');
  const btnQuota = document.getElementById('btnToggleQuota');

  if (dayEl) dayEl.textContent = `Hari ke-${warmup.dayNumber}`;
  if (sentEl) sentEl.textContent = warmup.todaySent;

  if (warmup.isEnforced) {
    if (maxEl) maxEl.textContent = `/ ${warmup.maxDailyLimit} maks`;
    if (remEl) remEl.textContent = `${warmup.remainingToday} pesan`;
    if (subEl) {
      subEl.textContent = 'Batas kuota aktif';
      subEl.className = 'text-[11px] text-amber-400 mt-0.5 font-medium';
    }
    if (btnQuota) {
      btnQuota.textContent = 'Dibatasi';
      btnQuota.className = 'text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-400/15 text-amber-300 hover:bg-amber-400/25 transition';
    }
    if (infoEl) infoEl.textContent = `Batas harian: ${warmup.maxDailyLimit} pesan/hari`;
  } else {
    if (maxEl) maxEl.textContent = 'pesan';
    if (remEl) remEl.textContent = '∞ Bebas';
    if (subEl) {
      subEl.textContent = 'Bisa kirim semua nomor';
      subEl.className = 'text-[11px] text-sky-400 mt-0.5 font-medium';
    }
    if (btnQuota) {
      btnQuota.textContent = 'Tanpa Batas';
      btnQuota.className = 'text-[10px] font-bold px-1.5 py-0.5 rounded bg-sky-400/15 text-sky-300 hover:bg-sky-400/25 transition';
    }
    if (infoEl) infoEl.textContent = 'Mode bebas: Tanpa pembatasan kuota harian';
  }
}

async function toggleQuotaLimit() {
  try {
    const res = await fetch('/api/toggle-quota-limit', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      updateWarmupUI(data.warmup);
    }
  } catch (err) {
    console.error('Gagal toggle kuota:', err);
  }
}

function updateWorkingHoursUI(wh) {
  if (!wh) return;
  const hoursText = document.getElementById('statWorkingHours');
  const statusEl = document.getElementById('statWorkingHoursStatus');
  const btnToggle = document.getElementById('btnToggleHours');

  if (wh.isEnforced) {
    if (hoursText) hoursText.textContent = '09.00 - 17.00';
    if (btnToggle) {
      btnToggle.textContent = 'Kunci 09-17';
      btnToggle.className = 'text-[10px] font-bold px-1.5 py-0.5 rounded bg-sky-400/15 text-sky-300 hover:bg-sky-400/25 transition';
    }
    if (statusEl) {
      if (wh.isAllowed) {
        statusEl.className = 'text-[11px] font-semibold text-sky-400 mt-0.5';
        statusEl.innerHTML = '<i class="fa-solid fa-circle-check"></i> Dalam jam operasional';
      } else {
        statusEl.className = 'text-[11px] font-semibold text-amber-400 mt-0.5';
        statusEl.innerHTML = `<i class="fa-solid fa-clock-rotate-left"></i> Menunggu jam 09.00`;
      }
    }
  } else {
    if (hoursText) hoursText.textContent = 'Kapan Saja (Bebas)';
    if (btnToggle) {
      btnToggle.textContent = 'Mode Bebas';
      btnToggle.className = 'text-[10px] font-bold px-1.5 py-0.5 rounded bg-sky-400/15 text-sky-300 hover:bg-sky-400/25 transition';
    }
    if (statusEl) {
      statusEl.className = 'text-[11px] font-semibold text-sky-400 mt-0.5';
      statusEl.innerHTML = '<i class="fa-solid fa-circle-check"></i> Siap kirim kapan saja';
    }
  }
}

async function toggleWorkingHours() {
  try {
    const res = await fetch('/api/toggle-working-hours', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      updateWorkingHoursUI(data.workingHours);
    }
  } catch (err) {
    console.error('Gagal toggle jam kerja:', err);
  }
}

// ==========================================
// 3. PAIRING CODE MODAL & REQUEST
// ==========================================

function openPairingModal() {
  document.getElementById('pairingModal').classList.remove('hidden');
}

function closePairingModal() {
  document.getElementById('pairingModal').classList.add('hidden');
}

function switchModalTab(tab) {
  const btnQr = document.getElementById('modalTabBtn-qr');
  const btnPairing = document.getElementById('modalTabBtn-pairing');
  const contentQr = document.getElementById('modalTabContent-qr');
  const contentPairing = document.getElementById('modalTabContent-pairing');

  if (tab === 'qr') {
    btnQr.className = 'flex-1 py-2 border-b-2 border-sky-400 text-sky-300 font-bold flex items-center justify-center gap-1.5';
    btnPairing.className = 'flex-1 py-2 border-b-2 border-transparent text-slate-500 hover:text-white flex items-center justify-center gap-1.5';
    contentQr.classList.remove('hidden');
    contentPairing.classList.add('hidden');
  } else {
    btnPairing.className = 'flex-1 py-2 border-b-2 border-sky-400 text-sky-300 font-bold flex items-center justify-center gap-1.5';
    btnQr.className = 'flex-1 py-2 border-b-2 border-transparent text-slate-500 hover:text-white flex items-center justify-center gap-1.5';
    contentPairing.classList.remove('hidden');
    contentQr.classList.add('hidden');
  }
}

function displayQrCodeImage(qrDataUrl) {
  const img = document.getElementById('qrCodeImage');
  const loader = document.getElementById('qrLoading');
  if (img && loader) {
    img.src = qrDataUrl;
    img.classList.remove('hidden');
    loader.classList.add('hidden');
  }
}

async function refreshQrCode() {
  const img = document.getElementById('qrCodeImage');
  const loader = document.getElementById('qrLoading');
  if (img) img.classList.add('hidden');
  if (loader) {
    loader.classList.remove('hidden');
    loader.innerHTML = `
      <i class="fa-solid fa-circle-notch fa-spin text-2xl text-sky-400"></i>
      <span class="font-medium">Menyegarkan QR Code...</span>
    `;
  }

  try {
    const res = await fetch('/api/refresh-qr', { method: 'POST' });
    const data = await res.json();
    console.log(data.message);
  } catch (err) {
    console.error('Gagal refresh QR:', err);
  }
}

async function requestPairingCode() {
  const input = document.getElementById('inputPairingPhone');
  const btn = document.getElementById('btnRequestCode');
  const msgEl = document.getElementById('modalStatusMessage');

  let phone = input.value.trim();
  if (!phone) {
    alert('Masukkan nomor telepon WhatsApp Anda terlebih dahulu!');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Meminta...';
  msgEl.textContent = 'Sedang meminta kode pairing dari WhatsApp...';

  try {
    const res = await fetch('/api/request-pairing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber: phone })
    });
    const result = await res.json();

    if (result.success && result.code) {
      showPairingCodeInModal(result.code);
      msgEl.textContent = 'Kode berhasil didapat! Segera masukkan ke WhatsApp HP Anda.';
    } else {
      msgEl.textContent = 'Gagal: ' + (result.message || 'Coba lagi');
      alert('Gagal meminta kode: ' + (result.message || 'Silakan tunggu sebentar dan coba lagi'));
    }
  } catch (err) {
    msgEl.textContent = 'Terjadi kesalahan jaringan atau server belum siap.';
    alert('Error: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Minta Kode';
  }
}

function showPairingCodeInModal(code) {
  const area = document.getElementById('pairingCodeDisplayArea');
  const text = document.getElementById('displayPairingCode');
  if (!area || !text) return;

  // Format 8 karakter jadi ABCD - EFGH untuk kenyamanan visual
  let formatted = code;
  if (code.length === 8) {
    formatted = `${code.substring(0, 4)} - ${code.substring(4)}`;
  }

  text.textContent = formatted;
  text.dataset.rawCode = code;
  area.classList.remove('hidden');
}

function copyPairingCode() {
  const text = document.getElementById('displayPairingCode');
  const code = text.dataset.rawCode || text.textContent.replace(/\s|-/g, '');
  navigator.clipboard.writeText(code).then(() => {
    alert(`Kode ${code} berhasil disalin ke clipboard!`);
  }).catch(() => {
    alert(`Kode: ${code}`);
  });
}

async function logoutWA() {
  if (!confirm('Apakah Anda yakin ingin memutuskan koneksi WhatsApp dan menghapus sesi?')) return;
  try {
    await fetch('/api/logout', { method: 'POST' });
    alert('Sesi WhatsApp telah diputus.');
    location.reload();
  } catch (err) {
    alert('Gagal logout: ' + err.message);
  }
}

// ==========================================
// 4. IMPORT FILE EXCEL / CSV
// ==========================================

function handleFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  uploadFile(file);
}

// Drag & drop handlers
const dropZone = document.getElementById('dropZone');
if (dropZone) {
  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.add('border-sky-400', 'bg-sky-400/10');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.remove('border-sky-400', 'bg-sky-400/10');
    });
  });

  dropZone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  });
}

async function uploadFile(file) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('operatorName', currentUser ? currentUser.name : 'Super Admin');

  const tickerText = document.getElementById('tickerText');
  if (tickerText) tickerText.textContent = `Mengunggah & memproses file ${file.name}...`;

  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });
    const result = await res.json();

    if (!result.success) {
      alert('Gagal impor: ' + result.message);
      return;
    }

    currentRows = result.rows || [];

    // Tampilkan ringkasan
    document.getElementById('importSummaryCard').classList.remove('hidden');
    document.getElementById('sumTotal').textContent = `${result.summary.total} Baris`;
    document.getElementById('sumValid').textContent = result.summary.valid;
    document.getElementById('sumAlreadySent').textContent = result.summary.alreadySent;
    document.getElementById('sumBlacklisted').textContent = result.summary.blacklisted;
    document.getElementById('sumInvalid').textContent = result.summary.duplicate + result.summary.invalid;

    // Render tabel
    renderContactTable(currentRows);
    updateProgressUI();

  } catch (err) {
    alert('Terjadi kesalahan saat mengunggah file: ' + err.message);
  }
}

async function loadSavedQueue() {
  try {
    const res = await fetch('/api/queue');
    const data = await res.json();
    if (data.success && Array.isArray(data.rows) && data.rows.length > 0) {
      currentRows = data.rows;
      renderContactTable(currentRows);
      recalculateSummary();
      updateProgressUI();
      const tickerText = document.getElementById('tickerText');
      if (tickerText) tickerText.textContent = `Tersimpan ${currentRows.length} kontak di antrean. Siap dilanjutkan.`;
    }
  } catch (err) {
    console.error('Gagal memuat antrean tersimpan:', err);
  }
}

// State Filter Status
let currentFilter = 'ALL';

function setQueueFilter(filter) {
  currentFilter = filter;
  ['ALL', 'READY', 'SUCCESS', 'FAILED'].forEach(f => {
    const btn = document.getElementById(`filterBtn-${f}`);
    if (btn) {
      if (f === filter) {
        btn.className = 'filter-chip active px-2.5 py-1 rounded-lg bg-sky-400 text-slate-950 font-semibold text-xs';
      } else {
        btn.className = 'filter-chip px-2.5 py-1 rounded-lg bg-slate-700/50 text-slate-200 hover:bg-slate-600/60 font-semibold text-xs';
      }
    }
  });
  renderContactTable(currentRows);
}

// Modal Input Kontak Sendiri
function openManualContactModal() {
  document.getElementById('manualContactModal').classList.remove('hidden');
  document.getElementById('manualInputNomor').focus();
}

function closeManualContactModal() {
  document.getElementById('manualContactModal').classList.add('hidden');
}

async function submitManualContact() {
  const nomor = document.getElementById('manualInputNomor').value.trim();
  const nama_bisnis = document.getElementById('manualInputNama').value.trim();
  const kategori = document.getElementById('manualInputKategori').value.trim();

  if (!nomor) {
    alert('Nomor WhatsApp wajib diisi!');
    return;
  }

  try {
    const res = await fetch('/api/queue/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        nomor, 
        nama_bisnis, 
        kategori,
        operatorName: currentUser ? currentUser.name : 'Super Admin'
      })
    });
    const result = await res.json();

    if (result.success) {
      currentRows = result.rows || [];
      document.getElementById('manualInputNomor').value = '';
      document.getElementById('manualInputNama').value = '';
      document.getElementById('manualInputKategori').value = '';
      closeManualContactModal();
      renderContactTable(currentRows);
      recalculateSummary();
      updateProgressUI();
      alert(`Kontak ${result.item.nama_bisnis} (${result.item.nomor}) berhasil ditambahkan ke antrean!`);
    } else {
      alert('Gagal menambah kontak: ' + (result.message || 'Error'));
    }
  } catch (err) {
    alert('Terjadi kesalahan: ' + err.message);
  }
}

function renderContactTable(rows) {
  const tbody = document.getElementById('contactTableBody');
  const btnClearAll = document.getElementById('btnClearAll');
  document.getElementById('tabCountQueue').textContent = rows.length;

  // Hitung jumlah untuk tombol filter
  let countAll = rows.length;
  let countPending = 0;
  let countSent = 0;
  let countFailed = 0;

  rows.forEach(r => {
    if (r.status === 'READY' || r.status === 'PENDING') countPending++;
    else if (r.status === 'SUCCESS' || r.status === 'ALREADY_SENT') countSent++;
    else if (r.status === 'FAILED') countFailed++;
  });

  const elAll = document.getElementById('countFilterAll');
  const elPending = document.getElementById('countFilterPending');
  const elSent = document.getElementById('countFilterSent');
  const elFailed = document.getElementById('countFilterFailed');

  if (elAll) elAll.textContent = countAll;
  if (elPending) elPending.textContent = countPending;
  if (elSent) elSent.textContent = countSent;
  if (elFailed) elFailed.textContent = countFailed;

  if (!rows || rows.length === 0) {
    if (btnClearAll) btnClearAll.classList.add('hidden');
    tbody.innerHTML = `<tr><td colspan="7" class="p-8 text-center text-slate-400">Belum ada kontak. Silakan impor file Excel / CSV atau klik "+ Input Sendiri".</td></tr>`;
    return;
  }

  if (btnClearAll) btnClearAll.classList.remove('hidden');

  // Filter tampilan berdasarkan tombol filter yang dipilih
  let filteredRows = rows;
  if (currentFilter === 'READY') {
    filteredRows = rows.filter(r => r.status === 'READY' || r.status === 'PENDING');
  } else if (currentFilter === 'SUCCESS') {
    filteredRows = rows.filter(r => r.status === 'SUCCESS' || r.status === 'ALREADY_SENT');
  } else if (currentFilter === 'FAILED') {
    filteredRows = rows.filter(r => r.status === 'FAILED');
  }

  if (filteredRows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="p-6 text-center text-slate-400">Tidak ada kontak dengan status <strong>${currentFilter}</strong>.</td></tr>`;
    return;
  }

  let html = '';
  filteredRows.forEach((row) => {
    const originalIdx = rows.findIndex(r => r.nomor === row.nomor);
    const idx = originalIdx >= 0 ? originalIdx : row.id - 1;

    let badgeIcon = '';
    let badgeText = row.statusText || row.status;
    let statusClass = row.status;

    if (row.status === 'READY' || row.status === 'PENDING') {
      badgeIcon = '<i class="fa-regular fa-clock mr-1"></i>';
      badgeText = 'Pending (Siap Kirim)';
      statusClass = 'READY';
    } else if (row.status === 'SUCCESS' || row.status === 'ALREADY_SENT') {
      badgeIcon = '<i class="fa-solid fa-circle-check mr-1"></i>';
      badgeText = 'Sudah Terkirim';
      statusClass = 'SUCCESS';
    } else if (row.status === 'FAILED') {
      badgeIcon = '<i class="fa-solid fa-circle-xmark mr-1"></i>';
      badgeText = 'Gagal Terkirim';
    } else if (row.status === 'TYPING') {
      badgeIcon = '<i class="fa-solid fa-keyboard mr-1 animate-pulse"></i>';
      badgeText = 'Sedang Mengetik...';
    }

    html += `
      <tr id="row-${idx}" class="hover:bg-sky-400/5 transition">
        <td class="p-3 text-center text-slate-400 font-mono text-[11px]">${row.id}</td>
        <td class="p-3 font-mono font-medium text-slate-100">${row.nomor}</td>
        <td class="p-3 font-semibold text-white">${row.nama_bisnis}</td>
        <td class="p-3">
          <span class="px-2 py-0.5 rounded text-[10px] uppercase font-bold bg-slate-700/40 text-slate-200">
            ${row.kategori}
          </span>
        </td>
        <td class="p-3">
          <span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-indigo-400/10 text-indigo-300 border border-indigo-400/30 whitespace-nowrap">
            <i class="fa-solid fa-user text-[9px] mr-1"></i>${row.sentBy || 'Super Admin'}
          </span>
        </td>
        <td class="p-3" id="status-cell-${idx}">
          <span class="status-badge status-${statusClass}" title="${row.statusText || ''}">${badgeIcon} ${badgeText}</span>
        </td>
        <td class="p-3 text-right whitespace-nowrap">
          <button onclick="openCustomSendModal(${idx})" id="btn-send-${idx}" title="Kirim pesan ke nomor ini (Bisa edit / ketik pesan kustom sendiri)" class="btn-cyan-action text-[11px] px-2.5 py-1 rounded-lg mr-1.5 inline-flex items-center gap-1.5 shadow-sm font-semibold">
            <i class="fa-solid fa-paper-plane text-[10px]"></i>
            <span>Kirim</span>
          </button>
          <button onclick="deleteQueueItem(${idx})" title="Hapus kontak ini" class="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition inline-flex items-center">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </td>
      </tr>
    `;
  });
  tbody.innerHTML = html;
}

async function deleteQueueItem(idx) {
  const item = currentRows[idx];
  if (!item) return;

  if (!confirm(`Hapus "${item.nama_bisnis}" (${item.nomor}) dari daftar kontak?`)) return;

  try {
    const res = await fetch(`/api/queue/item/${idx}`, { method: 'DELETE' });
    const result = await res.json();
    if (result.success) {
      currentRows.splice(idx, 1);
      // Re-index nomor urut
      currentRows.forEach((r, i) => { r.id = i + 1; });
      renderContactTable(currentRows);
      recalculateSummary();
      updateProgressUI();
    } else {
      alert('Gagal menghapus kontak: ' + (result.message || 'Error'));
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function clearAllQueue() {
  if (!currentRows || currentRows.length === 0) return;
  if (!confirm('Apakah Anda yakin ingin mengosongkan seluruh daftar kontak antrean?')) return;

  try {
    const res = await fetch('/api/queue/clear', { method: 'DELETE' });
    const result = await res.json();
    if (result.success) {
      currentRows = [];
      const fileInput = document.getElementById('fileInput');
      if (fileInput) fileInput.value = '';
      document.getElementById('importSummaryCard').classList.add('hidden');
      renderContactTable([]);
      updateProgressUI();
      const tickerText = document.getElementById('tickerText');
      if (tickerText) tickerText.textContent = 'Daftar kontak telah dikosongkan.';
    } else {
      alert(result.message);
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

function recalculateSummary() {
  let valid = 0, duplicate = 0, blacklisted = 0, alreadySent = 0, invalid = 0;
  currentRows.forEach(r => {
    if (r.status === 'READY' || r.status === 'PENDING') valid++;
    else if (r.status === 'DUPLICATE') duplicate++;
    else if (r.status === 'BLACKLISTED') blacklisted++;
    else if (r.status === 'ALREADY_SENT' || r.status === 'SUCCESS') alreadySent++;
    else if (r.status === 'INVALID') invalid++;
    else valid++;
  });

  if (currentRows.length > 0) {
    document.getElementById('sumTotal').textContent = `${currentRows.length} Baris`;
    document.getElementById('sumValid').textContent = valid;
    document.getElementById('sumAlreadySent').textContent = alreadySent;
    document.getElementById('sumBlacklisted').textContent = blacklisted;
    document.getElementById('sumInvalid').textContent = duplicate + invalid;
  } else {
    document.getElementById('importSummaryCard').classList.add('hidden');
  }
}

function updateRowUI(idx, item) {
  renderContactTable(currentRows);
  recalculateSummary();
}

// ==========================================
// 5. TEMPLATE & SPINTAX MANAGEMENT
// ==========================================

async function loadTemplatesFromServer() {
  try {
    const res = await fetch('/api/templates');
    const data = await res.json();
    if (data.success) {
      currentTemplates = data.templates;
      renderActiveTemplate();
    }
  } catch (err) {
    console.error('Gagal memuat template:', err);
  }
}

function renderActiveTemplate() {
  const category = document.getElementById('templateCategory').value;
  const variantIndex = parseInt(document.getElementById('templateVariant').value) || 0;

  const list = currentTemplates[category] || currentTemplates['umum'] || [];
  const content = list[variantIndex] || '';

  document.getElementById('templateEditor').value = content;
  refreshPreview();
}

function loadTemplateForCategory() {
  renderActiveTemplate();
}

function refreshPreview() {
  const template = document.getElementById('templateEditor').value;
  const category = document.getElementById('templateCategory').value;
  const businessSample = category === 'hotel' ? 'Hotel Grand Mentari' : (category === 'restoran' ? 'Resto Rasa Nusantara' : 'Klinik Medika Sehat');

  // Evaluasi Spintax secara lokal di browser
  let resolved = template;
  resolved = resolved.replace(/\{nama_bisnis\}/gi, businessSample);
  resolved = resolved.replace(/\{kategori\}/gi, category);

  const spintaxRegex = /\{([^{}]+)\}/g;
  let prev;
  do {
    prev = resolved;
    resolved = resolved.replace(spintaxRegex, (match, choices) => {
      const parts = choices.split('|');
      return parts[Math.floor(Math.random() * parts.length)];
    });
  } while (resolved !== prev);

  const previewBox = document.getElementById('previewBox');
  previewBox.textContent = resolved;
}

async function saveCurrentTemplate() {
  const category = document.getElementById('templateCategory').value;
  const variantIndex = parseInt(document.getElementById('templateVariant').value) || 0;
  const content = document.getElementById('templateEditor').value.trim();

  if (!content) {
    alert('Isi template tidak boleh kosong!');
    return;
  }

  // Simpan ke seluruh kategori agar semua kontak (Hotel, Penginapan, Guest House, Villa, Homestay, Umum) memakai teks yang sama persis
  const allCategories = ['hotel', 'homestay', 'vila', 'villa', 'penginapan', 'guest house', 'bisnis', 'umum', 'restoran', 'klinik'];
  allCategories.forEach(cat => {
    currentTemplates[cat] = [content];
  });
  Object.keys(currentTemplates).forEach(cat => {
    currentTemplates[cat] = [content];
  });

  try {
    const res = await fetch('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templates: currentTemplates })
    });
    const result = await res.json();
    if (result.success) {
      alert('✅ Template berhasil disimpan!');
      refreshPreview();
    } else {
      alert('Gagal menyimpan: ' + result.message);
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ==========================================
// 6. KONTROL ANTREAN (KIRIM SEMUA, BATAS BATCH, PAUSE, STOP)
// ==========================================

function setSendBatchLimit(val) {
  const input = document.getElementById('sendBatchLimit');
  if (input) {
    input.value = val;
    updateSendButtonLabel();
  }
}

function updateSendButtonLabel() {
  const input = document.getElementById('sendBatchLimit');
  const label = document.getElementById('startBtnLabel');
  if (!label) return;
  const val = input ? parseInt(input.value, 10) : 0;
  if (val && val > 0) {
    label.textContent = `Kirim (${val} Nomor)`;
  } else {
    label.textContent = 'Kirim Semua';
  }
}

async function startQueue() {
  if (currentWhatsAppStatus !== 'ready') {
    alert('WhatsApp belum terhubung! Silakan klik tombol "Kode Pairing" di atas untuk menghubungkan nomor pengirim.');
    return;
  }

  if (currentRows.length === 0) {
    alert('Silakan impor file kontak Excel atau CSV terlebih dahulu.');
    return;
  }

  const inputLimit = document.getElementById('sendBatchLimit');
  const limitVal = inputLimit ? parseInt(inputLimit.value, 10) : 0;
  const targetDesc = (limitVal && limitVal > 0) ? `${limitVal} nomor kontak` : 'seluruh kontak di antrean';

  if (!confirm(`Mulai pengiriman pesan ke ${targetDesc}?\n\n• Pesan pertama akan langsung dikirim sekarang.\n• Jika ada nomor berikutnya, jeda acak 15-30 detik diterapkan untuk menjaga keamanan nomor Anda.${limitVal && limitVal > 0 ? `\n• Pengiriman akan otomatis berhenti setelah ${limitVal} nomor.` : ''}`)) {
    return;
  }

  try {
    const res = await fetch('/api/queue/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: (limitVal && limitVal > 0) ? limitVal : null })
    });
    const result = await res.json();
    if (!result.success) {
      alert(result.message);
    }
  } catch (err) {
    alert('Gagal memulai antrean: ' + err.message);
  }
}

async function togglePauseQueue() {
  try {
    if (queueState.isPaused) {
      await fetch('/api/queue/resume', { method: 'POST' });
    } else {
      await fetch('/api/queue/pause', { method: 'POST' });
    }
  } catch (err) {
    alert('Gagal mengubah status pause: ' + err.message);
  }
}

async function stopQueue() {
  if (!confirm('Hentikan seluruh proses pengiriman sekarang?')) return;
  try {
    await fetch('/api/queue/stop', { method: 'POST' });
  } catch (err) {
    alert('Gagal menghentikan antrean: ' + err.message);
  }
}

function updateQueueButtonsUI() {
  const btnStart = document.getElementById('btnStartQueue');
  const btnPause = document.getElementById('btnPauseQueue');
  const btnStop = document.getElementById('btnStopQueue');
  const pauseIcon = document.getElementById('pauseIcon');
  const pauseLabel = document.getElementById('pauseLabel');

  if (queueState.isRunning) {
    btnStart.disabled = true;
    btnStart.classList.add('opacity-40', 'cursor-not-allowed');

    btnPause.disabled = false;
    btnStop.disabled = false;

    if (queueState.isPaused) {
      pauseIcon.className = 'fa-solid fa-play';
      pauseLabel.textContent = 'Lanjutkan';
      btnPause.className = 'px-3 py-2 btn-cyan-action rounded-xl text-xs font-bold transition flex items-center space-x-1.5';
    } else {
      pauseIcon.className = 'fa-solid fa-pause';
      pauseLabel.textContent = 'Pause';
      btnPause.className = 'px-3 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-xl text-xs font-bold transition flex items-center space-x-1.5';
    }
  } else {
    btnStart.disabled = false;
    btnStart.classList.remove('opacity-40', 'cursor-not-allowed');
    btnPause.disabled = true;
    btnStop.disabled = true;
    pauseIcon.className = 'fa-solid fa-pause';
    pauseLabel.textContent = 'Pause';
  }
}

function updateProgressUI() {
  const total = currentRows.length;
  let doneCount = 0;

  currentRows.forEach(r => {
    if (r.status === 'SUCCESS' || r.status === 'FAILED' || r.status === 'SKIPPED' || r.status === 'ALREADY_SENT' || r.status === 'BLACKLISTED' || r.status === 'INVALID' || r.status === 'DUPLICATE') {
      doneCount++;
    }
  });

  const percent = total > 0 ? Math.round((doneCount / total) * 100) : 0;
  document.getElementById('queueProgressLabel').textContent = `Kemajuan: ${doneCount} / ${total} nomor`;
  document.getElementById('queueProgressPercent').textContent = `${percent}%`;
  document.getElementById('queueProgressBar').style.width = `${percent}%`;
}

// ==========================================
// 7. TABEL BLACKLIST & RIWAYAT TERKIRIM
// ==========================================

function switchTab(tabName) {
  ['queue', 'blacklist', 'history', 'logs'].forEach(name => {
    const btn = document.getElementById(`tabBtn-${name}`);
    const content = document.getElementById(`tabContent-${name}`);
    if (name === tabName) {
      btn.className = 'tab-btn active px-4 py-3 border-b-2 border-sky-400 text-sky-300 bg-slate-900/60 flex items-center gap-1.5 font-bold';
      content.classList.remove('hidden');
    } else {
      btn.className = 'tab-btn px-4 py-3 border-b-2 border-transparent text-slate-300 hover:text-white flex items-center gap-1.5 font-medium';
      content.classList.add('hidden');
    }
  });

  if (tabName === 'blacklist') loadBlacklist();
  if (tabName === 'history') loadSentHistory();
}

async function loadBlacklist() {
  try {
    const res = await fetch('/api/blacklist');
    const data = await res.json();
    const list = data.blacklist || [];

    document.getElementById('tabCountBlacklist').textContent = list.length;
    const tbody = document.getElementById('blacklistTableBody');

    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="2" class="p-4 text-center text-slate-400">Belum ada nomor yang diblokir</td></tr>`;
      return;
    }

    let html = '';
    list.forEach(num => {
      html += `
        <tr class="hover:bg-sky-400/5">
          <td class="p-2.5 font-mono text-slate-100 font-semibold">${num}</td>
          <td class="p-2.5 text-right">
            <button onclick="removeBlacklist('${num}')" class="px-2 py-0.5 text-xs text-rose-600 hover:text-rose-300 font-semibold">
              Hapus
            </button>
          </td>
        </tr>
      `;
    });
    tbody.innerHTML = html;
  } catch (err) {
    console.error('Gagal memuat blacklist:', err);
  }
}

async function addManualBlacklist() {
  const input = document.getElementById('manualBlacklistInput');
  const num = input.value.trim();
  if (!num) return;

  try {
    const res = await fetch('/api/blacklist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: num })
    });
    const result = await res.json();
    if (result.success) {
      input.value = '';
      loadBlacklist();
    } else {
      alert('Gagal: ' + result.message);
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function removeBlacklist(num) {
  if (!confirm(`Hapus nomor ${num} dari daftar blokir?`)) return;
  try {
    await fetch(`/api/blacklist/${num}`, { method: 'DELETE' });
    loadBlacklist();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function loadSentHistory() {
  try {
    const res = await fetch('/api/history');
    const data = await res.json();
    const history = data.history || {};
    const keys = Object.keys(history);

    document.getElementById('tabCountHistory').textContent = keys.length;
    const tbody = document.getElementById('historyTableBody');

    if (keys.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-slate-400">Belum ada riwayat pengiriman</td></tr>`;
      return;
    }

    let html = '';
    keys.reverse().forEach(num => {
      const item = history[num];
      const dateStr = item.sentAt ? new Date(item.sentAt).toLocaleString('id-ID') : '-';
      html += `
        <tr class="hover:bg-sky-400/5">
          <td class="p-2.5 font-mono font-semibold text-slate-100">${num}</td>
          <td class="p-2.5 font-medium text-white">${item.businessName || '-'}</td>
          <td class="p-2.5 uppercase text-[10px] text-slate-500 font-bold">${item.category || '-'}</td>
          <td class="p-2.5 font-semibold text-indigo-300 text-[11px]">${item.sentBy || 'Super Admin'}</td>
          <td class="p-2.5 text-slate-500 text-[11px]">${dateStr}</td>
        </tr>
      `;
    });
    tbody.innerHTML = html;
  } catch (err) {
    console.error('Gagal memuat riwayat pengiriman:', err);
  }
}

// ==========================================
// 8. LOG CONSOLE HELPER
// ==========================================

function appendLogToConsole(log) {
  const consoleBox = document.getElementById('logConsole');
  if (!consoleBox) return;

  const el = document.createElement('div');
  const lineText = `[${log.timestamp}] [${log.level}] [${log.number}] ${log.message}`;
  el.textContent = lineText;
  colorizeLogElement(el, lineText);

  consoleBox.appendChild(el);
  consoleBox.scrollTop = consoleBox.scrollHeight;
}

function colorizeLogElement(el, text) {
  if (text.includes('[SUCCESS]')) {
    el.className = 'text-emerald-400';
  } else if (text.includes('[ERROR]') || text.includes('[CIRCUIT_BREAKER]')) {
    el.className = 'text-rose-400 font-bold';
  } else if (text.includes('[WARN]') || text.includes('[BLACKLIST]')) {
    el.className = 'text-amber-400';
  } else {
    el.className = 'text-slate-300';
  }
}

// ==========================================
// 9. SUPER ADMIN: MANAJEMEN KARYAWAN
// ==========================================

function openEmployeesModal() {
  if (!currentUser || currentUser.role !== 'super_admin') {
    alert('Hanya Super Admin yang berhak mengelola akun karyawan.');
    return;
  }
  const modal = document.getElementById('employeesModal');
  if (modal) {
    modal.classList.remove('hidden');
    loadEmployeesTable();
  }
}

function closeEmployeesModal() {
  const modal = document.getElementById('employeesModal');
  if (modal) modal.classList.add('hidden');
}

async function loadEmployeesTable() {
  const tbody = document.getElementById('employeesTableBody');
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i> Memuat data karyawan...</td></tr>`;

  try {
    const res = await fetch('/api/users');
    const data = await res.json();
    if (!data.success) {
      tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-rose-500">${data.error || 'Gagal memuat karyawan'}</td></tr>`;
      return;
    }

    const users = data.users || [];
    if (users.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-slate-400">Belum ada akun karyawan terdaftar.</td></tr>`;
      return;
    }

    let rowsHtml = '';
    users.forEach(u => {
      const isSuperAdmin = u.role === 'super_admin';
      const roleBadge = isSuperAdmin
        ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-400/15 text-indigo-300 border border-indigo-400/30"><i class="fa-solid fa-crown text-amber-500 mr-1"></i>Super Admin</span>`
        : `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-700/40 text-slate-200 border border-slate-600/40"><i class="fa-solid fa-user mr-1 text-slate-400"></i>Karyawan</span>`;

      const isActive = (u.status || 'active') === 'active';
      const statusBadge = isActive
        ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-sky-400/15 text-sky-300 border border-sky-400/30 flex items-center gap-1 w-fit"><span class="w-1.5 h-1.5 rounded-full bg-sky-400"></span>Aktif</span>`
        : `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/15 text-rose-300 border border-rose-500/30 flex items-center gap-1 w-fit"><span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span>Nonaktif</span>`;

      // Jangan izinkan blokir / hapus akun Super Admin
      const isSelf = currentUser && currentUser.id === u.id;
      const canToggle = !isSelf && !isSuperAdmin;
      const canDelete = !isSelf && !isSuperAdmin;

      rowsHtml += `
        <tr class="hover:bg-sky-400/5 transition">
          <td class="p-3 font-semibold text-white">${u.name}</td>
          <td class="p-3 font-mono text-slate-300">${u.username}</td>
          <td class="p-3">${roleBadge}</td>
          <td class="p-3">${statusBadge}</td>
          <td class="p-3 font-bold text-slate-100 text-xs">${u.totalSent || 0} pesan</td>
          <td class="p-3 text-right space-x-1.5">
            ${canToggle ? `
              <button onclick="toggleUserStatus('${u.id}', '${u.status || 'active'}')" title="${isActive ? 'Nonaktifkan Karyawan' : 'Aktifkan Karyawan'}" class="px-2 py-1 rounded text-xs font-semibold ${isActive ? 'bg-amber-400/15 hover:bg-amber-400/25 text-amber-300' : 'bg-sky-400/15 hover:bg-sky-400/25 text-sky-300'} transition">
                <i class="fa-solid ${isActive ? 'fa-ban' : 'fa-check'}"></i> ${isActive ? 'Suspend' : 'Aktifkan'}
              </button>
            ` : ''}
            <button onclick="openResetPasswordModal('${u.id}', '${u.name}')" title="Ganti Password" class="px-2 py-1 rounded text-xs font-semibold bg-slate-700/40 hover:bg-slate-600/50 text-slate-200 transition">
              <i class="fa-solid fa-key"></i> Password
            </button>
            ${canDelete ? `
              <button onclick="deleteEmployee('${u.id}', '${u.name}')" title="Hapus Akun" class="px-2 py-1 rounded text-xs font-semibold bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 transition">
                <i class="fa-solid fa-trash"></i>
              </button>
            ` : ''}
          </td>
        </tr>
      `;
    });

    tbody.innerHTML = rowsHtml;
  } catch (err) {
    console.error('Error load employees:', err);
    tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-rose-500">Koneksi gagal: ${err.message}</td></tr>`;
  }
}

function openAddEmployeeModal() {
  document.getElementById('addEmpName').value = '';
  document.getElementById('addEmpUsername').value = '';
  document.getElementById('addEmpPassword').value = '';
  document.getElementById('addEmpRole').value = 'karyawan';

  const modal = document.getElementById('addEmployeeModal');
  if (modal) modal.classList.remove('hidden');
}

function closeAddEmployeeModal() {
  const modal = document.getElementById('addEmployeeModal');
  if (modal) modal.classList.add('hidden');
}

async function submitNewEmployee(event) {
  event.preventDefault();
  const name = document.getElementById('addEmpName').value.trim();
  const username = document.getElementById('addEmpUsername').value.trim();
  const password = document.getElementById('addEmpPassword').value;
  const role = document.getElementById('addEmpRole').value;

  if (!name || !username || !password) {
    alert('Harap lengkapi semua kolom pendaftaran karyawan.');
    return;
  }

  try {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, username, password, role })
    });
    const data = await res.json();
    if (data.success) {
      alert(`Berhasil menambahkan karyawan "${name}"!`);
      closeAddEmployeeModal();
      loadEmployeesTable();
    } else {
      alert(`Gagal: ${data.error}`);
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

async function toggleUserStatus(id, currentStatus) {
  const newStatus = currentStatus === 'active' ? 'inactive' : 'active';
  const label = newStatus === 'active' ? 'mengaktifkan kembali' : 'menonaktifkan (suspend)';
  if (!confirm(`Apakah Anda yakin ingin ${label} karyawan ini?`)) return;

  try {
    const res = await fetch(`/api/users/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    });
    const data = await res.json();
    if (data.success) {
      loadEmployeesTable();
    } else {
      alert(data.error || 'Gagal mengubah status');
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

function openResetPasswordModal(id, name) {
  document.getElementById('resetTargetId').value = id;
  document.getElementById('resetTargetName').textContent = name;
  document.getElementById('resetNewPassword').value = '';

  const modal = document.getElementById('resetPasswordModal');
  if (modal) modal.classList.remove('hidden');
}

function closeResetPasswordModal() {
  const modal = document.getElementById('resetPasswordModal');
  if (modal) modal.classList.add('hidden');
}

async function submitResetPassword() {
  const id = document.getElementById('resetTargetId').value;
  const password = document.getElementById('resetNewPassword').value;

  if (!password || password.length < 3) {
    alert('Password baru minimal 3 karakter!');
    return;
  }

  try {
    const res = await fetch(`/api/users/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (data.success) {
      alert('Password karyawan berhasil diperbarui!');
      closeResetPasswordModal();
    } else {
      alert(data.error || 'Gagal mereset password');
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function deleteEmployee(id, name) {
  if (!confirm(`PERINGATAN: Apakah Anda yakin ingin MENGHAPUS karyawan "${name}" secara permanen?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/users/${id}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (data.success) {
      alert(`Karyawan "${name}" telah dihapus.`);
      loadEmployeesTable();
    } else {
      alert(data.error || 'Gagal menghapus karyawan');
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ==========================================
// 12. PENGIRIMAN SATU PER SATU (CUSTOM PESAN)
// ==========================================

function generatePreviewForContact(item, preferredSource = 'auto') {
  let raw = '';
  const activeEditorContent = document.getElementById('templateEditor')?.value?.trim();

  if (preferredSource === 'active' && activeEditorContent && activeEditorContent.length > 5) {
    raw = activeEditorContent;
  } else if (preferredSource && preferredSource !== 'auto' && currentTemplates[preferredSource]?.length > 0) {
    const list = currentTemplates[preferredSource];
    raw = list[Math.floor(Math.random() * list.length)];
  } else {
    // Mode 'auto': utamakan template yang ada di editor layar jika user baru mengetik/menyimpannya
    if (activeEditorContent && activeEditorContent.length > 10) {
      raw = activeEditorContent;
    } else {
      const cat = (item.kategori || 'umum').toLowerCase();
      let list = currentTemplates[cat];
      if (!list || !list.length) list = currentTemplates['umum'] || [];
      if (list && list.length > 0) {
        raw = list[Math.floor(Math.random() * list.length)];
      }
    }
  }

  if (!raw) {
    raw = activeEditorContent || `Halo {nama_bisnis}, perkenalkan kami dari tim pembuatan website...`;
  }

  let resolved = raw.replace(/\{nama_bisnis\}/gi, item.nama_bisnis || 'Rekan Bisnis');
  resolved = resolved.replace(/\{kategori\}/gi, item.kategori || 'umum');
  const spintaxRegex = /\{([^{}]+)\}/g;
  let prev;
  do {
    prev = resolved;
    resolved = resolved.replace(spintaxRegex, (match, choices) => {
      const parts = choices.split('|');
      return parts[Math.floor(Math.random() * parts.length)];
    });
  } while (resolved !== prev);
  return resolved;
}

function openCustomSendModal(idx) {
  const item = currentRows[idx];
  if (!item) return;

  document.getElementById('modalTargetIndex').value = idx;
  document.getElementById('modalTargetBusiness').textContent = item.nama_bisnis || 'Rekan Bisnis';
  document.getElementById('modalTargetPhone').textContent = item.nomor || '-';

  const warnEl = document.getElementById('modalResendWarning');
  const warnText = document.getElementById('modalResendWarningText');
  if (item.status === 'SUCCESS' || item.status === 'ALREADY_SENT') {
    warnEl.classList.remove('hidden');
    warnText.textContent = `Nomor ini sudah berstatus "${item.statusText || 'Sudah Terkirim'}". Anda tetap bisa mengirim ulang pesan kustom sekarang.`;
  } else {
    warnEl.classList.add('hidden');
  }

  // Pilih otomatis template aktif di layar
  const sel = document.getElementById('modalTemplateSelector');
  if (sel) sel.value = 'active';

  const generated = generatePreviewForContact(item, 'active');
  document.getElementById('modalCustomMessage').value = generated;

  document.getElementById('customSendModal').classList.remove('hidden');
}

function changeModalTemplateSource() {
  const idx = parseInt(document.getElementById('modalTargetIndex').value, 10);
  const item = currentRows[idx];
  if (!item) return;
  const sel = document.getElementById('modalTemplateSelector');
  const source = sel ? sel.value : 'active';
  document.getElementById('modalCustomMessage').value = generatePreviewForContact(item, source);
}

function closeCustomSendModal() {
  document.getElementById('customSendModal').classList.add('hidden');
}

function regenerateModalTemplate() {
  const idx = parseInt(document.getElementById('modalTargetIndex').value, 10);
  const item = currentRows[idx];
  if (!item) return;
  const sel = document.getElementById('modalTemplateSelector');
  const source = sel ? sel.value : 'active';
  document.getElementById('modalCustomMessage').value = generatePreviewForContact(item, source);
}

async function submitCustomSend() {
  const idxVal = document.getElementById('modalTargetIndex').value;
  const idx = parseInt(idxVal, 10);
  const item = currentRows[idx];
  if (!item) return;

  const customMessage = document.getElementById('modalCustomMessage').value.trim();
  if (!customMessage) {
    alert('Isi pesan WhatsApp tidak boleh kosong!');
    return;
  }

  const btn = document.getElementById('btnModalSubmitSend');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i><span>Mengirim ke WhatsApp...</span>';

  try {
    const res = await fetch('/api/queue/send-single', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: idx, customMessage, forceResend: true })
    });
    const result = await res.json();
    if (result.success) {
      closeCustomSendModal();
      alert(`✅ Berhasil! ${result.message}`);
      loadSentHistory();
    } else {
      alert(`⚠️ ${result.message || 'Gagal mengirim pesan.'}`);
    }
  } catch (err) {
    console.error('Error submitCustomSend:', err);
    alert('Terjadi kesalahan jaringan saat mengirim pesan: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i><span>Kirim Sekarang</span>';
  }
}

// ==========================================
// 13. STATUS & SINKRONISASI SUPABASE CLOUD
// ==========================================

async function checkSupabaseStatus(interactive = false) {
  try {
    const res = await fetch('/api/supabase/status');
    const data = await res.json();

    const badge = document.getElementById('supabaseStatusBadge');
    const dot = document.getElementById('supabaseDot');
    const text = document.getElementById('supabaseStatusText');

    if (!badge || !dot || !text) return;

    if (data.tablesReady) {
      badge.className = 'hidden sm:flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-emerald-400/10 text-emerald-300 border border-emerald-400/30 hover:bg-emerald-400/20 transition cursor-pointer';
      dot.className = 'w-2 h-2 rounded-full bg-emerald-400';
      text.textContent = 'Supabase: Sinkron';
      if (interactive) {
        alert('✅ Database Cloud Supabase AKTIF dan tersinkronisasi penuh!');
      }
    } else if (data.connected) {
      badge.className = 'hidden sm:flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-amber-400/10 text-amber-300 border border-amber-400/30 hover:bg-amber-400/20 transition cursor-pointer';
      dot.className = 'w-2 h-2 rounded-full bg-amber-400 animate-pulse';
      text.textContent = 'Supabase: Perlu SQL';
      if (interactive) {
        alert('ℹ️ Supabase terhubung dengan Secret Key!\n\nNamun tabel database belum dibuat di Supabase.\nSilakan jalankan query supabase_schema.sql di SQL Editor Supabase Anda.');
      }
    } else {
      badge.className = 'hidden sm:flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-rose-400/10 text-rose-300 border border-rose-400/30 hover:bg-rose-400/20 transition cursor-pointer';
      dot.className = 'w-2 h-2 rounded-full bg-rose-400';
      text.textContent = 'Supabase Offline';
      if (interactive) {
        alert('⚠️ Supabase belum terhubung: ' + (data.message || 'Error'));
      }
    }
  } catch (err) {
    console.error('Gagal memeriksa status Supabase:', err);
  }
}
