// The Claude Code agent of the collector (collectors/agents/claude.mjs): synthetic session logs, a fake site, no real ~/.claude.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dir } from './codex-home.mjs' // CODEX_HOME, TOKEN_TRACKER_HOME and CLAUDE_CONFIG_DIR point into a temporary directory

const claude = (await import('../../collectors/agents/claude.mjs')).default
const { claudeHookCommand, allowedTranscript } = await import('../../collectors/agents/claude.mjs')
const { ROW_KEYS } = await import('../../collectors/lib/contract.mjs')
const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const projects = join(dir, 'claude', 'projects', '-work-app')
const tt = join(dir, 'tt')
const SECRET = 'SECRET-PROMPT-TEXT'

const usage = (i, o, cr = 0, cc = 0) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cc })
const prompt = (ts, session) => JSON.stringify({ type: 'user', timestamp: ts, sessionId: session, message: { role: 'user', content: SECRET } })
const reply = (ts, session, id, u, model = 'claude-sonnet-x', extra = {}) => JSON.stringify({ type: 'assistant', timestamp: ts, sessionId: session, ...extra, message: { id, model, role: 'assistant', content: [{ type: 'text', text: SECRET }], usage: u } })

/** Resets what a test leaves: logs, state, link (since = `since`), and a fake site that records what is sent to it. */
function setup({ since = '2026-10-24T00:00:00Z' } = {}) {
  rmSync(join(dir, 'claude'), { recursive: true, force: true })
  mkdirSync(projects, { recursive: true })
  for (const f of ['claude-state.json', 'claude-sync.lock', 'notify.log']) rmSync(join(tt, f), { force: true })
  mkdirSync(tt, { recursive: true })
  writeFileSync(join(tt, 'config.json'), JSON.stringify({ url: 'https://unit.invalid', token: 'tok', device: 'unit', since }))
  const calls = []
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return url.endsWith('/api/import') ? Response.json({ inserted: 2, duplicates: 1, afterLink: 0 }) : new Response(null, { status: 204 }) }
  return calls
}
const sentRows = calls => calls.filter(c => c.url.endsWith('/api/ingest')).flatMap(c => c.body.rows)
const log = (session, lines) => { const f = join(projects, `${session}.jsonl`); writeFileSync(f, lines.join('\n') + '\n'); return f }

test('claude: a turn is the prompt and all its replies; a reply logged per content block counts once; ids are cc:<session>:<n>', async () => {
  const calls = setup()
  const f = log('sess-A', [
    prompt('2026-10-24T10:00:00Z', 'sess-A'),
    reply('2026-10-24T10:00:05Z', 'sess-A', 'm1', usage(100, 20, 500, 10)),
    reply('2026-10-24T10:00:05Z', 'sess-A', 'm1', usage(100, 20, 500, 10)), // the same API message, another content block
    reply('2026-10-24T10:00:09Z', 'sess-A', 'm2', usage(30, 40, 700, 0), 'claude-opus-x'),
    prompt('2026-10-24T10:05:00Z', 'sess-A'),
    reply('2026-10-24T10:05:04Z', 'sess-A', 'm3', usage(7, 3), 'claude-sonnet-x', { isSidechain: true }),
  ])
  const r = await claude.sync()
  assert.equal(r.rows, 2)
  const rows = sentRows(calls)
  assert.deepEqual(rows.map(t => t.turn_id), ['cc:sess-A:1', 'cc:sess-A:2'])
  assert.deepEqual([rows[0].provider, rows[0].session_id, rows[0].input_tokens, rows[0].output_tokens, rows[0].cache_read_tokens, rows[0].cache_creation_tokens, rows[0].model, rows[0].ts, rows[0].duration_ms, rows[0].is_subagent],
    ['claude', 'sess-A', 130, 60, 1200, 10, 'claude-opus-x', '2026-10-24T10:00:09.000Z', 9000, false])
  assert.equal(rows[1].is_subagent, true)
  assert.ok(existsSync(f))
})

test('claude: only turns that ended since the device was linked here; the rest is history', async () => {
  const calls = setup({ since: '2026-10-24T10:03:00Z' })
  log('sess-B', [prompt('2026-10-24T10:00:00Z', 'sess-B'), reply('2026-10-24T10:00:05Z', 'sess-B', 'm1', usage(1, 1)), prompt('2026-10-24T10:05:00Z', 'sess-B'), reply('2026-10-24T10:05:04Z', 'sess-B', 'm2', usage(2, 2))])
  await claude.sync()
  assert.deepEqual(sentRows(calls).map(t => t.turn_id), ['cc:sess-B:2'])
})

