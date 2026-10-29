// The settings a device pastes: they point Claude Code's logs at /v1/logs as JSON, keep metrics and traces off and never ask for prompt text.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cloudEnv, cloudScript, codexInstallPs, codexInstallSh, codexToml, setupPlan, pcInstallPs, pcInstallSh, settingsJson, setupEnv, shellEnv } from '../web/lib/setup.ts'

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
    'CLAUDE_CODE_PLUGIN_DIRS=/root/.claude/mods/token-tracker',
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
  for (const part of ['[otel]', 'log_user_prompt = false', 'endpoint = "https://x.test/v1/logs"', 'protocol = "json"', '"x-device-token" = "tok"']) assert.ok(toml.includes(part), part)
})

test('setup: install-codex.sh writes its [otel] block once, replaces it on a second run, puts the plugin in place, leaves the user\'s own alone', () => {
  const home = mkdtempSync(join(tmpdir(), 'tt-codex-'))
  const raw = 'file://' + new URL('..', import.meta.url).pathname.replace(/\/$/, '') // the plugin from this checkout, not the network
  const run = (...args) => spawnSync('bash', [new URL('../scripts/install-codex.sh', import.meta.url).pathname, ...args], { env: { ...process.env, CODEX_HOME: home, TT_RAW: raw, PATH: '/usr/bin:/bin' }, encoding: 'utf8' })
  const config = join(home, 'config.toml')
  const user = 'model = "gpt-5.1-codex"\n\n[profiles.fast]\nmodel = "gpt-5-mini"\n'
  writeFileSync(config, user)
  assert.equal(run('https://x.test/', 'tok1').status, 0)
  const first = readFileSync(config, 'utf8')
  assert.equal(run('https://x.test', 'tok2').status, 0)
  assert.equal(run('https://x.test', 'tok2').status, 0)
  const text = readFileSync(config, 'utf8')
  assert.equal(text, first.replace('tok1', 'tok2')) // a second and a third run change nothing but the token
  assert.equal(text.split('[otel]').length, 2)
  assert.ok(!text.includes('notify'))
  assert.ok(text.startsWith(user + '\n# >>> token-tracker')) // the user's config stays as it was, the block comes after it
  assert.ok(text.includes('"x-device-token" = "tok2"') && !text.includes('tok1'))
  assert.ok(text.includes('endpoint = "https://x.test/v1/logs", protocol = "json"'))
  // the plugin and its local marketplace, ready for `codex plugin add token-tracker@token-tracker-local`
  const market = JSON.parse(readFileSync(join(home, 'token-tracker', '.agents', 'plugins', 'marketplace.json'), 'utf8'))
  assert.deepEqual(market, { name: 'token-tracker-local', plugins: [{ name: 'token-tracker', source: './plugins/token-tracker' }] })
  for (const f of ['.codex-plugin/plugin.json', 'hooks/hooks.json', 'hooks/limits.py', 'hooks/limits.ps1']) {
    assert.equal(readFileSync(join(home, 'token-tracker', 'plugins', 'token-tracker', f), 'utf8'), readFileSync(new URL('../mods/codex-tracker/' + f, import.meta.url), 'utf8'), f)
  }
  const out = run('https://x.test', 'tok3')
  assert.equal(out.status, 0)
  assert.ok(!out.stdout.includes('tok3')) // the token is never printed
  assert.ok(out.stdout.includes('codex plugin add token-tracker@token-tracker-local')) // no codex command here: how to install it by hand

  writeFileSync(config, '[otel]\nenvironment = "prod"\n')
  const otel = run('https://x.test', 'tok4')
  assert.equal(otel.status, 1)
  assert.equal(readFileSync(config, 'utf8'), '[otel]\nenvironment = "prod"\n')
  assert.ok(!otel.stdout.includes('tok4'))
  assert.equal(run('https://x.test').status, 1) // no token: nothing written
})

test('setup: each agent and place gets one best way first and the manual settings last; the token is where it must be', () => {
  const O = 'https://x.test', T = 'tok-123'
  const codeOf = steps => steps.map(st => st.code ?? '').join('\n')
  for (const agent of ['claude', 'codex']) for (const place of ['windows', 'linux', 'cloud']) {
    const plan = setupPlan(agent, place, O, T)
    assert.ok(plan.steps.length > 0 && plan.manual.length > 0, `${agent}/${place}`)
    assert.ok(codeOf(plan.steps).includes(T) && codeOf(plan.manual).includes(T), `${agent}/${place}: the token`)
    for (const st of [...plan.steps, ...plan.manual]) assert.equal((st.text.match(/`/g) ?? []).length % 2, 0, `${agent}/${place}: backticks pair up`)
  }
  assert.equal(setupPlan('claude', 'windows', O, T).steps[0].code, pcInstallPs(O, T))
  assert.equal(setupPlan('claude', 'linux', O, T).steps[0].code, pcInstallSh(O, T))
  assert.equal(setupPlan('codex', 'windows', O, T).steps[0].code, codexInstallPs(O, T))
  assert.equal(setupPlan('codex', 'linux', O, T).steps[0].code, codexInstallSh(O, T))
  assert.ok(codeOf(setupPlan('codex', 'linux', O, T).manual).includes('protocol = "json"'))
  // the claude.ai/code setup script cannot read the environment: the token goes into the variables only, never into the script line
  const cloud = setupPlan('claude', 'cloud', O, T)
  assert.equal(cloud.steps[0].code, cloudScript())
  assert.ok(!cloud.steps[0].code.includes(T) && cloud.steps[1].code.includes(T))
  assert.ok(cloud.steps[2].text.includes('`x.test`'))
  assert.ok(setupPlan('claude', 'cloud', 'http://127.0.0.1:8787', T).steps[2].text.includes('`127.0.0.1`')) // the host name, no port
  assert.ok(!JSON.stringify(setupPlan('claude', 'windows', O, T).manual).includes('export ')) // no shell lines for Windows
})
