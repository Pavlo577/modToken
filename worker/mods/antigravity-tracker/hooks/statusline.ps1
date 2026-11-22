# Token Tracker statusLine bridge for Antigravity CLI on Windows (PowerShell).
# Normalizes model names, buffers OTLP logRecords & quota snapshots locally in queue.json (up to 500 records),
# and flushes in batches on idle / >=10 records / >=flush_seconds / -Sync / -Flush; keeps items on offline failure.
param([switch]$Sync, [switch]$Flush, [switch]$Deliver)
$ErrorActionPreference = 'Stop'

$cliDir = if ($env:ANTIGRAVITY_CLI_DIR) { $env:ANTIGRAVITY_CLI_DIR } else { Join-Path $HOME '.gemini\antigravity-cli' }
$data = if ($env:ANTIGRAVITY_TRACKER_DIR) { $env:ANTIGRAVITY_TRACKER_DIR } else { Join-Path $cliDir 'token-tracker' }
$stateDir = Join-Path $data 'state'
$actDir = Join-Path $data 'activity'
$queuePath = Join-Path $data 'queue.json'

function Load-Json($p) {
  if (-not (Test-Path $p)) { return @{} }
  try {
    $o = Get-Content -Raw -Encoding UTF8 $p | ConvertFrom-Json
    if ($null -eq $o) { return @{} }
    return $o
  } catch { return @{} }
}

function Save-Json($p, $obj) {
  New-Item -ItemType Directory -Force (Split-Path $p) | Out-Null
  $tmp = "$p.tmp.$PID.$([Guid]::NewGuid().ToString('N').Substring(0,6))"
  [System.IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Depth 12 -Compress), (New-Object System.Text.UTF8Encoding $false))
  Move-Item -Force $tmp $p
}

function Load-Config {
  $cfg = Load-Json (Join-Path $data 'config.json')
  $site = if ($cfg.site) { ([string]$cfg.site).TrimEnd('/') } else { '' }
  $tok = if ($cfg.token) { [string]$cfg.token } else { '' }
  $chain = if ($cfg.chain_command) { [string]$cfg.chain_command } else { '' }
  $flushSec = if ($null -ne $cfg.flush_seconds -and [double]$cfg.flush_seconds -ge 0) { [double]$cfg.flush_seconds } else { 15.0 }
  if (-not ($site -match '^https?://') -or -not $tok) { return @($null, $null, $chain, $flushSec) }
  return @($site, $tok, $chain, $flushSec)
}

function Normalize-Model($raw) {
  $s = if ($raw) { ([string]$raw).Trim() } else { '' }
  if (-not $s) { return 'unknown' }
  if ($s.Length -gt 100) { $s = $s.Substring(0, 100) }
  if ($s -match '^[a-z0-9._-]+$') { return $s }
  $slug = ($s.ToLowerInvariant() -replace '[()]+', '' -replace '[\s/]+', '-' -replace '-+', '-').Trim('-')
  if ($slug.StartsWith('claude-')) { $slug = [regex]::Replace($slug, '(\d)\.(\d)', '$1-$2') }
  if (-not $slug) { return 'unknown' }
  return $slug
}

function Post-Json($site, $tok, $path, $body) {
  $json = $body | ConvertTo-Json -Depth 14 -Compress
  Invoke-RestMethod -Uri ($site + $path) -Method Post -ContentType 'application/json' -Headers @{ 'x-device-token' = $tok; 'user-agent' = 'modToken-antigravity/1.0' } -Body $json -TimeoutSec 5 | Out-Null
}

function Plugin-Version {
  try {
    $m = Load-Json (Join-Path (Split-Path $PSScriptRoot) 'plugin.json')
    if ($m.version) { return [string]$m.version }
  } catch {}
  return ''
}

function Record-Id($rec) {
  foreach ($a in @($rec.attributes)) {
    if ($a.key -eq 'request_id' -and $a.value.stringValue) { return [string]$a.value.stringValue }
  }
  return ''
}

