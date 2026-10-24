import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findNotify, formatNotify } from '../../collectors/lib/toml-notify.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

test('notify: reads a plain array, a multi-line one with comments and Windows paths, and ignores tables', () => {
  const t = 'model = "x"\n\n# c\nnotify = [\n  "C:\\\\Users\\\\a b\\\\x.exe", # tail ] comment\n  \'lit\\path\',\n  "turn-ended",\n]\nother = 1\n[profiles.p]\nnotify = ["no"]\n'
  const f = findNotify(t)
  assert.deepEqual(f.argv, ['C:\\Users\\a b\\x.exe', 'lit\\path', 'turn-ended'])
  assert.ok(t.slice(f.start, f.end).startsWith('notify = [') && t.slice(f.start, f.end).endsWith(']'))
  assert.equal(findNotify('a = 1\n[x]\nnotify = ["y"]\n'), null)
  assert.equal(findNotify('notify = "a string"\n').argv, null) // not an array: left alone
  assert.equal(formatNotify(['C:\\a b\\x.exe', 'q"t']), 'notify = ["C:\\\\a b\\\\x.exe", "q\\"t"]')
})

const THEIRS = 'C:\\\\Users\\\\IOOOI\\\\Tools\\\\other-notifier.exe'
const config = `model = "gpt-5.6-sol"\n\nnotify = [ "${THEIRS}", "turn-ended" ]\n\n[projects.x]\ntrust = "trusted"\n`

// one temporary home for the collector (it reads CODEX_HOME / TOKEN_TRACKER_HOME when it is loaded)
const dir = mkdtempSync(join(tmpdir(), 'nt-'))
mkdirSync(join(dir, 'codex'), { recursive: true })
process.env.CODEX_HOME = join(dir, 'codex'); process.env.TOKEN_TRACKER_HOME = join(dir, 'tt')
const codex = (await import('../../collectors/agents/codex.mjs')).default
const file = join(dir, 'codex', 'config.toml')

test('notify: another program\'s notify is chained, kept, and restored byte for byte', () => {
  writeFileSync(file, config)
  const info = codex.notifyInfo()
  assert.equal(info.state, 'other')
  assert.deepEqual(info.argv, [THEIRS.replaceAll('\\\\', '\\'), 'turn-ended'])
  assert.equal(codex.installNotify().changed, false, 'without chain nothing is touched')
  assert.equal(readFileSync(file, 'utf8'), config)

  const r = codex.installNotify({ chain: true })
  assert.equal(r.changed, true)
  assert.ok(existsSync(r.backup) && readFileSync(r.backup, 'utf8') === config)
  const after = readFileSync(file, 'utf8')
  assert.equal(codex.notifyState(), 'ours')
  const f = findNotify(after)
  assert.deepEqual(f.argv.slice(-3), ['--then', THEIRS.replaceAll('\\\\', '\\'), 'turn-ended'])
  assert.ok(after.includes('[projects.x]') && after.includes('model = "gpt-5.6-sol"'))
  assert.equal(codex.installNotify({ chain: true }).changed, false, 'a second time does nothing')

  const back = codex.restoreNotify()
  assert.equal(back.changed, true)
  assert.equal(readFileSync(file, 'utf8'), config, 'the old notify is back as it was')
  assert.equal(codex.notifyState(), 'other')
})

test('notify: no notify yet: ours is added on top and removed again without a trace', () => {
  const plain = 'model = "m"\n\n[projects.x]\ntrust = "trusted"\n'
  writeFileSync(file, plain)
  assert.equal(codex.installNotify().changed, true)
  assert.equal(codex.notifyState(), 'ours')
  assert.ok(readFileSync(file, 'utf8').startsWith('# token-tracker'))
  codex.restoreNotify()
  assert.equal(readFileSync(file, 'utf8'), plain)
  assert.ok(readdirSync(join(dir, 'codex')).filter(n => n.startsWith('config.toml.bak')).length >= 2, 'every change keeps a copy of the file')
})

