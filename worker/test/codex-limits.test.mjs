// The token-tracker plugin for Codex (mods/codex-tracker): its Stop hook sends the rate-limit windows from Codex's session files to
// POST /v1/limits, and nothing else (synthetic files, a local server).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PLUGIN = new URL('../mods/codex-tracker/', import.meta.url).pathname
const SCRIPT = PLUGIN + 'hooks/limits.py'
const TOKEN = 'ab'.repeat(32)

const run = (home, args = [], stdin = '') => new Promise(done => {
  const p = spawn('python3', [SCRIPT, ...args], { env: { ...process.env, CODEX_HOME: home } })
  p.stdin.end(stdin)
  let out = ''
  p.stdout.on('data', d => (out += d)); p.stderr.on('data', d => (out += d))
  p.on('close', code => done({ code, out }))
})

/** A local stand-in for the site: the requests it got. */
async function site() {
  const got = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', d => (body += d)).on('end', () => { got.push({ url: req.url, token: req.headers['x-device-token'], body }); res.end('{}') })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { got, origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }
}

function codexHome(origin, lines, name = 'rollout-2026-10-29T20-24-22-01a18955.jsonl') {
  const home = mkdtempSync(join(tmpdir(), 'tt-codex-limits-'))
  writeFileSync(join(home, 'config.toml'), `model = "gpt-5.6-sol"\n\n# >>> token-tracker\n[otel]\nexporter = { otlp-http = { endpoint = "${origin}/v1/logs", protocol = "json", headers = { "x-device-token" = "${TOKEN}" } } }\n# <<< token-tracker\n`)
  const day = join(home, 'sessions', '2026', '10', '29')
  mkdirSync(day, { recursive: true })
  writeFileSync(join(day, name), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return home
}

const tokenCount = (rate_limits, timestamp = '2026-10-29T20:27:18.161Z') => ({ timestamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5 } }, rate_limits } })

test('codex limits: the last token_count with rate_limits is sent as five_hour and seven_day, with the token, and nothing of the conversation', async () => {
  const s = await site()
  try {
    const home = codexHome(s.origin, [
      { timestamp: '2026-10-29T20:24:22.000Z', type: 'session_meta', payload: { id: '01a18955', cwd: '/home/SECRET-PATH' } },
      tokenCount({ primary: { used_percent: 3, window_minutes: 300, resets_at: 1793305000 } }, '2026-10-29T20:25:00.000Z'),
      { timestamp: '2026-10-29T20:26:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SECRET PROMPT' }] } },
      tokenCount({ primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1793322000 }, secondary: { used_percent: 41, window_minutes: 10080, resets_at: 1793700000 }, plan_type: 'plus', credits: { balance: '7' } }),
      tokenCount(null, '2026-10-29T20:27:19.000Z'), // a later count without limits does not hide the last one that had them
    ])
    const r = await run(home, [], JSON.stringify({ hook_event_name: 'Stop', session_id: 's', transcript_path: null, last_assistant_message: 'SECRET ANSWER', cwd: '/home/SECRET-CWD' }))
    assert.equal(r.code, 0); assert.equal(r.out, '')
    assert.equal(s.got.length, 1)
    assert.equal(s.got[0].url, '/v1/limits'); assert.equal(s.got[0].token, TOKEN)
    assert.deepEqual(JSON.parse(s.got[0].body), { provider: 'codex', limits: [
      { kind: 'five_hour', percentUsed: 12.5, resetsAt: '2026-10-30T01:00:00+00:00' },
      { kind: 'seven_day', percentUsed: 41, resetsAt: '2026-11-03T10:00:00+00:00' },
    ] })
    for (const bad of ['SECRET', 'plus', 'balance']) assert.equal(s.got[0].body.includes(bad), false, bad)
  } finally { s.close() }
})

test('codex limits: older files with resets_in_seconds, other windows by name; no limits or no config sends nothing and stays silent', async () => {
  const s = await site()
  try {
    await run(codexHome(s.origin, [tokenCount({ primary: { used_percent: 7, window_minutes: 60, resets_in_seconds: 600 } })]))
    assert.deepEqual(JSON.parse(s.got[0].body).limits, [{ kind: 'primary', percentUsed: 7, resetsAt: '2026-10-29T20:37:18.161000+00:00' }])
    const quiet = await run(codexHome(s.origin, [tokenCount(null)]))
    assert.equal(s.got.length, 1); assert.equal(quiet.code, 0); assert.equal(quiet.out, '')
    const nowhere = await run(mkdtempSync(join(tmpdir(), 'tt-codex-empty-')))
    assert.equal(nowhere.code, 0); assert.equal(nowhere.out, '')
  } finally { s.close() }
})

