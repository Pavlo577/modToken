# Token Tracker for Codex CLI on a Windows computer, one command from the dashboard's "Add device" box (PowerShell):
#   & ([scriptblock]::Create((irm <raw url of this file>))) https://<your-site> <device token>
# Same as install-codex.sh: the [otel] table that exports Codex's log events to the site goes into %USERPROFILE%\.codex\config.toml
# ($env:CODEX_HOME if set) between marker lines, replaced on every run; a config with an [otel] table of its own is left as it is.
# The prompt text stays off (log_user_prompt = false). The token is never printed.
# Limits & activity: hook scripts (mods/codex-tracker) are saved into .codex\token-tracker\plugins\token-tracker and registered
# once in %USERPROFILE%\.codex\hooks.json (works across Codex CLI, Desktop, and IDE extensions); any previous
# token-tracker@token-tracker-local plugin entry in config.toml is disabled automatically to prevent double firing.
param([Parameter(Mandatory = $true)][string]$Origin, [Parameter(Mandatory = $true)][string]$Token)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
function U([string]$s) { [regex]::Replace($s, '\\u(00[a-f0-9]{2}|04[a-f0-9]{2}|2[0-7][a-f0-9]{2})', { param($m) [char][int]("0x" + $m.Groups[1].Value) }) }
function Write-Host([object]$Object = '') { Microsoft.PowerShell.Utility\Write-Host (U "$Object") }
function Read-Host([string]$Prompt = '') { Microsoft.PowerShell.Utility\Read-Host (U $Prompt) }
$Origin = $Origin.TrimEnd('/')
$dir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$config = Join-Path $dir 'config.toml'
$raw = if ($env:TT_RAW) { $env:TT_RAW } else { 'https://raw.githubusercontent.com/Pavlo577/modToken/main/worker' }
$plugin = Join-Path $dir 'token-tracker\plugins\token-tracker'
$begin = '# >>> token-tracker (written by the Token Tracker install command; run it again to update)'
$end = '# <<< token-tracker'
Write-Host "Token Tracker \u0434\u043b\u044f Codex: $config"
New-Item -ItemType Directory -Force $dir | Out-Null

# the file without our earlier block; also disable legacy plugin duplicate if previously enabled in config.toml
$lines = if (Test-Path $config) { @(Get-Content -Encoding UTF8 $config) } else { @() }
$rest = New-Object System.Collections.Generic.List[string]; $skip = $false; $inPlug = $false; $disabledOld = $false
foreach ($l in $lines) {
  if ($l -like '# >>> token-tracker*') { $skip = $true; $inPlug = $false; continue }
  if ($skip) {
    if ($l -eq $end) { $skip = $false }
    continue
  }
  if ($l -match '^\s*\[plugins\.["'']token-tracker@token-tracker-local["'']\]\s*(#.*)?$') { $inPlug = $true; $rest.Add($l); continue }
  if ($l -match '^\s*\[') { $inPlug = $false; $rest.Add($l); continue }
  if ($inPlug -and $l -match '^(\s*enabled\s*=\s*)true(\s*(#.*)?)$') {
    $rest.Add("$($Matches[1])false$($Matches[2])"); $disabledOld = $true; continue
  }
  if ($l -match '^(\s*plugins\.["'']token-tracker@token-tracker-local["'']\.enabled\s*=\s*)true(\s*(#.*)?)$') {
    $rest.Add("$($Matches[1])false$($Matches[2])"); $disabledOld = $true; continue
  }
  $rest.Add($l)
}
while ($rest.Count -and -not $rest[$rest.Count - 1].Trim()) { $rest.RemoveAt($rest.Count - 1) }
while ($rest.Count -and -not $rest[0].Trim()) { $rest.RemoveAt(0) }
if ($rest | Where-Object { $_ -match '^\s*\[otel(\]|\.)' }) {
  Write-Host "  \u0423 $config \u0443\u0436\u0435 \u0454 \u0441\u0432\u043e\u044f \u0441\u0435\u043a\u0446\u0456\u044f [otel]; \u0457\u0457 \u043d\u0435 \u0447\u0456\u043f\u0430\u044e. \u0414\u043e\u0434\u0430\u0439 \u0443 \u043d\u0435\u0457 \u0432\u0440\u0443\u0447\u043d\u0443:"
  Write-Host '    log_user_prompt = false'
  Write-Host '    log_agent_responses = false'
  Write-Host '    log_guardian_assessments = false'
  Write-Host '    log_sse_deltas = false'
  Write-Host "    exporter = { otlp-http = { endpoint = `"$Origin/v1/logs`", protocol = `"json`", headers = { `"x-device-token`" = `"<\u0442\u043e\u043a\u0435\u043d>`" } } }"
  exit 1
}

# a table goes at the end: keys above it stay at the top level
$out = New-Object System.Collections.Generic.List[string]
if ($rest.Count) { $out.AddRange($rest); $out.Add('') }
$out.AddRange([string[]]@($begin, '[otel]', 'log_user_prompt = false',
  'log_agent_responses = false', 'log_guardian_assessments = false', 'log_sse_deltas = false',
  "exporter = { otlp-http = { endpoint = `"$Origin/v1/logs`", protocol = `"json`", headers = { `"x-device-token`" = `"$Token`" } } }", $end))
