# Token Tracker for Antigravity CLI (`agy`) on Windows (PowerShell), one command from the dashboard's "Add device" box:
#   & ([scriptblock]::Create((irm <raw url of this file>))) https://<your-site> <device token>
# Installs the Antigravity plugin (`mods/antigravity-tracker`) into %USERPROFILE%\.gemini\config\plugins\token-tracker,
# saves site/token into %USERPROFILE%\.gemini\antigravity-cli\token-tracker\config.json (never printed), and merges statusLine
# into %USERPROFILE%\.gemini\antigravity-cli\settings.json.
param([Parameter(Mandatory = $true)][string]$Origin, [Parameter(Mandatory = $true)][string]$Token)
$ErrorActionPreference = 'Stop'
$Origin = $Origin.TrimEnd('/')
$cliDir = if ($env:ANTIGRAVITY_CLI_DIR) { $env:ANTIGRAVITY_CLI_DIR } else { Join-Path $HOME '.gemini\antigravity-cli' }
$cfgDir = if ($env:GEMINI_CONFIG_DIR) { $env:GEMINI_CONFIG_DIR } else { Join-Path $HOME '.gemini\config' }
$dataDir = if ($env:ANTIGRAVITY_TRACKER_DIR) { $env:ANTIGRAVITY_TRACKER_DIR } else { Join-Path $cliDir 'token-tracker' }
$plugin = Join-Path $cfgDir 'plugins\token-tracker'
$settingsPath = Join-Path $cliDir 'settings.json'
$raw = if ($env:TT_RAW) { $env:TT_RAW } else { 'https://raw.githubusercontent.com/Pavlo577/modToken/main/worker' }

Write-Host "Token Tracker для Antigravity CLI: $cliDir"
New-Item -ItemType Directory -Force (Join-Path $plugin 'hooks'), $dataDir, $cliDir | Out-Null

foreach ($f in 'plugin.json', 'hooks.json', 'hooks/statusline.py', 'hooks/activity.py', 'hooks/statusline.ps1', 'hooks/activity.ps1') {
  $dst = Join-Path $plugin $f
  Invoke-RestMethod "$raw/mods/antigravity-tracker/$f" -OutFile $dst
}

$actScript = Join-Path $plugin 'hooks\activity.ps1'
$slScript = Join-Path $plugin 'hooks\statusline.ps1'
$actBase = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$actScript`""
$hooksObj = @{
  'token-tracker' = @{
    SessionStart  = @(@{ type = 'command'; command = "$actBase -EventName SessionStart"; timeout = 10 })
    PreInvocation = @(@{ type = 'command'; command = "$actBase -EventName PreInvocation"; timeout = 10 })
    Stop          = @(@{ type = 'command'; command = "$actBase -EventName Stop"; timeout = 10 })
  }
}
[System.IO.File]::WriteAllText((Join-Path $plugin 'hooks.json'), ($hooksObj | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding $false))

$settings = @{}
if (Test-Path $settingsPath) {
  try {
    $parsed = Get-Content -Raw -Encoding UTF8 $settingsPath | ConvertFrom-Json
    foreach ($p in $parsed.PSObject.Properties) { $settings[$p.Name] = $p.Value }
  } catch {}
}

$cfgPath = Join-Path $dataDir 'config.json'
$chain = ''
if (Test-Path $cfgPath) {
  try { $old = Get-Content -Raw -Encoding UTF8 $cfgPath | ConvertFrom-Json; if ($old.chain_command) { $chain = [string]$old.chain_command } } catch {}
}
if ($settings.ContainsKey('statusLine') -and $settings['statusLine'].command) {
  $prevCmd = [string]$settings['statusLine'].command
  if ($prevCmd -and -not $prevCmd.Contains('token-tracker\hooks\statusline.ps1')) { $chain = $prevCmd }
}

$settings['statusLine'] = @{
  type = 'command'
  command = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$slScript`""
  stack_with_default = $true
}
[System.IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding $false))

$cfgObj = @{ site = $Origin; token = $Token }
if ($chain) { $cfgObj.chain_command = $chain }
[System.IO.File]::WriteAllText($cfgPath, ($cfgObj | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding $false))

Write-Host "  Плагін встановлено в $plugin"
Write-Host "  statusLine підключено в $settingsPath"
try {
  $mt = Join-Path $HOME '.modtoken'; New-Item -ItemType Directory -Force $mt | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $mt 'config.json'), (@{ site = $Origin; token = $Token } | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))
  Invoke-RestMethod "$raw/scripts/modtoken.ps1" -OutFile (Join-Path $mt 'modtoken.ps1')
  [System.IO.File]::WriteAllText((Join-Path $mt 'modtoken.cmd'), "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $mt 'modtoken.ps1')`" %*`r`n", (New-Object System.Text.UTF8Encoding $false))
  $up = [Environment]::GetEnvironmentVariable('Path', 'User'); $pts = @("$up" -split ';' | Where-Object { $_ })
  if ($pts -notcontains $mt) { [Environment]::SetEnvironmentVariable('Path', (($pts + $mt) -join ';'), 'User') }
  if (($env:PATH -split ';') -notcontains $mt) { $env:PATH = "$mt;$env:PATH" }
} catch {}
if ($env:COMPUTERNAME) { try { Invoke-RestMethod -Uri "$Origin/v1/config?agent=antigravity&host=$([Uri]::EscapeDataString($env:COMPUTERNAME))" -Headers @{ 'x-device-token' = $Token; 'User-Agent' = 'modToken-antigravity/1.0' } -TimeoutSec 3 | Out-Null } catch {} }
Write-Host "Готово. Перезапусти Antigravity CLI (agy); дані з'являться на дашборді після першої відповіді (консольна програма керування й оновлення: modtoken)."