test('notify: `notify --then <cmd> ... <json>` starts the old command with its arguments and the untouched JSON', () => {
  const out = join(dir, 'got.json')
  const fake = join(dir, 'fake.mjs')
  writeFileSync(fake, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)))`)
  const payload = '{"type":"agent-turn-complete","turn-id":"t1"}'
  const r = spawnSync(process.execPath, [join(root, 'collectors/token-tracker.mjs'), 'notify', '--then', process.execPath, fake, 'turn-ended', payload], { env: { ...process.env, TOKEN_TRACKER_HOME: join(dir, 'tt'), CODEX_HOME: join(dir, 'none') } })
  assert.equal(r.status, 0)
  const t0 = Date.now()
  while (!existsSync(out) && Date.now() - t0 < 5000) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},50)'])
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), ['turn-ended', payload])
})

test('compiled program is recognised on every system (Windows shows the virtual folder with %7E)', async () => {
  const { isCompiled } = await import('../../collectors/lib/core.mjs')
  assert.equal(isCompiled('file:///B:/%7EBUN/root/token-tracker-windows-x64.exe', 'B:\\~BUN\\root\\token-tracker-windows-x64.exe'), true)
  assert.equal(isCompiled('file:///B:/~BUN/root/token-tracker.exe', undefined), true)
  assert.equal(isCompiled('file:///$bunfs/root/token-tracker', '/$bunfs/root/token-tracker'), true)
  assert.equal(isCompiled('file:///home/u/modToken/collectors/lib/core.mjs', '/home/u/modToken/collectors/token-tracker.mjs'), false)
  assert.equal(isCompiled('file:///C:/repo/collectors/lib/core.mjs', 'C:\\repo\\collectors\\codex.mjs'), false)
})

// Codex Desktop's computer-use helper keeps the previous notify itself and rewrites a notify it finds into --previous-notify form
const CU = 'C:\\Users\\IOOOI\\AppData\\Local\\OpenAI\\Codex\\runtimes\\cua_node\\x\\bin\\codex-computer-use.exe'
const asToml = a => formatNotify(a)
const cuConfig = argv => `model = "m"\n\n${asToml(argv)}\n\n[projects.x]\ntrust = "trusted"\n`

test('notify: the computer-use helper: ours goes into --previous-notify, and comes out again as it was', () => {
  const original = cuConfig([CU, 'turn-ended'])
  writeFileSync(file, original)
  assert.equal(codex.notifyState(), 'other')
  assert.equal(codex.installNotify({ chain: true }).changed, true)
  const argv = findNotify(readFileSync(file, 'utf8')).argv
  assert.deepEqual(argv.slice(0, 3), [CU, 'turn-ended', '--previous-notify'])
  assert.deepEqual(JSON.parse(argv[3]).slice(-1), ['notify'], 'a bare command of ours, no --then, nothing called twice')
  assert.equal(argv.length, 4)
  assert.equal(codex.notifyState(), 'ours')
  assert.equal(codex.installNotify({ chain: true }).changed, false)
  assert.equal(codex.restoreNotify().changed, true)
  assert.equal(readFileSync(file, 'utf8'), original)
})

test('notify: the helper wrapped OUR old line (with the extra ~BUN path and --then <helper>): that is ours, and turning it off leaves the helper alone', () => {
  const ours = ['C:\\Users\\IOOOI\\Downloads\\token-tracker-windows-x64 (2).exe', 'B:\\~BUN\\root\\token-tracker-windows-x64.exe', 'notify', '--then', CU, 'turn-ended']
  writeFileSync(file, cuConfig([CU, 'turn-ended', '--previous-notify', JSON.stringify(ours)]))
  assert.equal(codex.notifyState(), 'ours')
  assert.equal(codex.restoreNotify().changed, true)
  assert.equal(readFileSync(file, 'utf8'), cuConfig([CU, 'turn-ended']))
  assert.equal(codex.notifyState(), 'other')
})

test('notify: the helper with somebody else\'s previous notify: ours is added inside, only ours is taken out', () => {
  const theirs = ['C:\\Tools\\mux.exe', 'x']
  writeFileSync(file, cuConfig([CU, 'turn-ended', '--previous-notify', JSON.stringify(theirs)]))
  codex.installNotify({ chain: true })
  const argv = findNotify(readFileSync(file, 'utf8')).argv
  assert.deepEqual(JSON.parse(argv[3]).slice(-3), ['--then', ...theirs])
  assert.equal(codex.notifyState(), 'ours')
  codex.restoreNotify()
  assert.deepEqual(findNotify(readFileSync(file, 'utf8')).argv, [CU, 'turn-ended', '--previous-notify', JSON.stringify(theirs)])
})

// ---- the diagnostic log of `notify`
const logFile = join(dir, 'tt', 'notify.log')
const events = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
const wait = ms => spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`])
const callNotify = (then, payload) => spawnSync(process.execPath, [join(root, 'collectors/token-tracker.mjs'), 'notify', ...(then.length ? ['--then', ...then] : []), payload], { env: { ...process.env, TOKEN_TRACKER_HOME: join(dir, 'tt'), CODEX_HOME: join(dir, 'none') } })
const SECRET = 'TOP-SECRET-PROMPT-TEXT'
const PAYLOAD = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 't1', 'turn-id': 'u1', cwd: '/secret/dir', 'input-messages': [SECRET], 'last-assistant-message': SECRET })

