# down.ps1 -- stop the Paragraf dev stack.
#
# Stops billing service + ETL worker, optionally docker containers (-Docker).
#
# Run:
#   .\down.ps1            # stop billing + ETL (keep docker -- data in volume)
#   .\down.ps1 -Docker    # + stop gateway/billing containers

param([switch]$Docker)

$ROOT = $PSScriptRoot

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

# -- Docker (optional) --
if ($Docker) {
  Step "Stopping docker containers..."
  docker compose -f "$ROOT\gateway\docker-compose.yml" down 2>$null | Out-Null
  docker compose -f "$ROOT\billing\docker-compose.yml" down 2>$null | Out-Null
  Ok "gateway + billing containers stopped (volumes kept)"
} else {
  Write-Host "  (docker containers kept -- to stop: .\down.ps1 -Docker)" -ForegroundColor Gray
}

Write-Host "=== Stack stopped ===" -ForegroundColor Green