[System.IO.File]::WriteAllLines($config, $out, (New-Object System.Text.UTF8Encoding $false)) # TOML: UTF-8 without a BOM
Write-Host '  OpenTelemetry \u043d\u0430\u043b\u0430\u0448\u0442\u043e\u0432\u0430\u043d\u043e'
if ($disabledOld) { Write-Host "  \u0421\u0442\u0430\u0440\u0438\u0439 \u043f\u043b\u0430\u0433\u0456\u043d token-tracker@token-tracker-local \u0432\u0438\u043c\u043a\u043d\u0435\u043d\u043e \u0432 $config, \u0449\u043e\u0431 \u0445\u0443\u043a\u0438 \u043d\u0435 \u0437\u0430\u043f\u0443\u0441\u043a\u0430\u043b\u0438\u0441\u044f \u0434\u0432\u0456\u0447\u0456" }

# hook scripts live in .codex\token-tracker\plugins\token-tracker and are registered once in .codex\hooks.json
$got = $true
foreach ($f in '.codex-plugin/plugin.json', 'hooks/hooks.json', 'hooks/limits.py', 'hooks/limits.ps1', 'hooks/history.py', 'hooks/history.ps1', 'hooks/activity.py', 'hooks/activity.ps1') {
  $p = Join-Path $plugin $f
  New-Item -ItemType Directory -Force (Split-Path $p) | Out-Null
  try { Invoke-RestMethod "$raw/mods/codex-tracker/$f" -OutFile $p } catch { $got = $false }
}

