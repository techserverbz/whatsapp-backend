# Registers "wpp-backend-boot" — the scheduled task that brings the backend up
# at machine boot. Run once, elevated. Re-running is safe: it replaces the task.
#
# Runs as SYSTEM so no password is stored and no user needs to be logged in.
# That is the same account the retired NSSM service used, so the headless
# Chromium the WhatsApp engine launches is known to work under it.
#
# Uninstall with:  Unregister-ScheduledTask -TaskName wpp-backend-boot -Confirm:$false
$ErrorActionPreference = 'Stop'

$TaskName = 'wpp-backend-boot'
$Root     = Split-Path -Parent $PSScriptRoot
$Node     = 'C:\Program Files\nodejs\node.exe'
$Boot     = Join-Path $Root 'scripts\boot.mjs'

if (-not (Test-Path $Node)) { throw "node.exe not found at $Node" }
if (-not (Test-Path $Boot)) { throw "boot.mjs not found at $Boot" }

$action = New-ScheduledTaskAction -Execute $Node -Argument "`"$Boot`"" -WorkingDirectory $Root

# 30s delay: the disk is busy at boot and Tailscale needs a moment to start.
# boot.mjs waits for the tailnet regardless; this just avoids racing the storm.
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT30S'

$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -RestartCount 5 `
  -RestartInterval (New-TimeSpan -Minutes 1)

# The default 3-day execution limit would kill a 24/7 server mid-week.
$settings.ExecutionTimeLimit = 'PT0S'
# Never let Windows stop the backend just because the machine looks idle.
$settings.IdleSettings.StopOnIdleEnd = $false
$settings.DisallowStartIfOnBatteries = $false

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description 'Starts the WhatsApp backend and applies the Tailscale Funnel at boot.' `
  -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName'."
Get-ScheduledTask -TaskName $TaskName |
  Select-Object TaskName, State, @{n='Action';e={ $_.Actions[0].Execute + ' ' + $_.Actions[0].Arguments }} |
  Format-List
