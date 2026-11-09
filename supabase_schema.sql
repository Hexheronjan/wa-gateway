-- ====================================================================
-- SUPABASE SCHEMA UNTUK WHATSAPP BLASTING MULTI-OPERATOR (ANTI-BANNED)
-- Salin dan jalankan script ini di:
-- https://supabase.com/dashboard/project/qrvlumpzxzgcxsfufrcf/sql/new
-- ====================================================================

-- 1. Tabel Karyawan / Pengguna Aplikasi
CREATE TABLE IF NOT EXISTS public.app_users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Tabel Riwayat Kontak Terkirim (Anti-Kirim Ulang Lintas Karyawan)
CREATE TABLE IF NOT EXISTS public.sent_history (
  number TEXT PRIMARY KEY,
  business_name TEXT,
  category TEXT,
  message TEXT,
  sent_by TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Tabel Daftar Blokir / Opt-Out (STOP / BERHENTI / TIDAK)
CREATE TABLE IF NOT EXISTS public.blacklist (
  number TEXT PRIMARY KEY,
  reason TEXT,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Tabel Antrean Kontak (Queue Items)
CREATE TABLE IF NOT EXISTS public.queue_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nomor TEXT NOT NULL,
  raw_nomor TEXT,
  nama_bisnis TEXT,
  kategori TEXT,
  status TEXT DEFAULT 'READY',
  status_text TEXT,
  sent_by TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Tabel Template Pesan Spintax
CREATE TABLE IF NOT EXISTS public.templates (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Tabel Pengaturan & Statistik Global
CREATE TABLE IF NOT EXISTS public.app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Pastikan service_role dan authenticated memiliki akses penuh
ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sent_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blacklist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.queue_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- Policy agar backend service_role dapat membaca dan menulis
DROP POLICY IF EXISTS "Service role full access app_users" ON public.app_users;
CREATE POLICY "Service role full access app_users" ON public.app_users FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access sent_history" ON public.sent_history;
CREATE POLICY "Service role full access sent_history" ON public.sent_history FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access blacklist" ON public.blacklist;
CREATE POLICY "Service role full access blacklist" ON public.blacklist FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access queue_items" ON public.queue_items;
CREATE POLICY "Service role full access queue_items" ON public.queue_items FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access templates" ON public.templates;
CREATE POLICY "Service role full access templates" ON public.templates FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access app_settings" ON public.app_settings;
CREATE POLICY "Service role full access app_settings" ON public.app_settings FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Insert Akun Super Admin Bawaan
INSERT INTO public.app_users (id, name, username, password, role, status)
VALUES ('usr_admin', 'Super Admin', 'prajalinks@gmail.com', 'prajalinks0123', 'super_admin', 'active')
ON CONFLICT (id) DO NOTHING;
