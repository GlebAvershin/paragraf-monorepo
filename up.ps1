# up.ps1 -- bring up the full Paragraf dev stack in one command.
#
# Steps:
#   1. Gateway (LiteLLM + Postgres) via docker, wait healthy
#   2. Billing Postgres via docker
#   3. Apply billing manual migrations (idempotent -- see CLAUDE.md lesson)
#   4. Billing service in a separate window (OTP login codes show there!)
#   5. ETL worker loop (charges credits from LiteLLM spend)
#   6. Health-check all services
#
# Desktop is NOT auto-started (GUI) -- command is printed at the end.
#
# Run:  powershell -ExecutionPolicy Bypass -File up.ps1

# Continue (not Stop): native tools (docker/psql/bun) write NOTICE/progress to
# stderr which Stop would treat as fatal. We check $LASTEXITCODE where it matters
# and the final health-check reveals real failures.
$ErrorActionPreference = "Continue"
$BUN = "C:\Users\Home\.bun\bin"
$env:PATH = "$BUN;$env:PATH"
$ROOT = $PSScriptRoot

function Step($m) { Write-Host "`n[up] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  OK $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  ! $m" -ForegroundColor Yellow }

# -- 1. Gateway -- (2>$null: docker writes progress to stderr, not errors)
Step "Gateway (LiteLLM + Postgres)..."
docker compose -f "$ROOT\gateway\docker-compose.yml" up -d 2>$null | Out-Null
Ok "gateway containers up"

# -- 2. Billing Postgres --
Step "Billing Postgres..."
docker compose -f "$ROOT\billing\docker-compose.yml" up -d 2>$null | Out-Null
Ok "billing_postgres up"

# Wait for billing Postgres.
Step "Waiting for billing Postgres..."
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  docker exec billing_postgres pg_isready -U billing 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  Start-Sleep -Seconds 1
}
if ($ready) { Ok "postgres accepting connections" } else { Warn "postgres not ready in 30s -- continuing" }

# -- 3. Apply manual migrations (idempotent) --
Step "Applying billing manual migrations..."
$manualDir = "$ROOT\billing\drizzle\manual"
if (Test-Path $manualDir) {
  Get-ChildItem "$manualDir\*.sql" | Sort-Object Name | ForEach-Object {
    Get-Content $_.FullName -Raw | docker exec -i billing_postgres psql -U billing -d billing -v ON_ERROR_STOP=1 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Ok "migration $($_.Name)" } else { Warn "migration $($_.Name) -- check manually" }
  }
} else { Warn "no drizzle/manual -- skipping" }

# -- 4. Billing service (separate window -- OTP codes here) --
# If billing already answers on :3000, skip re-launch (avoid duplicate windows).
Step "Billing service (port 3000, separate window with logs)..."
$alreadyUp = $false
try {
  $h = Invoke-RestMethod -Uri "http://localhost:3000/health/readiness" -TimeoutSec 2
  if (($h | ConvertTo-Json -Compress) -match "ok") { $alreadyUp = $true }
} catch {}
if ($alreadyUp) {
  Ok "billing already running on :3000 -- not relaunching"
} else {
  $pid3000 = (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess
  if ($pid3000) { Stop-Process -Id $pid3000 -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1 }
  $billingCmd = '$env:PATH=' + "'$BUN;'" + '+$env:PATH; $env:NODE_ENV=' + "'production'; " + "Set-Location '$ROOT\billing'; " + "Write-Host 'BILLING -- OTP login codes appear here' -ForegroundColor Magenta; bun run src/index.ts"
  Start-Process powershell -ArgumentList "-NoExit", "-Command", $billingCmd
  Ok "billing started (see new window)"
}

# -- 5. ETL worker loop (skip if already running) --
Step "ETL worker (credit charging, loop 30s)..."
$etlRunning = Get-CimInstance Win32_Process -Filter "Name='bun.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match "etl\.ts" }
if ($etlRunning) {
  Ok "ETL already running -- not relaunching"
} else {
  $etlCmd = '$env:PATH=' + "'$BUN;'" + '+$env:PATH; $env:NODE_ENV=' + "'production'; " + "Set-Location '$ROOT\billing'; bun run src/worker/etl.ts --loop --interval=30"
  Start-Process powershell -WindowStyle Minimized -ArgumentList "-NoExit", "-Command", $etlCmd
  Ok "ETL loop started (minimized window)"
}

# -- 6. Health-check --
Step "Health-check..."
Start-Sleep -Seconds 4
function Check($name, $url, $expect) {
  try {
    $r = Invoke-RestMethod -Uri $url -TimeoutSec 5
    $s = ($r | ConvertTo-Json -Compress)
    if ($s -match $expect) { Ok "$name : $s" } else { Warn "$name unexpected: $s" }
  } catch { Warn "$name NOT responding ($url)" }
}
Check "gateway" "http://localhost:4000/health/liveliness" "alive"
Check "billing" "http://localhost:3000/health/readiness" "ok"

# -- Done --
Write-Host "`n=== Stack is up ===" -ForegroundColor Green
Write-Host "Start desktop separately:" -ForegroundColor White
Write-Host "  bun run --cwd '$ROOT\desktop' dev:desktop" -ForegroundColor Gray
Write-Host "Stop stack:  .\down.ps1" -ForegroundColor Gray
Write-Host "OTP login codes -- in the BILLING window (Kod dlya vhoda: NNN NNN)" -ForegroundColor Gray
