# down.ps1 -- stop the Paragraf dev stack.
#
# Stops billing and engine services + ETL worker, optionally docker containers (-Docker).
#
# Run:
#   .\down.ps1            # stop billing + ETL (keep docker -- data in volume)
#   .\down.ps1 -Docker    # + stop gateway/billing containers

param([switch]$Docker)

$ROOT = $PSScriptRoot
# Gateway вынесен в отдельный репо -- соседний клон ..\paragraf-gateway (см. up.ps1/DEPLOY.md).
$GATEWAY = if ($env:PARAGRAF_GATEWAY_DIR) { $env:PARAGRAF_GATEWAY_DIR } else { Join-Path (Split-Path $ROOT -Parent) "paragraf-gateway" }

function Step($m) { Write-Host "[down] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  OK $m" -ForegroundColor Green }

# -- Billing service (port 3000) --
Step "Stopping billing service (port 3000)..."
$pid3000 = (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess
if ($pid3000) { Stop-Process -Id $pid3000 -Force -ErrorAction SilentlyContinue; Ok "billing stopped" }
else { Ok "billing not running" }

# -- ETL worker (no port -- match by command line) --
Step "Stopping ETL worker..."
$etl = Get-CimInstance Win32_Process -Filter "Name='bun.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match "etl\.ts" }
if ($etl) {
  $etl | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Ok "ETL stopped"
} else { Ok "ETL not running" }

# -- Engine service (port 4096) --
Step "Stopping engine service (port 4096)..."
$pid4096 = (Get-NetTCPConnection -LocalPort 4096 -State Listen -ErrorAction SilentlyContinue).OwningProcess
if ($pid4096) { Stop-Process -Id $pid4096 -Force -ErrorAction SilentlyContinue; Ok "engine stopped" }
else { Ok "engine not running" }

# -- Gateway app service (port 4100) --
Step "Stopping gateway app (port 4100)..."
$pid4100 = (Get-NetTCPConnection -LocalPort 4100 -State Listen -ErrorAction SilentlyContinue).OwningProcess
if ($pid4100) { Stop-Process -Id $pid4100 -Force -ErrorAction SilentlyContinue; Ok "gateway app stopped" }
else { Ok "gateway app not running" }

# -- Docker (optional) --
if ($Docker) {
  Step "Stopping docker containers..."
  if (Test-Path "$GATEWAY\docker-compose.yml") { docker compose -f "$GATEWAY\docker-compose.yml" down 2>$null | Out-Null }
  docker compose -f "$ROOT\engine\docker-compose.yml" down 2>$null | Out-Null
  docker compose -f "$ROOT\billing\docker-compose.yml" down 2>$null | Out-Null
  Ok "gateway + engine + billing containers stopped (volumes kept)"
} else {
  Write-Host "  (docker containers kept -- to stop: .\down.ps1 -Docker)" -ForegroundColor Gray
}

Write-Host "=== Stack stopped ===" -ForegroundColor Green
