# Token Tracker activity hook for Antigravity CLI on Windows (PowerShell): SessionStart, PreInvocation, Stop.
# Reads only conversationId and workspacePaths (locally, for git origin remote only) from stdin; never lastUserInput or transcriptPath.
param([string]$EventName = '')
$ErrorActionPreference = 'Stop'

$cliDir = if ($env:ANTIGRAVITY_CLI_DIR) { $env:ANTIGRAVITY_CLI_DIR } else { Join-Path $HOME '.gemini\antigravity-cli' }
$data = if ($env:ANTIGRAVITY_TRACKER_DIR) { $env:ANTIGRAVITY_TRACKER_DIR } else { Join-Path $cliDir 'token-tracker' }
$actDir = Join-Path $data 'activity'
$stateDir = Join-Path $data 'state'

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
  [System.IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Depth 8 -Compress), (New-Object System.Text.UTF8Encoding $false))
  Move-Item -Force $tmp $p
}

function Call-Api($site, $tok, $path, $body) {
  $headers = @{ 'x-device-token' = $tok; 'user-agent' = 'modToken-antigravity/1.0' }
  if ($null -eq $body) { return Invoke-RestMethod -Uri ($site + $path) -Method Get -Headers $headers -TimeoutSec 5 }
  $json = $body | ConvertTo-Json -Depth 8 -Compress
  return Invoke-RestMethod -Uri ($site + $path) -Method Post -ContentType 'application/json' -Headers $headers -Body $json -TimeoutSec 5
}

function Get-Project($paths, $mode) {
  if ($mode -ne 'name' -and $mode -ne 'hash') { return @($null, $(if ($mode -eq 'off') { 'off' } else { 'config_failed' })) }
  $cwd = if ($paths -and @($paths).Count -gt 0) { [string]@($paths)[0] } else { '' }
  if (-not $cwd) { return @($null, 'no_repo') }
  $d = [System.IO.Path]::GetFullPath($cwd)
  $gd = $null; $root = $null
  while ($d) {
    $g = Join-Path $d '.git'
    if (Test-Path -PathType Container $g) { $gd = $g; $root = $d; break }
    if (Test-Path -PathType Leaf $g) {
      $line = (Get-Content -Raw $g).Trim()
      if ($line -match '^gitdir:\s*(.+)$') {
        $gd = [System.IO.Path]::GetFullPath((Join-Path $d $Matches[1].Trim()))
        $common = Join-Path $gd 'commondir'
        if (Test-Path -PathType Leaf $common) { $gd = [System.IO.Path]::GetFullPath((Join-Path $gd (Get-Content -Raw $common).Trim())) }
        $root = $d; break
      }
    }
    $up = Split-Path $d
    if ($up -eq $d) { break }
    $d = $up
  }
  if (-not $gd) { return @($null, 'no_repo') }
  $remote = $null
  $cfgFile = Join-Path $gd 'config'
  if (Test-Path $cfgFile) {
    $cur = $null; $remotes = @{}
    foreach ($l in (Get-Content $cfgFile)) {
      $t = $l.Trim()
      if ($t -match '^\[remote\s+"([^"]+)"\]$') { $cur = $Matches[1] }
      elseif ($t.StartsWith('[')) { $cur = $null }
      elseif ($cur -and $t -match '^url\s*=\s*(.+)$' -and -not $remotes.ContainsKey($cur)) { $remotes[$cur] = $Matches[1].Trim() }
    }
    if ($remotes.ContainsKey('origin')) { $remote = $remotes['origin'] } elseif ($remotes.Count -gt 0) { $remote = ($remotes.Values | Select-Object -First 1) }
  }
  if ($mode -eq 'name' -and $remote -and $remote -match '[:/]([\w.-]+)/([\w.-]+?)(?:\.git)?/?$') { return @("$($Matches[1])/$($Matches[2])", $null) }
  $src = if ($remote) { $remote } else { $root }
  $bytes = [System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($src))
  $hex = ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant().Substring(0, 12)
  return @("h:$hex", $null)
}

