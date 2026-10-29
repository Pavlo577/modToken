# Token Tracker for Codex CLI on a Windows computer, one command from the dashboard's "Add device" box (PowerShell):
#   & ([scriptblock]::Create((irm <raw url of this file>))) https://<your-site> <device token>
# Same as install-codex.sh: the [otel] table that exports Codex's log events to the site goes into %USERPROFILE%\.codex\config.toml
# ($env:CODEX_HOME if set) between marker lines, replaced on every run; a config with an [otel] table of its own is left as it is.
# The prompt text stays off (log_user_prompt = false). The token is never printed.
param([Parameter(Mandatory = $true)][string]$Origin, [Parameter(Mandatory = $true)][string]$Token)
$ErrorActionPreference = 'Stop'
$Origin = $Origin.TrimEnd('/')
$dir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$config = Join-Path $dir 'config.toml'
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
if ($rest | Where-Object { $_ -match '^\s*\[otel(\]|\.)' }) {
  Write-Host "  У $config уже є своя секція [otel]; її не чіпаю. Додай у неї вручну:"
  Write-Host '    log_user_prompt = false'
  Write-Host "    exporter = { otlp-http = { endpoint = `"$Origin/v1/logs`", protocol = `"json`", headers = { `"x-device-token`" = `"<токен>`" } } }"
  exit 1
}

# a table goes at the end: keys above it stay at the top level
$out = New-Object System.Collections.Generic.List[string]
if ($rest.Count) { $out.AddRange($rest); $out.Add('') }
$out.AddRange([string[]]@($begin, '[otel]', 'log_user_prompt = false',
  "exporter = { otlp-http = { endpoint = `"$Origin/v1/logs`", protocol = `"json`", headers = { `"x-device-token`" = `"$Token`" } } }", $end))
[System.IO.File]::WriteAllLines($config, $out, (New-Object System.Text.UTF8Encoding $false)) # TOML: UTF-8 without a BOM
Write-Host '  OpenTelemetry налаштовано'
Write-Host "Готово. Перезапусти Codex; дані з'являться на дашборді після першого запиту."