test('codex limits: the Stop hook names the session file: that one is read, not the newest', async () => {
  const s = await site()
  try {
    const home = codexHome(s.origin, [tokenCount({ primary: { used_percent: 90, window_minutes: 300, resets_at: 1793322000 } })], 'rollout-2026-10-29T23-00-00-newest.jsonl')
    const other = join(home, 'sessions', '2026', '10', '29', 'rollout-2026-10-29T20-00-00-named.jsonl')
    writeFileSync(other, JSON.stringify(tokenCount({ primary: { used_percent: 5, window_minutes: 300, resets_at: 1793322000 } })) + '\n')
    await run(home, [], JSON.stringify({ hook_event_name: 'Stop', transcript_path: other, last_assistant_message: 'SECRET' }))
    assert.deepEqual(JSON.parse(s.got[0].body).limits.map(l => l.percentUsed), [5])
  } finally { s.close() }
})

test('codex plugin: the manifest points at the hooks file, the Stop hook runs the collector that is in the plugin', () => {
  const manifest = JSON.parse(readFileSync(PLUGIN + '.codex-plugin/plugin.json', 'utf8'))
  assert.equal(manifest.name, 'token-tracker')
  const hooks = JSON.parse(readFileSync(PLUGIN + manifest.hooks.replace(/^\.\//, ''), 'utf8'))
  assert.deepEqual(Object.keys(hooks).sort(), ['description', 'hooks']) // Codex reads a hooks file with deny_unknown_fields
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ['SessionStart', 'Stop'])
  assert.equal(hooks.hooks.SessionStart[0].hooks[0].async, undefined) // Codex skips async hooks: the script detaches itself instead
  for (const [event, script] of [['Stop', 'limits'], ['SessionStart', 'history']]) {
    const [h] = hooks.hooks[event][0].hooks
    assert.equal(h.type, 'command')
    for (const cmd of [h.command, h.commandWindows]) {
      const file = /\$\{PLUGIN_ROOT\}[/\\](hooks[/\\]\w+\.(py|ps1))/.exec(cmd)[1].replace(/\\/g, '/')
      assert.ok(file.startsWith('hooks/' + script + '.') && existsSync(PLUGIN + file), file)
    }
  }
})

test('codex limits: a failed send leaves only its message in the data folder, never the token, and prints nothing', async () => {
  const home = codexHome('http://127.0.0.1:1', [tokenCount({ primary: { used_percent: 1, window_minutes: 300, resets_at: 1793322000 } })]) // nothing listens there
  const data = mkdtempSync(join(tmpdir(), 'tt-codex-data-'))
  const r = await new Promise(done => {
    const p = spawn('python3', [SCRIPT], { env: { ...process.env, CODEX_HOME: home, PLUGIN_DATA: data } })
    p.stdin.end(''); let out = ''
    p.stdout.on('data', d => (out += d)); p.stderr.on('data', d => (out += d))
    p.on('close', code => done({ code, out }))
  })
  assert.equal(r.code, 0); assert.equal(r.out, '')
  const log = readFileSync(join(data, 'last-error.txt'), 'utf8')
  assert.ok(log.length > 20 && !log.includes(TOKEN))
})

// ---- the history import (hooks/history.py, run by the SessionStart hook)
const HISTORY = PLUGIN + 'hooks/history.py'
const runHistory = (home, data, args = ['--run']) => new Promise(done => {
  const p = spawn('python3', [HISTORY, ...args], { env: { ...process.env, CODEX_HOME: home, PLUGIN_DATA: data } })
  p.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: '/home/SECRET-CWD' }))
  let out = ''
  p.stdout.on('data', d => (out += d)); p.stderr.on('data', d => (out += d))
  p.on('close', code => done({ code, out }))
})
const usage = (input, cached, output, total) => ({ total_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total },
  last_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output } })
const SID = '01a189a3-0214-7c72-b88f-5c6d65b5c981'
const ev = (timestamp, payload) => ({ timestamp, type: 'event_msg', payload })

