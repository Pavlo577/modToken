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
  if (-not $t) { return 'не задано' }
  if ($t.Length -ge 12) { return "$($t.Substring(0, 4))…$($t.Substring($t.Length - 4))" }
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
    } elseif (-not (Test-Path -LiteralPath $psPath)) {
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
  Write-Host '╔════════════════════════════════════════════════════════════════╗'
  Write-Host '║  Token Tracker CLI (modtoken) · Управління агентами та OTLP    ║'
  Write-Host '╚════════════════════════════════════════════════════════════════╝'
  Write-Host "  Комп'ютер: $hostName"
  Write-Host "  Сервер:    $(if ($script:site) { $script:site } else { 'не налаштовано' })"
  Write-Host "  Токен:     $(Mask-Token $script:token)$(if ($script:tokenSource) { " (знайдено в: $($script:tokenSource))" } else { '' })"
  Write-Host ''
  Write-Host '  Стан агентів на цьому ПК:'

  $cv = Get-ClaudeVersion; $xv = Get-CodexVersion; $av = Get-AgyVersion
  if (Test-ClaudeConfigured) { Write-Host "    [✓] Claude Code   OTLP: увімкнено · Мод: v$(if ($cv) { $cv } else { '?' })" }
  elseif (Test-ClaudeDetected) { Write-Host '    [•] Claude Code   виявлено на ПК, ще не підключено до Token Tracker' }
  else { Write-Host '    [ ] Claude Code   не виявлено' }

  if (Test-CodexConfigured) {
    $hf = Join-Path $codexDir 'hooks.json'
    $hs = if ((Test-Path $hf) -and ((Get-Content -Raw -Encoding UTF8 $hf) -match 'token-tracker')) { 'hooks.json активний' } else { 'немає hooks.json' }
    Write-Host "    [✓] Codex         OTLP: увімкнено · Хуки: v$(if ($xv) { $xv } else { '?' }) ($hs)"
  } elseif (Test-CodexDetected) { Write-Host '    [•] Codex         виявлено на ПК, ще не підключено до Token Tracker' }
  else { Write-Host '    [ ] Codex         не виявлено' }

  if (Test-AgyConfigured) { Write-Host "    [✓] Antigravity   statusLine: увімкнено · Плагін: v$(if ($av) { $av } else { '?' })" }
  elseif (Test-AgyDetected) { Write-Host '    [•] Antigravity   виявлено на ПК, ще не підключено до Token Tracker' }
  else { Write-Host '    [ ] Antigravity   не виявлено' }
  Write-Host ''
}

function Prompt-CredentialsIfMissing {
  Discover-Credentials | Out-Null
  if ($script:site -and $script:token) { return $true }
  Write-Host 'Токен пристрою на цьому ПК ще не знайдено.'
  $inSite = Read-Host 'Адреса сервера (Enter = https://ait.bdev.pp.ua)'
  if (-not $inSite.Trim()) { $inSite = 'https://ait.bdev.pp.ua' }
  $inTok = (Read-Host 'Вставте токен пристрою з дашборду (Пристрої → Створити токен)').Trim()
  if (-not $inTok) { Write-Host 'Токен не введено.'; return $false }
  Save-Credentials $inSite $inTok
  Write-Host "  Токен збережено в $mtCfg"
  return $true
}

function Get-AgentCredentials([string]$agent) {
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
  return @($script:site, $script:token)
}

function Invoke-AgentInstaller([string]$agent) {
  $scriptName = switch ($agent) {
    'claude'      { 'install.ps1' }
    'codex'       { 'install-codex.ps1' }
    'antigravity' { 'install-antigravity.ps1' }
    default       { '' }
  }
  if (-not $scriptName) { Write-Host "Невідомий агент: $agent"; return }
  $creds = Get-AgentCredentials $agent
  $useSite = if ($creds[0]) { $creds[0] } else { $script:site }
  $useTok = if ($creds[1]) { $creds[1] } else { $script:token }
  if (-not $useSite -or -not $useTok) { Write-Host '  Помилка: спочатку задайте сервер і токен'; return }
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
    Write-Host '  Налаштовую Claude Code та Codex:'
    Invoke-AgentInstaller 'claude'
    Invoke-AgentInstaller 'codex'
  }
}

function Invoke-Update {
  Discover-Credentials | Out-Null
  if (-not $script:site -or -not $script:token) {
    if (-not (Prompt-CredentialsIfMissing)) { return }
  }
  Write-Host 'Оновлення Token Tracker CLI та всіх підключених агентів...'
  Ensure-CliInstalled
  try {
    $selfCode = (Invoke-RestMethod "$raw/scripts/modtoken.ps1").TrimStart([char]0xFEFF)
    [System.IO.File]::WriteAllText($psPath, $selfCode, $utf8NoBom)
    Write-Host "  [✓] Команду modtoken ($cmdPath) оновлено"
  } catch {}
  $updated = $false
  if ((Test-ClaudeConfigured) -or (Test-ClaudeDetected)) {
    $oldV = Get-ClaudeVersion
    Invoke-AgentInstaller 'claude'
    $newV = Get-ClaudeVersion
    Write-Host "  [✓] Claude Code: v$(if ($oldV) { $oldV } else { '—' }) → v$(if ($newV) { $newV } else { '?' })"
    $updated = $true
  }
  if ((Test-CodexConfigured) -or (Test-CodexDetected)) {
    $oldV = Get-CodexVersion
    Invoke-AgentInstaller 'codex'
    $newV = Get-CodexVersion
    Write-Host "  [✓] Codex: v$(if ($oldV) { $oldV } else { '—' }) → v$(if ($newV) { $newV } else { '?' })"
    $updated = $true
  }
  if ((Test-AgyConfigured) -or (Test-AgyDetected)) {
    $oldV = Get-AgyVersion
    Invoke-AgentInstaller 'antigravity'
    $newV = Get-AgyVersion
    Write-Host "  [✓] Antigravity: v$(if ($oldV) { $oldV } else { '—' }) → v$(if ($newV) { $newV } else { '?' })"
    $updated = $true
  }
  if (-not $updated) { Write-Host '  Підключених агентів не знайдено. Запустіть: modtoken install all' }
}