test('claude: nothing is sent twice, a turn that grew is sent again with the same id, nothing leaks', async () => {
  const calls = setup()
  const f = log('sess-C', [prompt('2026-10-24T10:00:00Z', 'sess-C'), reply('2026-10-24T10:00:05Z', 'sess-C', 'm1', usage(10, 5))])
  await claude.sync()
  assert.equal((await claude.sync()).rows, 0, 'unchanged: nothing')
  appendFileSync(f, reply('2026-10-24T10:00:30Z', 'sess-C', 'm2', usage(20, 8)) + '\n')
  assert.equal((await claude.sync()).rows, 1)
  const rows = sentRows(calls)
  assert.deepEqual(rows.map(t => [t.turn_id, t.input_tokens, t.output_tokens]), [['cc:sess-C:1', 10, 5], ['cc:sess-C:1', 30, 13]])
  // what leaves: exactly the contract's fields; and no prompt text in the request, the state or the log
  for (const c of calls) assert.ok(!JSON.stringify(c.body).includes(SECRET))
  for (const r of rows) assert.deepEqual(Object.keys(r).sort(), [...ROW_KEYS].sort())
  for (const name of readdirSync(tt)) assert.ok(!readFileSync(join(tt, name), 'utf8').includes(SECRET), `${name} holds no text`)
})

test('claude: a hook may name only a real log inside the projects directory (and the sub-agent logs beside it come along)', async () => {
  const calls = setup()
  const main = log('sess-D', [prompt('2026-10-24T10:00:00Z', 'sess-D'), reply('2026-10-24T10:00:05Z', 'sess-D', 'm1', usage(10, 5))])
  mkdirSync(join(projects, 'sess-D', 'subagents'), { recursive: true })
  writeFileSync(join(projects, 'sess-D', 'subagents', 'agent-1.jsonl'), [prompt('2026-10-24T10:00:02Z', 'sess-D'), reply('2026-10-24T10:00:03Z', 'sess-D', 's1', usage(4, 2), 'claude-haiku-x', { isSidechain: true })].join('\n') + '\n')
  // outside the projects directory, a symlink that leads out, a file that is not a log
  const outside = join(tmpdir(), `outside-${Date.now()}.jsonl`)
  writeFileSync(outside, prompt('2026-10-24T11:00:00Z', 'x') + '\n' + reply('2026-10-24T11:00:01Z', 'x', 'o1', usage(1, 1)) + '\n')
  symlinkSync(outside, join(projects, 'sneaky.jsonl'))
  assert.equal(allowedTranscript(outside), null)
  assert.equal(allowedTranscript(join(projects, 'sneaky.jsonl')), null)
  assert.equal(allowedTranscript(join(projects, 'nope.jsonl')), null)
  assert.equal(allowedTranscript('/etc/passwd'), null)
  assert.ok(allowedTranscript(main))
  assert.equal((await claude.sync({ only: outside })).rows, 0)
  assert.equal((await claude.sync({ only: join(projects, 'sneaky.jsonl') })).rows, 0)
  const r = await claude.sync({ only: main })
  assert.equal(r.rows, 2, 'the session and its sub-agent')
  assert.deepEqual(sentRows(calls).map(t => [t.turn_id, t.is_subagent]).sort(), [['cc:agent-1:1', true], ['cc:sess-D:1', false]])
  unlinkSync(outside)
})

test('claude: the history from before the device is sent as imp:<path>:<n> through /api/import, once per message across copies', async () => {
  const calls = setup()
  log('sess-E', [prompt('2026-10-20T10:00:00Z', 'sess-E'), reply('2026-10-20T10:00:05Z', 'sess-E', 'm1', usage(10, 5)), prompt('2026-10-20T11:00:00Z', 'sess-E'), reply('2026-10-20T11:00:05Z', 'sess-E', 'm2', usage(3, 2))])
  mkdirSync(join(dir, 'claude', 'projects', '-other'), { recursive: true })
  writeFileSync(join(dir, 'claude', 'projects', '-other', 'copy.jsonl'), [prompt('2026-10-20T10:00:00Z', 'sess-E'), reply('2026-10-20T10:00:05Z', 'sess-E', 'm1', usage(10, 5))].join('\n') + '\n') // a copy of the same message
  const r = await claude.importHistory()
  // the fake site answers every call with 2 inserted + 1 duplicate; there is one call per file
  assert.deepEqual([r.files, r.turns, r.inserted, r.duplicates], [2, 2, 4, 2])
  const imports = calls.filter(c => c.url.endsWith('/api/import')).flatMap(c => c.body.rows)
  // the copy sorts first, so it owns the shared message; the original keeps only the turn that is its own (numbered 2)
  assert.deepEqual(imports.map(t => t.turn_id).sort(), ['imp:-other/copy:1', 'imp:-work-app/sess-E:2'])
  assert.ok(imports.every(t => t.provider === 'claude' && t.turn_id.startsWith('imp:')))
  assert.ok(!JSON.stringify(calls).includes(SECRET))
})

