# Starts Agent Monitor in the background and opens the dashboard.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\start.ps1 [-NoBrowser]
param([switch]$NoBrowser)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$port = if ($env:AGENT_MONITOR_PORT) { $env:AGENT_MONITOR_PORT } else { "4317" }
$url = "http://127.0.0.1:$port"
try { Invoke-RestMethod "$url/api/health" -TimeoutSec 2 | Out-Null; Write-Host "Already running at $url"; if (-not $NoBrowser) { Start-Process $url }; exit 0 } catch {}
if (-not (Test-Path "$root\web\dist\index.html")) { Write-Host "UI not built; building..."; Push-Location "$root\web"; npm install; npm run build; Pop-Location }
New-Item -ItemType Directory -Force "$root\data" | Out-Null
# Strip variables inherited from a Claude Code terminal so managed sessions start clean.
$clean = "CLAUDECODE","CLAUDE_CODE_SESSION_ID","CLAUDE_CODE_MESSAGING_SOCKET","CLAUDE_CODE_MESSAGING_TOKEN","CLAUDE_CODE_ENTRYPOINT"
foreach ($v in $clean) { Remove-Item "Env:$v" -ErrorAction SilentlyContinue }
Start-Process -FilePath "node" -ArgumentList "server/index.ts" -WorkingDirectory $root -WindowStyle Hidden `
  -RedirectStandardOutput "$root\data\server.log" -RedirectStandardError "$root\data\server.err.log"
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  try { Invoke-RestMethod "$url/api/health" -TimeoutSec 2 | Out-Null; Write-Host "Agent Monitor running at $url (logs: data\server.log)"; if (-not $NoBrowser) { Start-Process $url }; exit 0 } catch {}
}
Write-Error "Server did not start. See $root\data\server.err.log"