function Deliver-Queue {
  $site, $tok, $_, $_ = Load-Config
  if (-not $site) { return }
  $q = Load-Json $queuePath
  $recs = @($q.records | Where-Object { $null -ne $_ })
  $lims = if ($q.limits) { @($q.limits) } else { $null }
  if ($recs.Count -eq 0 -and (-not $lims -or $lims.Count -eq 0)) { return }

  $sentIds = @{}
  $limOk = $false
  if ($recs.Count -gt 0) {
    $otlp = @{ resourceLogs = @(@{ resource = @{ attributes = @(@{ key = 'service.name'; value = @{ stringValue = 'antigravity-cli' } }) }; scopeLogs = @(@{ logRecords = $recs }) }) }
    try {
      Post-Json $site $tok '/v1/logs' $otlp
      foreach ($r in $recs) { $id = Record-Id $r; if ($id) { $sentIds[$id] = $true } }
    } catch {}
  }
  if ($lims -and $lims.Count -gt 0) {
    try {
      Post-Json $site $tok '/v1/limits' @{ provider = 'antigravity'; limits = $lims }
      $limOk = $true
      $beat = Join-Path $data 'limits-reported'
      if (-not (Test-Path $beat) -or ((Get-Date) - (Get-Item $beat).LastWriteTime).TotalSeconds -gt 3600) {
        New-Item -ItemType Directory -Force $data | Out-Null
        Set-Content -Path $beat -Value ''
        try { Post-Json $site $tok '/v1/plugin-log' @{ provider = 'antigravity'; version = (Plugin-Version); events = @(@{ kind = 'limits'; n = $lims.Count }) } } catch {}
      }
    } catch {}
  }
  if ($sentIds.Count -gt 0 -or $limOk) {
    $cur = Load-Json $queuePath
    $curRecs = @($cur.records | Where-Object { $null -ne $_ -and -not $sentIds.ContainsKey((Record-Id $_)) })
    $curLims = if ($limOk) { $null } else { $cur.limits }
    $lastMs = if ($curRecs.Count -eq 0 -and (-not $curLims)) { 0 } else { [int64]($cur.last_flush_ms) }
    Save-Json $queuePath @{ records = $curRecs; limits = $curLims; last_flush_ms = $lastMs }
  }
}