test('notify log: a good downstream is logged with its exit code, and no text of the payload gets in', () => {
  writeFileSync(logFile, '')
  const ok = join(dir, 'ok.mjs'); writeFileSync(ok, 'process.exit(0)')
  assert.equal(callNotify([process.execPath, ok, 'turn-ended'], PAYLOAD).status, 0)
  const names = events().map(e => e.event)
  assert.deepEqual(names.filter(n => !n.startsWith('sync_')), ['notify_received', 'downstream_started', 'downstream_finished']) // the detached sync writes its own events whenever it ends
  const ev = Object.fromEntries(events().map(e => [e.event, e]))
  assert.equal(ev.downstream_finished.exitCode, 0)
  assert.deepEqual([ev.notify_received.hasThreadId, ev.notify_received.hasTurnId, ev.notify_received.hasInputMessages, ev.notify_received.hasAssistantMessage], [true, true, true, true])
  assert.deepEqual(ev.downstream_started.arguments.slice(-2), [ev.downstream_started.arguments.at(-2), '<json>'])
  assert.ok(ev.downstream_started.arguments.includes('<json>') && !ev.downstream_started.arguments.some(a => a.includes('{')))
  assert.ok(!readFileSync(logFile, 'utf8').includes(SECRET) && !readFileSync(logFile, 'utf8').includes('/secret/dir'), 'no prompt text, no directory in the log')
})

test('notify log: a failing downstream is logged with its code; a missing program is logged and does not break anything', () => {
  writeFileSync(logFile, '')
  const bad = join(dir, 'bad.mjs'); writeFileSync(bad, 'process.exit(3)')
  assert.equal(callNotify([process.execPath, bad, 'x'], PAYLOAD).status, 0)
  assert.equal(events().find(e => e.event === 'downstream_failed').exitCode, 3)
  writeFileSync(logFile, '')
  assert.equal(callNotify([join(dir, 'moved', 'codex-computer-use.exe'), 'turn-ended'], PAYLOAD).status, 0)
  const names = events().map(e => e.event)
  assert.ok(names.includes('downstream_missing') && !names.includes('downstream_started'))
  assert.equal(events().find(e => e.event === 'downstream_missing').program, 'codex-computer-use.exe')
})

test('notify log: without a previous command only the notify and the sync are logged; the log command prints it', () => {
  writeFileSync(logFile, '')
  assert.equal(callNotify([], PAYLOAD).status, 0)
  wait(300)
  const names = events().map(e => e.event)
  assert.ok(names.includes('notify_received') && names.includes('sync_started') && !names.some(n => n.startsWith('downstream_')))
  const r = spawnSync(process.execPath, [join(root, 'collectors/token-tracker.mjs'), 'log'], { env: { ...process.env, TOKEN_TRACKER_HOME: join(dir, 'tt') } })
  assert.match(String(r.stdout), /notify_received/)
  assert.ok(!String(r.stdout).includes(SECRET))
})
