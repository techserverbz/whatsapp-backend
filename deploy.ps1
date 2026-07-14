<#
.SYNOPSIS
  One-command, idempotent deploy for the wpp-backend on a Windows server.
  Builds the app, installs it as an always-on Windows service (NSSM), and
  optionally sets up Caddy for HTTPS + firewall rules. Safe to re-run:
  re-running rebuilds and restarts (use it to ship updates).

.EXAMPLE
  # First run - full deploy incl. Caddy (run in an ELEVATED PowerShell):
  .\deploy.ps1

.EXAMPLE
  # Ship a code update (backend only, leave Caddy alone):
  .\deploy.ps1 -SkipCaddy

.EXAMPLE
  # Just (re)configure the service, skip npm build:
  .\deploy.ps1 -SkipBuild -SkipCaddy

.NOTES
  * Run in an ELEVATED PowerShell (service + firewall changes need admin).
  * Fill backend\.env before first run (copy from .env.production.example).
  * For Caddy to get a TLS cert, the DNS A record (wa-api -> public IP) and
    the 80/443 port-forward must already be live. Caddy retries until they are.
#>
[CmdletBinding()]
param(
  [string]$ServiceName = 'wpp-backend',
  [string]$ApiDomain   = 'wa-api.bhole.co',
  [int]   $BackendPort = 8099,
  [string]$Email       = 'admin@bhole.co',
  [string]$CaddyDir    = 'C:\apps\caddy',
  [switch]$SkipCaddy,
  [switch]$SkipBuild,
  [switch]$GitPull
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$BackendDir = $PSScriptRoot

function Say  ($m) { Write-Host "  $m"        -ForegroundColor Cyan }
function Ok   ($m) { Write-Host "  [OK] $m"   -ForegroundColor Green }
function Warn ($m) { Write-Host "  [!]  $m"   -ForegroundColor Yellow }
function Fail ($m) { Write-Host "  [X]  $m`n" -ForegroundColor Red; exit 1 }
function Line     { Write-Host ('-' * 64) -ForegroundColor DarkGray }

Write-Host "`n  wpp-backend deploy" -ForegroundColor White
Line

# --- 0. Preflight -----------------------------------------------------------
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
  Fail "Please run this in an ELEVATED PowerShell (right-click -> Run as Administrator)."
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Fail "Node.js not found on PATH. Install Node 20+ (https://nodejs.org) and re-run." }
$node = $nodeCmd.Source
Ok "Node: $((node -v)) at $node"

# --- 1. .env presence + sanity ---------------------------------------------
$envFile     = Join-Path $BackendDir '.env'
$envExample  = Join-Path $BackendDir '.env.production.example'
if (-not (Test-Path $envFile)) {
  if (Test-Path $envExample) { Copy-Item $envExample $envFile }
  Fail "No .env found - created one from the template. Fill in the <PLACEHOLDER> values (JWT_SECRET, DATABASE_URL, ...) then re-run."
}
$envText = Get-Content $envFile -Raw
if (($envText -match '<[A-Z_]+>') -or ($envText -match 'PASTE_')) {
  Fail ".env still has placeholder values (e.g. <PASTE_SCRM_PROD_JWT_SECRET>). Fill them in and re-run."
}
foreach ($key in @('JWT_SECRET','DATABASE_URL','CORS_ORIGIN','COOKIE_DOMAIN')) {
  if ($envText -notmatch "(?m)^\s*$key\s*=\s*\S") { Fail "'$key' is missing or empty in .env." }
}
Ok ".env present and populated"

# --- 2. Build ---------------------------------------------------------------
if (-not $SkipBuild) {
  if ($GitPull -and (Test-Path (Join-Path $BackendDir '..\.git'))) {
    Say "git pull..."; git -C (Split-Path $BackendDir -Parent) pull
    if ($LASTEXITCODE -ne 0) { Warn "git pull returned $LASTEXITCODE (continuing)" }
  }
  Push-Location $BackendDir
  try {
    if (Test-Path (Join-Path $BackendDir 'package-lock.json')) { Say "npm ci..."; npm ci }
    else { Say "npm install..."; npm install }
    if ($LASTEXITCODE -ne 0) { Fail "npm install failed (exit $LASTEXITCODE)." }
    Say "npm run build..."; npm run build
    if ($LASTEXITCODE -ne 0) { Fail "build failed (exit $LASTEXITCODE)." }
  } finally { Pop-Location }
}
if (-not (Test-Path (Join-Path $BackendDir 'dist\index.js'))) { Fail "dist\index.js missing - build did not produce output." }
Ok "Build ready (dist\index.js)"

# --- 3. Ensure NSSM ---------------------------------------------------------
function Ensure-Nssm {
  $n = Get-Command nssm -ErrorAction SilentlyContinue
  if ($n) { return }
  $wg = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $wg) { Fail "NSSM not found and winget unavailable. Install NSSM from https://nssm.cc, add to PATH, re-run." }
  Say "Installing NSSM via winget..."
  winget install --id NSSM.NSSM -e --silent --accept-source-agreements --accept-package-agreements
  # Refresh PATH for the current session so the new nssm.exe is visible.
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
  if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
    Fail "NSSM still not on PATH after install. Open a new elevated PowerShell and re-run."
  }
}
Ensure-Nssm
Ok "NSSM available"

