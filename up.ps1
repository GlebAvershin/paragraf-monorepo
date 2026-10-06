# up.ps1 -- bring up the full Paragraf dev stack in one command.
#
# Steps:
#   1. Gateway (LiteLLM + Postgres) via docker and gateway-app on port 4100
#   2. Engine and billing Postgres via docker
#   3. Create local env files and keep their JWT secret aligned
#   4. Apply billing manual migrations (idempotent)
#   5. Billing and engine services in separate windows (OTP login codes show in billing)
#   6. ETL worker loop (charges credits from LiteLLM spend)
#   7. Health-check all services
#
# Web renderer is NOT auto-started -- command is printed at the end.
#
# Run:  powershell -ExecutionPolicy Bypass -File up.ps1

# Continue (not Stop): native tools (docker/psql/bun) write NOTICE/progress to
# stderr which Stop would treat as fatal. We check $LASTEXITCODE where it matters
# and the final health-check reveals real failures.
$ErrorActionPreference = "Continue"
$BUN = "C:\Users\Home\.bun\bin"
$env:PATH = "$BUN;$env:PATH"
$ROOT = $PSScriptRoot
# Gateway вынесен в ОТДЕЛЬНЫЙ репо (github.com/GlebAvershin/paragraf-gateway -- зарубежный
# деплой). Для локального дева ожидается соседний клон ..\paragraf-gateway; путь можно
# переопределить через $env:PARAGRAF_GATEWAY_DIR. См. DEPLOY.md.
$GATEWAY = if ($env:PARAGRAF_GATEWAY_DIR) { $env:PARAGRAF_GATEWAY_DIR } else { Join-Path (Split-Path $ROOT -Parent) "paragraf-gateway" }

function Step($m) { Write-Host "`n[up] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  OK $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  ! $m" -ForegroundColor Yellow }

# -- 1. Gateway -- (2>$null: docker writes progress to stderr, not errors)
Step "Gateway (LiteLLM + Postgres)..."
if (Test-Path "$GATEWAY\docker-compose.yml") {
  docker compose -f "$GATEWAY\docker-compose.yml" up -d 2>$null | Out-Null
  Ok "gateway containers up"
} else {
  Warn "gateway repo not found at $GATEWAY -- clone github.com/GlebAvershin/paragraf-gateway as a sibling (see DEPLOY.md)"
}

# -- 2. Engine and billing Postgres --
Step "Engine and billing Postgres..."
docker compose -f "$ROOT\engine\docker-compose.yml" up -d 2>$null | Out-Null
docker compose -f "$ROOT\billing\docker-compose.yml" up -d 2>$null | Out-Null
Ok "engine_postgres and billing_postgres up"

# Wait for both local databases.
Step "Waiting for local Postgres databases..."
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  docker exec billing_postgres pg_isready -U billing 2>$null | Out-Null
  $billingReady = $LASTEXITCODE -eq 0
  docker exec engine_postgres pg_isready -U engine 2>$null | Out-Null
  $engineReady = $LASTEXITCODE -eq 0
  if ($billingReady -and $engineReady) { $ready = $true; break }
  Start-Sleep -Seconds 1
}
if ($ready) { Ok "Postgres databases accepting connections" } else { Warn "Postgres databases not ready in 30s -- continuing" }

# -- 3. Local environment files --
Step "Checking local environment files..."
foreach ($service in @("billing", "engine")) {
  $envFile = "$ROOT\$service\.env"
  $exampleFile = "$ROOT\$service\.env.example"
  if (-not (Test-Path $envFile) -and (Test-Path $exampleFile)) {
    Copy-Item $exampleFile $envFile
    Ok "created $service\.env from example"
  }
}

$gatewayAppEnv = "$GATEWAY\app\.env"
$gatewayAppExample = "$GATEWAY\app\.env.example"
if (-not (Test-Path $gatewayAppEnv) -and (Test-Path $gatewayAppExample)) {
  Copy-Item $gatewayAppExample $gatewayAppEnv
  Ok "created gateway-app .env from example"
}

$billingEnv = "$ROOT\billing\.env"
$engineEnv = "$ROOT\engine\.env"
if ((Test-Path $billingEnv) -and (Test-Path $engineEnv)) {
  $billingJwt = (Get-Content $billingEnv | Where-Object { $_ -match '^JWT_SECRET=' } | Select-Object -First 1) -replace '^JWT_SECRET=', ''
  $engineJwt = (Get-Content $engineEnv | Where-Object { $_ -match '^JWT_SECRET=' } | Select-Object -First 1) -replace '^JWT_SECRET=', ''
  if ([string]::IsNullOrWhiteSpace($billingJwt) -and [string]::IsNullOrWhiteSpace($engineJwt)) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $sharedJwt = [Convert]::ToHexString($bytes).ToLowerInvariant()
    foreach ($envFile in @($billingEnv, $engineEnv)) {
      $text = Get-Content $envFile -Raw
      $text = [regex]::Replace($text, '(?m)^JWT_SECRET=.*$', "JWT_SECRET=$sharedJwt")
      [IO.File]::WriteAllText($envFile, $text, [Text.UTF8Encoding]::new($false))
    }
    Ok "generated and aligned local JWT secret"
  } elseif ($billingJwt -ne $engineJwt) {
    Warn "JWT_SECRET differs between billing\.env and engine\.env -- login will fail until they match"
  }
}

