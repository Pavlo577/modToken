// scripts/codex-limits.py: Codex's rate-limit windows from its session files to POST /v1/limits, and nothing else (synthetic files, a local server).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = new URL('../scripts/codex-limits.py', import.meta.url).pathname
const TOKEN = 'ab'.repeat(32)

const run = (home, args = []) => new Promise(done => {
  const p = spawn('python3', [SCRIPT, ...args], { env: { ...process.env, CODEX_HOME: home } })
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

function codexHome(origin, lines) {
  const home = mkdtempSync(join(tmpdir(), 'tt-codex-limits-'))
  writeFileSync(join(home, 'config.toml'), `model = "gpt-5.6-sol"\n\n# >>> token-tracker\n[otel]\nexporter = { otlp-http = { endpoint = "${origin}/v1/logs", protocol = "json", headers = { "x-device-token" = "${TOKEN}" } } }\n# <<< token-tracker\n`)
  const day = join(home, 'sessions', '2026', '10', '29')
  mkdirSync(day, { recursive: true })
  writeFileSync(join(day, 'rollout-2026-10-29T20-24-22-01a18955.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
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
    const r = await run(home, ['{"type":"agent-turn-complete","last-assistant-message":"SECRET ANSWER"}'])
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
