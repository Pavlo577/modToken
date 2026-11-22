// The settings a device pastes: they point Claude Code's logs at /v1/logs as JSON, keep metrics and traces off and never ask for prompt text.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { antigravityInstallPs, antigravityInstallSh, cloudEnv, cloudScript, codexInstallPs, codexInstallSh, codexToml, guessSetup, setupPlan, pcInstallPs, pcInstallSh, settingsJson, setupEnv, shellEnv } from '../web/lib/setup.ts'

test('setup: the logs endpoint, the JSON protocol and the token header', () => {
  const env = setupEnv('https://track.example.test/', 'tok123')
  assert.equal(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, 'https://track.example.test/v1/logs')
  assert.equal(env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL, 'http/json')
  assert.equal(env.OTEL_EXPORTER_OTLP_LOGS_HEADERS, 'x-device-token=tok123')
  assert.equal(env.OTEL_METRICS_EXPORTER, 'none'); assert.equal(env.OTEL_TRACES_EXPORTER, 'none')
})

test('setup: prompt text and tool details are never switched on', () => {
  const keys = Object.keys(setupEnv('https://x.test', 't'))
  for (const k of keys) assert.equal(/LOG_USER_PROMPTS|LOG_TOOL|LOG_ASSISTANT|RAW_API/.test(k), false, k)
})

test('setup: settings.json and the shell variant carry the same values', () => {
  const json = JSON.parse(settingsJson('https://x.test', 'tok'))
  assert.deepEqual(Object.keys(json), ['env'])
  const shell = shellEnv('https://x.test', 'tok').split('\n')
  assert.equal(shell.length, Object.keys(json.env).length)
  assert.ok(shell.includes('export OTEL_EXPORTER_OTLP_LOGS_HEADERS=x-device-token=tok'))
  assert.ok(shell.every(l => l.startsWith('export ')))
})

test('setup: the cloud variant is the minimum OTLP set plus the mod folder; the setup script line holds no token', () => {
  const lines = cloudEnv('https://x.test/', 'tok').split('\n')
  assert.deepEqual(lines, [
    'CLAUDE_CODE_ENABLE_TELEMETRY=1', 'OTEL_LOGS_EXPORTER=otlp', 'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json',
    'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://x.test/v1/logs', 'OTEL_EXPORTER_OTLP_LOGS_HEADERS=x-device-token=tok',
    'CLAUDE_CODE_PLUGIN_DIRS=~/.claude/mods/token-tracker',
  ])
  assert.equal(cloudScript().includes('tok'), false)
  assert.ok(cloudScript().endsWith('| bash'))
})

test('setup: the computer one-liners pass the site and the token to the install scripts', () => {
  assert.ok(pcInstallSh('https://x.test/', 'tok').endsWith('/install.sh | bash -s -- https://x.test tok'))
  assert.ok(pcInstallPs('https://x.test/', 'tok').endsWith('/install.ps1))) https://x.test tok'))
})

test('setup: the Codex one-liners and the [otel] table: logs endpoint, JSON, the token header, the prompt text off', () => {
  assert.ok(codexInstallSh('https://x.test/', 'tok').endsWith('/install-codex.sh | bash -s -- https://x.test tok'))
  assert.ok(codexInstallPs('https://x.test/', 'tok').endsWith('/install-codex.ps1))) https://x.test tok'))
  const toml = codexToml('https://x.test/', 'tok')
  for (const part of ['[otel]', 'log_user_prompt = false', 'log_agent_responses = false', 'log_guardian_assessments = false', 'log_sse_deltas = false', 'endpoint = "https://x.test/v1/logs"', 'protocol = "json"', '"x-device-token" = "tok"']) assert.ok(toml.includes(part), part)
})

