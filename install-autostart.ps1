# JURNAL Tracker'ni Windows startup'ga qo'shadi
# Bir marta ishga tushiring (PowerShell)

$WshShell = New-Object -ComObject WScript.Shell
$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'JURNAL Tracker.lnk'
$targetPath = Join-Path $PSScriptRoot 'start.bat'

if (-not (Test-Path $targetPath)) {
  Write-Host "[!] start.bat topilmadi: $targetPath" -ForegroundColor Red
  exit 1
}

$shortcut = $WshShell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $targetPath
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.WindowStyle = 7   # minimized
$shortcut.Description = 'JURNAL Roadmap Tracker — kunlik email hisobot'
$shortcut.Save()

Write-Host ""
Write-Host "[OK] Avtomatik ishga tushirish sozlandi" -ForegroundColor Green
Write-Host "     Shortcut: $shortcutPath" -ForegroundColor Gray
Write-Host ""
Write-Host "Endi har kompyuter yoqilganda tracker o'zi ishga tushadi" -ForegroundColor Cyan
Write-Host "Olib tashlash uchun shortcut'ni o'chiring" -ForegroundColor Gray
Write-Host ""
