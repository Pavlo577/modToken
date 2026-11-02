# Token Tracker plugin for Codex on Windows: the subscription's rate-limit windows, sent to the site (POST /v1/limits, provider codex).
# Same as limits.py: the plugin's Stop hook runs it after every turn; of the hook's input it reads `transcript_path` only (the input also
# holds the last answer, never looked at), of the session file only the numbers of the last `token_count` event's `rate_limits`; without
# a transcript path, the newest file of %USERPROFILE%\.codex\sessions\YYYY\MM\DD. Nothing is printed; a failure only leaves its message
# (never the token or the data) in last-error.txt in the plugin's data folder (PLUGIN_DATA, else %USERPROFILE%\.codex\token-tracker), and its type in the dashboard's plugin log.
$ErrorActionPreference = 'Stop'
$home_ = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$data = if ($env:PLUGIN_DATA) { $env:PLUGIN_DATA } else { Join-Path $home_ 'token-tracker' }
# the plugin's own log on the dashboard (POST /v1/plugin-log): kinds and counts, an error's type, never its message or a path
$script:siteUrl = $null; $script:tok = $null
function Send-Report($events, $timeout = 5) {
  if (-not $script:siteUrl) { return }
  try {
    $v = try { "$((Get-Content -Raw (Join-Path $PSScriptRoot '..\.codex-plugin\plugin.json') | ConvertFrom-Json).version)" } catch { '' }
    $body = @{ provider = 'codex'; version = $v; events = @($events) } | ConvertTo-Json -Depth 4 -Compress
    Invoke-RestMethod -Method Post -Uri ($script:siteUrl + '/v1/plugin-log') -ContentType 'application/json' -Headers @{ 'x-device-token' = $script:tok } -Body $body -TimeoutSec $timeout | Out-Null
  } catch { }
}
try {
  # Windows PowerShell 5.1 on an older .NET may offer only TLS 1.0 / 1.1, which the site refuses
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $config = Get-Content -Raw (Join-Path $home_ 'config.toml')
  $site = [regex]::Match($config, 'endpoint = "(https?://[^"]+?)/v1/logs"')
  $token = [regex]::Match($config, '"x-device-token" = "([0-9a-f]{16,128})"')
  if (-not $site.Success -or -not $token.Success) { exit 0 }
  $script:siteUrl = $site.Groups[1].Value; $script:tok = $token.Groups[1].Value

  # the session file the Stop hook names, then the most recently written ones from the last two day folders
  $named = $null
  if ([Console]::IsInputRedirected) {
    try { $p = ([Console]::In.ReadToEnd() | ConvertFrom-Json).transcript_path; if ("$p" -like '*.jsonl' -and (Test-Path -LiteralPath "$p" -PathType Leaf)) { $named = Get-Item -LiteralPath "$p" } } catch { }
  }
  $root = Join-Path $home_ 'sessions'
  $days = if (-not (Test-Path $root)) { @() } else { Get-ChildItem $root -Directory | Sort-Object Name -Descending | Select-Object -First 2 |
    ForEach-Object { Get-ChildItem $_.FullName -Directory | Sort-Object Name -Descending | Select-Object -First 2 } |
    ForEach-Object { Get-ChildItem $_.FullName -Directory | Sort-Object Name -Descending | Select-Object -First 2 } |
    Sort-Object FullName -Descending | Select-Object -First 2 }
  $files = @($days | ForEach-Object { Get-ChildItem $_.FullName -File -Filter 'rollout-*.jsonl' } | Sort-Object LastWriteTime -Descending | Select-Object -First 3)
  if ($named) { $files = @($named) + $files }

  foreach ($f in $files) {
    $lines = @(Get-Content $f.FullName -Tail 400)
    [array]::Reverse($lines)
    $rl = $null; $stamp = $null
    foreach ($line in $lines) {
      if ($line -notlike '*"token_count"*' -or $line -notlike '*"rate_limits"*') { continue }
      try { $row = $line | ConvertFrom-Json } catch { continue }
      if ($row.type -eq 'event_msg' -and $row.payload.type -eq 'token_count' -and $row.payload.rate_limits) { $rl = $row.payload.rate_limits; $stamp = $row.timestamp; break }
    }
    if (-not $rl) { continue }
    $limits = @()
    foreach ($name in 'primary', 'secondary') {
      $w = $rl.$name
      if (-not $w -or $null -eq $w.used_percent) { continue }
      $kind = switch ($w.window_minutes) { 300 { 'five_hour' } 10080 { 'seven_day' } default { $name } }
      $r = [ordered]@{ kind = $kind; percentUsed = [math]::Round([double]$w.used_percent, 2) }
      if ($null -ne $w.resets_at) { $r.resetsAt = [DateTimeOffset]::FromUnixTimeSeconds([long]$w.resets_at).ToString('o') }
      elseif ($null -ne $w.resets_in_seconds -and $stamp) { $r.resetsAt = ([DateTimeOffset]::Parse("$stamp")).AddSeconds([double]$w.resets_in_seconds).ToString('o') } # older Codex versions
      $limits += $r
    }
    if ($limits.Count) {
      $body = @{ provider = 'codex'; limits = $limits } | ConvertTo-Json -Depth 4 -Compress
      Invoke-RestMethod -Method Post -Uri ($site.Groups[1].Value + '/v1/limits') -ContentType 'application/json' -Headers @{ 'x-device-token' = $token.Groups[1].Value } -Body $body -TimeoutSec 5 | Out-Null
      $beat = Join-Path $data 'limits-reported' # the dashboard's log hears "limits sent" at most once an hour
      if (-not (Test-Path $beat) -or ((Get-Date) - (Get-Item $beat).LastWriteTime).TotalSeconds -gt 3600) {
        New-Item -ItemType Directory -Force $data | Out-Null
        Set-Content -Encoding ascii $beat ''
        Send-Report @(@{ kind = 'limits'; n = $limits.Count })
      }
    }
    break
  }
} catch {
  $type = $_.Exception.GetType().Name
  try {
    New-Item -ItemType Directory -Force $data | Out-Null
    "$((Get-Date).ToUniversalTime().ToString('o')) $($_.Exception.Message)" | Set-Content -Encoding utf8 (Join-Path $data 'last-error.txt')
  } catch { }
  Send-Report @(@{ kind = 'error'; error = $type; stage = 'limits' })
}
exit 0