try {
  if ($EventName -notin @('SessionStart', 'PreInvocation', 'Stop')) { Write-Output '{}'; exit 0 }
  $raw = [Console]::In.ReadToEnd()
  $hook = if ($raw.Trim()) { $raw | ConvertFrom-Json } else { @{} }
  $sid = if ($hook.conversationId) { [string]$hook.conversationId } elseif ($hook.sessionId) { [string]$hook.sessionId } else { '' }
  if (-not ($sid -match '^[\w-]{1,80}$')) { Write-Output '{}'; exit 0 }
  $cfg = Load-Json (Join-Path $data 'config.json')
  $site = if ($cfg.site) { ([string]$cfg.site).TrimEnd('/') } else { '' }
  $tok = if ($cfg.token) { [string]$cfg.token } else { '' }
  if (-not ($site -match '^https?://') -or -not $tok) { Write-Output '{}'; exit 0 }

  $stPath = Join-Path $actDir "$sid.json"
  $st = Load-Json $stPath
  $at = [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  $started = if ($st.started_at) { [string]$st.started_at } else { $at }

  if ($EventName -eq 'SessionStart') {
    $proj = $st.project; $note = $st.project_note
    if ($null -eq $proj -and $null -eq $note) {
      $mode = try { [string](Call-Api $site $tok '/v1/config' $null).project } catch { 'config_failed' }
      $proj, $note = Get-Project $hook.workspacePaths $mode
    }
    $stateOut = @{ started_at = $started; project = $proj; project_note = $note; sent = $true; turn_seq = if ($st.turn_seq) { [int]$st.turn_seq } else { 0 }; last_end = $st.last_end }
    Save-Json $stPath $stateOut
    Call-Api $site $tok '/v1/activity' @{ provider = 'antigravity'; session = @{ id = $sid; started_at = $started; project = $proj; project_note = $note } } | Out-Null
  } elseif ($EventName -eq 'PreInvocation') {
    if (-not $st.turn) {
      $seq = (if ($st.turn_seq) { [int]$st.turn_seq } else { 0 }) + 1
      $think = if ($st.last_end) { [Math]::Max(0, [int64]([DateTimeOffset]::Parse($at) - [DateTimeOffset]::Parse([string]$st.last_end)).TotalMilliseconds) } else { $null }
      $turn = @{ id = "$($sid.Substring(0, [Math]::Min(36, $sid.Length)))-t$seq-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"; start = $at; think_ms = $think }
      Save-Json $stPath @{ started_at = $started; project = $st.project; project_note = $st.project_note; sent = [bool]$st.sent; turn_seq = $seq; turn = $turn; last_end = $st.last_end }
    }
  } elseif ($EventName -eq 'Stop') {
    if ($st.turn -and $st.turn.start) {
      $sl = Load-Json (Join-Path $stateDir "$sid.json")
      $ctx = $sl.last_context
      $wall = [Math]::Max(0, [int64]([DateTimeOffset]::Parse($at) - [DateTimeOffset]::Parse([string]$st.turn.start)).TotalMilliseconds)
      $row = @{ id = [string]$st.turn.id; session = $sid; ts = [string]$st.turn.start; wall_ms = $wall; think_ms = $st.turn.think_ms; outcome = 'answer'; context_tokens = if ($ctx) { $ctx.tokens } else { $null }; context_window = if ($ctx) { $ctx.window } else { $null }; context_pct = if ($ctx) { $ctx.pct } else { $null } }
      $body = @{ provider = 'antigravity'; turns = @($row) }
      if (-not $st.sent) { $body.session = @{ id = $sid; started_at = $started; project = $st.project; project_note = $st.project_note } }
      Save-Json $stPath @{ started_at = $started; project = $st.project; project_note = $st.project_note; sent = $true; turn_seq = if ($st.turn_seq) { [int]$st.turn_seq } else { 0 }; last_end = $at }
      Call-Api $site $tok '/v1/activity' $body | Out-Null
    }
  }
} catch {}
Write-Output '{}'
exit 0
