/**
 * Modul Integrasi Supabase Database
 * Digunakan untuk sinkronisasi data antar karyawan (Multi-Operator):
 * - app_users (Daftar karyawan & login)
 * - sent_history (Pencegahan duplikasi pengiriman silang antar karyawan)
 * - blacklist (Daftar nomor blokir bersama)
 * - queue_items (Antrean nomor)
 * - templates (Template Spintax pesan)
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || '';
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || '';

let supabaseClient = null;
let isConfigured = false;
let tablesAvailable = false;
let lastCheckTime = 0;

try {
  if (SUPABASE_URL && SUPABASE_SECRET_KEY) {
    supabaseClient = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
    isConfigured = true;
    console.log('✅ Supabase client berhasil diinisialisasi:', SUPABASE_URL);
  }
} catch (err) {
  console.warn('⚠️ Gagal inisialisasi Supabase client:', err.message);
}

/**
 * Cek apakah tabel-tabel Supabase sudah dibuat dan siap digunakan
 */
async function checkHealth() {
  if (!supabaseClient) return { connected: false, tablesReady: false, message: 'Supabase client belum terpasang' };
  
  try {
    const { data, error } = await supabaseClient.from('app_users').select('id').limit(1);
    if (error) {
      if (error.code === 'PGRST205' || error.message.includes('Could not find the table')) {
        tablesAvailable = false;
        return {
          connected: true,
          tablesReady: false,
          message: 'Tabel database di Supabase belum dibuat. Jalankan query supabase_schema.sql di SQL Editor Supabase.'
        };
      }
      return { connected: true, tablesReady: false, message: error.message };
    }
    tablesAvailable = true;
    return { connected: true, tablesReady: true, message: 'Supabase Database aktif & sinkron' };
  } catch (err) {
    return { connected: false, tablesReady: false, message: err.message };
  }
}

/**
 * Sinkronisasi Pengguna (Users)
 */
async function fetchUsers() {
  if (!supabaseClient || !tablesAvailable) return null;
  try {
    const { data, error } = await supabaseClient.from('app_users').select('*').order('created_at', { ascending: true });
    if (error) throw error;
    return data.map(u => ({
      id: u.id,
      name: u.name,
      username: u.username,
      password: u.password,
      role: u.role,
      status: u.status,
      createdAt: u.created_at
    }));
  } catch (err) {
    console.warn('Supabase fetchUsers gagal:', err.message);
    return null;
  }
}

async function upsertUser(user) {
  if (!supabaseClient || !tablesAvailable) return false;
  try {
    const { error } = await supabaseClient.from('app_users').upsert({
      id: user.id,
      name: user.name,
      username: user.username,
      password: user.password,
      role: user.role,
      status: user.status || 'active',
      created_at: user.createdAt || new Date().toISOString()
    });
    if (error) throw error;
    return true;
  } catch (err) {
    console.warn('Supabase upsertUser gagal:', err.message);
    return false;
  }
}

async function deleteUser(userId) {
  if (!supabaseClient || !tablesAvailable) return false;
  try {
    const { error } = await supabaseClient.from('app_users').delete().eq('id', userId);
    if (error) throw error;
    return true;
  } catch (err) {
    console.warn('Supabase deleteUser gagal:', err.message);
    return false;
  }
}

/**
 * Sinkronisasi Riwayat Kontak Terkirim (sent_history)
 */
async function fetchSentHistory() {
  if (!supabaseClient || !tablesAvailable) return null;
  try {
    const { data, error } = await supabaseClient.from('sent_history').select('*');
    if (error) throw error;
    const map = {};
    (data || []).forEach(row => {
      map[row.number] = {
        sentAt: row.sent_at,
        businessName: row.business_name,
        category: row.category,
        message: row.message,
        sentBy: row.sent_by
      };
    });
    return map;
  } catch (err) {
    console.warn('Supabase fetchSentHistory gagal:', err.message);
    return null;
  }
}

async function recordSentMessage(number, data) {
  if (!supabaseClient || !tablesAvailable) return false;
  try {
    const { error } = await supabaseClient.from('sent_history').upsert({
      number: String(number),
      business_name: data.businessName || '',
      category: data.category || '',
      message: data.message || '',
      sent_by: data.sentBy || 'Super Admin',
      sent_at: data.sentAt || new Date().toISOString()
    });
    if (error) throw error;
    return true;
  } catch (err) {
    console.warn('Supabase recordSentMessage gagal:', err.message);
    return false;
  }
}

/**
 * Sinkronisasi Daftar Blokir (blacklist)
 */
async function fetchBlacklist() {
  if (!supabaseClient || !tablesAvailable) return null;
  try {
    const { data, error } = await supabaseClient.from('blacklist').select('number');
    if (error) throw error;
    return (data || []).map(r => r.number);
  } catch (err) {
    console.warn('Supabase fetchBlacklist gagal:', err.message);
    return null;
  }
}

async function addToBlacklist(number, reason = '') {
  if (!supabaseClient || !tablesAvailable) return false;
  try {
    const { error } = await supabaseClient.from('blacklist').upsert({
      number: String(number),
      reason: reason || 'Opt-out (STOP)',
      added_at: new Date().toISOString()
    });
    if (error) throw error;
    return true;
  } catch (err) {
    console.warn('Supabase addToBlacklist gagal:', err.message);
    return false;
  }
}

async function removeFromBlacklist(number) {
  if (!supabaseClient || !tablesAvailable) return false;
  try {
    const { error } = await supabaseClient.from('blacklist').delete().eq('number', String(number));
    if (error) throw error;
    return true;
  } catch (err) {
    console.warn('Supabase removeFromBlacklist gagal:', err.message);
    return false;
  }
}

/**
 * Sinkronisasi Antrean (queue_items)
 */
async function syncQueueItems(items) {
  if (!supabaseClient || !tablesAvailable) return false;
  try {
    // Bersihkan lalu masukkan yang baru
    await supabaseClient.from('queue_items').delete().neq('id', 0);
    if (!items || items.length === 0) return true;

    const payload = items.map(item => ({
      nomor: item.nomor,
      raw_nomor: item.rawNomor || item.nomor,
      nama_bisnis: item.nama_bisnis || '',
      kategori: item.kategori || 'umum',
      status: item.status || 'READY',
      status_text: item.statusText || '',
      sent_by: item.sentBy || '',
      sent_at: item.sentAt || null
    }));

    const { error } = await supabaseClient.from('queue_items').insert(payload);
    if (error) throw error;
    return true;
  } catch (err) {
    console.warn('Supabase syncQueueItems gagal:', err.message);
    return false;
  }
}

/**
 * Ekspor modul
 */
module.exports = {
  supabaseClient,
  isConfigured: () => isConfigured,
  areTablesReady: () => tablesAvailable,
  checkHealth,
  fetchUsers,
  upsertUser,
  deleteUser,
  fetchSentHistory,
  recordSentMessage,
  fetchBlacklist,
  addToBlacklist,
  removeFromBlacklist,
  syncQueueItems
};
