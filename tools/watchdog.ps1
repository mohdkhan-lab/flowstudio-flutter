# FlowStudio Watchdog
# Quiet, best-effort self-healing for the FlowStudio connection chain.
# Registered by the installer as the per-user Scheduled Task
# "FlowStudio Watchdog" (every 5 minutes, only while the user is
# logged on). Each run:
#   1. Starts FlowStudio Lite if it is not running.
#   2. Runs "tailscale up" if the Tailscale backend is not connected.
#   3. Re-asserts the Tailscale Funnel for local port 48191 if it is
#      not present in "tailscale funnel status".
# Every action (and a short "ok" line for a no-op cycle) is appended to
# %APPDATA%\FlowStudio Lite\watchdog.log, trimmed to the last ~500
# lines. Nothing here may ever show an error: all work is wrapped in
# try/catch and the script always exits 0.

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$AppExeName  = 'flutter_flow.exe'
$AppDir      = $PSScriptRoot
$AppExe      = Join-Path $AppDir $AppExeName
$FunnelPort  = 48191
$LogDir      = Join-Path $env:APPDATA 'FlowStudio Lite'
$LogPath     = Join-Path $LogDir 'watchdog.log'

function Write-WatchdogLog {
    param([string]$Message)
    try {
        if (-not (Test-Path $LogDir)) {
            New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
        }
        $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Add-Content -Path $LogPath -Value "$stamp $Message" -Encoding Ascii
    } catch {
        # Logging itself must never break the watchdog.
    }
}

function Trim-WatchdogLog {
    try {
        if (Test-Path $LogPath) {
            $lines = Get-Content $LogPath
            if ($lines.Count -gt 600) {
                $lines | Select-Object -Last 500 | Set-Content $LogPath -Encoding Ascii
            }
        }
    } catch {
        # Best effort only.
    }
}

$actions = @()

# --- 1. FlowStudio must be running -------------------------------------
try {
    $proc = Get-Process -Name ([System.IO.Path]::GetFileNameWithoutExtension($AppExeName)) -ErrorAction SilentlyContinue
    if (-not $proc) {
        if (Test-Path $AppExe) {
            Start-Process -FilePath $AppExe -WorkingDirectory $AppDir
            $actions += 'app: was not running, started'
        } else {
            $actions += 'app: exe not found, skipped'
        }
    }
} catch {
    $actions += 'app: check failed (ignored)'
}

# --- Locate tailscale.exe ----------------------------------------------
$tailscale = $null
try {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Tailscale\tailscale.exe')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) {
            $tailscale = $candidate
            break
        }
    }
    if (-not $tailscale) {
        $cmd = Get-Command 'tailscale.exe' -ErrorAction SilentlyContinue
        if ($cmd) { $tailscale = $cmd.Source }
    }
} catch {
    $tailscale = $null
}

if ($tailscale) {
    # --- 2. Tailscale backend must be connected ------------------------
    $backendRunning = $false
    try {
        $statusText = & $tailscale status --json 2>$null | Out-String
        if ($statusText) {
            $status = $statusText | ConvertFrom-Json
            if ($status.BackendState -eq 'Running') {
                $backendRunning = $true
            }
        }
    } catch {
        $backendRunning = $false
    }

    if (-not $backendRunning) {
        try {
            & $tailscale up 2>$null | Out-Null
            $actions += 'tailscale: backend was not running, ran tailscale up'
        } catch {
            $actions += 'tailscale: up failed (ignored)'
        }
    }

    # --- 3. Funnel for port 48191 must be asserted ---------------------
    try {
        $funnelText = & $tailscale funnel status 2>&1 | Out-String
        if ($funnelText -notmatch "$FunnelPort") {
            & $tailscale funnel --bg "http://localhost:$FunnelPort" 2>$null | Out-Null
            $actions += "funnel: no entry for port $FunnelPort, re-asserted"
        }
    } catch {
        $actions += 'funnel: check failed (ignored)'
    }
} else {
    $actions += 'tailscale: exe not found, skipped'
}

# --- Log this cycle ------------------------------------------------------
try {
    if ($actions.Count -gt 0) {
        foreach ($action in $actions) {
            Write-WatchdogLog $action
        }
    } else {
        Write-WatchdogLog 'ok'
    }
    Trim-WatchdogLog
} catch {
    # Nothing may escape.
}

exit 0
