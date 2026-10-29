# Заливка файлов приложения в GitHub через API (git не нужен).
# Читает токен из C:\Users\Эдуард\Downloads\токены.txt (строка github=...)
# Запуск: powershell -NoProfile -ExecutionPolicy Bypass -File tools\sync-github.ps1

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Net.Http

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$src = "C:\Users\Эдуард\Downloads\ЗАЛИТЬ-В-GITHUB"
$owner = "bvydcvkbnovhsdsvibsdv7woikhcfhnoesb7f"
$repoName = "masha"
$branch = "main"

$tokenFile = "C:\Users\Эдуард\Downloads\токены.txt"
$gh = (Get-Content $tokenFile | Where-Object { $_ -match '^\s*github\s*=\s*(.+)$' } | ForEach-Object { $Matches[1].Trim() } | Select-Object -First 1)
if (-not $gh) { throw "нет github= в $tokenFile" }
if (-not (Test-Path $src)) { throw "нет папки с файлами: $src" }

$headers = @{
    Authorization          = "Bearer $gh"
    Accept                 = "application/vnd.github+json"
    "User-Agent"           = "masha-sync"
    "X-GitHub-Api-Version" = "2022-11-28"
}
$api = "https://api.github.com/repos/$owner/$repoName"

function Invoke-GH($method, $url, $obj) {
    $json = if ($null -ne $obj) { $obj | ConvertTo-Json -Depth 8 -Compress } else { $null }
    $params = @{ Uri = $url; Method = $method; Headers = $headers; TimeoutSec = 120 }
    if ($json) { $params["Body"] = [System.Text.Encoding]::UTF8.GetBytes($json); $params["ContentType"] = "application/json" }
    return Invoke-RestMethod @params
}

Write-Host "1) читаю ветку $branch ..."
$refInfo = Invoke-GH "GET" "$api/git/ref/heads/$branch" $null
$baseCommit = $refInfo.object.sha
$commitInfo = Invoke-GH "GET" "$api/git/commits/$baseCommit" $null
$baseTree = $commitInfo.tree.sha
Write-Host "   базовый коммит: $($baseCommit.Substring(0,7)) | дерево: $($baseTree.Substring(0,7))"

$files = Get-ChildItem $src -Recurse -File | Where-Object { $_.FullName -notmatch '\\\.github\\workflows\\' }
Write-Host "2) загружаю $($files.Count) файлов как blob'ы ..."
$entries = New-Object System.Collections.ArrayList
$i = 0
$total = $files.Count
foreach ($f in $files) {
    $i++
    $rel = $f.FullName.Substring($src.Length + 1).Replace("\", "/")
    $b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($f.FullName))
    $blob = Invoke-GH "POST" "$api/git/blobs" @{ content = $b64; encoding = "base64" }
    [void]$entries.Add(@{ path = $rel; mode = "100644"; type = "blob"; sha = $blob.sha })
    if ($i % 25 -eq 0 -or $i -eq $total) {
        Write-Host ("   {0}/{1} — {2} ({3} КБ)" -f $i, $total, $rel, [math]::Round($f.Length / 1KB, 0))
    }
}

Write-Host "3) создаю дерево (порциями по 60, чтобы не упереться в лимит запроса) ..."
$currentTree = $baseTree
$batchSize = 60
for ($b = 0; $b -lt $entries.Count; $b += $batchSize) {
    $slice = $entries[$b..([Math]::Min($b + $batchSize - 1, $entries.Count - 1))]
    $json = @{ base_tree = $currentTree; tree = $slice } | ConvertTo-Json -Depth 8 -Compress
    $params = @{
        Uri = "$api/git/trees"; Method = "POST"; Headers = $headers; TimeoutSec = 120
        Body = [System.Text.Encoding]::UTF8.GetBytes($json); ContentType = "application/json"
    }
    $res = Invoke-RestMethod @params
    $currentTree = $res.sha
    Write-Host ("   порция {0}-{1}: дерево {2}" -f $b, ([Math]::Min($b + $batchSize, $entries.Count) - 1), $currentTree.Substring(0, 7))
}
$tree = @{ sha = $currentTree }

Write-Host "4) создаю коммит ..."
$msg = "Маша: сборка 30 — её голос (XTTS), распознавание речи, рабочий релей"
$commit = Invoke-GH "POST" "$api/git/commits" @{ message = $msg; tree = $tree.sha; parents = @($baseCommit) }
Write-Host "   коммит: $($commit.sha.Substring(0,7))"

Write-Host "5) обновляю ветку ..."
Invoke-GH "PATCH" "$api/git/refs/heads/$branch" @{ sha = $commit.sha; force = $true } | Out-Null

Write-Host ""
Write-Host "ГОТОВО. Репозиторий: https://github.com/$owner/$repoName" -ForegroundColor Green
