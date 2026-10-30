# Деплой релея «Маши» в Cloudflare Workers через API.
# Запуск:  powershell -File tools\deploy-worker.ps1
# Токен берётся из C:\Users\Эдуард\Downloads\токены.txt (строка cloudflare=...)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Net.Http
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ACCOUNT = "47ff370b5cbb0c42260d805647250aca"
$SCRIPT = "masha-relay"
$WORKER = Join-Path $root "worker\worker.js"

$tokenFile = "C:\Users\Эдуард\Downloads\токены.txt"
if (-not (Test-Path $tokenFile)) { throw "нет файла с токенами: $tokenFile" }
$cf = (Get-Content $tokenFile | Where-Object { $_ -match '^\s*cloudflare\s*=\s*(.+)$' } | ForEach-Object { $Matches[1].Trim() } | Select-Object -First 1)
if (-not $cf) { throw "в файле нет строки cloudflare=" }

$dsKey = (Get-Content $tokenFile | Where-Object { $_ -match '^\s*deepseek\s*=\s*(.+)$' } | ForEach-Object { $Matches[1].Trim() } | Select-Object -First 1)
if (-not $dsKey) { $dsKey = "sk-a0f49e113e3c4187aed7b89a9a252014" }

Write-Host "Ключ DeepSeek: $($dsKey.Substring(0,6))..., длина $($dsKey.Length)"
Write-Host "Воркер: $SCRIPT (аккаунт $ACCOUNT)"

$code = [System.IO.File]::ReadAllBytes($WORKER)
Write-Host "Код воркера: $([math]::Round($code.Length/1KB,1)) КБ"

$metadata = @{
    main_module        = "worker.js"
    compatibility_date = "2024-09-23"
    bindings           = @(
        @{ type = "ai"; name = "AI" },
        @{ type = "secret_text"; name = "DEEPSEEK_API_KEY"; text = $dsKey },
        @{ type = "plain_text"; name = "HF_TTS_SPACE"; text = "Nymbo/Voice-Clone-Multilingual" },
        @{ type = "plain_text"; name = "HF_TTS_REF_URL"; text = "https://bvydcvkbnovhsdsvibsdv7woikhcfhnoesb7f.github.io/masha/voice/ref.wav" },
        @{ type = "plain_text"; name = "HF_TTS_LANG"; text = "ru" }
    )
} | ConvertTo-Json -Depth 6 -Compress

Write-Host "Metadata: $metadata"

$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromMinutes(3)
$client.DefaultRequestHeaders.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", $cf)

$form = New-Object System.Net.Http.MultipartFormDataContent
$metaContent = New-Object System.Net.Http.StringContent($metadata, [System.Text.Encoding]::UTF8, "application/json")
$form.Add($metaContent, "metadata")

$codeContent = New-Object System.Net.Http.ByteArrayContent -ArgumentList @(,$code)
$codeContent.Headers.ContentType = New-Object System.Net.Http.Headers.MediaTypeHeaderValue("application/javascript+module")
$form.Add($codeContent, "worker.js", "worker.js")

$url = "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/scripts/$SCRIPT"
Write-Host "Загружаю на $url ..."
try {
    $resp = $client.PutAsync($url, $form).Result
    $body = $resp.Content.ReadAsStringAsync().Result
    Write-Host "HTTP $([int]$resp.StatusCode)"
    $json = $body | ConvertFrom-Json
    if ($json.success) {
        Write-Host "OK: релей задеплоен (версия $($json.result.id))" -ForegroundColor Green
        Write-Host "Адрес: https://$SCRIPT.lusnikoveduard9.workers.dev"
    } else {
        Write-Host "ОШИБКА:" -ForegroundColor Red
        $json.errors | ForEach-Object { Write-Host ("  " + $_.code + ": " + $_.message) }
    }
} catch {
    Write-Host "ИСКЛЮЧЕНИЕ: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.Exception.InnerException) { Write-Host "  $($_.Exception.InnerException.Message)" }
}
