# Token Tracker on a Windows computer, one command from the dashboard's "Add device" box (PowerShell):
#   & ([scriptblock]::Create((irm <raw url of this file>))) https://<your-site> <device token>
# Same steps as install.sh: the OTLP settings with the token into %USERPROFILE%\.claude\settings.json (env), the token-tracker mod into
# .claude\mods\token-tracker, installed as a plugin from that folder; the collector version's Stop hook is removed. The token is never printed.
param([Parameter(Mandatory = $true)][string]$Origin, [Parameter(Mandatory = $true)][string]$Token)
$ErrorActionPreference = 'Stop'
$Origin = $Origin.TrimEnd('/')
$dir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$raw = if ($env:TT_RAW) { $env:TT_RAW } else { 'https://raw.githubusercontent.com/Pavlo577/modToken/claudesolo/worker' }
$mods = Join-Path $dir 'mods'; $mod = Join-Path $mods 'token-tracker'
Write-Host "Token Tracker: встановлення в $dir"

# 1. the mod's files and a local marketplace that lists it
foreach ($f in '.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.ts', 'hooks/history.ts') {
  $p = Join-Path $mod $f
  New-Item -ItemType Directory -Force (Split-Path $p) | Out-Null
  Invoke-RestMethod "$raw/mods/token-tracker/$f" -OutFile $p
}
New-Item -ItemType Directory -Force (Join-Path $mods '.claude-plugin') | Out-Null
'{ "name": "token-tracker-local", "owner": { "name": "Token Tracker" }, "plugins": [{ "name": "token-tracker", "source": "./token-tracker", "description": "Token Tracker: limits, sessions, history import" }] }' |
  Set-Content -Encoding utf8 (Join-Path $mods '.claude-plugin/marketplace.json')
Write-Host '  мод завантажено'

# 2. settings.json: the OTLP variables (merged into env), the old Stop hook removed
$settings = Join-Path $dir 'settings.json'
$s = if (Test-Path $settings) { Get-Content -Raw $settings | ConvertFrom-Json } else { [pscustomobject]@{} }
if (-not $s.PSObject.Properties['env']) { $s | Add-Member -NotePropertyName env -NotePropertyValue ([pscustomobject]@{}) }
$vars = [ordered]@{ CLAUDE_CODE_ENABLE_TELEMETRY = '1'; OTEL_LOGS_EXPORTER = 'otlp'; OTEL_METRICS_EXPORTER = 'none'; OTEL_TRACES_EXPORTER = 'none'
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = 'http/json'; OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "$Origin/v1/logs"; OTEL_EXPORTER_OTLP_LOGS_HEADERS = "x-device-token=$Token" }
foreach ($k in $vars.Keys) { $s.env | Add-Member -Force -NotePropertyName $k -NotePropertyValue $vars[$k] }
if ($s.PSObject.Properties['hooks'] -and $s.hooks.PSObject.Properties['Stop']) {
  $stop = @($s.hooks.Stop | ForEach-Object { $_.hooks = @($_.hooks | Where-Object { "$($_.command)" -notlike '*token-tracker/stop-hook*' }); $_ } | Where-Object { $_.hooks.Count })
  if ($stop.Count) { $s.hooks.Stop = $stop } else { $s.hooks.PSObject.Properties.Remove('Stop') }
}
New-Item -ItemType Directory -Force $dir | Out-Null
$s | ConvertTo-Json -Depth 20 | Set-Content -Encoding utf8 $settings
Write-Host "  OpenTelemetry налаштовано ($settings)"

# 3. the plugin: the old one out, the local one in
if (Get-Command claude -ErrorAction SilentlyContinue) {
  $ErrorActionPreference = 'Continue'
  claude plugin uninstall token-tracker@modtoken *> $null
  claude plugin marketplace add $mods *> $null; if ($LASTEXITCODE) { claude plugin marketplace update token-tracker-local *> $null }
  claude plugin install token-tracker@token-tracker-local --scope user *> $null
  if ($LASTEXITCODE) { claude plugin enable token-tracker@token-tracker-local *> $null }
  if ($LASTEXITCODE) { Write-Host "  мод не вдалося встановити: запускай claude з --plugin-dir `"$mod`"" } else { Write-Host '  мод увімкнено' }
} else { Write-Host "  Команди claude не знайдено: запускай claude з --plugin-dir `"$mod`"" }
Write-Host 'Готово. Перезапусти Claude Code; стару історію додасть команда /tracker-import.'
