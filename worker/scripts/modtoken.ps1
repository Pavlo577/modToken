# Token Tracker CLI (modtoken) for Windows (PowerShell 5.1 / 7+):
# Interactive and command-line manager that auto-detects installed AI agents (Claude Code, Codex, Antigravity),
# reuses any existing device token already configured on the computer, installs or updates all plugins/hooks/OTLP
# settings in one step, and runs diagnostics (doctor).
#
# One-liner launch / install from PowerShell:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/Pavlo577/modToken/main/worker/scripts/modtoken.ps1)))
# After first run, type `modtoken`, `modtoken update`, `modtoken doctor`, or `modtoken status` in PowerShell or cmd.
param(
  [Parameter(Position = 0)][string]$Command = 'menu',
  [Parameter(Position = 1)][string]$Arg1 = '',
  [Parameter(Position = 2)][string]$Arg2 = '',
  [Parameter(Position = 3)][string]$Arg3 = ''
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
function U([string]$s) { [regex]::Replace($s, '\\u(00[a-f0-9]{2}|04[a-f0-9]{2}|2[0-7][a-f0-9]{2})', { param($m) [char][int]("0x" + $m.Groups[1].Value) }) }
function Write-Host([object]$Object = '') { Microsoft.PowerShell.Utility\Write-Host (U "$Object") }
function Read-Host([string]$Prompt = '') { Microsoft.PowerShell.Utility\Read-Host (U $Prompt) }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$utf8NoBom = New-Object System.Text.UTF8Encoding $false

$raw = if ($env:TT_RAW) { $env:TT_RAW } else { 'https://raw.githubusercontent.com/Pavlo577/modToken/main/worker' }
$mtDir = if ($env:MODTOKEN_HOME) { $env:MODTOKEN_HOME } else { Join-Path $HOME '.modtoken' }
$mtCfg = Join-Path $mtDir 'config.json'
$psPath = Join-Path $mtDir 'modtoken.ps1'
$cmdPath = Join-Path $mtDir 'modtoken.cmd'

$claudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$codexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$agyCliDir = if ($env:ANTIGRAVITY_CLI_DIR) { $env:ANTIGRAVITY_CLI_DIR } else { Join-Path $HOME '.gemini\antigravity-cli' }
$agyCfgDir = if ($env:GEMINI_CONFIG_DIR) { $env:GEMINI_CONFIG_DIR } else { Join-Path $HOME '.gemini\config' }
$agyDataDir = if ($env:ANTIGRAVITY_TRACKER_DIR) { $env:ANTIGRAVITY_TRACKER_DIR } else { Join-Path $agyCliDir 'token-tracker' }

$script:site = ''
$script:token = ''
$script:tokenSource = ''

function Mask-Token([string]$t) {
  if (-not $t) { return '\u043d\u0435 \u0437\u0430\u0434\u0430\u043d\u043e' }
  if ($t.Length -ge 12) { return "$($t.Substring(0, 4))\u2026$($t.Substring($t.Length - 4))" }
  return '***'
}

function Read-JsonProp([string]$file, [scriptblock]$extract) {
  if (-not (Test-Path -LiteralPath $file)) { return '' }
  try {
    $obj = Get-Content -Raw -Encoding UTF8 -LiteralPath $file | ConvertFrom-Json
    $v = & $extract $obj
    if ($v) { return "$v".Trim() }
  } catch {}
  return ''
}

function Save-Credentials([string]$s, [string]$t) {
  $s = $s.Trim().TrimEnd('/')
  $t = $t.Trim()
  if (-not $s -or -not $t) { return }
  New-Item -ItemType Directory -Force $mtDir | Out-Null
  $json = @{ site = $s; token = $t } | ConvertTo-Json
  [System.IO.File]::WriteAllText($mtCfg, $json, $utf8NoBom)
  $script:site = $s
  $script:token = $t
}

function Discover-Credentials {
  if (Test-Path -LiteralPath $mtCfg) {
    $s = Read-JsonProp $mtCfg { param($d) $d.site }
    $t = Read-JsonProp $mtCfg { param($d) $d.token }
    if ($s -and $t) { $script:site = $s.TrimEnd('/'); $script:token = $t; $script:tokenSource = $mtCfg; return $true }
  }
  $cSet = Join-Path $claudeDir 'settings.json'
  if (Test-Path -LiteralPath $cSet) {
    $ep = Read-JsonProp $cSet { param($d) $d.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT }
    $hdr = Read-JsonProp $cSet { param($d) $d.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS }
    $m = [regex]::Match("$hdr", 'x-device-token=([0-9a-fA-F_-]{6,128})')
    if ($ep -and $m.Success) {
      $s = ($ep -replace '/v1/logs$', '').TrimEnd('/')
      $t = $m.Groups[1].Value
      $script:tokenSource = "Claude ($cSet)"
      Save-Credentials $s $t
      return $true
    }
  }
  $xCfg = Join-Path $codexDir 'config.toml'
  if (Test-Path -LiteralPath $xCfg) {
    try {
      $txt = Get-Content -Raw -Encoding UTF8 -LiteralPath $xCfg
      $ms = [regex]::Match($txt, 'endpoint = "(https?://[^"]+?)/v1/logs"')
      $mt = [regex]::Match($txt, '"x-device-token" = "([^"]+)"')
      if ($ms.Success -and $mt.Success) {
        $script:tokenSource = "Codex ($xCfg)"
        Save-Credentials $ms.Groups[1].Value $mt.Groups[1].Value
        return $true
      }
    } catch {}
  }
  $aCfg = Join-Path $agyDataDir 'config.json'
  if (Test-Path -LiteralPath $aCfg) {
    $s = Read-JsonProp $aCfg { param($d) $d.site }
    $t = Read-JsonProp $aCfg { param($d) $d.token }
    if ($s -and $t) {
      $script:tokenSource = "Antigravity ($aCfg)"
      Save-Credentials $s $t
      return $true
    }
  }
  return $false
}

function Ensure-CliInstalled {
  New-Item -ItemType Directory -Force $mtDir | Out-Null
  try {
    if ($PSCommandPath -and (Test-Path -LiteralPath $PSCommandPath) -and ($PSCommandPath -ne $psPath)) {
      Copy-Item -LiteralPath $PSCommandPath -Destination $psPath -Force
    } elseif (-not $PSCommandPath -or -not (Test-Path -LiteralPath $psPath)) {
      Invoke-RestMethod "$raw/scripts/modtoken.ps1" -OutFile $psPath
    }
    $cmdBody = "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$psPath`" %*`r`n"
    [System.IO.File]::WriteAllText($cmdPath, $cmdBody, $utf8NoBom)
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $userPath) { $userPath = '' }
    $parts = @($userPath -split ';' | Where-Object { $_ })
    if ($parts -notcontains $mtDir) {
      [Environment]::SetEnvironmentVariable('Path', (($parts + $mtDir) -join ';'), 'User')
    }
    if (($env:PATH -split ';') -notcontains $mtDir) { $env:PATH = "$mtDir;$env:PATH" }
  } catch {}
}

