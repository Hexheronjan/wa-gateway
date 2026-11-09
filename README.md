# 📱 WA Website Offer Sender (Anti-Banned Engine)

Aplikasi web lokal berbasis **Node.js + Express + whatsapp-web.js** untuk mengirimkan pesan penawaran pembuatan website secara otomatis melalui WhatsApp ke nomor-nomor prospek dari file Excel / CSV, dengan sistem keamanan berlapis untuk **mencegah pemblokiran nomor (anti-banned)**.

---

## 🛡️ Mengapa Aplikasi Ini Aman (Fitur Anti-Banned)

WhatsApp memiliki algoritma deteksi spam yang sangat ketat. Aplikasi ini dirancang dengan 11 lapisan keamanan wajib:

1. **Mode Pemanasan Otomatis (Warmup)**:
   - Hari 1 - 3: Maksimal **10 pesan / hari**
   - Hari 4 - 7: Maksimal **20 pesan / hari**
   - Hari 8 - 14: Maksimal **30 pesan / hari**
   - Setelah Hari ke-14: Maksimal **40 pesan / hari**
   - *Batas ini dikunci secara permanen di kode dan tidak bisa dinaikkan lewat pengaturan demi melindungi nomor.*
2. **Jeda Acak Alami (45 - 120 Detik)**:
   - Setiap pesan dikirim dengan jeda acak antara 45 hingga 120 detik, meniru jeda antar pesan manusia.
   - **Istirahat Panjang (5 - 10 Menit)**: Setiap 8 - 12 pesan terkirim, sistem otomatis rehat selama 5 - 10 menit (seperti manusia yang sedang istirahat sejenak).
3. **Pembatasan Jam Operasional (09.00 - 17.00)**:
   - Pengiriman hanya berjalan pada jam kerja (09.00 - 17.00 waktu setempat). Di luar jam tersebut, sistem otomatis menahan pengiriman hingga jam 09.00 pagi berikutnya.
4. **Simulasi Perilaku Manusia (Sedang Mengetik)**:
   - Sebelum pesan dikirim, sistem mengaktifkan status *"sedang mengetik..."* pada chat selama 3 - 7 detik (proporsional dengan panjang pesan).
5. **Variasi Pesan Tinggi (Spintax & Rotasi Template)**:
   - Mendukung format Spintax seperti `{Halo|Hai|Selamat siang}` dan `{Boleh|Bisa}`.
   - Setiap pengiriman memilih variasi kata secara acak sehingga **hampir tidak ada dua pesan yang identik**.
   - Disediakan 3 varian template bawaan per kategori (Hotel, Restoran, Klinik, Umum).
6. **Verifikasi Nomor Terdaftar**:
   - Memeriksa apakah nomor tujuan benar-benar terdaftar di WhatsApp sebelum mencoba mengirim. Nomor tidak terdaftar otomatis dilewati.
7. **Pesan Pertama Dingin (Cold Message) Aman**:
   - **TANPA LINK / TAUTAN** dan **TANPA LAMPIRAN** (aturan mutlak agar tidak terdeteksi spam pada chat pertama).
   - Singkat, ramah, menyebut nama bisnis, diakhiri pertanyaan ringan dan opsi berhenti: *"Kalau tidak berminat, balas STOP"*.
8. **Daftar Blokir Otomatis (Opt-Out Auto Blacklist)**:
   - Jika penerima membalas `STOP`, `BERHENTI`, atau `TIDAK`, nomor tersebut otomatis masuk ke daftar blokir (`blacklist`) di `data.json` dan tidak akan pernah dikirimi lagi.
9. **Pemutus Darurat (Circuit Breaker)**:
   - Jika terjadi **3 kegagalan kirim berturut-turut** atau sesi WhatsApp terputus, seluruh proses pengiriman langsung dihentikan otomatis dan memicu peringatan darurat ke layar.
10. **Pencegahan Duplikasi & Riwayat Permanen**:
    - Nomor yang sudah pernah dikirimi pesan dicatat di `data.json` dan tidak akan dikirim ulang meskipun aplikasi dijalankan lagi atau file Excel diimpor ulang.
11. **Pencatatan Log Lengkap**:
    - Seluruh aktivitas dicatat ke file `activity.log` lengkap dengan waktu, nomor tujuan, status, dan alasan.

---

## 📋 Struktur File

```
whatshap-kirim/
├── package.json          # Konfigurasi dependensi Node.js
├── server.js            # Server Express, Socket.IO & whatsapp-web.js engine
├── data.json            # Database lokal (warmup, sent history, blacklist, template)
├── activity.log         # Catatan log aktivitas pengiriman & sistem
├── sample_kontak.xlsx   # Contoh file Excel siap pakai
├── sample_kontak.csv    # Contoh file CSV siap pakai
└── public/              # Antarmuka Web (Frontend)
    ├── index.html       # Tampilan antarmuka responsif
    ├── style.css        # Gaya visual & status badge
    └── app.js           # Logika interaktif & WebSocket client
```

---

## 🚀 Langkah Instalasi & Menjalankan di Windows

