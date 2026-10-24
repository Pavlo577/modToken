// Claude Code over OTLP, set up by the program: the settings it writes, the headers helper, one source per agent. Own temp home (spawned processes).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { otlpEnv, otlpState, withOtlp, withoutOtlp } from '../../collectors/lib/otlp-claude.mjs'

const cli = resolve(import.meta.dirname, '../../collectors/token-tracker.mjs')
const URL_ = 'https://track.example.test'
const TOKEN = 'a'.repeat(40)
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'otlpc-'))
  mkdirSync(join(dir, 'claude')); mkdirSync(join(dir, 'tt'))
  writeFileSync(join(dir, 'tt', 'config.json'), JSON.stringify({ url: URL_, token: TOKEN, device: 'pc' }))
  const env = { ...process.env, TOKEN_TRACKER_HOME: join(dir, 'tt'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), CODEX_HOME: join(dir, 'none') }
  const run = (...a) => spawnSync(process.execPath, [cli, ...a], { env, encoding: 'utf8' })
  return { dir, run, settings: () => JSON.parse(readFileSync(join(dir, 'claude', 'settings.json'), 'utf8')), config: () => JSON.parse(readFileSync(join(dir, 'tt', 'config.json'), 'utf8')) }
}

test('otlp-claude: the block points logs at /v1/logs as JSON, keeps metrics and traces off and never asks for prompt text', () => {
  const env = otlpEnv(URL_ + '/')
  assert.equal(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, URL_ + '/v1/logs'); assert.equal(env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL, 'http/json')
  assert.equal(env.OTEL_METRICS_EXPORTER, 'none'); assert.equal(env.OTEL_TRACES_EXPORTER, 'none')
  assert.equal('OTEL_LOG_USER_PROMPTS' in env, false); assert.equal('OTEL_LOG_TOOL_DETAILS' in env, false)
})

test('otlp-claude: our block is added beside the user\'s settings, removed exactly, and the user\'s own OTEL settings are never overwritten', () => {
  const doc = { permissions: { allow: ['x'] }, env: { FOO: '1' } }
  const on = withOtlp(doc, URL_, 'h')
  assert.equal(otlpState(on, URL_, 'h'), 'ours'); assert.equal(on.env.FOO, '1')
  assert.deepEqual(withoutOtlp(on, URL_, 'h'), doc)
  assert.throws(() => withOtlp({ env: { OTEL_LOGS_EXPORTER: 'console' } }, URL_, 'h'), /already has OpenTelemetry settings/)
  assert.throws(() => withOtlp({ otelHeadersHelper: 'mine.sh' }, URL_, 'h'), /already has/)
  assert.deepEqual(withoutOtlp({ env: { OTEL_LOGS_EXPORTER: 'console' } }, URL_, 'h'), { env: { OTEL_LOGS_EXPORTER: 'console' } }, 'not ours: untouched')
})

test('otlp-claude: enable writes the settings without the token, the helper prints the headers, the log collector steps aside, disable undoes it', () => {
  const t = setup()
  writeFileSync(join(t.dir, 'claude', 'settings.json'), JSON.stringify({ model: 'x' }))
  const on = t.run('otlp', 'enable'); assert.equal(on.status, 0, on.stderr)
  const text = readFileSync(join(t.dir, 'claude', 'settings.json'), 'utf8')
  assert.equal(text.includes(TOKEN), false, 'the device token is not copied into settings.json')
  assert.equal(t.settings().model, 'x'); assert.match(t.settings().otelHeadersHelper, /otlp-headers/)
  assert.equal(t.config().sources.claude, 'otlp')
  assert.match(t.run('otlp', 'status').stdout, /: on/)
  const headers = t.run('otlp-headers'); assert.deepEqual(JSON.parse(headers.stdout), { 'x-device-token': TOKEN })
  const sync = t.run('sync', '--agent', 'claude'); assert.equal(sync.status, 0, sync.stderr)
  const off = t.run('otlp', 'disable'); assert.equal(off.status, 0, off.stderr)
  assert.deepEqual(t.settings(), { model: 'x' }); assert.equal(t.config().sources.claude, undefined)
  assert.match(t.run('otlp', 'status').stdout, /: off/)
})

test('otlp-claude: not linked, nothing is written and the helper prints nothing', () => {
  const t = setup(); writeFileSync(join(t.dir, 'tt', 'config.json'), '{}')
  assert.notEqual(t.run('otlp', 'enable').status, 0)
  assert.equal(t.run('otlp-headers').stdout, '')
})