test('codex history: each new token_count is a call, the first after task_started is the turn; numbers only, sent once', async () => {
  const s = await site()
  try {
    const home = codexHome(s.origin, [
      { timestamp: '2026-10-20T10:00:00.000Z', type: 'session_meta', payload: { id: SID, cwd: '/home/SECRET-PATH', instructions: 'SECRET' } },
      { timestamp: '2026-10-20T10:00:00.100Z', type: 'turn_context', payload: { cwd: '/home/SECRET-PATH', approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write' }, model: 'gpt-5.6-sol' } },
      ev('2026-10-20T10:00:01.000Z', { type: 'task_started', turn_id: 't1' }),
      ev('2026-10-20T10:00:01.100Z', { type: 'user_message', message: 'SECRET PROMPT that mentions "token_count" on purpose' }),
      ev('2026-10-20T10:00:03.000Z', { type: 'token_count', info: usage(11000, 9000, 120, 11120), rate_limits: null }),
      ev('2026-10-20T10:00:03.500Z', { type: 'token_count', info: usage(11000, 9000, 120, 11120), rate_limits: { primary: { used_percent: 4 } } }), // the same totals: no call
      { timestamp: '2026-10-20T10:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SECRET ANSWER' }] } },
      ev('2026-10-20T10:00:09.000Z', { type: 'token_count', info: usage(12000, 11000, 300, 23420) }),
      ev('2026-10-20T10:01:00.000Z', { type: 'task_started', turn_id: 't2' }),
      ev('2026-10-20T10:01:02.000Z', { type: 'token_count', info: usage(12500, 12000, 50, 35970) }),
    ], `rollout-2026-10-20T10-00-00-${SID}.jsonl`)
    const data = mkdtempSync(join(tmpdir(), 'tt-codex-hist-'))
    const r = await runHistory(home, data)
    assert.equal(r.code, 0); assert.equal(r.out, '')
    assert.equal(s.got.length, 1); assert.equal(s.got[0].url, '/v1/import'); assert.equal(s.got[0].token, TOKEN)
    const body = JSON.parse(s.got[0].body)
    assert.equal(body.provider, 'codex')
    assert.deepEqual(body.turns.map(t => [t.id, t.ts, t.model, t.input, t.cache_read, t.output, t.first, t.bg, t.duration_ms]), [
      [`cx:${SID}:1`, '2026-10-20T10:00:03.000Z', 'gpt-5.6-sol', 2000, 9000, 120, true, false, 8000], // the turn lasts from task_started to its last call
      [`cx:${SID}:2`, '2026-10-20T10:00:09.000Z', 'gpt-5.6-sol', 1000, 11000, 300, false, false, 0],
      [`cx:${SID}:3`, '2026-10-20T10:01:02.000Z', 'gpt-5.6-sol', 500, 12000, 50, true, false, 2000],
    ])
    for (const bad of ['SECRET', 'home/']) assert.equal(s.got[0].body.includes(bad), false, bad)
    // the marker: the next session start sends nothing
    assert.ok(readFileSync(join(data, 'history-imported'), 'utf8').includes(' 3'))
    await runHistory(home, data)
    assert.equal(s.got.length, 1)
  } finally { s.close() }
})

test('codex history: a session Codex started by itself (no approvals, read-only) is background; a failed send leaves no marker', async () => {
  const s = await site()
  try {
    const lines = [
      { timestamp: '2026-10-20T11:00:00.000Z', type: 'session_meta', payload: { id: SID } },
      { timestamp: '2026-10-20T11:00:00.100Z', type: 'turn_context', payload: { cwd: '/x', approval_policy: 'never', sandbox_policy: { type: 'read-only' }, model: 'gpt-5.6-luna' } },
      ev('2026-10-20T11:00:01.000Z', { type: 'task_started', turn_id: 't1' }),
      ev('2026-10-20T11:00:02.000Z', { type: 'token_count', info: usage(8900, 7000, 40, 8940) }),
    ]
    const data = mkdtempSync(join(tmpdir(), 'tt-codex-hist-'))
    await runHistory(codexHome(s.origin, lines), data)
    assert.deepEqual(JSON.parse(s.got[0].body).turns.map(t => [t.bg, t.model]), [[true, 'gpt-5.6-luna']])
    const failed = mkdtempSync(join(tmpdir(), 'tt-codex-hist-'))
    const r = await runHistory(codexHome('http://127.0.0.1:1', lines), failed)
    assert.equal(r.out, '')
    assert.equal(existsSync(join(failed, 'history-imported')), false) // tried again at the next session start
    assert.ok(readFileSync(join(failed, 'last-error.txt'), 'utf8').includes('history'))
  } finally { s.close() }
})

test('codex history: as the hook runs it (no --run), it returns at once and the import goes on in a detached process', async () => {
  const s = await site()
  try {
    const home = codexHome(s.origin, [
      { timestamp: '2026-10-20T11:00:00.000Z', type: 'session_meta', payload: { id: SID } },
      ev('2026-10-20T11:00:01.000Z', { type: 'task_started', turn_id: 't1' }),
      ev('2026-10-20T11:00:02.000Z', { type: 'token_count', info: usage(500, 0, 10, 510) }),
    ])
    const data = mkdtempSync(join(tmpdir(), 'tt-codex-hist-'))
    const started = Date.now()
    const r = await runHistory(home, data, [])
    assert.equal(r.code, 0); assert.equal(r.out, '')
    assert.ok(Date.now() - started < 3000)
    assert.ok(existsSync(join(data, 'history-started'))) // the trace that the hook ran
    for (let i = 0; i < 50 && !existsSync(join(data, 'history-imported')); i++) await new Promise(ok => setTimeout(ok, 100))
    assert.equal(s.got.length, 1)
    assert.equal(JSON.parse(s.got[0].body).turns[0].input, 500)
  } finally { s.close() }
})
