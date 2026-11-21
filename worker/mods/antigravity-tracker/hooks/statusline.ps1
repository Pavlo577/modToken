# Token Tracker statusLine bridge for Antigravity CLI on Windows (PowerShell).
# Same contract as statusline.py: reads only numeric token/cost/quota fields from stdin JSON, sends OTLP deltas to POST /v1/logs
# and quota snapshots to POST /v1/limits (provider "antigravity"), and saves context fill locally for activity.ps1.
param([switch]$Sync, [string]$Deliver)
$ErrorActionPreference = 'Stop'

$cliDir = if ($env:ANTIGRAVITY_CLI_DIR) { $env:ANTIGRAVITY_CLI_DIR } else { Join-Path $HOME '.gemini\antigravity-cli' }
$data = if ($env:ANTIGRAVITY_TRACKER_DIR) { $env:ANTIGRAVITY_TRACKER_DIR } else { Join-Path $cliDir 'token-tracker' }
$stateDir = Join-Path $data 'state'
$actDir = Join-Path $data 'activity'

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
  $tmp = "$p.tmp.$PID"
  [System.IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Depth 10 -Compress), (New-Object System.Text.UTF8Encoding $false))
  Move-Item -Force $tmp $p
}

function Load-Config {
  $cfg = Load-Json (Join-Path $data 'config.json')
  $site = if ($cfg.site) { ([string]$cfg.site).TrimEnd('/') } else { '' }
  $tok = if ($cfg.token) { [string]$cfg.token } else { '' }
  $chain = if ($cfg.chain_command) { [string]$cfg.chain_command } else { '' }
  if (-not ($site -match '^https?://') -or -not $tok) { return @($null, $null, $chain) }
  return @($site, $tok, $chain)
}

function Post-Json($site, $tok, $path, $body) {
  $json = $body | ConvertTo-Json -Depth 12 -Compress
  Invoke-RestMethod -Uri ($site + $path) -Method Post -ContentType 'application/json' -Headers @{ 'x-device-token' = $tok; 'user-agent' = 'modToken-antigravity/1.0' } -Body $json -TimeoutSec 5 | Out-Null
}

function Plugin-Version {
  try {
    $m = Load-Json (Join-Path (Split-Path $PSScriptRoot) 'plugin.json')
    if ($m.version) { return [string]$m.version }
  } catch {}
  return ''
}

function Deliver-Job($jobPath) {
  $job = Load-Json $jobPath
  Remove-Item -Force -ErrorAction SilentlyContinue $jobPath
  $site, $tok, $_ = Load-Config
  if (-not $site) { return }
  if ($job.otlp) {
    try { Post-Json $site $tok '/v1/logs' $job.otlp } catch {}
  }
  if ($job.limits) {
    try {
      Post-Json $site $tok '/v1/limits' @{ provider = 'antigravity'; limits = @($job.limits) }
      $beat = Join-Path $data 'limits-reported'
      if (-not (Test-Path $beat) -or ((Get-Date) - (Get-Item $beat).LastWriteTime).TotalSeconds -gt 3600) {
        New-Item -ItemType Directory -Force $data | Out-Null
        Set-Content -Path $beat -Value ''
        try { Post-Json $site $tok '/v1/plugin-log' @{ provider = 'antigravity'; version = (Plugin-Version); events = @(@{ kind = 'limits'; n = @($job.limits).Count }) } } catch {}
      }
    } catch {}
  }
}

try {
  if ($Deliver) { Deliver-Job $Deliver; exit 0 }
  $raw = [Console]::In.ReadToEnd()
  $site, $tok, $chain = Load-Config
  if (-not $site -or -not $raw.Trim()) { exit 0 }
  $p = $raw | ConvertFrom-Json
  $now = [DateTimeOffset]::UtcNow
  $job = @{}

  if ($p.quota) {
    $byKind = @{}
    foreach ($prop in $p.quota.PSObject.Properties) {
      $info = $prop.Value
      if ($null -eq $info -or $info.disabled -eq $true -or $null -eq $info.remaining_fraction) { continue }
      $pct = [Math]::Round([Math]::Max(0.0, [Math]::Min(100.0, (1.0 - [double]$info.remaining_fraction) * 100.0)), 2)
      $low = $prop.Name.ToLowerInvariant()
      $rs = if ($null -ne $info.reset_in_seconds) { [double]$info.reset_in_seconds } else { -1 }
      $kind = if ($low -match 'week|7d|seven' -or $rs -gt 86400) { 'seven_day' } elseif ($low -match '5h|five|hour|session' -or ($rs -gt 0 -and $rs -le 21600)) { 'five_hour' } else { ($low -replace '[^a-z]+', '_').Trim('_') }
      if (-not $kind) { $kind = 'quota' }
      if (-not $byKind.ContainsKey($kind) -or $pct -gt $byKind[$kind].percentUsed) {
        $entry = @{ kind = $kind; percentUsed = $pct }
        if ($info.reset_time) { $entry.resetsAt = [string]$info.reset_time }
        elseif ($rs -ge 0) { $entry.resetsAt = $now.AddSeconds($rs).ToString('yyyy-MM-ddTHH:mm:00Z') }
        $byKind[$kind] = $entry
      }
    }
    if ($byKind.Count -gt 0) {
      $limits = @($byKind.Keys | Sort-Object | ForEach-Object { $byKind[$_] })
      $qPath = Join-Path $stateDir 'quota.json'
      $qState = Load-Json $qPath
      $sig = (@($limits | ForEach-Object { "$($_.kind)|$($_.percentUsed)|$(if ($_.resetsAt) { ([string]$_.resetsAt).Substring(0, [Math]::Min(16, ([string]$_.resetsAt).Length)) } else { '' })" }) -join ';')
      if ($qState.sig -ne $sig) {
        Save-Json $qPath @{ sig = $sig; ts = $now.ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
        $job.limits = $limits
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
      $nowMs = $now.ToUnixTimeMilliseconds()
      $dur = if ($lastCallMs -gt 0 -and ($nowMs - $lastCallMs) -gt 0 -and ($nowMs - $lastCallMs) -le 600000) { $nowMs - $lastCallMs } else { 0 }
      $modelId = if ($p.model -and $p.model.id) { [string]$p.model.id } elseif ($p.model -and $p.model.display_name) { [string]$p.model.display_name } else { 'unknown' }
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
      $job.otlp = @{ resourceLogs = @(@{ resource = @{ attributes = @(@{ key = 'service.name'; value = @{ stringValue = 'antigravity-cli' } }) }; scopeLogs = @(@{ logRecords = @(@{ timeUnixNano = $ns; attributes = $attrs }) }) }) }
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

  if ($job.Count -gt 0) {
    New-Item -ItemType Directory -Force $stateDir | Out-Null
    $jobPath = Join-Path $stateDir ".job-$PID-$([Guid]::NewGuid().ToString('N').Substring(0,8)).json"
    Save-Json $jobPath $job
    if ($Sync) { Deliver-Job $jobPath }
    else { Start-Process -WindowStyle Hidden -FilePath 'powershell' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Deliver', $jobPath) | Out-Null }
  }
} catch {}
exit 0
