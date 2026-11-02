# Token Tracker plugin for Codex on Windows: the session's activity as numbers, to POST /v1/activity (provider codex). Same as activity.py:
# one script for SessionStart (the start, and the repository when the device allows it: owner/name or 'h:' and 12 hex characters of the
# SHA-256 of the origin remote, found from the session's cwd, which is never sent nor kept), UserPromptSubmit (a turn starts), Stop and
# Interrupt (the turn ends: wall-clock time and context fill from the last token_count line of the session's file) and SessionEnd.
# Of the hook's input only hook_event_name, session_id, turn_id, transcript_path, cwd and reason are read: never the prompt, nor the last
# answer. The times between hooks live in the plugin's data folder (activity\<session>.json). Nothing is printed; a hook never fails Codex.
$ErrorActionPreference = 'Stop'
$home_ = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$data = if ($env:PLUGIN_DATA) { $env:PLUGIN_DATA } else { Join-Path $home_ 'token-tracker' }
$stateDir = Join-Path $data 'activity'
$idRe = '^[\w-]{1,80}$'

function Now { (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
function Ms($a, $b) { try { [long][math]::Max(0, ([DateTimeOffset]::Parse($b) - [DateTimeOffset]::Parse($a)).TotalMilliseconds) } catch { $null } }

function Find-GitDir($cwd) {
  $d = [IO.Path]::GetFullPath($cwd)
  while ($d) {
    $g = Join-Path $d '.git'
    if (Test-Path -LiteralPath $g -PathType Container) { return @($g, $d) }
    if (Test-Path -LiteralPath $g -PathType Leaf) { # a worktree or a submodule: "gitdir: <path>"
      $m = [regex]::Match((Get-Content -Raw -LiteralPath $g).Trim(), '^gitdir:\s*(.+)$')
      if ($m.Success) {
        $gd = [IO.Path]::GetFullPath((Join-Path $d $m.Groups[1].Value.Trim()))
        $common = Join-Path $gd 'commondir'
        if (Test-Path -LiteralPath $common -PathType Leaf) { $gd = [IO.Path]::GetFullPath((Join-Path $gd (Get-Content -Raw -LiteralPath $common).Trim())) }
        return @($gd, $d)
      }
    }
    $up = Split-Path -Parent $d
    if (-not $up -or $up -eq $d) { break }
    $d = $up
  }
  return $null
}

function Get-Origin($gd) {
  $cfg = Join-Path $gd 'config'
  if (-not (Test-Path -LiteralPath $cfg -PathType Leaf)) { return $null }
  $remotes = [ordered]@{}; $current = $null
  foreach ($line in Get-Content -LiteralPath $cfg) {
    $l = $line.Trim()
    $m = [regex]::Match($l, '^\[remote\s+"([^"]+)"\]')
    if ($m.Success) { $current = $m.Groups[1].Value; continue }
    if ($l.StartsWith('[')) { $current = $null; continue }
    if ($current) { $u = [regex]::Match($l, '^url\s*=\s*(.+)$'); if ($u.Success -and -not $remotes.Contains($current)) { $remotes[$current] = $u.Groups[1].Value.Trim() } }
  }
  if ($remotes.Contains('origin')) { return $remotes['origin'] }
  foreach ($v in $remotes.Values) { return $v }
  return $null
}

function Get-Project($cwd, $mode) {
  if ($mode -ne 'name' -and $mode -ne 'hash') { return @($null, $(if ($mode -eq 'off') { 'off' } else { 'config_failed' })) }
  if (-not $cwd) { return @($null, 'no_repo') }
  try { $found = Find-GitDir $cwd } catch { return @($null, 'repo_failed') }
  if (-not $found) { return @($null, 'no_repo') }
  $remote = Get-Origin $found[0]
  $m = [regex]::Match("$remote", '[:/]([\w.-]+)/([\w.-]+?)(?:\.git)?/?$')
  if ($mode -eq 'name' -and $m.Success) { return @("$($m.Groups[1].Value)/$($m.Groups[2].Value)", $null) }
  $src = if ($remote) { $remote } else { $found[1] }
  $sha = [Security.Cryptography.SHA256]::Create()
  $hex = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($src)) | ForEach-Object { $_.ToString('x2') })
  return @("h:$($hex.Substring(0, 12))", $null)
}

