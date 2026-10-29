# Клонирование голоса Маши в Fish Audio + подключение к релею.
# Запуск: powershell -NoProfile -ExecutionPolicy Bypass -File tools\add-fish.ps1
#
# Нужны строки в C:\Users\Эдуард\Downloads\токены.txt:
#   fish_key=...     (API-ключ из личного кабинета fish.audio)
#   cloudflare=...   (уже есть)
#
# Скрипт сам: создаёт голос из 8 файлов, берёт его id, прописывает секреты
# в воркер и озвучивает тестовую фразу.

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Net.Http

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$TOKENS = "C:\Users\Эдуард\Downloads\токены.txt"
$ACCOUNT = "47ff370b5cbb0c42260d805647250aca"
$SCRIPT = "masha-relay"
$RELAY = "https://masha-relay.lusnikoveduard9.workers.dev"
$CLIPS = "C:\Users\Эдуард\Downloads\голос-для-клонирования"

function Get-Token($name) {
    return ((Get-Content $TOKENS | Where-Object { $_ -match ("^\s*" + $name + "\s*=\s*(.+)$") } | ForEach-Object { $Matches[1].Trim() } | Select-Object -First 1))
}
function Set-Token($name, $value) {
    $lines = @(Get-Content $TOKENS | Where-Object { $_ -notmatch ("^\s*" + $name + "\s*=") })
    $lines += ($name + "=" + $value)
    [System.IO.File]::WriteAllLines($TOKENS, $lines, (New-Object System.Text.UTF8Encoding($false)))
}

$cf = Get-Token "cloudflare"
$fishKey = Get-Token "fish_key"
$fishVoice = Get-Token "fish_voice"

if (-not $fishKey) { throw "нет fish_key= в $TOKENS — сначала зарегистрируйся на fish.audio и создай API-ключ" }
Write-Host ("Ключ Fish: " + $fishKey.Substring(0, [Math]::Min(8, $fishKey.Length)) + "..., длина " + $fishKey.Length)

# ---------- 1. Проверяем ключ
Write-Host ""
Write-Host "1) проверяю ключ Fish Audio ..."
$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromMinutes(5)
try {
    $req = New-Object System.Net.Http.HttpRequestMessage -ArgumentList ([System.Net.Http.HttpMethod]::Get), "https://api.fish.audio/model?page_size=5"
    $req.Headers.Add("Authorization", "Bearer $fishKey")
    $resp = $client.SendAsync($req).Result
    $body = $resp.Content.ReadAsStringAsync().Result
    Write-Host ("   HTTP " + [int]$resp.StatusCode)
    if (-not $resp.IsSuccessStatusCode) { throw ("ключ не принят: " + $body) }
    Write-Host "   ключ работает"
} catch {
    Write-Host ("   ОШИБКА: " + $_.Exception.Message) -ForegroundColor Red
    exit 1
}

