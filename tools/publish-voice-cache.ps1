# Публикация озвученных фраз на сайт (чтобы её голос работал на телефоне).
# Запуск: powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish-voice-cache.ps1
#
# Что делает:
#   1) собирает voice\tts-index.json (фраза -> файл);
#   2) копирует voice\cache\*.wav и индекс в папку заливки;
#   3) заливает всё в GitHub (сайт GitHub Pages отдаёт эти файлы телефону).

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$up = "C:\Users\Эдуард\Downloads\ЗАЛИТЬ-В-GITHUB"
$cache = Join-Path $root "voice\cache"

Write-Host "1) собираю индекс ..."
& python (Join-Path $root "tools\build-tts-index.py") | ForEach-Object { Write-Host ("   " + $_) }

$indexFile = Join-Path $root "voice\tts-index.json"
if (-not (Test-Path $indexFile)) { throw "не создался voice\tts-index.json" }

Write-Host ""
Write-Host "2) копирую в папку заливки ..."
New-Item -ItemType Directory -Path (Join-Path $up "voice\cache") -Force | Out-Null
Copy-Item $indexFile (Join-Path $up "voice\tts-index.json") -Force
$wavs = Get-ChildItem $cache -File -Filter "*.wav"
foreach ($w in $wavs) { Copy-Item $w.FullName (Join-Path $up "voice\cache\$($w.Name)") -Force }
Write-Host ("   wav-файлов: " + $wavs.Count)
Write-Host ("   размер: " + [Math]::Round((($wavs | Measure-Object Length -Sum).Sum / 1MB), 1) + " МБ")

# свежие версии приложения
foreach ($f in @("index.html", "sw.js", "js\config.js")) {
    $src = Join-Path $root $f
    if (Test-Path $src) { Copy-Item $src (Join-Path $up $f) -Force }
}

Write-Host ""
Write-Host "3) заливаю в GitHub (это займёт несколько минут при большом кэше) ..."
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "tools\sync-github.ps1")

Write-Host ""
Write-Host "ГОТОВО. Через 1-2 минуты сайт обновится, и её голос будет работать на телефоне." -ForegroundColor Green
Write-Host "Проверка: https://bvydcvkbnovhsdsvibsdv7woikhcfhnoesb7f.github.io/masha/voice/tts-index.json"
