<#
.SYNOPSIS
  One-shot local environment bootstrap for VoiceFront on Windows + Docker Desktop.

.DESCRIPTION
  Rebuilds the local stack deterministically:
    1. Preflight: Docker running, Node >= 18.18, port conflicts.
    2. Sanitizes .env files (strips quotes that break Prisma on Windows, P1012).
    3. Tears down the old DB container AND its volume (-Reset), so stale
       credentials baked into voicefront_pgdata can never survive (P1000).
    4. Starts Postgres and waits for the compose healthcheck (pg_isready).
    5. npm install, prisma generate, db push, seed.
    6. Verifies an authenticated TCP connection from the HOST with the exact
       DATABASE_URL Prisma will use — not a trust-authenticated in-container
       check, which can mask a wrong password.

.PARAMETER Reset
  Also delete the database volume (full wipe). Default: on for first run if
  the volume does not exist; pass -Reset explicitly to force a wipe.

.EXAMPLE
  .\scripts\setup-local.ps1 -Reset
#>
[CmdletBinding()]
param(
    [switch]$Reset
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($msg)  { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok($msg)    { Write-Host "    OK: $msg" -ForegroundColor Green }
function Fail($msg)  { Write-Host "    FAIL: $msg" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- preflight
Step "Preflight checks"

docker info *> $null
if (-not $?) { Fail "Docker Desktop is not running. Start it and re-run." }
Ok "Docker is running"

$nodeVer = (node --version) -replace '^v', ''
if ([version]$nodeVer -lt [version]'18.18.0') { Fail "Node >= 18.18 required (found $nodeVer)" }
Ok "Node $nodeVer"

# Warn if something other than Docker owns the DB host port.
$envFile = Join-Path $root 'apps\api\.env'
if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path $root 'apps\api\.env.example') $envFile
    Ok "Created apps/api/.env from .env.example"
}
$webEnvFile = Join-Path $root 'apps\web\.env'
if (-not (Test-Path $webEnvFile)) {
    Copy-Item (Join-Path $root 'apps\web\.env.example') $webEnvFile
    Ok "Created apps/web/.env from .env.example"
}

# ------------------------------------------------- sanitize .env (P1012 fix)
Step "Sanitizing apps/api/.env (Prisma rejects quoted values on Windows)"

$raw = Get-Content $envFile
$clean = $raw | ForEach-Object {
    if ($_ -match '^\s*([A-Z0-9_]+)\s*=\s*["''](.*)["'']\s*$') {
        Write-Host "    stripped quotes from $($Matches[1])" -ForegroundColor Yellow
        "$($Matches[1])=$($Matches[2])"
    } else { $_ }
}
if (Compare-Object $raw $clean) {
    Set-Content -Path $envFile -Value $clean -Encoding ascii
    Ok "Rewrote .env without quoted values"
} else {
    Ok "No quoted values found"
}

$dbUrlLine = $clean | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
if (-not $dbUrlLine) { Fail "DATABASE_URL missing from apps/api/.env" }
$dbUrl = $dbUrlLine -replace '^DATABASE_URL=', ''
if ($dbUrl -notmatch ':(\d+)/') { Fail "Could not parse port from DATABASE_URL" }
$dbPort = $Matches[1]
Ok "DATABASE_URL targets port $dbPort"

# Detect a foreign process on the DB port (e.g. native PostgreSQL service).
$listener = Get-NetTCPConnection -LocalPort $dbPort -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName } |
    Sort-Object -Unique
# Docker Desktop publishes ports via these helper processes depending on
# backend: com.docker.backend (Hyper-V/legacy), vpnkit, wslrelay (WSL2).
$foreign = $listener | Where-Object { $_ -and $_ -notmatch 'docker|vpnkit|wslrelay' }
if ($foreign) {
    Fail "Port $dbPort is held by non-Docker process(es): $($foreign -join ', '). Pick a free port in docker-compose.yml + DATABASE_URL."
}
Ok "Port $dbPort is free for Docker (no native Postgres shadowing it)"

# --------------------------------------------------- teardown (P1000 fix)
Step "Tearing down previous database stack"

# Remove current project stack; -v drops the named volume so credentials
# baked at first init can never come back stale.
$volumeArgs = @('compose', 'down', '--remove-orphans')
if ($Reset) { $volumeArgs += '-v' }
& docker @volumeArgs

# Also remove stacks from older compose project names (folder-name default)
# that may still own port mappings or the old volume.
$staleContainers = docker ps -aq --filter "name=voicefront"
if ($staleContainers) { docker rm -f @staleContainers | Out-Null }
if ($Reset) {
    $staleVolumes = docker volume ls -q | Where-Object { $_ -match 'voicefront_pgdata$' }
    foreach ($v in $staleVolumes) { docker volume rm $v | Out-Null }
    Ok "Old containers and volumes removed (fresh credentials guaranteed)"
} else {
    Ok "Old containers removed (volume kept; use -Reset for a full wipe)"
}

# ------------------------------------------------------------------- start
Step "Starting PostgreSQL and waiting for healthcheck"
docker compose up -d --wait
if (-not $?) { Fail "docker compose up --wait failed (container unhealthy)" }
Ok "voicefront-db is healthy"

# ------------------------------------------------------------ dependencies
Step "Installing npm dependencies (workspaces)"
npm install
if ($LASTEXITCODE -ne 0) { Fail "npm install failed" }
Ok "Dependencies installed"

# -------------------------------------------------------- schema + seed
Step "Prisma: generate client, push schema, seed demo data"
npm run db:setup
if ($LASTEXITCODE -ne 0) { Fail "db:setup failed (generate / db push / seed)" }
Ok "Schema pushed and demo data seeded"

# ------------------------------------------------------------ verification
Step "Verifying authenticated connection from the HOST (the path Prisma uses)"
# psql inside the container uses 'trust' auth and proves nothing about the
# password; connect from the host network through the published port instead.
# Strip Prisma-only query params (?schema=...) that psql rejects.
$psqlUrl = ($dbUrl -replace 'localhost', 'host.docker.internal') -replace '\?.*$', ''
docker run --rm postgres:16-alpine psql $psqlUrl -c "SELECT count(*) AS tenants FROM tenants;"
if ($LASTEXITCODE -ne 0) { Fail "Host-side authenticated connection failed" }
Ok "Host-side authentication + schema verified"

Write-Host ""
Write-Host "Local environment ready. Next:" -ForegroundColor Green
Write-Host "    npm run dev      # api on :4000, web on :3000"
Write-Host "    login: demo@voicefront.dev / demo1234!"
