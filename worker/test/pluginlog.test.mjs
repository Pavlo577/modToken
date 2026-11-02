// POST /v1/plugin-log keeps a kind, counts, an error's type and a stage word; never an error message, a path or anything else.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { droppedNames } from '../src/dropped.ts'
import { parsePluginLog } from '../src/pluginlog.ts'

test('plugin log: known kinds with counts, an error type and a stage; nothing else survives', () => {
  const log = parsePluginLog({
    provider: 'codex', version: '1.3.0', cwd: '/home/SECRET',
    events: [
      { kind: 'history_imported', n: 421, total: 558 },
      { kind: 'error', error: 'URLError', stage: 'limits', message: 'cannot open C:\\Users\\SECRET\\x' },
      { kind: 'error', error: 'Error: SECRET path /home/x', stage: 'Bad Stage' },
      { kind: 'rm -rf', n: 1 }, { kind: 'limits', n: -5, total: 1.5 }, null,
    ],
  })
  assert.deepEqual(log, { provider: 'codex', version: '1.3.0', events: [
    { kind: 'history_imported', n: 421, total: 558 },
    { kind: 'error', error: 'URLError', stage: 'limits' },
    { kind: 'error' },
    { kind: 'limits' },
  ] })
  assert.equal(JSON.stringify(log).includes('SECRET'), false)
  assert.deepEqual(droppedNames('plugin_log', { provider: 'codex', version: '1', cwd: 'x', events: [{ kind: 'limits', message: 'x' }] }), ['cwd', 'events.message'])
})

test('plugin log: a body without events is refused; an unknown provider is the Claude mod; a version must be a version', () => {
  assert.equal(parsePluginLog({ provider: 'codex' }), null)
  assert.equal(parsePluginLog([]), null)
  assert.equal(parsePluginLog({ provider: 'x', version: 'SECRET VALUE', events: [] }).provider, 'claude')
  assert.equal(parsePluginLog({ version: 'SECRET VALUE', events: [] }).version, '')
})

test('plugin log: the Claude mod reports the version its plugin.json says', () => {
  const version = JSON.parse(readFileSync(new URL('../mods/token-tracker/.claude-plugin/plugin.json', import.meta.url), 'utf8')).version
  assert.ok(readFileSync(new URL('../mods/token-tracker/hooks/register.ts', import.meta.url), 'utf8').includes(`const MOD_VERSION = '${version}'`), version)
})
