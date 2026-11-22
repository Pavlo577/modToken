// Antigravity CLI (`agy`) integration: OTLP adapter, provider routing, statusLine bridge, activity plugin hooks, and install script.
// Synthetic payloads with planted secrets verify that emails, titles, prompts, answers, and file paths never leave the device or survive parsing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activityProvider } from '../src/activity.ts'
import { sortDevices } from '../src/admin/devices.ts'
import { importProvider } from '../src/import.ts'
import { limitsProvider } from '../src/limits.ts'
import { parseOtlpLogs } from '../src/otlp.ts'
import { parsePluginLog } from '../src/pluginlog.ts'

const PLUGIN = new URL('../mods/antigravity-tracker/', import.meta.url).pathname
const STATUSLINE = PLUGIN + 'hooks/statusline.py'
const ACTIVITY = PLUGIN + 'hooks/activity.py'
const INSTALLER = new URL('../scripts/install-antigravity.sh', import.meta.url).pathname
const TOKEN = 'cd'.repeat(32)

const s = (key, v) => ({ key, value: { stringValue: v } })
const i = (key, v) => ({ key, value: { intValue: String(v) } })

async function site(projectMode = 'name') {
  const got = [], logs = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', d => (body += d)).on('end', () => {
      if (req.url === '/v1/config') {
        res.end(JSON.stringify({ project: projectMode }))
        return
      }
      if (req.url === '/v1/plugin-log') logs.push(JSON.parse(body))
      else got.push({ url: req.url, token: req.headers['x-device-token'], body })
      res.end('{}')
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { got, logs, origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }
}

const runPy = (script, args, env, stdin = '') => new Promise(done => {
  const p = spawn('python3', [script, ...args], { env: { ...process.env, ...env } })
  p.stdin.end(stdin)
  let out = '', err = ''
  p.stdout.on('data', d => (out += d))
  p.stderr.on('data', d => (err += d))
  p.on('close', code => done({ code, out, err }))
})

function agyEnv(origin, extraCfg = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tt-agy-'))
  const data = join(root, 'token-tracker')
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, 'config.json'), JSON.stringify({ site: origin, token: TOKEN, ...extraCfg }))
  return { root, env: { ANTIGRAVITY_CLI_DIR: root, ANTIGRAVITY_TRACKER_DIR: data } }
}

test('antigravity otlp: parses antigravity.api_request, handles subagents, and drops planted secrets', () => {
  const payload = {
    resourceLogs: [{
      resource: { attributes: [s('service.name', 'antigravity-cli')] },
      scopeLogs: [{
        logRecords: [
          {
            timeUnixNano: '1761300000123456789',
            attributes: [
              s('event.name', 'antigravity.api_request'), s('session.id', 'conv-1'), s('prompt.id', 'turn-1'), s('request_id', 'conv-1:sl:1'),
              s('model', 'gemini-4-neon-high'), s('effort', 'high'), s('query_source', 'repl_main_thread'),
              i('input_tokens', 1200), i('output_tokens', 450), i('cache_read_tokens', 8000), i('cache_creation_tokens', 300),
              i('duration_ms', 4200), i('cost_usd_micros', 125000),
              s('user.email', 'me@SECRET.example'), s('prompt', 'SECRET PROMPT'), s('response', 'SECRET ANSWER'),
            ],
          },
          {
            timeUnixNano: '1761300005000000000',
            attributes: [
              s('event.name', 'antigravity.api_request'), s('session.id', 'conv-1'), s('prompt.id', 'turn-1'), s('request_id', 'conv-1:sl:2'),
              s('model', 'gemini-3.8-flash-medium'), s('query_source', 'subagent'),
              i('input_tokens', 500), i('output_tokens', 100), i('cache_read_tokens', 0), i('cache_creation_tokens', 0),
            ],
          },
        ],
      }],
    }],
  }
  const res = parseOtlpLogs(payload)
  assert.equal(res.ignored, 0)
  assert.equal(res.calls.length, 2)
  assert.deepEqual(res.calls[0], {
    provider: 'antigravity', call_id: 'conv-1:sl:1', session_id: 'conv-1', turn_key: 'turn-1', ts: '2025-10-24T10:00:00.123Z',
    model: 'gemini-4-neon-high', input_tokens: 1200, output_tokens: 450, cache_read_tokens: 8000, cache_creation_tokens: 300,
    duration_ms: 4200, cost_micros: 125000, is_subagent: false, kind: 'main',
  })
  assert.deepEqual([res.calls[1].provider, res.calls[1].kind, res.calls[1].is_subagent, res.calls[1].turn_key], [
    'antigravity', 'sub', true, 'turn-1:sub:gemini-3.8-flash-medium',
  ])
  assert.equal(JSON.stringify(res).includes('SECRET'), false)
})

