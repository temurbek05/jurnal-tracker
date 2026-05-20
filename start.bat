@echo off
chcp 65001 > nul
cd /d "%~dp0"

if not exist .env (
  echo.
  echo  [!] .env fayli yo'q. .env.example ni .env ga nusxalab to'ldiring.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo.
  echo  Birinchi marta — paketlar o'rnatilmoqda...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo  [!] npm install xatolik berdi.
    pause
    exit /b 1
  )
)

start "" http://localhost:5555
node tracker.js