function Invoke-Doctor {
  Show-Status
  Write-Host '  Діагностика (doctor):'
  if ($script:site -and $script:token) {
    $h = if ($env:COMPUTERNAME) { [Uri]::EscapeDataString($env:COMPUTERNAME) } else { '' }
    try {
      $resp = Invoke-RestMethod -Uri "$($script:site)/v1/config?host=$h" -Headers @{ 'x-device-token' = $script:token; 'User-Agent' = 'modToken-cli/1.0' } -TimeoutSec 8
      Write-Host "    [✓] Зв'язок із сервером $($script:site)/v1/config: OK (project_mode = $($resp.project))"
    } catch {
      Write-Host "    [✗] Помилка зв'язку з $($script:site)/v1/config: $($_.Exception.Message)"
    }
  } else {
    Write-Host '    [!] Сервер і токен ще не налаштовані'
  }
  $rc = Get-RemoteVersion 'mods/token-tracker/.claude-plugin/plugin.json'
  $rx = Get-RemoteVersion 'mods/codex-tracker/.codex-plugin/plugin.json'
  $ra = Get-RemoteVersion 'mods/antigravity-tracker/plugin.json'
  $lc = Get-ClaudeVersion; $lx = Get-CodexVersion; $la = Get-AgyVersion
  if ($lc) { Write-Host "    [•] Версія мода Claude:         локальна v$lc / остання v$(if ($rc) { $rc } else { '?' })" }
  if ($lx) { Write-Host "    [•] Версія хуків Codex:         локальна v$lx / остання v$(if ($rx) { $rx } else { '?' })" }
  if ($la) { Write-Host "    [•] Версія плагіна Antigravity: локальна v$la / остання v$(if ($ra) { $ra } else { '?' })" }

  $xCfg = Join-Path $codexDir 'config.toml'
  if (Test-Path $xCfg) {
    $txt = Get-Content -Raw -Encoding UTF8 $xCfg
    if ($txt -match '\[plugins\.["'']token-tracker@token-tracker-local["'']\][\s\S]{0,80}?enabled\s*=\s*true') {
      Write-Host "    [!] У $xCfg досі активний старий плагін token-tracker@token-tracker-local (запустіть: modtoken update)"
    }
  }
  foreach ($ef in @(
    (Join-Path $claudeDir 'mods\token-tracker\last-error.txt'),
    (Join-Path $codexDir 'token-tracker\last-error.txt'),
    (Join-Path $agyDataDir 'last-error.txt')
  )) {
    if (Test-Path $ef) {
      $last = (Get-Content -Encoding UTF8 $ef | Select-Object -Last 1)
      Write-Host "    [!] Остання помилка в ${ef}: $last"
    }
  }
  Write-Host ''
}

function Show-Menu {
  Ensure-CliInstalled
  while ($true) {
    Show-Status
    Write-Host '  Оберіть дію:'
    Write-Host '    1) Оновити все (плагіни, хуки, OTLP та команду modtoken)'
    Write-Host '    2) Підключити / налаштувати всі виявлені агенти на цьому ПК'
    Write-Host '    3) Підключити окремий агент (Claude Code / Codex / Antigravity)'
    Write-Host '    4) Діагностика (doctor: перевірка сервера, версій, хуків і помилок)'
    Write-Host '    5) Змінити сервер або токен пристрою'
    Write-Host '    0) Вихід'
    $ch = (Read-Host "`n  Ваш вибір [1-5, 0]").Trim()
    Write-Host ''
    switch ($ch) {
      '1' { Invoke-Update; return }
      '2' { Invoke-Install 'all'; return }
      '3' {
        $ach = (Read-Host '  Який агент підключити? (1 = Claude Code, 2 = Codex, 3 = Antigravity)').Trim()
        switch ($ach) {
          '1' { Invoke-Install 'claude' }
          'claude' { Invoke-Install 'claude' }
          '2' { Invoke-Install 'codex' }
          'codex' { Invoke-Install 'codex' }
          '3' { Invoke-Install 'antigravity' }
          'antigravity' { Invoke-Install 'antigravity' }
          default { Write-Host '  Невірний вибір.' }
        }
        return
      }
      '4' { Invoke-Doctor; return }
      '5' {
        $script:site = ''; $script:token = ''
        Remove-Item -LiteralPath $mtCfg -Force -ErrorAction SilentlyContinue
        Prompt-CredentialsIfMissing | Out-Null
      }
      '0' { return }
      ''  { return }
      default { Write-Host '  Невірний вибір.' }
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
      if (-not $Arg1 -or -not $Arg2) { Write-Host 'Використання: modtoken token https://<сайт> <токен>'; exit 1 }
      Save-Credentials $Arg1 $Arg2
      Ensure-CliInstalled
      Write-Host "Токен збережено в $mtCfg"
    }
    default {
      Write-Host 'Використання: modtoken [status|update|doctor|install [all|claude|codex|antigravity]|token <сайт> <токен>]'
      exit 1
    }
  }
}
