# Подключение голоса ElevenLabs к релею «Маши».
# Запуск: powershell -NoProfile -ExecutionPolicy Bypass -File tools\add-elevenlabs.ps1
# Нужны строки в C:\Users\Эдуард\Downloads\токены.txt:
#   elevenlabs_key=...
#   elevenlabs_voice=...
#   cloudflare=...

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Net.Http

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ACCOUNT = "47ff370b5cbb0c42260d805647250aca"
$SCRIPT = "masha-relay"
$TOKENS = "C:\Users\Эдуард\Downloads\токены.txt"

function Get-Token($name) {
    $v = (Get-Content $TOKENS | Where-Object { $_ -match ("^\s*" + $name + "\s*=\s*(.+)$") } | ForEach-Object { $Matches[1].Trim() } | Select-Object -First 1)
    return $v
}

$cf = Get-Token "cloudflare"
$elKey = Get-Token "elevenlabs_key"
$elVoice = Get-Token "elevenlabs_voice"

if (-not $cf) { throw "нет cloudflare= в $TOKENS" }
if (-not $elKey) { throw "нет elevenlabs_key= в $TOKENS — сначала зарегистрируйся и создай ключ" }
if (-not $elVoice) { throw "нет elevenlabs_voice= в $TOKENS — скопируй Voice ID голоса" }

Write-Host ("Ключ ElevenLabs: " + $elKey.Substring(0, [Math]::Min(6, $elKey.Length)) + "..., длина " + $elKey.Length)
Write-Host ("Voice ID: " + $elVoice)

# --- 1. Проверяем ключ и голос в ElevenLabs
Write-Host ""
Write-Host "1) проверяю ключ ElevenLabs ..."
try {
    $voices = Invoke-RestMethod "https://api.elevenlabs.io/v1/voices" -Headers @{ "xi-api-key" = $elKey } -TimeoutSec 40
    Write-Host ("   ключ работает. Голосов в аккаунте: " + $voices.voices.Count)
    foreach ($v in $voices.voices) {
        $mark = if ($v.voice_id -eq $elVoice) { "  <-- ВЫБРАН" } else { "" }
        Write-Host ("   - " + $v.name + " | " + $v.voice_id + $mark)
    }
} catch {
    Write-Host ("   ОШИБКА ключа: " + $_.Exception.Message) -ForegroundColor Red
    if ($_.ErrorDetails) { Write-Host ("   " + $_.ErrorDetails.Message) }
    exit 1
}

# --- 2. Прописываем секреты в воркер
Write-Host ""
Write-Host "2) прописываю секреты в Cloudflare ..."
$secrets = @(
    @{ name = "ELEVENLABS_KEY"; text = $elKey },
    @{ name = "ELEVENLABS_VOICE_ID"; text = $elVoice }
)
foreach ($s in $secrets) {
    $body = @{ name = $s.name; text = $s.text; type = "secret_text" } | ConvertTo-Json -Compress
    try {
        $r = Invoke-RestMethod "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/scripts/$SCRIPT/secrets" `
            -Method Put -Headers @{ Authorization = "Bearer $cf" } `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -ContentType "application/json" -TimeoutSec 60
        if ($r.success) { Write-Host ("   " + $s.name + ": установлен") } else { Write-Host ("   " + $s.name + ": ошибка") }
    } catch {
        Write-Host ("   " + $s.name + ": ОШИБКА " + $_.Exception.Message)
        if ($_.ErrorDetails) { Write-Host ("     " + $_.ErrorDetails.Message) }
    }
}

# --- 3. Проверяем, что релей видит голос
Write-Host ""
Write-Host "3) жду, пока релей применит настройки ..."
$relay = "https://masha-relay.lusnikoveduard9.workers.dev"
$tts = ""
for ($i = 1; $i -le 12; $i++) {
    Start-Sleep -Seconds 5
    try {
        $h = Invoke-RestMethod "$relay/health" -TimeoutSec 20
        $tts = [string]$h.tts
        Write-Host ("   [" + ($i * 5) + " сек] tts = " + $tts)
        if ($tts -match "elevenlabs") { break }
    } catch { Write-Host ("   [" + ($i * 5) + " сек] релей не отвечает") }
}

# --- 4. Озвучиваем тестовую фразу
Write-Host ""
Write-Host "4) озвучиваю тестовую фразу через ElevenLabs ..."
$payload = @{ tts = "Привет, это мой голос. Я тебя очень сильно люблю." } | ConvertTo-Json -Compress
try {
    $r = Invoke-WebRequest "$relay/api/relay" -Method Post `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($payload)) `
        -ContentType "application/json; charset=utf-8" -TimeoutSec 120 -UseBasicParsing
    $j = $r.Content | ConvertFrom-Json
    if ($j.ok -and $j.audio) {
        $bytes = [Convert]::FromBase64String($j.audio)
        $out = "C:\Users\Эдуард\Downloads\голос-ElevenLabs.wav"
        [System.IO.File]::WriteAllBytes($out, $bytes)
        Write-Host ("   OK! " + [Math]::Round($bytes.Length / 1KB, 1) + " КБ → " + $out) -ForegroundColor Green
        Write-Host ("   провайдер: " + $j.provider)
        Start-Process $out
    } else {
        Write-Host ("   не получилось: " + $j.error + " " + $j.message) -ForegroundColor Red
    }
} catch {
    Write-Host ("   ОШИБКА: " + $_.Exception.Message)
    if ($_.ErrorDetails) { Write-Host ("   " + $_.ErrorDetails.Message) }
}

Write-Host ""
Write-Host "ГОТОВО. В приложении: Настройки → Голос Маши → включи «Озвучивать её голосом»." -ForegroundColor Green