test('claude: the Stop hook is added next to the others (the cloud hook included), recognised, and taken out again; broken JSON is never touched', () => {
  setup()
  const file = claude.hooksJson
  const cloud = { matcher: '', hooks: [{ type: 'command', command: 'node "$HOME/.claude/token-tracker/stop-hook.mjs"' }] }
  const before = { permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [cloud], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'audit.sh' }] }] } }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(before))
  assert.equal(claude.hookState(), 'none', 'the cloud hook is not ours')
  assert.equal(claude.enabled(), false, 'Claude Code is collected only when chosen')
  const r = claude.installHook()
  assert.equal(r.changed, true); assert.ok(readFileSync(r.backup, 'utf8') === JSON.stringify(before))
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(doc.permissions, before.permissions); assert.deepEqual(doc.hooks.PreToolUse, before.hooks.PreToolUse)
  assert.equal(doc.hooks.Stop.length, 2); assert.deepEqual(doc.hooks.Stop[0], cloud)
  assert.match(doc.hooks.Stop[1].hooks[0].command, /hook-stop --agent claude$/)
  assert.equal(claude.hookState(), 'ours'); assert.equal(claude.enabled(), true)
  assert.equal(claude.installHook().changed, false)
  claude.removeHook()
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), before)
  writeFileSync(file, '{ broken')
  assert.equal(claude.hookState(), 'unreadable'); assert.equal(claude.installHook().changed, false); assert.equal(readFileSync(file, 'utf8'), '{ broken')
  rmSync(file)
  assert.equal(claude.installHook().changed, true, 'no settings file yet: created')
  claude.removeHook(); assert.equal(existsSync(file), false)
})

test('claude: the hook command line for the shell Claude Code runs it in', () => {
  assert.equal(claudeHookCommand(['C:\\Users\\IOOOI\\Downloads\\token-tracker-windows-x64 (2).exe'], 'win32'), '"C:/Users/IOOOI/Downloads/token-tracker-windows-x64 (2).exe" hook-stop --agent claude')
  assert.equal(claudeHookCommand(['/opt/my tools/token-tracker'], 'linux'), "'/opt/my tools/token-tracker' hook-stop --agent claude")
})

test('claude: hook-stop --agent claude is silent, exits 0 and logs who called, never the text', () => {
  // its own home: the shared one holds the log of other tests (they run in one process under bun)
  const home = mkdtempSync(join(tmpdir(), 'claude-hook-'))
  const input = JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', transcript_path: join(projects, 'sess-F.jsonl'), cwd: '/secret/dir', last_assistant_message: SECRET, stop_hook_active: false })
  const r = spawnSync(process.execPath, [join(root, 'collectors/token-tracker.mjs'), 'hook-stop', '--agent', 'claude'], { input, env: { ...process.env, TOKEN_TRACKER_HOME: home, CLAUDE_CONFIG_DIR: join(dir, 'claude'), CODEX_HOME: join(dir, 'none') } })
  assert.equal(r.status, 0); assert.equal(String(r.stdout), '')
  const text = readFileSync(join(home, 'notify.log'), 'utf8')
  const ev = text.split('\n').filter(Boolean).map(l => JSON.parse(l))
  const got = ev.find(e => e.event === 'hook_received')
  assert.deepEqual([got.agent, got.hook, got.hasSessionId, got.hasTranscript], ['claude', 'Stop', true, true])
  assert.ok(!text.includes(SECRET) && !text.includes('/secret/dir'))
})

test('claude: a plain `sync` leaves Claude Code alone until the user chose it (Codex-only users send no Claude turns)', () => {
  const home = mkdtempSync(join(tmpdir(), 'optin-')), claudeDir = join(home, 'claude'), proj = join(claudeDir, 'projects', '-p')
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(proj, 's.jsonl'), prompt('2030-01-01T10:00:00Z', 's') + '\n' + reply('2030-01-01T10:00:05Z', 's', 'm1', usage(5, 5)) + '\n')
  writeFileSync(join(home, 'config.json'), JSON.stringify({ url: 'http://127.0.0.1:1', token: 't', since: '2020-01-01T00:00:00Z' }))
  const env = { ...process.env, TOKEN_TRACKER_HOME: home, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: join(home, 'none') }
  const cli = join(root, 'collectors/token-tracker.mjs')
  const off = spawnSync(process.execPath, [cli, 'sync'], { env })
  assert.equal(off.status, 0); assert.equal(String(off.stdout).trim(), '', 'nothing is read or sent')
  assert.equal(existsSync(join(home, 'claude-state.json')), false, 'not even a state file')
  // chosen: its Stop hook is in settings.json -> it is part of a plain sync (the site is unreachable here, so it reports that, which proves it ran)
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `'${process.execPath}' '${cli}' hook-stop --agent claude` }] }] } }))
  const on = spawnSync(process.execPath, [cli, 'sync'], { env })
  assert.equal(on.status, 1); assert.match(String(on.stderr), /could not reach the site/)
})
