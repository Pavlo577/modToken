import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasOurHook, hookCommand, isEmptyDoc, isOurHook, quoteArg, withHook, withoutHook } from '../../collectors/lib/hooks-json.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const WIN = ['C:\\Users\\IOOOI\\Downloads\\token-tracker-windows-x64 (2).exe']
const UNIX = ['/opt/my tools/token-tracker']

test('hook command line: quoted for cmd.exe on Windows and for sh elsewhere, paths with spaces and brackets survive', () => {
  assert.equal(hookCommand(WIN, 'win32'), '"C:\\Users\\IOOOI\\Downloads\\token-tracker-windows-x64 (2).exe" hook-stop')
  assert.equal(hookCommand(UNIX, 'linux'), "'/opt/my tools/token-tracker' hook-stop")
  assert.equal(quoteArg("it's", 'linux'), "'it'\\''s'")
  assert.equal(hookCommand(['node', '/x/y.mjs'], 'darwin'), "'node' '/x/y.mjs' hook-stop")
})

test('hooks.json: ours is added as a new group next to other hooks, nothing else is changed, and it comes out again', () => {
  const theirs = { description: 'mine', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'audit.sh' }] }], Stop: [{ hooks: [{ type: 'command', command: 'notify-send done', timeout: 5 }] }] } }
  const cmd = hookCommand(WIN, 'win32')
  const added = withHook(theirs, cmd)
  assert.equal(hasOurHook(added, WIN), true)
  assert.equal(hasOurHook(theirs, WIN), false)
  assert.equal(added.hooks.Stop.length, 2)
  assert.deepEqual(added.hooks.Stop[1], { hooks: [{ type: 'command', command: cmd, timeout: 10 }] })
  assert.deepEqual(added.hooks.PreToolUse, theirs.hooks.PreToolUse)
  assert.deepEqual(Object.keys(added).sort(), ['description', 'hooks'], 'no key Codex would reject')
  assert.deepEqual(withoutHook(added, WIN), theirs)
  assert.equal(isEmptyDoc(withoutHook(withHook({}, cmd), WIN)), true)
  assert.equal(isEmptyDoc(theirs), false)
  assert.equal(isOurHook('audit.sh', WIN), false)
  assert.equal(isOurHook('"D:\\moved\\token-tracker-windows-x64.exe" hook-stop', WIN), true, 'recognised even when the program was moved')
})

import { codex, dir } from './codex-home.mjs'
const file = join(dir, 'codex', 'hooks.json')

test('install / remove on disk: a copy is kept, other hooks stay, an invalid file is never touched', () => {
  assert.equal(codex.hookState(), 'none')
  assert.equal(codex.installHook().changed, true) // no file yet
  assert.equal(codex.hookState(), 'ours')
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))), ['hooks'])
  assert.equal(codex.installHook().changed, false, 'twice does nothing')
  assert.equal(codex.removeHook().changed, true)
  assert.equal(existsSync(file), false, 'a file that holds nothing else is removed')

  const other = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other.exe' }] }] } }
  writeFileSync(file, JSON.stringify(other))
  const r = codex.installHook()
  assert.ok(readFileSync(r.backup, 'utf8') === JSON.stringify(other))
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).hooks.Stop.length, 2)
  codex.removeHook()
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), other)

  writeFileSync(file, '{ not json')
  assert.equal(codex.hookState(), 'unreadable')
  assert.equal(codex.installHook().changed, false)
  assert.equal(readFileSync(file, 'utf8'), '{ not json')
  assert.ok(readdirSync(join(dir, 'codex')).filter(n => n.startsWith('hooks.json.bak')).length >= 2)
})

test('hook-stop: reads Codex\'s JSON from stdin, prints nothing, exits 0, logs only flags, and never keeps the answer', async () => {
  const SECRET = 'THE-ANSWER-TEXT'
  const input = JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', turn_id: 't1', model: 'gpt-5.6-sol', cwd: '/secret/dir', last_assistant_message: SECRET, transcript_path: join(dir, 'codex', 'sessions', 'rollout-x.jsonl'), stop_hook_active: false, permission_mode: 'default' })
  const env = { ...process.env, TOKEN_TRACKER_HOME: join(dir, 'tt'), CODEX_HOME: join(dir, 'codex') }
  const r = spawnSync(process.execPath, [join(root, 'collectors/token-tracker.mjs'), 'hook-stop'], { input, env })
  assert.equal(r.status, 0)
  assert.equal(String(r.stdout), '', 'a Stop hook that prints JSON could make Codex continue')
  const t0 = Date.now(); while (Date.now() - t0 < 600) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},50)'])
  const logText = readFileSync(join(dir, 'tt', 'notify.log'), 'utf8')
  const ev = logText.split('\n').filter(Boolean).map(l => JSON.parse(l))
  const got = ev.find(e => e.event === 'hook_received')
  assert.deepEqual([got.hook, got.hasSessionId, got.hasTurnId, got.hasTranscript, got.model], ['Stop', true, true, true, 'gpt-5.6-sol'])
  assert.ok(ev.some(e => e.event === 'sync_started' && e.scope === 'file'))
  assert.ok(!logText.includes(SECRET) && !logText.includes('/secret/dir'))
  // garbage on stdin or nothing at all: still silent and 0
  for (const bad of ['', 'not json', '{"transcript_path": 5}']) {
    const b = spawnSync(process.execPath, [join(root, 'collectors/token-tracker.mjs'), 'hook-stop'], { input: bad, env })
    assert.equal(b.status, 0); assert.equal(String(b.stdout), '')
  }
})
