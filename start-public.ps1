# Anime Arena — public preview (Cloudflare Quick Tunnel)
# Run:  powershell -ExecutionPolicy Bypass -File .\start-public.ps1
# The link lives while this PC, the Node server and cloudflared are running.
# The URL changes every time cloudflared is restarted.

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$port = 8787
$cloudflared = 'C:\Temp\cloudflared.exe'
$log = Join-Path $env:TEMP 'anime-arena-tunnel.log'

Write-Host ''
Write-Host '  ANIME ARENA — public preview' -ForegroundColor Cyan
Write-Host '  ─────────────────────────────'

if (-not (Test-Path $cloudflared)) {
  Write-Host "  cloudflared topilmadi: $cloudflared" -ForegroundColor Red
  exit 1
}

# 1) Node server
$listening = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Listen' }
if (-not $listening) {
  Write-Host '  Server ishga tushirilmoqda…'
  Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $root -WindowStyle Hidden
  for ($i = 0; $i -lt 20; $i += 1) {
    Start-Sleep -Milliseconds 500
    try {
      $health = Invoke-RestMethod "http://127.0.0.1:$port/api/health" -TimeoutSec 3
      if ($health.ok) { break }
    } catch { }
  }
}

try {
  $health = Invoke-RestMethod "http://127.0.0.1:$port/api/health" -TimeoutSec 5
  Write-Host "  Server OK · $($health.catalog.heroes) hero · $($health.registeredPlayers) o‘yinchi" -ForegroundColor Green
} catch {
  Write-Host '  Server ishga tushmadi. Avval: npm start' -ForegroundColor Red
  exit 1
}

# 2) Restart only the tunnel that points at this project
$old = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'cloudflared.exe' -and $_.CommandLine -match '127\.0\.0\.1:8787'
}
foreach ($process in $old) {
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}

if (Test-Path $log) { Remove-Item -LiteralPath $log -Force -ErrorAction SilentlyContinue }

Write-Host '  Tunnel ochilmoqda…'
Start-Process -FilePath $cloudflared -ArgumentList @(
  'tunnel', '--url', "http://127.0.0.1:$port", '--no-autoupdate',
  '--protocol', 'http2', '--edge-ip-version', '4'
) -RedirectStandardOutput (Join-Path $env:TEMP 'anime-arena-tunnel.out.log') -RedirectStandardError $log -WindowStyle Hidden

$url = $null
for ($i = 0; $i -lt 40; $i += 1) {
  Start-Sleep -Milliseconds 750
  if (Test-Path $log) {
    $match = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($match) {
      $url = [regex]::Match($match.Line, 'https://[a-z0-9-]+\.trycloudflare\.com').Value
      break
    }
  }
}

if (-not $url) {
  Write-Host '  Tunnel havolasi olinmadi. Log:' $log -ForegroundColor Red
  exit 1
}

Write-Host ''
Write-Host '  HAVOLA:' -ForegroundColor Cyan
Write-Host "  $url" -ForegroundColor Yellow
Write-Host ''
Write-Host '  Eslatma: bu vaqtinchalik Cloudflare Quick Tunnel.' -ForegroundColor DarkGray
Write-Host '  Kompyuter o‘chsa yoki tunnel to‘xtasa havola ishlamaydi.' -ForegroundColor DarkGray
Write-Host ''

Start-Process $url
