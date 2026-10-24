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

const THEIRS = 'C:\\\\Users\\\\IOOOI\\\\AppData\\\\Local\\\\OpenAI\\\\Codex\\\\bin\\\\codex-computer-use.exe'
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