# --- 4. Backend Windows service (create or update) --------------------------
$logsDir = Join-Path $BackendDir 'logs'
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

$existing = Get-Service $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Say "Service '$ServiceName' exists - updating."
  Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
} else {
  Say "Installing service '$ServiceName'."
  nssm install $ServiceName $node 'dist\index.js'
  if ($LASTEXITCODE -ne 0) { Fail "nssm install failed (exit $LASTEXITCODE)." }
}
nssm set $ServiceName Application           $node                             | Out-Null
nssm set $ServiceName AppParameters         'dist\index.js'                   | Out-Null
nssm set $ServiceName AppDirectory          $BackendDir                       | Out-Null
nssm set $ServiceName AppStdout             (Join-Path $logsDir 'out.log')    | Out-Null
nssm set $ServiceName AppStderr             (Join-Path $logsDir 'err.log')    | Out-Null
nssm set $ServiceName AppRotateFiles        1                                 | Out-Null
nssm set $ServiceName AppRotateBytes        10485760                          | Out-Null
nssm set $ServiceName AppStopMethodConsole  15000                             | Out-Null  # graceful shutdown (session preserved)
nssm set $ServiceName Start                 SERVICE_AUTO_START                | Out-Null
nssm set $ServiceName AppExit Default       Restart                           | Out-Null

Start-Service $ServiceName
Ok "Service '$ServiceName' started (auto-start on boot, auto-restart on crash)"

# --- 5. Caddy (HTTPS) -------------------------------------------------------
if (-not $SkipCaddy) {
  New-Item -ItemType Directory -Force -Path $CaddyDir | Out-Null
  $caddyExe = Join-Path $CaddyDir 'caddy.exe'
  if (-not (Test-Path $caddyExe)) {
    Say "Downloading Caddy..."
    Invoke-WebRequest "https://caddyserver.com/api/download?os=windows&arch=amd64" -OutFile $caddyExe -UseBasicParsing
  }
  Ok "Caddy binary: $caddyExe"

  $caddyfile = Join-Path $CaddyDir 'Caddyfile'
  if (-not (Test-Path $caddyfile)) {
    $dataRoot = ($CaddyDir -replace '\\','/') + '/data'   # forward slashes: no escaping headaches
    $cf = @"
{
    email $Email
    storage file_system {
        root "$dataRoot"
    }
}

$ApiDomain {
    reverse_proxy 127.0.0.1:$BackendPort
}
"@
    [System.IO.File]::WriteAllText($caddyfile, $cf)        # UTF-8, no BOM (Caddy chokes on a BOM)
    Ok "Wrote Caddyfile for $ApiDomain -> 127.0.0.1:$BackendPort"
  } else {
    Say "Caddyfile already exists - left as-is."
  }

  foreach ($p in 80, 443) {
    $ruleName = "Caddy TCP $p"
    if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $p -Action Allow | Out-Null
      Ok "Firewall: allowed inbound TCP $p"
    }
  }

  if (Get-Service caddy -ErrorAction SilentlyContinue) {
    nssm set caddy Application   $caddyExe                            | Out-Null
    nssm set caddy AppParameters "run --config `"$caddyfile`""        | Out-Null
    nssm set caddy AppDirectory  $CaddyDir                            | Out-Null
    nssm set caddy Start         SERVICE_AUTO_START                   | Out-Null
    Restart-Service caddy
  } else {
    nssm install caddy $caddyExe run --config $caddyfile              | Out-Null
    nssm set caddy AppParameters "run --config `"$caddyfile`""        | Out-Null
    nssm set caddy AppDirectory  $CaddyDir                            | Out-Null
    nssm set caddy Start         SERVICE_AUTO_START                   | Out-Null
    Start-Service caddy
  }
  Ok "Caddy service running (auto-HTTPS for $ApiDomain)"
} else {
  Warn "Skipping Caddy (-SkipCaddy). Backend is on 127.0.0.1:$BackendPort only."
}

# --- 6. Health check --------------------------------------------------------
Line
Say "Waiting for backend health on 127.0.0.1:$BackendPort ..."
$healthy = $false
for ($i = 0; $i -lt 20; $i++) {
  try {
    $r = Invoke-RestMethod "http://127.0.0.1:$BackendPort/api/health" -TimeoutSec 3
    if ($r.ok) { $healthy = $true; break }
  } catch { Start-Sleep -Seconds 2 }
}
if ($healthy) { Ok "Backend healthy (state: $($r.state))" }
else { Warn "No health response yet. Check: Get-Content `"$logsDir\err.log`" -Tail 40" }

# --- 7. Summary -------------------------------------------------------------
Line
Write-Host "  DONE." -ForegroundColor White
Write-Host ""
Say "Services:"
Get-Service $ServiceName, caddy -ErrorAction SilentlyContinue |
  Format-Table Name, Status, StartType -AutoSize | Out-String | Write-Host
Say "Local health : http://127.0.0.1:$BackendPort/api/health"
if (-not $SkipCaddy) { Say "Public health: https://$ApiDomain/api/health  (once DNS + 80/443 forward are live)" }
Write-Host ""
Say "Next: point DNS 'wa-api' -> your public IP, forward 80/443, then an ADMIN"
Say "opens https://wa.bhole.co, signs in, clicks Connect, and scans the QR once."
Line