### 1. Prasyarat
Pastikan komputer Windows Anda sudah terpasang **Node.js** (versi 18 ke atas disarankan).
Jika belum ada, unduh dari [https://nodejs.org](https://nodejs.org).

### 2. Buka Terminal / PowerShell
Buka folder aplikasi ini di PowerShell atau Command Prompt:
```powershell
cd "c:\whatshap kirim"
```

### 3. Pasang Dependensi
Jalankan perintah berikut:
```powershell
npm install
```
*(Proses ini akan mengunduh express, whatsapp-web.js, puppeteer/chromium, xlsx, multer, dan socket.io).*

### 4. Jalankan Aplikasi
Jalankan server dengan perintah:
```powershell
node server.js
```
*atau:*
```powershell
npm start
```

### 5. Buka di Browser
Buka browser favorit Anda (Chrome / Edge / Firefox) dan kunjungi:
```
http://localhost:3000
```
*(Jika port 3000 sedang digunakan aplikasi lain seperti Next.js, server akan otomatis menggunakan port 3001: `http://localhost:3001`)*.

---

## 📲 Cara Menghubungkan Nomor WhatsApp (Tanpa QR Code)

Aplikasi ini menggunakan fitur resmi **Pairing Code** dari WhatsApp Web:

1. Di halaman aplikasi, klik tombol hijau **"Kode Pairing"** di kanan atas.
2. Masukkan nomor WhatsApp pengirim Anda (contoh: `08123456789` atau `628123456789`).
3. Klik tombol **"Minta Kode"**.
4. Di layar akan muncul **8 karakter kode pairing** (contoh: `ABCD - 1234`).
5. Buka aplikasi WhatsApp di HP Anda:
   - Ketuk menu titik tiga (Android) atau **Pengaturan** (iPhone) > **Perangkat Tertaut**.
   - Ketuk **Tautkan Perangkat**.
   - Di bagian bawah layar, pilih **"Tautkan dengan nomor telepon saja"**.
   - Ketik 8 karakter kode pairing yang tertera di layar komputer.
6. WhatsApp akan terhubung! Status akan berubah menjadi hijau **"Terhubung: +62 812-xxxx-xxxx"**.
7. **Sesi Tersimpan (LocalAuth)**: Folder `.wwebjs_auth` akan menyimpan sesi login Anda. Jika aplikasi di-restart, WhatsApp akan otomatis langsung terhubung tanpa perlu verifikasi ulang!

---

## 📊 Format File Excel / CSV

File Excel (`.xlsx`) atau `.csv` harus memiliki 3 kolom utama di baris pertama (header):

| nomor | nama_bisnis | kategori |
| :--- | :--- | :--- |
| 081234567890 | Hotel Grand Mentari | hotel |
| 082198765432 | Klinik Medika Sehat | klinik |
| 085711223344 | Restoran Rasa Nusantara | restoran |
| 6281355556666 | Hotel Villa Indah | hotel |

- **Nomor**: Bisa diawali dengan `08`, `8`, atau `628`. Sistem otomatis merapikan menjadi `628xxx` dan membuang spasi/strip/tanda plus.
- **Kategori**: `hotel`, `restoran`, `klinik`, atau `umum`. Template pesan akan disesuaikan otomatis dengan kategori ini.

File contoh sudah tersedia langsung di dalam aplikasi: Anda dapat mengunduh `sample_kontak.xlsx` atau `sample_kontak.csv` melalui tombol di antarmuka.

---

## ✉️ Cara Menggunakan Template & Spintax

Pesan dapat dipersonalisasi dengan variabel dinamis:
- `{nama_bisnis}`: Diganti nama bisnis penerima (contoh: *Hotel Grand Mentari*).
- `{kategori}`: Diganti kategori (contoh: *hotel*).
- `{Halo|Hai|Selamat siang}`: Memilih salah satu kata secara acak.
- `{tertarik|berminat}`: Memilih variasi kata kedua.

**Contoh Template Bawaan (Hotel):**
> `{Halo|Hai|Selamat siang} pengelola {nama_bisnis}, perkenalkan saya dari tim pembuatan website. Kami melihat potensi hotel Anda sangat baik. Apakah {nama_bisnis} sudah memiliki website resmi untuk menampilkan foto kamar, daftar fasilitas, dan pemesanan langsung via WhatsApp? Kalau tidak berminat, balas STOP.`

Klik tombol **"Kocok Uji Spintax"** di aplikasi untuk melihat contoh pesan yang akan terkirim secara langsung!

---

## ⚠️ 3 Aturan Emas Keselamatan Tambahan

1. **Gunakan Nomor Khusus**: Jangan pernah gunakan nomor pribadi utama Anda.
2. **Nomor Baru Wajib Pemanasan Manual**: Nomor baru harus aktif chatting normal (keluarga/teman) minimal 1-2 minggu sebelum digunakan untuk penawaran.
3. **Patuhi Batas Sistem**: Jangan mencoba membypass batasan kuota harian. Konsistensi kecil setiap hari jauh lebih aman daripada mengirim ratusan pesan sekaligus yang berujung banned permanen.