test('antigravity providers: limits, activity, import, and plugin-log recognize antigravity', () => {
  assert.equal(limitsProvider({ provider: 'antigravity', limits: [] }), 'antigravity')
  assert.equal(activityProvider({ provider: 'antigravity' }), 'antigravity')
  assert.equal(importProvider({ provider: 'antigravity', turns: [] }), 'antigravity')
  assert.equal(parsePluginLog({ provider: 'antigravity', version: '1.0.0', events: [{ kind: 'limits', n: 2 }] }).provider, 'antigravity')
})

test('antigravity statusline: sends OTLP token deltas and normalized quotas, deduplicates repeats, and never leaks secrets', async () => {
  const srv = await site()
  try {
    const { env } = agyEnv(srv.origin)
    const snap1 = {
      cwd: '/home/SECRET-USER/project',
      conversation_id: '12345678-abcd-ef01-2345-6789abcdef01',
      conversation_title: 'SECRET TITLE about passwords',
      transcript_path: '/home/SECRET-USER/.gemini/transcript.jsonl',
      email: 'secret.person@example.com',
      version: '1.5.7',
      model: { id: 'gemini-4-neon-high', display_name: 'Gemini 4 Neon (High)', effort: 'high' },
      context_window: {
        total_input_tokens: 30000,
        total_output_tokens: 500,
        context_window_size: 1048576,
        used_percentage: 2.9,
        current_usage: { input_tokens: 29500, output_tokens: 500, cache_creation_input_tokens: 1000, cache_read_input_tokens: 20000 },
      },
      cost: { total_usd: 0.125, subagent_usd: 0, estimated: false },
      quota: {
        'gemini-weekly': { remaining_fraction: 0.85, reset_time: '2026-11-28T00:00:00Z', reset_in_seconds: 560000 },
        'gemini-5h': { remaining_fraction: 0.6, reset_in_seconds: 12000 },
        'disabled-bucket': { remaining_fraction: 0.0, disabled: true },
      },
    }
    const r1 = await runPy(STATUSLINE, ['--sync'], env, JSON.stringify(snap1))
    assert.equal(r1.code, 0); assert.equal(r1.out, '')

    // Exact same snapshot repeated: nothing sent
    const rRepeat = await runPy(STATUSLINE, ['--sync'], env, JSON.stringify(snap1))
    assert.equal(rRepeat.code, 0)
    assert.equal(srv.got.length, 2, 'only one /v1/logs and one /v1/limits')

    const logReq = srv.got.find(x => x.url === '/v1/logs')
    const limReq = srv.got.find(x => x.url === '/v1/limits')
    assert.equal(logReq.token, TOKEN); assert.equal(limReq.token, TOKEN)

    // Worker OTLP parser accepts the emitted OTLP JSON cleanly
    const parsed = parseOtlpLogs(JSON.parse(logReq.body))
    assert.equal(parsed.calls.length, 1)
    assert.deepEqual([parsed.calls[0].provider, parsed.calls[0].model, parsed.calls[0].input_tokens, parsed.calls[0].output_tokens, parsed.calls[0].cache_read_tokens, parsed.calls[0].cache_creation_tokens, parsed.calls[0].cost_micros, parsed.calls[0].is_subagent], [
      'antigravity', 'gemini-4-neon-high', 9000, 500, 20000, 1000, 125000, false,
    ])

    // Quota buckets normalized to five_hour and seven_day
    const limBody = JSON.parse(limReq.body)
    assert.equal(limBody.provider, 'antigravity')
    assert.equal(limBody.limits.length, 2)
    assert.equal(limBody.limits[0].kind, 'five_hour'); assert.equal(limBody.limits[0].percentUsed, 40)
    assert.equal(limBody.limits[1].kind, 'seven_day'); assert.equal(limBody.limits[1].percentUsed, 15)
    assert.equal(limBody.limits[1].resetsAt, '2026-11-28T00:00:00Z')

    // Second call: subagent spend delta -> marked as subagent; unchanged quota not re-sent
    const snap2 = {
      ...snap1,
      model: { id: 'gemini-3.8-flash-medium', effort: 'medium' },
      context_window: {
        total_input_tokens: 34000,
        total_output_tokens: 700,
        context_window_size: 1048576,
        used_percentage: 3.3,
        current_usage: { input_tokens: 4000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 3000 },
      },
      cost: { total_usd: 0.145, subagent_usd: 0.02, estimated: false },
    }
    const r2 = await runPy(STATUSLINE, ['--sync'], env, JSON.stringify(snap2))
    assert.equal(r2.code, 0)
    assert.equal(srv.got.length, 3, 'one more /v1/logs, no duplicate /v1/limits')
    const p2 = parseOtlpLogs(JSON.parse(srv.got[2].body))
    assert.deepEqual([p2.calls[0].input_tokens, p2.calls[0].output_tokens, p2.calls[0].cache_read_tokens, p2.calls[0].cost_micros, p2.calls[0].is_subagent, p2.calls[0].kind], [
      1000, 200, 3000, 20000, true, 'sub',
    ])

    // No planted secrets anywhere in HTTP bodies or plugin logs
    const everything = JSON.stringify({ got: srv.got, logs: srv.logs })
    for (const bad of ['SECRET', 'secret.person', 'passwords', 'transcript.jsonl']) assert.equal(everything.includes(bad), false, bad)
    assert.equal(srv.logs.length, 1)
    assert.deepEqual(srv.logs[0], { provider: 'antigravity', version: JSON.parse(readFileSync(PLUGIN + 'plugin.json', 'utf8')).version, events: [{ kind: 'limits', n: 2 }] })
  } finally { srv.close() }
})

