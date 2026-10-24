// The settings a device pastes: they point Claude Code's logs at /v1/logs as JSON, keep metrics and traces off and never ask for prompt text.
import test from 'node:test'
import assert from 'node:assert/strict'
import { settingsJson, setupEnv, shellEnv } from '../web/lib/setup.ts'

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