function Get-Context($path) {
  if (-not $path -or -not (Test-Path -LiteralPath "$path" -PathType Leaf)) { return @($null, $null) }
  # Codex keeps the file open for writing: a FileStream that shares writing; only the end of the file is read
  $fs = New-Object IO.FileStream("$path", [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  try {
    $fs.Seek([math]::Max(0, $fs.Length - 1000000), [IO.SeekOrigin]::Begin) | Out-Null
    $text = (New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8)).ReadToEnd()
  } finally { $fs.Dispose() }
  $lines = $text -split "`n"
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    if ($lines[$i] -notmatch '"token_count"') { continue }
    try { $p = ($lines[$i] | ConvertFrom-Json).payload } catch { continue }
    if ($p.type -ne 'token_count' -or -not $p.info) { continue }
    $used = $p.info.last_token_usage.input_tokens; $window = $p.info.model_context_window
    return @($(if ($used -is [ValueType] -and $used -ge 0) { [long]$used } else { $null }), $(if ($window -is [ValueType] -and $window -gt 0) { [long]$window } else { $null }))
  }
  return @($null, $null)
}

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  if (-not [Console]::IsInputRedirected) { exit 0 }
  $hook = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $event = "$($hook.hook_event_name)"; $session = "$($hook.session_id)"
  if ($session -notmatch $idRe) { exit 0 }
  $config = Get-Content -Raw (Join-Path $home_ 'config.toml')
  $site = [regex]::Match($config, 'endpoint = "(https?://[^"]+?)/v1/logs"')
  $token = [regex]::Match($config, '"x-device-token" = "([0-9a-f]{16,128})"')
  if (-not $site.Success -or -not $token.Success) { exit 0 }
  $siteUrl = $site.Groups[1].Value; $headers = @{ 'x-device-token' = $token.Groups[1].Value }
  function Post($body) {
    $json = $body | ConvertTo-Json -Depth 5 -Compress
    Invoke-RestMethod -Method Post -Uri ($siteUrl + '/v1/activity') -ContentType 'application/json' -Headers $headers -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 5 | Out-Null
  }

  $file = Join-Path $stateDir "$session.json"
  $state = @{}
  if (Test-Path -LiteralPath $file) { try { (Get-Content -Raw -LiteralPath $file | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $state[$_.Name] = $_.Value } } catch { } }
  function Save { New-Item -ItemType Directory -Force $stateDir | Out-Null; $state | ConvertTo-Json -Depth 4 -Compress | Set-Content -Encoding utf8 -LiteralPath $file }
  $at = Now
  function SessionBody($extra) {
    $b = [ordered]@{ id = $session; started_at = $(if ($state.started_at) { "$($state.started_at)" } else { $at }); project = $state.project; project_note = $state.project_note }
    if ($extra) { foreach ($k in $extra.Keys) { $b[$k] = $extra[$k] } }
    $b
  }

  if ($event -eq 'SessionStart') {
    # forget the times of sessions that never ended (no SessionEnd) after a week
    if (Test-Path $stateDir) { Get-ChildItem $stateDir -File -Filter '*.json' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } | Remove-Item -Force -ErrorAction SilentlyContinue }
    if (-not $state.started_at) { $state.started_at = $at } # a resumed session keeps its start
    if (-not $state.ContainsKey('project') -and -not $state.ContainsKey('project_note')) {
      $mode = try { "$((Invoke-RestMethod -Uri ($siteUrl + '/v1/config') -Headers $headers -TimeoutSec 5).project)" } catch { 'config_failed' }
      $p = Get-Project "$($hook.cwd)" $mode
      $state.project = $p[0]; $state.project_note = $p[1]
    }
    Save
    Post @{ provider = 'codex'; session = (SessionBody $null) }
    $state.sent = $true; Save
  }
  elseif ($event -eq 'UserPromptSubmit') {
    $turnId = "$($hook.turn_id)"
    if ($turnId -notmatch $idRe) { $turnId = "$($session.Substring(0, [math]::Min(36, $session.Length)))-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())" }
    $state.turn = @{ id = $turnId; start = $at; think_ms = $(if ($state.last_end) { Ms "$($state.last_end)" $at } else { $null }) }
    if (-not $state.started_at) { $state.started_at = $at }
    Save
  }
  elseif ($event -eq 'Stop' -or $event -eq 'Interrupt') {
    $turn = $state.turn
    if (-not $turn -or -not $turn.start) { exit 0 }
    $state.Remove('turn')
    $ctx = Get-Context "$($hook.transcript_path)"
    $start = "$($turn.start)"
    $row = [ordered]@{ id = "$($turn.id)"; session = $session; ts = $start; wall_ms = $(if ($w = Ms $start $at) { $w } else { 0 }); think_ms = $turn.think_ms
      outcome = $(if ($event -eq 'Stop') { 'answer' } else { 'aborted' }); context_tokens = $ctx[0]; context_window = $ctx[1]
      context_pct = $(if ($null -ne $ctx[0] -and $ctx[1]) { [math]::Round(100 * $ctx[0] / $ctx[1], 1) } else { $null }) }
    $state.last_end = $at; Save
    $body = @{ provider = 'codex'; turns = @($row) }
    if (-not $state.sent) { $body.session = (SessionBody $null) } # a session that began before the plugin did
    Post $body
    $state.sent = $true; Save
  }
  elseif ($event -eq 'SessionEnd') {
    $reason = if ("$($hook.reason)" -match '^[a-z_]{1,30}$') { "$($hook.reason)" } else { 'other' }
    Post @{ provider = 'codex'; session = (SessionBody @{ ended_at = $at; end_reason = $reason }) }
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  }
} catch {
  try {
    New-Item -ItemType Directory -Force $data | Out-Null
    "$(Now) activity: $($_.Exception.GetType().Name)" | Set-Content -Encoding utf8 (Join-Path $data 'last-error.txt')
  } catch { }
}
exit 0
