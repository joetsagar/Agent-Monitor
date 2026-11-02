# Stops Agent Monitor. Managed sessions are ended first; VS Code sessions are unaffected.
$root = Split-Path -Parent $PSScriptRoot
$port = if ($env:AGENT_MONITOR_PORT) { $env:AGENT_MONITOR_PORT } else { "4317" }
$token = (Get-Content "$root\data\token" -ErrorAction SilentlyContinue)
try {
  Invoke-RestMethod -Method Post "http://127.0.0.1:$port/api/shutdown" -Headers @{ "x-agent-monitor-token" = $token } -TimeoutSec 5 | Out-Null
  Write-Host "Shutdown requested."
  Start-Sleep -Seconds 2
} catch { Write-Host "Server did not respond to shutdown request." }
$pidFile = "$root\data\server.pid"
if (Test-Path $pidFile) {
  $p = Get-Content $pidFile
  if (Get-Process -Id $p -ErrorAction SilentlyContinue) {
    # Only kill the process if it is really this server (a stale pid may have been reused).
    $info = Get-CimInstance Win32_Process -Filter "ProcessId = $p" -ErrorAction SilentlyContinue
    if ($info -and $info.Name -match '^node(\.exe)?$' -and $info.CommandLine -match 'server[\/]index\.ts') {
      Stop-Process -Id $p -Force; Write-Host "Stopped process $p."
    } else { Write-Host "PID $p is not the Agent Monitor server; skipping kill and removing stale pid file." }
  }
  Remove-Item $pidFile -ErrorAction SilentlyContinue
}
Write-Host "Agent Monitor stopped."