# Register user-level %USERPROFILE%\.codex\hooks.json as the single canonical hook source across CLI, Desktop, and IDE
$hooksOk = $false
if ($got) {
  $hooksFile = Join-Path $dir 'hooks.json'
  $doc = @{}
  if (Test-Path $hooksFile) {
    try {
      $parsed = Get-Content -Raw -Encoding UTF8 $hooksFile | ConvertFrom-Json
      if ($parsed) { foreach ($prop in $parsed.PSObject.Properties) { $doc[$prop.Name] = $prop.Value } }
    } catch { }
  }
  $hooksMap = @{}
  if ($doc.ContainsKey('hooks') -and $doc['hooks']) {
    foreach ($prop in $doc['hooks'].PSObject.Properties) { $hooksMap[$prop.Name] = @($prop.Value) }
  }
  $psCmd = { param($scriptName) "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $plugin "hooks\$scriptName")`"" }
  $ours = [ordered]@{
    SessionStart = @(@{ hooks = @(@{ type = 'command'; command = (& $psCmd 'history.ps1'); timeout = 15 }, @{ type = 'command'; command = (& $psCmd 'activity.ps1'); timeout = 10 }) })
    Stop = @(@{ hooks = @(@{ type = 'command'; command = (& $psCmd 'limits.ps1'); timeout = 15 }, @{ type = 'command'; command = (& $psCmd 'activity.ps1'); timeout = 10 }) })
    UserPromptSubmit = @(@{ hooks = @(@{ type = 'command'; command = (& $psCmd 'activity.ps1'); timeout = 10 }) })
    Interrupt = @(@{ hooks = @(@{ type = 'command'; command = (& $psCmd 'activity.ps1'); timeout = 3 }) })
    SessionEnd = @(@{ hooks = @(@{ type = 'command'; command = (& $psCmd 'activity.ps1'); timeout = 3 }) })
  }
  foreach ($ev in $ours.Keys) {
    $cur = @()
    if ($hooksMap.ContainsKey($ev)) {
      $cur = @($hooksMap[$ev] | Where-Object {
        $grp = $_
        -not ($grp.hooks -and ($grp.hooks | Where-Object { "$($_.command)" -like '*token-tracker*' -or "$($_.commandWindows)" -like '*token-tracker*' }))
      })
    }
    $hooksMap[$ev] = @(@($cur) + @($ours[$ev]))
  }
  $doc['hooks'] = $hooksMap
  [System.IO.File]::WriteAllText($hooksFile, ($doc | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding $false))
  $hooksOk = $true
}

if (-not $got) { Write-Host '  \u041d\u0435 \u0432\u0434\u0430\u043b\u043e\u0441\u044f \u0437\u0430\u0432\u0430\u043d\u0442\u0430\u0436\u0438\u0442\u0438 \u0441\u043a\u0440\u0438\u043f\u0442\u0438 \u0445\u0443\u043a\u0456\u0432: \u043b\u0456\u043c\u0456\u0442\u0438 Codex \u043d\u0435 \u043d\u0430\u0434\u0441\u0438\u043b\u0430\u0442\u0438\u043c\u0443\u0442\u044c\u0441\u044f' }
elseif ($hooksOk) { Write-Host "  \u0425\u0443\u043a\u0438 \u0432\u0441\u0442\u0430\u043d\u043e\u0432\u043b\u0435\u043d\u043e \u0432 $dir\hooks.json (\u043f\u0440\u0430\u0446\u044e\u044e\u0442\u044c \u0443 Codex CLI, Desktop \u0442\u0430 IDE)" }
try {
  $mt = Join-Path $HOME '.modtoken'; New-Item -ItemType Directory -Force $mt | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $mt 'config.json'), (@{ site = $Origin; token = $Token } | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))
  Invoke-RestMethod "$raw/scripts/modtoken.ps1" -OutFile (Join-Path $mt 'modtoken.ps1')
  [System.IO.File]::WriteAllText((Join-Path $mt 'modtoken.cmd'), "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $mt 'modtoken.ps1')`" %*`r`n", (New-Object System.Text.UTF8Encoding $false))
  $up = [Environment]::GetEnvironmentVariable('Path', 'User'); $pts = @("$up" -split ';' | Where-Object { $_ })
  if ($pts -notcontains $mt) { [Environment]::SetEnvironmentVariable('Path', (($pts + $mt) -join ';'), 'User') }
  if (($env:PATH -split ';') -notcontains $mt) { $env:PATH = "$mt;$env:PATH" }
} catch {}
if ($env:COMPUTERNAME) { try { Invoke-RestMethod -Uri "$Origin/v1/config?agent=codex&host=$([Uri]::EscapeDataString($env:COMPUTERNAME))" -Headers @{ 'x-device-token' = $Token; 'User-Agent' = 'modToken-codex/1.0' } -TimeoutSec 3 | Out-Null } catch {} }
Write-Host "\u0413\u043e\u0442\u043e\u0432\u043e. \u041f\u0435\u0440\u0435\u0437\u0430\u043f\u0443\u0441\u0442\u0438 Codex \u0456 \u0441\u0445\u0432\u0430\u043b\u0438 \u0445\u0443\u043a\u0438 (/hooks \u0430\u0431\u043e Settings \u2192 Hooks \u2192 Review hooks); \u0434\u0430\u043d\u0456 \u0437'\u044f\u0432\u043b\u044f\u0442\u044c\u0441\u044f \u043f\u0456\u0441\u043b\u044f \u043f\u0435\u0440\u0448\u043e\u0433\u043e \u0437\u0430\u043f\u0438\u0442\u0443 (\u043a\u043e\u043d\u0441\u043e\u043b\u044c\u043d\u0430 \u043f\u0440\u043e\u0433\u0440\u0430\u043c\u0430 \u043a\u0435\u0440\u0443\u0432\u0430\u043d\u043d\u044f \u0439 \u043e\u043d\u043e\u0432\u043b\u0435\u043d\u043d\u044f: modtoken)."