# ---------- 2. Создаём голос из 8 файлов (если ещё не создан)
if (-not $fishVoice) {
    Write-Host ""
    Write-Host "2) создаю голос «Маша» из 8 файлов ..."
    $clips = Get-ChildItem $CLIPS -File -Filter "*.ogg" | Where-Object { $_.Name -match "^\d\d_" } | Sort-Object Name
    if ($clips.Count -eq 0) { throw "нет файлов голоса в $CLIPS" }
    Write-Host ("   файлов: " + $clips.Count)

    $form = New-Object System.Net.Http.MultipartFormDataContent
    $form.Add((New-Object System.Net.Http.StringContent("tts")), "type")
    $form.Add((New-Object System.Net.Http.StringContent("Маша")), "title")
    $form.Add((New-Object System.Net.Http.StringContent("Её настоящий голос из переписки")), "description")
    $form.Add((New-Object System.Net.Http.StringContent("private")), "visibility")
    $form.Add((New-Object System.Net.Http.StringContent("fast")), "train_mode")
    foreach ($c in $clips) {
        $bytes = [System.IO.File]::ReadAllBytes($c.FullName)
        $part = New-Object System.Net.Http.ByteArrayContent -ArgumentList @(, $bytes)
        $part.Headers.ContentType = New-Object System.Net.Http.Headers.MediaTypeHeaderValue("audio/ogg")
        $form.Add($part, "voices", $c.Name)
    }
    $req2 = New-Object System.Net.Http.HttpRequestMessage -ArgumentList ([System.Net.Http.HttpMethod]::Post), "https://api.fish.audio/model"
    $req2.Headers.Add("Authorization", "Bearer $fishKey")
    $req2.Content = $form
    $resp2 = $client.SendAsync($req2).Result
    $body2 = $resp2.Content.ReadAsStringAsync().Result
    Write-Host ("   HTTP " + [int]$resp2.StatusCode)
    if (-not $resp2.IsSuccessStatusCode) {
        Write-Host ("   ответ: " + $body2) -ForegroundColor Red
        throw "не удалось создать голос"
    }
    $model = $body2 | ConvertFrom-Json
    $fishVoice = $model._id
    if (-not $fishVoice) { $fishVoice = $model.id }
    if (-not $fishVoice) { Write-Host ("   ответ: " + $body2); throw "не нашёл id голоса в ответе" }
    Write-Host ("   голос создан! Voice ID: " + $fishVoice) -ForegroundColor Green
    Write-Host ("   состояние: " + $model.state)
    Set-Token "fish_voice" $fishVoice
} else {
    Write-Host ""
    Write-Host ("2) голос уже есть: " + $fishVoice)
}

# ---------- 3. Прописываем секреты в воркер
Write-Host ""
Write-Host "3) прописываю секреты в Cloudflare ..."
foreach ($s in @(@{ name = "FISH_KEY"; text = $fishKey }, @{ name = "FISH_VOICE_ID"; text = $fishVoice })) {
    $json = @{ name = $s.name; text = $s.text; type = "secret_text" } | ConvertTo-Json -Compress
    try {
        $r = Invoke-RestMethod "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/scripts/$SCRIPT/secrets" `
            -Method Put -Headers @{ Authorization = "Bearer $cf" } `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($json)) -ContentType "application/json" -TimeoutSec 60
        Write-Host ("   " + $s.name + ": " + $(if ($r.success) { "установлен" } else { "ошибка" }))
    } catch {
        Write-Host ("   " + $s.name + ": ОШИБКА " + $_.Exception.Message)
        if ($_.ErrorDetails) { Write-Host ("     " + $_.ErrorDetails.Message) }
    }
}

# ---------- 4. Ждём, пока релей увидит голос
Write-Host ""
Write-Host "4) жду применения настроек ..."
for ($i = 1; $i -le 12; $i++) {
    Start-Sleep -Seconds 5
    try {
        $h = Invoke-RestMethod "$RELAY/health" -TimeoutSec 20
        Write-Host ("   [" + ($i * 5) + " сек] tts = " + $h.tts)
        if ([string]$h.tts -match "fish") { break }
    } catch { }
}

# ---------- 5. Озвучиваем тест
Write-Host ""
Write-Host "5) озвучиваю её голосом через Fish Audio ..."
$payload = @{ tts = "Привет, это мой настоящий голос. Я тебя очень сильно люблю." } | ConvertTo-Json -Compress
try {
    $r = Invoke-WebRequest "$RELAY/api/relay" -Method Post `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($payload)) `
        -ContentType "application/json; charset=utf-8" -TimeoutSec 180 -UseBasicParsing
    $j = $r.Content | ConvertFrom-Json
    if ($j.ok -and $j.audio) {
        $bytes = [Convert]::FromBase64String($j.audio)
        $ext = if ($j.mime -match "wav") { "wav" } else { "mp3" }
        $out = "C:\Users\Эдуард\Downloads\голос-Fish-Маша.$ext"
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
Write-Host "ГОТОВО. В приложении: Настройки → Голос Маши → «Озвучивать её голосом»." -ForegroundColor Green