test('antigravity statusline: chains existing custom statusLine command and prints its output', async () => {
  const srv = await site()
  try {
    const { env } = agyEnv(srv.origin, { chain_command: 'echo "MY-CUSTOM-BAR"' })
    const r = await runPy(STATUSLINE, ['--sync'], env, JSON.stringify({ conversation_id: 'c-chain', context_window: { total_input_tokens: 0, total_output_tokens: 0 } }))
    assert.equal(r.code, 0)
    assert.equal(r.out.trim(), 'MY-CUSTOM-BAR')
  } finally { srv.close() }
})

test('antigravity activity: SessionStart, PreInvocation, Stop report session, repo, timing, and context fill without leaking secrets', async () => {
  const srv = await site('name')
  try {
    const { root, env } = agyEnv(srv.origin)
    const repo = join(root, 'SECRET-DIR-NAME')
    mkdirSync(join(repo, '.git'), { recursive: true })
    writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:Pavlo577/modToken.git\n')
    const sid = 'sess-agy-1'

    const h1 = await runPy(ACTIVITY, ['SessionStart'], env, JSON.stringify({
      conversationId: sid, workspacePaths: [repo], lastUserInput: 'SECRET PROMPT', transcriptPath: '/home/SECRET/t.jsonl', modelName: 'gemini-4-neon-high',
    }))
    assert.equal(h1.code, 0); assert.equal(h1.out.trim(), '{}')

    const h2 = await runPy(ACTIVITY, ['PreInvocation'], env, JSON.stringify({ conversationId: sid, lastUserInput: 'SECRET PROMPT' }))
    assert.equal(h2.code, 0); assert.equal(h2.out.trim(), '{}')

    // statusLine writes context_window snapshot + emits OTLP using the active turn's prompt.id
    await runPy(STATUSLINE, ['--sync'], env, JSON.stringify({
      conversation_id: sid,
      model: { id: 'gemini-4-neon-high' },
      context_window: {
        total_input_tokens: 5000, total_output_tokens: 300, context_window_size: 1000000, used_percentage: 0.5,
        current_usage: { input_tokens: 5000, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }))

    const h3 = await runPy(ACTIVITY, ['Stop'], env, JSON.stringify({ conversationId: sid, lastUserInput: 'SECRET PROMPT' }))
    assert.equal(h3.code, 0); assert.equal(h3.out.trim(), '{}')

    const actReqs = srv.got.filter(x => x.url === '/v1/activity').map(x => JSON.parse(x.body))
    assert.equal(actReqs.length, 2)
    assert.equal(actReqs[0].provider, 'antigravity')
    assert.equal(actReqs[0].session.project, 'Pavlo577/modToken')
    assert.equal(actReqs[1].provider, 'antigravity')
    assert.equal(actReqs[1].turns.length, 1)
    assert.deepEqual([actReqs[1].turns[0].context_tokens, actReqs[1].turns[0].context_window, actReqs[1].turns[0].context_pct], [5000, 1000000, 0.5])

    // OTLP prompt.id matches the activity turn id
    const otlpReq = srv.got.find(x => x.url === '/v1/logs')
    const [call] = parseOtlpLogs(JSON.parse(otlpReq.body)).calls
    assert.equal(call.turn_key, actReqs[1].turns[0].id)

    assert.equal(JSON.stringify(srv.got).includes('SECRET'), false)
  } finally { srv.close() }
})

test('antigravity plugin & install-antigravity.sh: idempotent install, chains existing statusLine, chmod 600, never prints token', () => {
  const manifest = JSON.parse(readFileSync(PLUGIN + 'plugin.json', 'utf8'))
  assert.equal(manifest.name, 'token-tracker')
  const hooks = JSON.parse(readFileSync(PLUGIN + 'hooks.json', 'utf8'))
  assert.deepEqual(Object.keys(hooks['token-tracker']).sort(), ['PreInvocation', 'SessionStart', 'Stop'])
  for (const ev of ['SessionStart', 'PreInvocation', 'Stop']) {
    assert.equal(hooks['token-tracker'][ev][0].type, 'command', `${ev} must use flat handler object`)
  }

  const base = mkdtempSync(join(tmpdir(), 'tt-agy-inst-'))
  const cliDir = join(base, 'antigravity-cli')
  const cfgDir = join(base, 'config')
  mkdirSync(cliDir, { recursive: true })
  writeFileSync(join(cliDir, 'settings.json'), JSON.stringify({ theme: 'dark', statusLine: { type: 'command', command: '~/my-bar.sh' } }))

  const raw = 'file://' + new URL('..', import.meta.url).pathname.replace(/\/$/, '')
  const run = (...args) => spawnSync('bash', [INSTALLER, ...args], {
    env: { ...process.env, ANTIGRAVITY_CLI_DIR: cliDir, GEMINI_CONFIG_DIR: cfgDir, TT_RAW: raw },
    encoding: 'utf8',
  })

  const r1 = run('https://x.test/', 'tok-one')
  assert.equal(r1.status, 0, r1.stderr)
  assert.equal(r1.stdout.includes('tok-one'), false)

  const settings = JSON.parse(readFileSync(join(cliDir, 'settings.json'), 'utf8'))
  assert.equal(settings.theme, 'dark')
  assert.equal(settings.statusLine.stack_with_default, true)
  assert.ok(settings.statusLine.command.includes('token-tracker/hooks/statusline.py'))

  const cfgPath = join(cliDir, 'token-tracker', 'config.json')
  const cfg1 = JSON.parse(readFileSync(cfgPath, 'utf8'))
  assert.deepEqual(cfg1, { site: 'https://x.test', token: 'tok-one', chain_command: '~/my-bar.sh' })
  assert.equal(statSync(cfgPath).mode & 0o777, 0o600)

  // Second run updates token without losing chain_command or clobbering plugin
  const r2 = run('https://x.test', 'tok-two')
  assert.equal(r2.status, 0)
  assert.equal(r2.stdout.includes('tok-two'), false)
  assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf8')), { site: 'https://x.test', token: 'tok-two', chain_command: '~/my-bar.sh' })
  assert.ok(existsSync(join(cfgDir, 'plugins', 'token-tracker', 'hooks.json')))
  assert.equal(run('https://x.test').status, 1) // missing token refused
})

test('devices: devices without interactions stay at the top (newest first), then sorted by last_seen descending', () => {
  const ordered = sortDevices([
    { name: 'older-used', created_at: '2026-11-20T10:00:00Z', last_seen: '2026-11-21T10:00:00Z' },
    { name: 'never-old', created_at: '2026-11-19T10:00:00Z', last_seen: null },
    { name: 'latest-used', created_at: '2026-11-18T10:00:00Z', last_seen: '2026-11-22T00:01:00Z' },
    { name: 'never-new', created_at: '2026-11-21T23:00:00Z', last_seen: null },
  ])
  assert.deepEqual(ordered.map(d => d.name), ['never-new', 'never-old', 'latest-used', 'older-used'])
})
