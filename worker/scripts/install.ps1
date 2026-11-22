# Token Tracker on a Windows computer, one command from the dashboard's "Add device" box (PowerShell):
#   & ([scriptblock]::Create((irm <raw url of this file>))) https://<your-site> <device token>
# Same steps as install.sh: the OTLP settings with the token into %USERPROFILE%\.claude\settings.json (env), the token-tracker mod into
# .claude\mods\token-tracker, installed as a plugin from that folder; the collector version's Stop hook is removed. The token is never printed.
param([Parameter(Mandatory = $true)][string]$Origin, [Parameter(Mandatory = $true)][string]$Token)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
function U([string]$s) { [regex]::Replace($s, '\\u(00[a-f0-9]{2}|04[a-f0-9]{2}|2[0-7][a-f0-9]{2})', { param($m) [char][int]("0x" + $m.Groups[1].Value) }) }
function Write-Host([object]$Object = '') { Microsoft.PowerShell.Utility\Write-Host (U "$Object") }
function Read-Host([string]$Prompt = '') { Microsoft.PowerShell.Utility\Read-Host (U $Prompt) }
$Origin = $Origin.TrimEnd('/')
$dir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$raw = if ($env:TT_RAW) { $env:TT_RAW } else { 'https://raw.githubusercontent.com/Pavlo577/modToken/main/worker' }
$mods = Join-Path $dir 'mods'; $mod = Join-Path $mods 'token-tracker'
Write-Host "Token Tracker: \u0432\u0441\u0442\u0430\u043d\u043e\u0432\u043b\u0435\u043d\u043d\u044f \u0432 $dir"

# 1. the mod's files and a local marketplace that lists it
foreach ($f in '.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.ts', 'hooks/history.ts') {
  $p = Join-Path $mod $f
  New-Item -ItemType Directory -Force (Split-Path $p) | Out-Null
  Invoke-RestMethod "$raw/mods/token-tracker/$f" -OutFile $p
}
New-Item -ItemType Directory -Force (Join-Path $mods '.claude-plugin') | Out-Null
[System.IO.File]::WriteAllText((Join-Path $mods '.claude-plugin\marketplace.json'), '{ "name": "token-tracker-local", "owner": { "name": "Token Tracker" }, "plugins": [{ "name": "token-tracker", "source": "./token-tracker", "description": "Token Tracker: limits, sessions, history import" }] }', (New-Object System.Text.UTF8Encoding $false))
Write-Host '  \u043c\u043e\u0434 \u0437\u0430\u0432\u0430\u043d\u0442\u0430\u0436\u0435\u043d\u043e'

# 2. settings.json: the OTLP variables (merged into env), the old Stop hook removed
$settings = Join-Path $dir 'settings.json'
$s = if (Test-Path $settings) { Get-Content -Raw -Encoding UTF8 $settings | ConvertFrom-Json } else { [pscustomobject]@{} }
if (-not $s.PSObject.Properties['env']) { $s | Add-Member -NotePropertyName env -NotePropertyValue ([pscustomobject]@{}) }
$vars = [ordered]@{ CLAUDE_CODE_ENABLE_TELEMETRY = '1'; OTEL_LOGS_EXPORTER = 'otlp'; OTEL_METRICS_EXPORTER = 'none'; OTEL_TRACES_EXPORTER = 'none'
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = 'http/json'; OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "$Origin/v1/logs"; OTEL_EXPORTER_OTLP_LOGS_HEADERS = "x-device-token=$Token" }
foreach ($k in $vars.Keys) { $s.env | Add-Member -Force -NotePropertyName $k -NotePropertyValue $vars[$k] }
if ($s.PSObject.Properties['hooks'] -and $s.hooks.PSObject.Properties['Stop']) {
  $stop = @($s.hooks.Stop | ForEach-Object { $_.hooks = @($_.hooks | Where-Object { "$($_.command)" -notlike '*token-tracker/stop-hook*' }); $_ } | Where-Object { $_.hooks.Count })
  if ($stop.Count) { $s.hooks.Stop = $stop } else { $s.hooks.PSObject.Properties.Remove('Stop') }
}
New-Item -ItemType Directory -Force $dir | Out-Null
[System.IO.File]::WriteAllText($settings, ($s | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding $false))
Write-Host "  OpenTelemetry \u043d\u0430\u043b\u0430\u0448\u0442\u043e\u0432\u0430\u043d\u043e ($settings)"

