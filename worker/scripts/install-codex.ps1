# Token Tracker for Codex CLI on a Windows computer, one command from the dashboard's "Add device" box (PowerShell):
#   & ([scriptblock]::Create((irm <raw url of this file>))) https://<your-site> <device token>
# Same as install-codex.sh: the [otel] table that exports Codex's log events to the site goes into %USERPROFILE%\.codex\config.toml
# ($env:CODEX_HOME if set) between marker lines, replaced on every run; a config with an [otel] table of its own is left as it is.
# The prompt text stays off (log_user_prompt = false). The token is never printed.
# Limits: codex-limits.ps1 goes into .codex\token-tracker and Codex runs it after every turn (`notify`, a top-level key, in a second
# marked block at the top of the file). A `notify` of the user's own is left as it is.
param([Parameter(Mandatory = $true)][string]$Origin, [Parameter(Mandatory = $true)][string]$Token)
$ErrorActionPreference = 'Stop'
$Origin = $Origin.TrimEnd('/')
$dir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$config = Join-Path $dir 'config.toml'
$raw = if ($env:TT_RAW) { $env:TT_RAW } else { 'https://raw.githubusercontent.com/Pavlo577/modToken/main/worker' }
$limits = Join-Path $dir 'token-tracker\codex-limits.ps1'
$begin = '# >>> token-tracker (written by the Token Tracker install command; run it again to update)'
$end = '# <<< token-tracker'
Write-Host "Token Tracker для Codex: $config"
New-Item -ItemType Directory -Force $dir | Out-Null

# the file without our earlier block
$lines = if (Test-Path $config) { @(Get-Content $config) } else { @() }
$rest = New-Object System.Collections.Generic.List[string]; $skip = $false
foreach ($l in $lines) {
  if ($l -like '# >>> token-tracker*') { $skip = $true; continue }
  if ($l -eq $end) { $skip = $false; continue }
  if (-not $skip) { $rest.Add($l) }
}
while ($rest.Count -and -not $rest[$rest.Count - 1].Trim()) { $rest.RemoveAt($rest.Count - 1) }
while ($rest.Count -and -not $rest[0].Trim()) { $rest.RemoveAt(0) }
if ($rest | Where-Object { $_ -match '^\s*\[otel(\]|\.)' }) {
  Write-Host "  У $config уже є своя секція [otel]; її не чіпаю. Додай у неї вручну:"
  Write-Host '    log_user_prompt = false'
  Write-Host "    exporter = { otlp-http = { endpoint = `"$Origin/v1/logs`", protocol = `"json`", headers = { `"x-device-token`" = `"<токен>`" } } }"
  exit 1
}

# the limits: the script, and `notify` unless the config has one of its own
$notify = $null
if ($rest | Where-Object { $_ -match '^\s*notify\s*=' }) {
  Write-Host "  У $config уже є свій notify; ліміти Codex не надсилатимуться (запусти з нього: powershell -File `"$limits`")"
} else {
  try {
    New-Item -ItemType Directory -Force (Split-Path $limits) | Out-Null
    Invoke-RestMethod "$raw/scripts/codex-limits.ps1" -OutFile $limits
    $notify = "notify = ['powershell.exe', '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', '$limits']"
    Write-Host '  збирач лімітів встановлено'
  } catch { Write-Host '  Не вдалося завантажити codex-limits.ps1: ліміти Codex не надсилатимуться' }
}

# `notify` is a top-level key, so its block goes first; a table goes at the end: keys above it stay at the top level
$out = New-Object System.Collections.Generic.List[string]
if ($notify) { $out.AddRange([string[]]@($begin, $notify, $end, '')) }
if ($rest.Count) { $out.AddRange($rest); $out.Add('') }
$out.AddRange([string[]]@($begin, '[otel]', 'log_user_prompt = false',
  "exporter = { otlp-http = { endpoint = `"$Origin/v1/logs`", protocol = `"json`", headers = { `"x-device-token`" = `"$Token`" } } }", $end))
[System.IO.File]::WriteAllLines($config, $out, (New-Object System.Text.UTF8Encoding $false)) # TOML: UTF-8 without a BOM
Write-Host '  OpenTelemetry налаштовано'
Write-Host "Готово. Перезапусти Codex; дані з'являться на дашборді після першого запиту."