function Test-ClaudeDetected { (Test-Path $claudeDir) -or [bool](Get-Command claude -ErrorAction SilentlyContinue) }
function Test-CodexDetected  { (Test-Path $codexDir)  -or [bool](Get-Command codex  -ErrorAction SilentlyContinue) }
function Test-AgyDetected    { (Test-Path $agyCliDir) -or (Test-Path $agyCfgDir) -or [bool](Get-Command agy -ErrorAction SilentlyContinue) }

function Test-ClaudeConfigured {
  $f = Join-Path $claudeDir 'settings.json'
  (Test-Path $f) -and ((Get-Content -Raw -Encoding UTF8 $f) -match 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT')
}
function Test-CodexConfigured {
  $f = Join-Path $codexDir 'config.toml'
  (Test-Path $f) -and ((Get-Content -Raw -Encoding UTF8 $f) -match 'x-device-token')
}
function Test-AgyConfigured {
  $f1 = Join-Path $agyDataDir 'config.json'; $f2 = Join-Path $agyCliDir 'settings.json'
  (Test-Path $f1) -and (Test-Path $f2) -and ((Get-Content -Raw -Encoding UTF8 $f2) -match 'statusline')
}

function Get-ClaudeVersion { Read-JsonProp (Join-Path $claudeDir 'mods\token-tracker\.claude-plugin\plugin.json') { param($d) $d.version } }
function Get-CodexVersion  { Read-JsonProp (Join-Path $codexDir 'token-tracker\plugins\token-tracker\.codex-plugin\plugin.json') { param($d) $d.version } }
function Get-AgyVersion    { Read-JsonProp (Join-Path $agyCfgDir 'plugins\token-tracker\plugin.json') { param($d) $d.version } }

function Get-RemoteVersion([string]$rel) {
  try {
    $r = Invoke-RestMethod "$raw/$rel" -TimeoutSec 8
    if ($r -and $r.version) { return "$($r.version)" }
  } catch {}
  return ''
}

function Show-Status {
  Discover-Credentials | Out-Null
  $hostName = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { 'windows-pc' }
  $cCred = Get-AgentOwnCredentials 'claude'
  $xCred = Get-AgentOwnCredentials 'codex'
  $aCred = Get-AgentOwnCredentials 'antigravity'
  Write-Host '\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557'
  Write-Host '\u2551  Token Tracker CLI (modtoken) \u00b7 \u0423\u043f\u0440\u0430\u0432\u043b\u0456\u043d\u043d\u044f \u0430\u0433\u0435\u043d\u0442\u0430\u043c\u0438 \u0442\u0430 OTLP    \u2551'
  Write-Host '\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d'
  Write-Host "  \u041a\u043e\u043c\u043f'\u044e\u0442\u0435\u0440: $hostName"
  Write-Host "  \u0421\u0435\u0440\u0432\u0435\u0440:    $(if ($script:site) { $script:site } else { '\u043d\u0435 \u043d\u0430\u043b\u0430\u0448\u0442\u043e\u0432\u0430\u043d\u043e' })"
  Write-Host "  \u0422\u043e\u043a\u0435\u043d \u041f\u041a:  $(Mask-Token $script:token)$(if ($script:tokenSource) { " (\u0437\u043d\u0430\u0439\u0434\u0435\u043d\u043e \u0432: $($script:tokenSource))" } else { '' })"
  Write-Host ''
  Write-Host '  \u0421\u0442\u0430\u043d \u0430\u0433\u0435\u043d\u0442\u0456\u0432 \u043d\u0430 \u0446\u044c\u043e\u043c\u0443 \u041f\u041a:'

  $cv = Get-ClaudeVersion; $xv = Get-CodexVersion; $av = Get-AgyVersion
  if (Test-ClaudeConfigured) { Write-Host "    [\u2713] Claude Code   OTLP: \u0443\u0432\u0456\u043c\u043a\u043d\u0435\u043d\u043e \u00b7 \u041c\u043e\u0434: v$(if ($cv) { $cv } else { '?' }) \u00b7 \u0442\u043e\u043a\u0435\u043d: $(Mask-Token $cCred[1])" }
  elseif (Test-ClaudeDetected) { Write-Host '    [\u2022] Claude Code   \u0432\u0438\u044f\u0432\u043b\u0435\u043d\u043e \u043d\u0430 \u041f\u041a, \u0449\u0435 \u043d\u0435 \u043f\u0456\u0434\u043a\u043b\u044e\u0447\u0435\u043d\u043e \u0434\u043e Token Tracker' }
  else { Write-Host '    [ ] Claude Code   \u043d\u0435 \u0432\u0438\u044f\u0432\u043b\u0435\u043d\u043e' }

  if (Test-CodexConfigured) {
    $hf = Join-Path $codexDir 'hooks.json'
    $hs = if ((Test-Path $hf) -and ((Get-Content -Raw -Encoding UTF8 $hf) -match 'token-tracker')) { 'hooks.json \u0430\u043a\u0442\u0438\u0432\u043d\u0438\u0439' } else { '\u043d\u0435\u043c\u0430\u0454 hooks.json' }
    Write-Host "    [\u2713] Codex         OTLP: \u0443\u0432\u0456\u043c\u043a\u043d\u0435\u043d\u043e \u00b7 \u0425\u0443\u043a\u0438: v$(if ($xv) { $xv } else { '?' }) ($hs) \u00b7 \u0442\u043e\u043a\u0435\u043d: $(Mask-Token $xCred[1])"
  } elseif (Test-CodexDetected) { Write-Host '    [\u2022] Codex         \u0432\u0438\u044f\u0432\u043b\u0435\u043d\u043e \u043d\u0430 \u041f\u041a, \u0449\u0435 \u043d\u0435 \u043f\u0456\u0434\u043a\u043b\u044e\u0447\u0435\u043d\u043e \u0434\u043e Token Tracker' }
  else { Write-Host '    [ ] Codex         \u043d\u0435 \u0432\u0438\u044f\u0432\u043b\u0435\u043d\u043e' }

  if (Test-AgyConfigured) { Write-Host "    [\u2713] Antigravity   statusLine: \u0443\u0432\u0456\u043c\u043a\u043d\u0435\u043d\u043e \u00b7 \u041f\u043b\u0430\u0433\u0456\u043d: v$(if ($av) { $av } else { '?' }) \u00b7 \u0442\u043e\u043a\u0435\u043d: $(Mask-Token $aCred[1])" }
  elseif (Test-AgyDetected) { Write-Host '    [\u2022] Antigravity   \u0432\u0438\u044f\u0432\u043b\u0435\u043d\u043e \u043d\u0430 \u041f\u041a, \u0449\u0435 \u043d\u0435 \u043f\u0456\u0434\u043a\u043b\u044e\u0447\u0435\u043d\u043e \u0434\u043e Token Tracker' }
  else { Write-Host '    [ ] Antigravity   \u043d\u0435 \u0432\u0438\u044f\u0432\u043b\u0435\u043d\u043e' }
  Write-Host ''
}

function Prompt-CredentialsIfMissing {
  Discover-Credentials | Out-Null
  if ($script:site -and $script:token) { return $true }
  Write-Host '\u0422\u043e\u043a\u0435\u043d \u043f\u0440\u0438\u0441\u0442\u0440\u043e\u044e \u043d\u0430 \u0446\u044c\u043e\u043c\u0443 \u041f\u041a \u0449\u0435 \u043d\u0435 \u0437\u043d\u0430\u0439\u0434\u0435\u043d\u043e.'
  $inSite = Read-Host '\u0410\u0434\u0440\u0435\u0441\u0430 \u0441\u0435\u0440\u0432\u0435\u0440\u0430 (Enter = https://ait.bdev.pp.ua)'
  if (-not $inSite.Trim()) { $inSite = 'https://ait.bdev.pp.ua' }
  $inTok = (Read-Host '\u0412\u0441\u0442\u0430\u0432\u0442\u0435 \u0442\u043e\u043a\u0435\u043d \u043f\u0440\u0438\u0441\u0442\u0440\u043e\u044e \u0437 \u0434\u0430\u0448\u0431\u043e\u0440\u0434\u0443 (\u041f\u0440\u0438\u0441\u0442\u0440\u043e\u0457 \u2192 \u0421\u0442\u0432\u043e\u0440\u0438\u0442\u0438 \u0442\u043e\u043a\u0435\u043d)').Trim()
  if (-not $inTok) { Write-Host '\u0422\u043e\u043a\u0435\u043d \u043d\u0435 \u0432\u0432\u0435\u0434\u0435\u043d\u043e.'; return $false }
  Save-Credentials $inSite $inTok
  Write-Host "  \u0422\u043e\u043a\u0435\u043d \u0437\u0431\u0435\u0440\u0435\u0436\u0435\u043d\u043e \u0432 $mtCfg"
  return $true
}

function Get-AgentOwnCredentials([string]$agent) {
  if ($agent -eq 'claude') {
    $cSet = Join-Path $claudeDir 'settings.json'
    if (Test-Path -LiteralPath $cSet) {
      $ep = Read-JsonProp $cSet { param($d) $d.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT }
      $hdr = Read-JsonProp $cSet { param($d) $d.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS }
      $m = [regex]::Match("$hdr", 'x-device-token=([0-9a-fA-F_-]{6,128})')
      if ($ep -and $m.Success) { return @((($ep -replace '/v1/logs$', '').TrimEnd('/')), $m.Groups[1].Value) }
    }
  } elseif ($agent -eq 'codex') {
    $xCfg = Join-Path $codexDir 'config.toml'
    if (Test-Path -LiteralPath $xCfg) {
      try {
        $txt = Get-Content -Raw -Encoding UTF8 -LiteralPath $xCfg
        $ms = [regex]::Match($txt, 'endpoint = "(https?://[^"]+?)/v1/logs"')
        $mt = [regex]::Match($txt, '"x-device-token" = "([^"]+)"')
        if ($ms.Success -and $mt.Success) { return @($ms.Groups[1].Value, $mt.Groups[1].Value) }
      } catch {}
    }
  } elseif ($agent -eq 'antigravity') {
    $aCfg = Join-Path $agyDataDir 'config.json'
    if (Test-Path -LiteralPath $aCfg) {
      $s = Read-JsonProp $aCfg { param($d) $d.site }
      $t = Read-JsonProp $aCfg { param($d) $d.token }
      if ($s -and $t) { return @($s.TrimEnd('/'), $t) }
    }
  }
  return @('', '')
}

function Get-AgentCredentials([string]$agent) {
  $own = Get-AgentOwnCredentials $agent
  if ($own[0] -and $own[1]) { return $own }
  return @($script:site, $script:token)
}

function Sync-AgentWithServer([string]$agent, [string]$useSite, [string]$useTok) {
  $h = if ($env:COMPUTERNAME) { [Uri]::EscapeDataString($env:COMPUTERNAME) } else { '' }
  $url = "$useSite/v1/config?sync=1&agent=$agent&host=$h&os=windows"
  $resp = $null
  try {
    $resp = Invoke-RestMethod -Uri $url -Headers @{ 'x-device-token' = $useTok; 'User-Agent' = 'modToken-cli/1.0' } -TimeoutSec 6
  } catch {
    if ($script:token -and ($script:token -ne $useTok)) {
      try {
        $resp = Invoke-RestMethod -Uri $url -Headers @{ 'x-device-token' = $script:token; 'User-Agent' = 'modToken-cli/1.0' } -TimeoutSec 6
      } catch {}
    }
  }
  if ($resp) {
    $tok = if ($resp.PSObject.Properties['token'] -and $resp.token) { "$($resp.token)" } else { $useTok }
    $dev = if ($resp.PSObject.Properties['device'] -and $resp.device) { "$($resp.device)" } else { '' }
    return @($tok, $dev)
  }
  return @($useTok, '')
}

function Invoke-AgentInstaller([string]$agent) {
  $scriptName = switch ($agent) {
    'claude'      { 'install.ps1' }
    'codex'       { 'install-codex.ps1' }
    'antigravity' { 'install-antigravity.ps1' }
    default       { '' }
  }
  if (-not $scriptName) { Write-Host "\u041d\u0435\u0432\u0456\u0434\u043e\u043c\u0438\u0439 \u0430\u0433\u0435\u043d\u0442: $agent"; return }
  $creds = Get-AgentCredentials $agent
  $useSite = if ($creds[0]) { $creds[0] } else { $script:site }
  $useTok = if ($creds[1]) { $creds[1] } else { $script:token }
  if (-not $useSite -or -not $useTok) { Write-Host '  \u041f\u043e\u043c\u0438\u043b\u043a\u0430: \u0441\u043f\u043e\u0447\u0430\u0442\u043a\u0443 \u0437\u0430\u0434\u0430\u0439\u0442\u0435 \u0441\u0435\u0440\u0432\u0435\u0440 \u0456 \u0442\u043e\u043a\u0435\u043d'; return }
  $prevTok = $useTok
  $synced = Sync-AgentWithServer $agent $useSite $useTok
  $useTok = $synced[0]
  $syncedDev = $synced[1]
  if ($syncedDev) {
    if ($useTok -ne $prevTok) {
      Write-Host "  [\u21bb] \u0421\u0438\u043d\u0445\u0440\u043e\u043d\u0456\u0437\u043e\u0432\u0430\u043d\u043e \u043e\u043a\u0440\u0435\u043c\u0438\u0439 \u0442\u043e\u043a\u0435\u043d \u0434\u043b\u044f $agent \u2192 \u043f\u0440\u0438\u0441\u0442\u0440\u0456\u0439 \u00ab$syncedDev\u00bb ($(Mask-Token $useTok))"
    } else {
      Write-Host "  [\u2713] \u0421\u0438\u043d\u0445\u0440\u043e\u043d\u0456\u0437\u043e\u0432\u0430\u043d\u043e \u043f\u0440\u0438\u0441\u0442\u0440\u0456\u0439 \u00ab$syncedDev\u00bb ($(Mask-Token $useTok))"
    }
  }
  $code = (Invoke-RestMethod "$raw/scripts/$scriptName").TrimStart([char]0xFEFF)
  & ([scriptblock]::Create($code)) $useSite $useTok
}

function Invoke-Install([string]$target = 'all', [string]$s = '', [string]$t = '') {
  if ($s -and $t) { Save-Credentials $s $t }
  elseif (-not (Prompt-CredentialsIfMissing)) { return }
  Ensure-CliInstalled
  if ($target -in @('claude', 'codex', 'antigravity')) {
    Invoke-AgentInstaller $target
    return
  }
  $any = $false
  if ((Test-ClaudeDetected) -or (Test-ClaudeConfigured)) { Invoke-AgentInstaller 'claude'; $any = $true }
  if ((Test-CodexDetected)  -or (Test-CodexConfigured))  { Invoke-AgentInstaller 'codex';  $any = $true }
  if ((Test-AgyDetected)    -or (Test-AgyConfigured))    { Invoke-AgentInstaller 'antigravity'; $any = $true }
  if (-not $any) {
    Write-Host '  \u041d\u0430\u043b\u0430\u0448\u0442\u043e\u0432\u0443\u044e Claude Code \u0442\u0430 Codex:'
    Invoke-AgentInstaller 'claude'
    Invoke-AgentInstaller 'codex'
  }
}

function Invoke-Update {
  Discover-Credentials | Out-Null
  if (-not $script:site -or -not $script:token) {
    if (-not (Prompt-CredentialsIfMissing)) { return }
  }
  Write-Host '\u041e\u043d\u043e\u0432\u043b\u0435\u043d\u043d\u044f Token Tracker CLI \u0442\u0430 \u0432\u0441\u0456\u0445 \u043f\u0456\u0434\u043a\u043b\u044e\u0447\u0435\u043d\u0438\u0445 \u0430\u0433\u0435\u043d\u0442\u0456\u0432...'
  Ensure-CliInstalled
  try {
    $selfCode = (Invoke-RestMethod "$raw/scripts/modtoken.ps1").TrimStart([char]0xFEFF)
    [System.IO.File]::WriteAllText($psPath, $selfCode, $utf8NoBom)
    Write-Host "  [\u2713] \u041a\u043e\u043c\u0430\u043d\u0434\u0443 modtoken ($cmdPath) \u043e\u043d\u043e\u0432\u043b\u0435\u043d\u043e"
  } catch {}
  $updated = $false
  if ((Test-ClaudeConfigured) -or (Test-ClaudeDetected)) {
    $oldV = Get-ClaudeVersion
    Invoke-AgentInstaller 'claude'
    $newV = Get-ClaudeVersion
    Write-Host "  [\u2713] Claude Code: v$(if ($oldV) { $oldV } else { '\u2014' }) \u2192 v$(if ($newV) { $newV } else { '?' })"
    $updated = $true
  }
  if ((Test-CodexConfigured) -or (Test-CodexDetected)) {
    $oldV = Get-CodexVersion
    Invoke-AgentInstaller 'codex'
    $newV = Get-CodexVersion
    Write-Host "  [\u2713] Codex: v$(if ($oldV) { $oldV } else { '\u2014' }) \u2192 v$(if ($newV) { $newV } else { '?' })"
    $updated = $true
  }
  if ((Test-AgyConfigured) -or (Test-AgyDetected)) {
    $oldV = Get-AgyVersion
    Invoke-AgentInstaller 'antigravity'
    $newV = Get-AgyVersion
    Write-Host "  [\u2713] Antigravity: v$(if ($oldV) { $oldV } else { '\u2014' }) \u2192 v$(if ($newV) { $newV } else { '?' })"
    $updated = $true
  }
  if (-not $updated) { Write-Host '  \u041f\u0456\u0434\u043a\u043b\u044e\u0447\u0435\u043d\u0438\u0445 \u0430\u0433\u0435\u043d\u0442\u0456\u0432 \u043d\u0435 \u0437\u043d\u0430\u0439\u0434\u0435\u043d\u043e. \u0417\u0430\u043f\u0443\u0441\u0442\u0456\u0442\u044c: modtoken install all' }
}

function Invoke-Doctor {
  Show-Status
  Write-Host '  \u0414\u0456\u0430\u0433\u043d\u043e\u0441\u0442\u0438\u043a\u0430 (doctor):'
  if ($script:site -and $script:token) {
    $h = if ($env:COMPUTERNAME) { [Uri]::EscapeDataString($env:COMPUTERNAME) } else { '' }
    try {
      $resp = Invoke-RestMethod -Uri "$($script:site)/v1/config?host=$h" -Headers @{ 'x-device-token' = $script:token; 'User-Agent' = 'modToken-cli/1.0' } -TimeoutSec 8
      Write-Host "    [\u2713] \u0417\u0432'\u044f\u0437\u043e\u043a \u0456\u0437 \u0441\u0435\u0440\u0432\u0435\u0440\u043e\u043c $($script:site)/v1/config: OK (project_mode = $($resp.project))"
    } catch {
      Write-Host "    [\u2717] \u041f\u043e\u043c\u0438\u043b\u043a\u0430 \u0437\u0432'\u044f\u0437\u043a\u0443 \u0437 $($script:site)/v1/config: $($_.Exception.Message)"
    }
  } else {
    Write-Host '    [!] \u0421\u0435\u0440\u0432\u0435\u0440 \u0456 \u0442\u043e\u043a\u0435\u043d \u0449\u0435 \u043d\u0435 \u043d\u0430\u043b\u0430\u0448\u0442\u043e\u0432\u0430\u043d\u0456'
  }
  $rc = Get-RemoteVersion 'mods/token-tracker/.claude-plugin/plugin.json'
  $rx = Get-RemoteVersion 'mods/codex-tracker/.codex-plugin/plugin.json'
  $ra = Get-RemoteVersion 'mods/antigravity-tracker/plugin.json'
  $lc = Get-ClaudeVersion; $lx = Get-CodexVersion; $la = Get-AgyVersion
  if ($lc) { Write-Host "    [\u2022] \u0412\u0435\u0440\u0441\u0456\u044f \u043c\u043e\u0434\u0430 Claude:         \u043b\u043e\u043a\u0430\u043b\u044c\u043d\u0430 v$lc / \u043e\u0441\u0442\u0430\u043d\u043d\u044f v$(if ($rc) { $rc } else { '?' })" }
  if ($lx) { Write-Host "    [\u2022] \u0412\u0435\u0440\u0441\u0456\u044f \u0445\u0443\u043a\u0456\u0432 Codex:         \u043b\u043e\u043a\u0430\u043b\u044c\u043d\u0430 v$lx / \u043e\u0441\u0442\u0430\u043d\u043d\u044f v$(if ($rx) { $rx } else { '?' })" }
  if ($la) { Write-Host "    [\u2022] \u0412\u0435\u0440\u0441\u0456\u044f \u043f\u043b\u0430\u0433\u0456\u043d\u0430 Antigravity: \u043b\u043e\u043a\u0430\u043b\u044c\u043d\u0430 v$la / \u043e\u0441\u0442\u0430\u043d\u043d\u044f v$(if ($ra) { $ra } else { '?' })" }

  $xCfg = Join-Path $codexDir 'config.toml'
  if (Test-Path $xCfg) {
    $txt = Get-Content -Raw -Encoding UTF8 $xCfg
    if ($txt -match '\[plugins\.["'']token-tracker@token-tracker-local["'']\][\s\S]{0,80}?enabled\s*=\s*true') {
      Write-Host "    [!] \u0423 $xCfg \u0434\u043e\u0441\u0456 \u0430\u043a\u0442\u0438\u0432\u043d\u0438\u0439 \u0441\u0442\u0430\u0440\u0438\u0439 \u043f\u043b\u0430\u0433\u0456\u043d token-tracker@token-tracker-local (\u0437\u0430\u043f\u0443\u0441\u0442\u0456\u0442\u044c: modtoken update)"
    }
  }
  foreach ($ef in @(
    (Join-Path $claudeDir 'mods\token-tracker\last-error.txt'),
    (Join-Path $codexDir 'token-tracker\last-error.txt'),
    (Join-Path $agyDataDir 'last-error.txt')
  )) {
    if (Test-Path $ef) {
      $last = (Get-Content -Encoding UTF8 $ef | Select-Object -Last 1)
      Write-Host "    [!] \u041e\u0441\u0442\u0430\u043d\u043d\u044f \u043f\u043e\u043c\u0438\u043b\u043a\u0430 \u0432 ${ef}: $last"
    }
  }
  Write-Host ''
}

function Show-Menu {
  Ensure-CliInstalled
  while ($true) {
    Show-Status
    Write-Host '  \u041e\u0431\u0435\u0440\u0456\u0442\u044c \u0434\u0456\u044e:'
    Write-Host '    1) \u041e\u043d\u043e\u0432\u0438\u0442\u0438 \u0432\u0441\u0435 (\u043f\u043b\u0430\u0433\u0456\u043d\u0438, \u0445\u0443\u043a\u0438, OTLP, \u0441\u0438\u043d\u0445\u0440\u043e\u043d\u0456\u0437\u0430\u0446\u0456\u044f \u0442\u043e\u043a\u0435\u043d\u0456\u0432 \u0456 modtoken)'
    Write-Host '    2) \u041f\u0456\u0434\u043a\u043b\u044e\u0447\u0438\u0442\u0438 / \u043d\u0430\u043b\u0430\u0448\u0442\u0443\u0432\u0430\u0442\u0438 \u0432\u0441\u0456 \u0432\u0438\u044f\u0432\u043b\u0435\u043d\u0456 \u0430\u0433\u0435\u043d\u0442\u0438 \u043d\u0430 \u0446\u044c\u043e\u043c\u0443 \u041f\u041a'
    Write-Host '    3) \u041f\u0456\u0434\u043a\u043b\u044e\u0447\u0438\u0442\u0438 \u043e\u043a\u0440\u0435\u043c\u0438\u0439 \u0430\u0433\u0435\u043d\u0442 (Claude Code / Codex / Antigravity)'
    Write-Host '    4) \u0414\u0456\u0430\u0433\u043d\u043e\u0441\u0442\u0438\u043a\u0430 (doctor: \u043f\u0435\u0440\u0435\u0432\u0456\u0440\u043a\u0430 \u0441\u0435\u0440\u0432\u0435\u0440\u0430, \u0432\u0435\u0440\u0441\u0456\u0439, \u0445\u0443\u043a\u0456\u0432 \u0456 \u043f\u043e\u043c\u0438\u043b\u043e\u043a)'
    Write-Host '    5) \u0417\u043c\u0456\u043d\u0438\u0442\u0438 \u0441\u0435\u0440\u0432\u0435\u0440 \u0430\u0431\u043e \u0442\u043e\u043a\u0435\u043d \u043f\u0440\u0438\u0441\u0442\u0440\u043e\u044e'
    Write-Host '    0) \u0412\u0438\u0445\u0456\u0434'
    $rawChoice = Read-Host "`n  \u0412\u0430\u0448 \u0432\u0438\u0431\u0456\u0440 [1-5, 0]"
    if ($null -eq $rawChoice) { return }
    $ch = $rawChoice.Trim()
    Write-Host ''
    switch ($ch) {
      '1' { Invoke-Update; Write-Host '' }
      '2' { Invoke-Install 'all'; Write-Host '' }
      '3' {
        $ach = (Read-Host '  \u042f\u043a\u0438\u0439 \u0430\u0433\u0435\u043d\u0442 \u043f\u0456\u0434\u043a\u043b\u044e\u0447\u0438\u0442\u0438? (1 = Claude Code, 2 = Codex, 3 = Antigravity)').Trim()
        switch ($ach) {
          '1' { Invoke-Install 'claude' }
          'claude' { Invoke-Install 'claude' }
          '2' { Invoke-Install 'codex' }
          'codex' { Invoke-Install 'codex' }
          '3' { Invoke-Install 'antigravity' }
          'antigravity' { Invoke-Install 'antigravity' }
          default { Write-Host '  \u041d\u0435\u0432\u0456\u0440\u043d\u0438\u0439 \u0432\u0438\u0431\u0456\u0440.' }
        }
        Write-Host ''
      }
      '4' { Invoke-Doctor; Write-Host '' }
      '5' {
        $script:site = ''; $script:token = ''
        Remove-Item -LiteralPath $mtCfg -Force -ErrorAction SilentlyContinue
        Prompt-CredentialsIfMissing | Out-Null
        Write-Host ''
      }
      '0'    { return }
      'q'    { return }
      'exit' { return }
      ''     { }
      default { Write-Host '  \u041d\u0435\u0432\u0456\u0440\u043d\u0438\u0439 \u0432\u0438\u0431\u0456\u0440.'; Write-Host '' }
    }
  }
}

if ($Command -match '^https?://') {
  Invoke-Install 'all' $Command $Arg1
} else {
  switch ($Command) {
    'menu'    { Show-Menu }
    'status'  { Show-Status }
    'update'  { Invoke-Update }
    'doctor'  { Invoke-Doctor }
    'install' { Invoke-Install $(if ($Arg1) { $Arg1 } else { 'all' }) $Arg2 $Arg3 }
    'token'   {
      if (-not $Arg1 -or -not $Arg2) { Write-Host '\u0412\u0438\u043a\u043e\u0440\u0438\u0441\u0442\u0430\u043d\u043d\u044f: modtoken token https://<\u0441\u0430\u0439\u0442> <\u0442\u043e\u043a\u0435\u043d>'; exit 1 }
      Save-Credentials $Arg1 $Arg2
      Ensure-CliInstalled
      Write-Host "\u0422\u043e\u043a\u0435\u043d \u0437\u0431\u0435\u0440\u0435\u0436\u0435\u043d\u043e \u0432 $mtCfg"
    }
    default {
      Write-Host '\u0412\u0438\u043a\u043e\u0440\u0438\u0441\u0442\u0430\u043d\u043d\u044f: modtoken [status|update|doctor|install [all|claude|codex|antigravity]|token <\u0441\u0430\u0439\u0442> <\u0442\u043e\u043a\u0435\u043d>]'
      exit 1
    }
  }
}
