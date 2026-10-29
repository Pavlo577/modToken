# Token Tracker plugin for Codex on Windows: the token history from before OpenTelemetry was switched on. Same as history.py: read from
# Codex's session files (%USERPROFILE%\.codex\sessions and archived_sessions) on the device, sent as numbers to POST /v1/import
# (provider codex) by the SessionStart hook until one import has gone through (then a marker in the plugin's data folder stops it).
# Only session_meta, turn_context, task_started and token_count lines are parsed; the conversation is not. Nothing is printed; a failure
# leaves its message in last-error.txt. Codex does not run async hooks yet, so the hook only starts the import as a hidden process of its
# own (-Run) and returns at once.
param([switch]$Run)
$ErrorActionPreference = 'Stop'
$home_ = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$data = if ($env:PLUGIN_DATA) { $env:PLUGIN_DATA } else { Join-Path $home_ 'token-tracker' }
$marker = Join-Path $data 'history-imported'
try {
  if (Test-Path $marker) { exit 0 }
  if (-not $Run) {
    Start-Process powershell -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Run')
    exit 0
  }
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $config = Get-Content -Raw (Join-Path $home_ 'config.toml')
  $site = [regex]::Match($config, 'endpoint = "(https?://[^"]+?)/v1/logs"')
  $token = [regex]::Match($config, '"x-device-token" = "([0-9a-f]{16,128})"')
  if (-not $site.Success -or -not $token.Success) { exit 0 }

  $rows = New-Object System.Collections.Generic.List[object]
  $files = foreach ($sub in 'sessions', 'archived_sessions') {
    $dir = Join-Path $home_ $sub
    if (Test-Path $dir) { Get-ChildItem $dir -Recurse -File -Filter 'rollout-*.jsonl' | Sort-Object FullName }
  }
  foreach ($file in $files) {
    $m = [regex]::Match($file.Name, '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})')
    $session = if ($m.Success) { $m.Groups[1].Value } else { $null }
    $model = 'unknown'; $own = $false; $newTurn = $true; $turnStart = $null; $turnRow = $null; $total = $null; $n = 0
    foreach ($line in [IO.File]::ReadLines($file.FullName)) {
      if ($line -notmatch '"(session_meta|turn_context|task_started|turn_started|token_count)"') { continue }
      try { $row = $line | ConvertFrom-Json } catch { continue }
      $p = $row.payload; $ts = "$($row.timestamp)"
      if ($row.timestamp -is [datetime]) { $ts = $row.timestamp.ToUniversalTime().ToString('o') } # PowerShell 7 turns ISO strings into dates
      if ($row.type -eq 'session_meta' -and $p.id) { $session = "$($p.id)" }
      elseif ($row.type -eq 'turn_context') {
        if ("$($p.model)" -match '^[\w.:/+-]{1,64}$') { $model = "$($p.model)" }
        $own = ($p.approval_policy -eq 'never') -and ($p.sandbox_policy.type -eq 'read-only')
      }
      elseif ($row.type -eq 'event_msg' -and ($p.type -eq 'task_started' -or $p.type -eq 'turn_started')) { $newTurn = $true; $turnStart = $ts }
      elseif ($row.type -eq 'event_msg' -and $p.type -eq 'token_count' -and $p.info) {
        $t = $p.info.total_token_usage.total_tokens
        if ($null -ne $total -and $t -eq $total) { continue } # the same totals again (a rate-limit update): no new call
        $total = $t
        $u = $p.info.last_token_usage
        $num = { param($v) if ($v -is [ValueType] -and $v -gt 0) { [long]$v } else { 0 } }
        $cached = & $num $u.cached_input_tokens; $written = & $num $u.cache_write_input_tokens; $output = & $num $u.output_tokens
        $fresh = [math]::Max(0, (& $num $u.input_tokens) - $cached - $written)
        if (-not $session -or ($fresh + $cached + $written + $output) -eq 0) { continue }
        $n++
        $call = [ordered]@{ id = "cx:${session}:$n"; session = $session; ts = $ts; model = $model; input = $fresh; output = $output
          cache_read = $cached; cache_creation = $written; sub = $false; first = $newTurn; duration_ms = 0; bg = $own }
        if ($newTurn) { $turnRow = $call; $newTurn = $false; if (-not $turnStart) { $turnStart = $ts } }
        if ($turnRow -and $turnStart) {
          try { $turnRow.duration_ms = [math]::Max(0, [long]([DateTimeOffset]::Parse($ts) - [DateTimeOffset]::Parse($turnStart)).TotalMilliseconds) } catch { }
        }
        $rows.Add($call)
      }
    }
  }
  for ($i = 0; $i -lt $rows.Count; $i += 500) {
    $part = $rows.GetRange($i, [math]::Min(500, $rows.Count - $i))
    $body = @{ provider = 'codex'; turns = @($part) } | ConvertTo-Json -Depth 4 -Compress
    Invoke-RestMethod -Method Post -Uri ($site.Groups[1].Value + '/v1/import') -ContentType 'application/json' -Headers @{ 'x-device-token' = $token.Groups[1].Value } -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 60 | Out-Null
  }
  New-Item -ItemType Directory -Force $data | Out-Null
  "$((Get-Date).ToUniversalTime().ToString('o')) $($rows.Count)" | Set-Content -Encoding utf8 $marker
} catch {
  try {
    New-Item -ItemType Directory -Force $data | Out-Null
    "$((Get-Date).ToUniversalTime().ToString('o')) history: $($_.Exception.Message)" | Set-Content -Encoding utf8 (Join-Path $data 'last-error.txt')
  } catch { }
}
exit 0
