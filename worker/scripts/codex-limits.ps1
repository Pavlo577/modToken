# Token Tracker for Codex on Windows: the subscription's rate-limit windows, sent to the site (POST /v1/limits, provider codex).
# Same as codex-limits.py: Codex runs it after every turn (`notify` in config.toml, written by install-codex.ps1); it reads only the
# numbers of the last `token_count` event's `rate_limits` in the newest session file of %USERPROFILE%\.codex\sessions\YYYY\MM\DD,
# never the conversation and not the argument Codex appends (it holds the turn's text). Nothing is printed; a failure is silent.
$ErrorActionPreference = 'Stop'
try {
  $home_ = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
  $config = Get-Content -Raw (Join-Path $home_ 'config.toml')
  $site = [regex]::Match($config, 'endpoint = "(https?://[^"]+?)/v1/logs"')
  $token = [regex]::Match($config, '"x-device-token" = "([0-9a-f]{16,128})"')
  if (-not $site.Success -or -not $token.Success) { exit 0 }

  # the most recently written session files, from the last two day folders
  $root = Join-Path $home_ 'sessions'
  $days = Get-ChildItem $root -Directory | Sort-Object Name -Descending | Select-Object -First 2 |
    ForEach-Object { Get-ChildItem $_.FullName -Directory | Sort-Object Name -Descending | Select-Object -First 2 } |
    ForEach-Object { Get-ChildItem $_.FullName -Directory | Sort-Object Name -Descending | Select-Object -First 2 } |
    Sort-Object FullName -Descending | Select-Object -First 2
  $files = $days | ForEach-Object { Get-ChildItem $_.FullName -File -Filter 'rollout-*.jsonl' } | Sort-Object LastWriteTime -Descending | Select-Object -First 3

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
    }
    break
  }
} catch { }
exit 0