test('setup: install-codex.sh writes its [otel] block once, disables legacy plugin duplicate, registers user hooks.json alone, leaves user config alone', () => {
  const home = mkdtempSync(join(tmpdir(), 'tt-codex-'))
  const binDir = mkdtempSync(join(tmpdir(), 'tt-codex-bin-'))
  const stubLog = join(home, 'codex-stub.log')
  const stub = join(binDir, 'codex')
  writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${stubLog}"\nexit 0\n`)
  chmodSync(stub, 0o755)
  const raw = 'file://' + new URL('..', import.meta.url).pathname.replace(/\/$/, '') // the scripts from this checkout, not the network
  const run = (...args) => spawnSync('bash', [new URL('../scripts/install-codex.sh', import.meta.url).pathname, ...args], { env: { ...process.env, CODEX_HOME: home, TT_RAW: raw, PATH: `${binDir}:/usr/bin:/bin` }, encoding: 'utf8' })
  const config = join(home, 'config.toml')
  const user = 'model = "gpt-5.1-codex"\n\n[profiles.fast]\nmodel = "gpt-5-mini"\n\n[plugins."token-tracker@token-tracker-local"]\nenabled = true\n\n[plugins."other@local"]\nenabled = true\n'
  const userDisabled = user.replace('[plugins."token-tracker@token-tracker-local"]\nenabled = true', '[plugins."token-tracker@token-tracker-local"]\nenabled = false')
  writeFileSync(config, user)
  writeFileSync(join(home, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo my-custom-hook' }] }] } }))
  const r1 = run('https://x.test/', 'tok1')
  assert.equal(r1.status, 0)
  assert.ok(r1.stdout.includes('вимкнено'))
  const first = readFileSync(config, 'utf8')
  assert.equal(run('https://x.test', 'tok2').status, 0)
  assert.equal(run('https://x.test', 'tok2').status, 0)
  const text = readFileSync(config, 'utf8')
  assert.equal(text, first.replace('tok1', 'tok2')) // a second and a third run change nothing but the token
  assert.equal(text.split('[otel]').length, 2)
  assert.ok(!text.includes('notify'))
  assert.ok(text.startsWith(userDisabled + '\n# >>> token-tracker')) // legacy duplicate disabled, other plugins & config kept intact
  assert.ok(text.includes('[plugins."other@local"]\nenabled = true'))
  assert.ok(text.includes('"x-device-token" = "tok2"') && !text.includes('tok1'))
  assert.ok(text.includes('log_sse_deltas = false'))
  assert.ok(text.includes('endpoint = "https://x.test/v1/logs", protocol = "json"'))
  // user-level hooks.json preserves user hooks and avoids duplicating token-tracker groups
  const userHooks = JSON.parse(readFileSync(join(home, 'hooks.json'), 'utf8'))
  assert.equal(userHooks.hooks.Stop.length, 2)
  assert.equal(userHooks.hooks.Stop[0].hooks[0].command, 'echo my-custom-hook')
  assert.equal(userHooks.hooks.Interrupt[0].hooks[0].timeout, 3)
  assert.equal(userHooks.hooks.SessionEnd[0].hooks[0].timeout, 3)
  // scripts & plugin manifest for plugin_version() are downloaded, without marketplace.json or invoking codex plugin add
  assert.equal(existsSync(join(home, 'token-tracker', '.agents', 'plugins', 'marketplace.json')), false)
  assert.equal(existsSync(stubLog), false)
  for (const f of ['.codex-plugin/plugin.json', 'hooks/hooks.json', 'hooks/limits.py', 'hooks/limits.ps1', 'hooks/history.py', 'hooks/history.ps1', 'hooks/activity.py', 'hooks/activity.ps1']) {
    assert.equal(readFileSync(join(home, 'token-tracker', 'plugins', 'token-tracker', f), 'utf8'), readFileSync(new URL('../mods/codex-tracker/' + f, import.meta.url), 'utf8'), f)
  }
  const out = run('https://x.test', 'tok3')
  assert.equal(out.status, 0)
  assert.ok(!out.stdout.includes('tok3')) // the token is never printed
  assert.ok(!out.stdout.includes('codex plugin add'))
  assert.ok(out.stdout.includes('hooks.json'))

  // empty config.toml produces no stray leading blank line
  const emptyHome = mkdtempSync(join(tmpdir(), 'tt-codex-emptycfg-'))
  assert.equal(spawnSync('bash', [new URL('../scripts/install-codex.sh', import.meta.url).pathname, 'https://x.test', 'tok0'], { env: { ...process.env, CODEX_HOME: emptyHome, TT_RAW: raw, PATH: '/usr/bin:/bin' }, encoding: 'utf8' }).status, 0)
  assert.ok(readFileSync(join(emptyHome, 'config.toml'), 'utf8').startsWith('# >>> token-tracker'))

  writeFileSync(config, '[otel]\nenvironment = "prod"\n')
  const otel = run('https://x.test', 'tok4')
  assert.equal(otel.status, 1)
  assert.equal(readFileSync(config, 'utf8'), '[otel]\nenvironment = "prod"\n')
  assert.ok(!otel.stdout.includes('tok4'))
  assert.equal(run('https://x.test').status, 1) // no token: nothing written
})

test('setup: install.sh sets CLAUDE_CODE_PLUGIN_DIRS when claude CLI is missing', () => {
  const cdir = mkdtempSync(join(tmpdir(), 'tt-claude-inst-'))
  const raw = 'file://' + new URL('..', import.meta.url).pathname.replace(/\/$/, '')
  const res = spawnSync('bash', [new URL('../scripts/install.sh', import.meta.url).pathname, 'https://x.test', 'ctok'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: cdir, TT_RAW: raw, PATH: '/usr/bin:/bin' }, encoding: 'utf8',
  })
  assert.equal(res.status, 0, res.stderr)
  const settings = JSON.parse(readFileSync(join(cdir, 'settings.json'), 'utf8'))
  assert.equal(settings.env.CLAUDE_CODE_PLUGIN_DIRS, join(cdir, 'mods', 'token-tracker'))
  assert.equal(settings.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS, 'x-device-token=ctok')
})

test('setup: each agent and place gets one best way first and the manual settings last; the token is where it must be', () => {
  const O = 'https://x.test', T = 'tok-123'
  const codeOf = steps => steps.map(st => st.code ?? '').join('\n')
  for (const agent of ['claude', 'codex', 'antigravity']) for (const place of ['windows', 'linux', 'cloud']) {
    const plan = setupPlan(agent, place, O, T)
    assert.ok(plan.steps.length > 0 && plan.manual.length > 0, `${agent}/${place}`)
    assert.ok(codeOf(plan.steps).includes(T) && codeOf(plan.manual).includes(T), `${agent}/${place}: the token`)
    for (const st of [...plan.steps, ...plan.manual]) assert.equal((st.text.match(/`/g) ?? []).length % 2, 0, `${agent}/${place}: backticks pair up`)
  }
  assert.equal(setupPlan('claude', 'windows', O, T).steps[0].code, pcInstallPs(O, T))
  assert.equal(setupPlan('claude', 'linux', O, T).steps[0].code, pcInstallSh(O, T))
  assert.equal(setupPlan('codex', 'windows', O, T).steps[0].code, codexInstallPs(O, T))
  assert.equal(setupPlan('codex', 'linux', O, T).steps[0].code, codexInstallSh(O, T))
  assert.equal(setupPlan('antigravity', 'windows', O, T).steps[0].code, antigravityInstallPs(O, T))
  assert.equal(setupPlan('antigravity', 'linux', O, T).steps[0].code, antigravityInstallSh(O, T))
  assert.ok(codeOf(setupPlan('codex', 'linux', O, T).manual).includes('protocol = "json"'))
  // the claude.ai/code setup script cannot read the environment: the token goes into the variables only, never into the script line
  const cloud = setupPlan('claude', 'cloud', O, T)
  assert.equal(cloud.steps[0].code, cloudScript())
  assert.ok(!cloud.steps[0].code.includes(T) && cloud.steps[1].code.includes(T))
  assert.ok(cloud.steps[2].text.includes('`x.test`'))
  assert.ok(setupPlan('claude', 'cloud', 'http://127.0.0.1:8787', T).steps[2].text.includes('`127.0.0.1`')) // the host name, no port
  assert.ok(!JSON.stringify(setupPlan('claude', 'windows', O, T).manual).includes('export ')) // no shell lines for Windows
})

test('setup: a device shown again gets its last choice, else what its data and name say', () => {
  const def = { agent: 'claude', place: 'linux' }
  assert.deepEqual(guessSetup('win-pk-h-codex', ['codex'], undefined, def), { agent: 'codex', place: 'windows' })
  assert.deepEqual(guessSetup('cloud', [], undefined, def), { agent: 'claude', place: 'cloud' })
  assert.deepEqual(guessSetup('box', ['claude', 'codex'], { agent: 'codex', place: 'cloud' }, def), { agent: 'codex', place: 'cloud' })
  assert.deepEqual(guessSetup('codex-ubuntu', [], undefined, { agent: 'claude', place: 'windows' }), { agent: 'codex', place: 'linux' })
  assert.deepEqual(guessSetup('linux-agy', [], undefined, def), { agent: 'antigravity', place: 'linux' })
  assert.deepEqual(guessSetup('box', ['antigravity'], undefined, def), { agent: 'antigravity', place: 'linux' })
  assert.deepEqual(guessSetup('box', ['claude', 'codex'], { agent: 'nope' }, def), def) // unknown saved values and two agents: the defaults
})
