@echo off
title WA Sender Website Penawaran
color 0b
echo ========================================================
echo   Memulai WA Sender Website (Multi-Operator Cloud)
echo ========================================================
echo.

:: 1. Cek apakah Node.js sudah terpasang
where node >nul 2>nul
if %errorlevel% neq 0 (
    color 0c
    echo [ERROR] Node.js belum terinstall di laptop ini!
    echo Silakan download dan install Node.js dari: https://nodejs.org
    echo Setelah install, buka kembali file ini.
    echo.
    pause
    exit /b
)

:: 2. Cek apakah folder node_modules sudah ada
if not exist "node_modules\" (
    echo [INFO] Memasang dependencies (hanya 1x saat pertama kali)...
    call npm install
    if %errorlevel% neq 0 (
        color 0c
        echo [ERROR] Gagal menjalankan npm install. Periksa koneksi internet Anda.
        pause
        exit /b
    )
)

:: 3. Jalankan server aplikasi
echo.
echo [INFO] Server berjalan! Silakan buka Google Chrome:
echo        http://localhost:3000
echo.
call npm start
pause