try {
  if ($Deliver) { Deliver-Queue; exit 0 }
  $site, $tok, $chain, $flushSec = Load-Config
  if (-not $site) { exit 0 }
  if ($Flush -and [Console]::IsInputRedirected -eq $false) {
    if ($Sync) { Deliver-Queue } else { Start-Process -WindowStyle Hidden -FilePath 'powershell' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Deliver') | Out-Null }
    exit 0
  }
  $raw = [Console]::In.ReadToEnd()
  if (-not $raw.Trim()) { exit 0 }
  $p = $raw | ConvertFrom-Json
  $now = [DateTimeOffset]::UtcNow
  $nowMs = $now.ToUnixTimeMilliseconds()
  $newLimits = $null
  $newRecord = $null
  $agentState = if ($p.agent_state) { ([string]$p.agent_state).Trim().ToLowerInvariant() } else { '' }

  if ($p.quota) {
    $byKind = @{}
    $counts = @{}
    $rawEntries = @()
    $obsIso = $now.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    foreach ($prop in $p.quota.PSObject.Properties) {
      $info = $prop.Value
      if ($null -eq $info -or $info.disabled -eq $true -or $null -eq $info.remaining_fraction) { continue }
      $pct = [Math]::Round([Math]::Max(0.0, [Math]::Min(100.0, (1.0 - [double]$info.remaining_fraction) * 100.0)), 2)
      $low = $prop.Name.ToLowerInvariant()
      $rs = if ($null -ne $info.reset_in_seconds) { [double]$info.reset_in_seconds } else { -1 }
      $kind = if ($low -match 'week|7d|seven' -or $rs -gt 86400) { 'seven_day' } elseif ($low -match '5h|five|hour|session' -or ($rs -gt 0 -and $rs -le 21600)) { 'five_hour' } else { ($low -replace '[^a-z]+', '_').Trim('_') }
      if (-not $kind) { $kind = 'quota' }
      $counts[$kind] = $(if ($counts.ContainsKey($kind)) { $counts[$kind] + 1 } else { 1 })
      $entry = @{ kind = $kind; percentUsed = $pct; observedAt = $obsIso }
      if ($info.reset_time) { $entry.resetsAt = [string]$info.reset_time }
      elseif ($rs -ge 0) { $entry.resetsAt = $now.AddSeconds($rs).ToString('yyyy-MM-ddTHH:mm:00Z') }
      $rawEntries += @{ bucket = $prop.Name; entry = $entry }
      if (-not $byKind.ContainsKey($kind) -or $pct -gt $byKind[$kind].percentUsed) {
        $byKind[$kind] = @{} + $entry
      }
    }
    if ($byKind.Count -gt 0) {
      $limits = @($byKind.Keys | Sort-Object | ForEach-Object { $byKind[$_] })
      if (@($counts.Values | Where-Object { $_ -gt 1 }).Count -gt 0) {
        $extras = @{}
        foreach ($item in $rawEntries) {
          $pk = ($item.bucket.ToLowerInvariant() -replace '[^a-z0-9]+', '_').Trim('_')
          if ($pk -and $pk -notmatch '^[a-z]') { $pk = 'q_' + $pk }
          if ($pk.Length -gt 30) { $pk = $pk.Substring(0, 30).Trim('_') }
          if (-not $pk) { $pk = 'quota' }
          if ($pk -eq 'five_hour' -or $pk -eq 'seven_day' -or $byKind.ContainsKey($pk)) { continue }
          $e = $item.entry
          if (-not $extras.ContainsKey($pk) -or $e.percentUsed -gt $extras[$pk].percentUsed) {
            $copy = @{} + $e
            $copy.kind = $pk
            $extras[$pk] = $copy
          }
        }
        foreach ($pk in ($extras.Keys | Sort-Object)) {
          if ($limits.Count -ge 8) { break }
          $limits += $extras[$pk]
        }
      }
      $qPath = Join-Path $stateDir 'quota.json'
      $qState = Load-Json $qPath
      $sig = (@($limits | ForEach-Object { "$($_.kind)|$($_.percentUsed)|$(if ($_.resetsAt) { ([string]$_.resetsAt).Substring(0, [Math]::Min(16, ([string]$_.resetsAt).Length)) } else { '' })" }) -join ';')
      if ($qState.sig -ne $sig) {
        Save-Json $qPath @{ sig = $sig; ts = $now.ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
        $newLimits = $limits
      }
    }
  }

  $sid = if ($p.conversation_id) { [string]$p.conversation_id } elseif ($p.session_id) { [string]$p.session_id } else { '' }
  if ($sid -match '^[\w-]{1,80}$') {
    $cw = $p.context_window; $cu = if ($cw) { $cw.current_usage } else { $null }
    $totalIn = if ($cw -and $cw.total_input_tokens -ge 0) { [int64]$cw.total_input_tokens } else { 0 }
    $totalOut = if ($cw -and $cw.total_output_tokens -ge 0) { [int64]$cw.total_output_tokens } else { 0 }
    $cwSize = if ($cw -and $cw.context_window_size -gt 0) { [int64]$cw.context_window_size } else { 0 }
    $costTotal = if ($p.cost -and $p.cost.total_usd -ge 0) { [double]$p.cost.total_usd } else { 0.0 }
    $costSub = if ($p.cost -and $p.cost.subagent_usd -ge 0) { [double]$p.cost.subagent_usd } else { 0.0 }

    $stPath = Join-Path $stateDir "$sid.json"
    $st = Load-Json $stPath
    $prevIn = if ($st.total_input) { [int64]$st.total_input } else { 0 }
    $prevOut = if ($st.total_output) { [int64]$st.total_output } else { 0 }
    $prevCost = if ($st.cost_usd) { [double]$st.cost_usd } else { 0.0 }
    $prevSub = if ($st.subagent_usd) { [double]$st.subagent_usd } else { 0.0 }
    if ($totalIn -lt $prevIn -or $totalOut -lt $prevOut) { $prevIn = 0; $prevOut = 0; $prevCost = 0.0; $prevSub = 0.0 }

    $dIn = $totalIn - $prevIn; $dOut = $totalOut - $prevOut
    $seq = if ($st.seq) { [int64]$st.seq } else { 0 }
    $lastCuSig = if ($st.last_cu_sig) { [string]$st.last_cu_sig } else { '' }
    $lastCallMs = if ($st.last_call_ms) { [int64]$st.last_call_ms } else { 0 }

    if ($dIn -gt 0 -or $dOut -gt 0) {
      $cuSig = if ($cu) { $cu | ConvertTo-Json -Compress } else { '' }
      $cRead = 0; $cWrite = 0
      if ($cu -and $cuSig -ne $lastCuSig) {
        if ($cu.cache_read_input_tokens -ge 0) { $cRead = [int64]$cu.cache_read_input_tokens }
        if ($cu.cache_creation_input_tokens -ge 0) { $cWrite = [int64]$cu.cache_creation_input_tokens }
      }
      $newIn = if (($cRead + $cWrite) -le $dIn) { $dIn - $cRead - $cWrite } else { $dIn }
      $dCost = [Math]::Max(0.0, $costTotal - $prevCost)
      $dSub = [Math]::Max(0.0, $costSub - $prevSub)
      $costMicros = [int64][Math]::Round($dCost * 1000000.0)
      $qs = if ($dSub -gt 0 -and $dSub -ge ($dCost * 0.99)) { 'subagent' } else { 'repl_main_thread' }
      $seq++
      $act = Load-Json (Join-Path $actDir "$sid.json")
      $promptId = if ($act.turn -and $act.turn.id) { [string]$act.turn.id } else { "$($sid.Substring(0, [Math]::Min(36, $sid.Length)))-t$seq" }
      $dur = if ($lastCallMs -gt 0 -and ($nowMs - $lastCallMs) -gt 0 -and ($nowMs - $lastCallMs) -le 600000) { $nowMs - $lastCallMs } else { 0 }
      $modelId = Normalize-Model $(if ($p.model -and $p.model.id) { $p.model.id } elseif ($p.model -and $p.model.display_name) { $p.model.display_name } else { 'unknown' })
      $attrs = @(
        @{ key = 'event.name'; value = @{ stringValue = 'antigravity.api_request' } }
        @{ key = 'session.id'; value = @{ stringValue = $sid } }
        @{ key = 'prompt.id'; value = @{ stringValue = $promptId } }
        @{ key = 'request_id'; value = @{ stringValue = "${sid}:sl:${seq}" } }
        @{ key = 'model'; value = @{ stringValue = $modelId } }
        @{ key = 'input_tokens'; value = @{ intValue = [string]$newIn } }
        @{ key = 'output_tokens'; value = @{ intValue = [string]$dOut } }
        @{ key = 'cache_read_tokens'; value = @{ intValue = [string]$cRead } }
        @{ key = 'cache_creation_tokens'; value = @{ intValue = [string]$cWrite } }
        @{ key = 'duration_ms'; value = @{ intValue = [string]$dur } }
        @{ key = 'query_source'; value = @{ stringValue = $qs } }
      )
      if ($costMicros -gt 0) { $attrs += @{ key = 'cost_usd_micros'; value = @{ intValue = [string]$costMicros } } }
      if ($p.model -and $p.model.effort) { $attrs += @{ key = 'effort'; value = @{ stringValue = [string]$p.model.effort } } }
      $ns = [string]($nowMs * 1000000)
      $newRecord = @{ timeUnixNano = $ns; attributes = $attrs }
      $lastCuSig = $cuSig; $lastCallMs = $nowMs
    }

    $ctxTok = if ($cu) {
      (if ($cu.input_tokens -ge 0) { [int64]$cu.input_tokens } else { 0 }) +
      (if ($cu.cache_read_input_tokens -ge 0) { [int64]$cu.cache_read_input_tokens } else { 0 }) +
      (if ($cu.cache_creation_input_tokens -ge 0) { [int64]$cu.cache_creation_input_tokens } else { 0 })
    } else { $null }
    $ctxObj = @{ tokens = $ctxTok; window = if ($cwSize -gt 0) { $cwSize } else { $null }; pct = if ($cw -and $null -ne $cw.used_percentage) { [double]$cw.used_percentage } else { $null } }
    Save-Json $stPath @{ seq = $seq; total_input = $totalIn; total_output = $totalOut; cost_usd = $costTotal; subagent_usd = $costSub; last_cu_sig = $lastCuSig; last_call_ms = $lastCallMs; last_context = $ctxObj }
  }

  $q = Load-Json $queuePath
  $recs = @($q.records | Where-Object { $null -ne $_ })
  if ($newRecord) { $recs += $newRecord }
  if ($recs.Count -gt 500) { $recs = $recs[($recs.Count - 500)..($recs.Count - 1)] }
  $qLims = if ($newLimits) { $newLimits } elseif ($q.limits) { @($q.limits) } else { $null }
  $lastFlush = if ($q.last_flush_ms) { [int64]$q.last_flush_ms } else { 0 }
  $hasWork = ($recs.Count -gt 0) -or ($qLims -and $qLims.Count -gt 0)
  if ($hasWork -and $lastFlush -eq 0) { $lastFlush = $nowMs }
  Save-Json $queuePath @{ records = $recs; limits = $qLims; last_flush_ms = $lastFlush }

  $elapsed = if ($lastFlush -gt 0) { $nowMs - $lastFlush } else { 0 }
  $shouldFlush = $hasWork -and ($Sync -or $Flush -or $agentState -eq 'idle' -or ($qLims -and $agentState -ne 'working' -and $recs.Count -eq 0) -or $recs.Count -ge 10 -or $elapsed -ge [int64]($flushSec * 1000))
  if (-not $shouldFlush) { exit 0 }

  if ($Sync) { Deliver-Queue }
  else { Start-Process -WindowStyle Hidden -FilePath 'powershell' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Deliver') | Out-Null }
} catch {}
exit 0
