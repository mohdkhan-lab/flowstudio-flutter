# FlowStudio Watchdog - Scheduled Task registration
# Run once by the installer at the end of setup. Registers (or
# refreshes) the per-user Scheduled Task "FlowStudio Watchdog", which
# runs watchdog.ps1 every 5 minutes and at logon, only while this user
# is logged on. Best effort: any failure is swallowed and the script
# still exits 0, so a registration problem can never fail an install.

$ErrorActionPreference = 'SilentlyContinue'

try {
    $watchdog = Join-Path $PSScriptRoot 'watchdog.ps1'
    if (Test-Path $watchdog) {
        $argument = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdog`""
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument -WorkingDirectory $PSScriptRoot

        $repeating = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
            -RepetitionInterval (New-TimeSpan -Minutes 5)
        $atLogon = New-ScheduledTaskTrigger -AtLogOn

        $settings = New-ScheduledTaskSettingsSet `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries `
            -StartWhenAvailable `
            -MultipleInstances IgnoreNew `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

        Register-ScheduledTask -TaskName 'FlowStudio Watchdog' `
            -Action $action -Trigger @($repeating, $atLogon) -Settings $settings `
            -Description 'Keeps FlowStudio Lite and its Tailscale Funnel connection alive.' `
            -Force | Out-Null
    }
} catch {
    # Best effort only - install must succeed regardless.
}

exit 0