$gatewayRootEnv = "$GATEWAY\.env"
if ((Test-Path $gatewayRootEnv) -and (Test-Path $billingEnv)) {
  $gatewayMasterKey = (Get-Content $gatewayRootEnv | Where-Object { $_ -match '^LITELLM_MASTER_KEY=' } | Select-Object -First 1) -replace '^LITELLM_MASTER_KEY=', ''
  $billingMasterKey = (Get-Content $billingEnv | Where-Object { $_ -match '^LITELLM_MASTER_KEY=' } | Select-Object -First 1) -replace '^LITELLM_MASTER_KEY=', ''
  if (-not [string]::IsNullOrWhiteSpace($gatewayMasterKey) -and [string]::IsNullOrWhiteSpace($billingMasterKey)) {
    $text = Get-Content $billingEnv -Raw
    $text = [regex]::Replace($text, '(?m)^LITELLM_MASTER_KEY=.*$', "LITELLM_MASTER_KEY=$gatewayMasterKey")
    [IO.File]::WriteAllText($billingEnv, $text, [Text.UTF8Encoding]::new($false))
    Ok "copied LiteLLM access setting to billing\.env"
  } elseif ([string]::IsNullOrWhiteSpace($gatewayMasterKey)) {
    Warn "LITELLM_MASTER_KEY is empty in gateway .env -- billing cannot create user model access"
  } elseif ($billingMasterKey -ne $gatewayMasterKey) {
    Warn "LiteLLM access setting differs between gateway .env and billing\.env -- model access will fail"
  }
}

# -- 4. Apply manual migrations (idempotent) --
Step "Applying billing manual migrations..."
$manualDir = "$ROOT\billing\drizzle\manual"
if (Test-Path $manualDir) {
  Get-ChildItem "$manualDir\*.sql" | Sort-Object Name | ForEach-Object {
    Get-Content $_.FullName -Raw | docker exec -i billing_postgres psql -U billing -d billing -v ON_ERROR_STOP=1 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Ok "migration $($_.Name)" } else { Warn "migration $($_.Name) -- check manually" }
  }
} else { Warn "no drizzle/manual -- skipping" }

# -- 5. Gateway app (port 4100, separate window) --
Step "Refreshing model catalog and virtual-key access..."
Push-Location "$ROOT\billing"
bun run db:seed
if ($LASTEXITCODE -eq 0) {
  bun run sync-model-access
  if ($LASTEXITCODE -eq 0) { Ok "model catalog and existing key access refreshed" }
  else { Warn "virtual-key access refresh failed -- check billing and LiteLLM configuration" }
} else {
  Warn "model catalog refresh failed -- check billing database configuration"
}
Pop-Location

# -- 6. Gateway app (port 4100, separate window) --
Step "Gateway app (port 4100, separate window with logs)..."
$gatewayAppAlreadyUp = $false
try {
  $h = Invoke-RestMethod -Uri "http://localhost:4100/health/readiness" -TimeoutSec 2
  if (($h | ConvertTo-Json -Compress) -match "ok") { $gatewayAppAlreadyUp = $true }
} catch {}
if ($gatewayAppAlreadyUp) {
  Ok "gateway app already running on :4100 -- not relaunching"
} elseif (Test-Path "$GATEWAY\app\package.json") {
  $pid4100 = (Get-NetTCPConnection -LocalPort 4100 -State Listen -ErrorAction SilentlyContinue).OwningProcess
  if ($pid4100) { Stop-Process -Id $pid4100 -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1 }
  $gatewayAppCmd = '$env:PATH=' + "'$BUN;'" + '+$env:PATH; ' + "Set-Location '$GATEWAY\app'; " + "if (-not (Test-Path node_modules)) { bun install }; Write-Host 'GATEWAY APP -- model request logs appear here' -ForegroundColor Magenta; bun run start"
  Start-Process powershell -ArgumentList "-NoExit", "-Command", $gatewayAppCmd
  Ok "gateway app started (see new window)"
} else {
  Warn "gateway app not found at $GATEWAY\app -- model requests cannot be processed"
}

# -- 7. Billing service (separate window -- OTP codes here) --
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

# -- 8. Engine service (separate window) --
Step "Engine service (port 4096, separate window with logs)..."
$engineAlreadyUp = $false
try {
  $h = Invoke-RestMethod -Uri "http://localhost:4096/health/readiness" -TimeoutSec 2
  if (($h | ConvertTo-Json -Compress) -match "ok") { $engineAlreadyUp = $true }
} catch {}
if ($engineAlreadyUp) {
  Ok "engine already running on :4096 -- not relaunching"
} else {
  $pid4096 = (Get-NetTCPConnection -LocalPort 4096 -State Listen -ErrorAction SilentlyContinue).OwningProcess
  if ($pid4096) { Stop-Process -Id $pid4096 -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1 }
  $engineCmd = '$env:PATH=' + "'$BUN;'" + '+$env:PATH; ' + "Set-Location '$ROOT\engine'; " + "Write-Host 'ENGINE -- chat service logs appear here' -ForegroundColor Magenta; bun run start"
  Start-Process powershell -ArgumentList "-NoExit", "-Command", $engineCmd
  Ok "engine started (see new window)"
}

# -- 9. ETL worker loop (skip if already running) --
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

# -- 10. Health-check --
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
Check "gateway app" "http://localhost:4100/health/readiness" "ok"
Check "billing" "http://localhost:3000/health/readiness" "ok"
Check "engine" "http://localhost:4096/health/readiness" "ok"

# -- Done --
Write-Host "`n=== Stack is up ===" -ForegroundColor Green
Write-Host "Start web renderer separately:" -ForegroundColor White
Write-Host "  bun run --cwd '$ROOT\web' dev:web" -ForegroundColor Gray
Write-Host "Stop stack:  .\down.ps1" -ForegroundColor Gray
Write-Host "OTP login codes -- in the BILLING window (Kod dlya vhoda: NNN NNN)" -ForegroundColor Gray