# 3. the plugin: the old one out, the local one in (fallback to CLAUDE_CODE_PLUGIN_DIRS for Desktop/IDE when claude CLI is absent)
$needDir = $false
if (Get-Command claude -ErrorAction SilentlyContinue) {
  $ErrorActionPreference = 'Continue'
  claude plugin uninstall token-tracker@modtoken *> $null
  claude plugin marketplace add $mods *> $null; if ($LASTEXITCODE) { claude plugin marketplace update token-tracker-local *> $null }
  claude plugin install token-tracker@token-tracker-local --scope user *> $null
  if ($LASTEXITCODE) { claude plugin enable token-tracker@token-tracker-local *> $null }
  if ($LASTEXITCODE) { $needDir = $true; Write-Host '  \u043c\u043e\u0434 \u043d\u0435 \u0432\u0434\u0430\u043b\u043e\u0441\u044f \u0432\u0441\u0442\u0430\u043d\u043e\u0432\u0438\u0442\u0438 \u0447\u0435\u0440\u0435\u0437 claude CLI \u2014 \u043f\u0456\u0434\u043a\u043b\u044e\u0447\u0430\u044e \u0447\u0435\u0440\u0435\u0437 CLAUDE_CODE_PLUGIN_DIRS' } else { Write-Host '  \u043c\u043e\u0434 \u0443\u0432\u0456\u043c\u043a\u043d\u0435\u043d\u043e' }
} else { $needDir = $true; Write-Host '  \u041a\u043e\u043c\u0430\u043d\u0434\u0438 claude \u043d\u0435 \u0437\u043d\u0430\u0439\u0434\u0435\u043d\u043e \u2014 \u043f\u0456\u0434\u043a\u043b\u044e\u0447\u0430\u044e \u043c\u043e\u0434 \u0447\u0435\u0440\u0435\u0437 CLAUDE_CODE_PLUGIN_DIRS \u0434\u043b\u044f Claude Desktop / IDE' }
if ($needDir) {
  $cur = @()
  if ($s.env.PSObject.Properties['CLAUDE_CODE_PLUGIN_DIRS'] -and $s.env.CLAUDE_CODE_PLUGIN_DIRS) {
    $cur = @("$($s.env.CLAUDE_CODE_PLUGIN_DIRS)" -split ';' | Where-Object { $_ })
  }
  if ($cur -notcontains $mod) { $cur += $mod }
  $s.env | Add-Member -Force -NotePropertyName CLAUDE_CODE_PLUGIN_DIRS -NotePropertyValue ($cur -join ';')
  [System.IO.File]::WriteAllText($settings, ($s | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding $false))
}
try {
  $mt = Join-Path $HOME '.modtoken'; New-Item -ItemType Directory -Force $mt | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $mt 'config.json'), (@{ site = $Origin; token = $Token } | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))
  Invoke-RestMethod "$raw/scripts/modtoken.ps1" -OutFile (Join-Path $mt 'modtoken.ps1')
  [System.IO.File]::WriteAllText((Join-Path $mt 'modtoken.cmd'), "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $mt 'modtoken.ps1')`" %*`r`n", (New-Object System.Text.UTF8Encoding $false))
  $up = [Environment]::GetEnvironmentVariable('Path', 'User'); $pts = @("$up" -split ';' | Where-Object { $_ })
  if ($pts -notcontains $mt) { [Environment]::SetEnvironmentVariable('Path', (($pts + $mt) -join ';'), 'User') }
  if (($env:PATH -split ';') -notcontains $mt) { $env:PATH = "$mt;$env:PATH" }
} catch {}
if ($env:COMPUTERNAME) { try { Invoke-RestMethod -Uri "$Origin/v1/config?agent=claude&host=$([Uri]::EscapeDataString($env:COMPUTERNAME))" -Headers @{ 'x-device-token' = $Token; 'User-Agent' = 'modToken-claude/1.0' } -TimeoutSec 3 | Out-Null } catch {} }
Write-Host '\u0413\u043e\u0442\u043e\u0432\u043e. \u041f\u0435\u0440\u0435\u0437\u0430\u043f\u0443\u0441\u0442\u0438 Claude Code (\u0456 Claude Desktop / IDE, \u044f\u043a\u0449\u043e \u0432\u0456\u0434\u043a\u0440\u0438\u0442\u0456); \u0441\u0442\u0430\u0440\u0443 \u0456\u0441\u0442\u043e\u0440\u0456\u044e \u0434\u043e\u0434\u0430\u0441\u0442\u044c \u043a\u043e\u043c\u0430\u043d\u0434\u0430 /tracker-import (\u043a\u043e\u043d\u0441\u043e\u043b\u044c\u043d\u0430 \u043f\u0440\u043e\u0433\u0440\u0430\u043c\u0430 \u043a\u0435\u0440\u0443\u0432\u0430\u043d\u043d\u044f \u0439 \u043e\u043d\u043e\u0432\u043b\u0435\u043d\u043d\u044f: modtoken).'
