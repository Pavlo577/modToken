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
$Origin = $Origin.TrimEnd('/')
$dir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$config = Join-Path $dir 'config.toml'
$raw = if ($env:TT_RAW) { $env:TT_RAW } else { 'https://raw.githubusercontent.com/Pavlo577/modToken/main/worker' }
$plugin = Join-Path $dir 'token-tracker\plugins\token-tracker'
$begin = '# >>> token-tracker (written by the Token Tracker install command; run it again to update)'
$end = '# <<< token-tracker'
Write-Host "Token Tracker для Codex: $config"
New-Item -ItemType Directory -Force $dir | Out-Null

# the file without our earlier block; also disable legacy plugin duplicate if previously enabled in config.toml
$lines = if (Test-Path $config) { @(Get-Content $config) } else { @() }
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
  Write-Host "  У $config уже є своя секція [otel]; її не чіпаю. Додай у неї вручну:"
  Write-Host '    log_user_prompt = false'
  Write-Host '    log_agent_responses = false'
  Write-Host '    log_guardian_assessments = false'
  Write-Host '    log_sse_deltas = false'
  Write-Host "    exporter = { otlp-http = { endpoint = `"$Origin/v1/logs`", protocol = `"json`", headers = { `"x-device-token`" = `"<токен>`" } } }"
  exit 1
}

# a table goes at the end: keys above it stay at the top level
$out = New-Object System.Collections.Generic.List[string]
if ($rest.Count) { $out.AddRange($rest); $out.Add('') }
$out.AddRange([string[]]@($begin, '[otel]', 'log_user_prompt = false',
  'log_agent_responses = false', 'log_guardian_assessments = false', 'log_sse_deltas = false',
  "exporter = { otlp-http = { endpoint = `"$Origin/v1/logs`", protocol = `"json`", headers = { `"x-device-token`" = `"$Token`" } } }", $end))
[System.IO.File]::WriteAllLines($config, $out, (New-Object System.Text.UTF8Encoding $false)) # TOML: UTF-8 without a BOM
Write-Host '  OpenTelemetry налаштовано'
if ($disabledOld) { Write-Host "  Старий плагін token-tracker@token-tracker-local вимкнено в $config, щоб хуки не запускалися двічі" }

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

if (-not $got) { Write-Host '  Не вдалося завантажити скрипти хуків: ліміти Codex не надсилатимуться' }
elseif ($hooksOk) { Write-Host "  Хуки встановлено в $dir\hooks.json (працюють у Codex CLI, Desktop та IDE)" }
Write-Host "Готово. Перезапусти Codex і схвали хуки (/hooks або Settings → Hooks → Review hooks); дані з'являться після першого запиту."
