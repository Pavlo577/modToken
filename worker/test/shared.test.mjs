// The shared collector layer (owner: claude): what Codex asked for in requests/codex.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dir } from './codex-home.mjs' // sets CODEX_HOME / TOKEN_TRACKER_HOME before the collector is loaded

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const tracker = join(root, 'collectors/token-tracker.mjs')
const { errorCategory, logFile, readLog } = await import('../../collectors/lib/notify-log.mjs')
const core = await import('../../collectors/lib/core.mjs')

test('error categories: a fixed list of codes, and no path or message gets through', () => {
  const e = Object.assign(new Error("ENOENT: no such file or directory, open '/home/me/secret/rollout-1.jsonl'"), { code: 'ENOENT' })
  assert.equal(errorCategory(e), 'os_enoent')
  assert.equal(errorCategory(new Error('site answered HTTP 503')), 'http_503')
  assert.equal(errorCategory(new Error('the site did not answer in time: try again later')), 'timeout')
  assert.equal(errorCategory(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'timeout')
  assert.equal(errorCategory(new Error('could not reach the site: check the internet connection')), 'network')
  assert.equal(errorCategory(new Error('the device token was rejected (revoked?): link again')), 'auth')
  assert.equal(errorCategory(new Error('not linked yet: run the program')), 'not_linked')
  assert.equal(errorCategory(new Error('C:\\Users\\IOOOI\\x.txt exploded')), 'unknown')
  assert.ok(/^[a-z0-9_]+$/.test(errorCategory(e)))
})

test('notify log: the value of a downstream argument is never logged, only how many there are', () => {
  const home = mkdtempSync(join(tmpdir(), 'sh-'))
  const fake = join(home, 'fake.mjs'); writeFileSync(fake, 'process.exit(0)')
  const SECRET = 'SECRET-TOKEN-123'
  const r = spawnSync(process.execPath, [tracker, 'notify', '--then', process.execPath, fake, '--token', SECRET, 'plain-word', '{"type":"agent-turn-complete"}'], { env: { ...process.env, TOKEN_TRACKER_HOME: home, CODEX_HOME: join(home, 'none') } })
  assert.equal(r.status, 0)
  const text = readFileSync(join(home, 'notify.log'), 'utf8')
  assert.ok(!text.includes(SECRET) && !text.includes('plain-word') && !text.includes('fake.mjs'), 'no argument value, no script path')
  const started = text.split('\n').filter(Boolean).map(l => JSON.parse(l)).find(e => e.event === 'downstream_started')
  assert.deepEqual([started.argumentCount, started.hasJsonPayload], [4, true])
})

test('http: a site that never answers ends in a clear, path-free error after the time limit', async () => {
  const srv = createServer(() => { /* never answers */ })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}`
  const code = `import('${join(root, 'collectors/lib/core.mjs').replace(/\\/g, '/')}').then(async c => { try { await c.post({ url: ${JSON.stringify(url)}, token: 't' }, { rows: [{ turn_id: 'a', ts: '2026-10-24T10:00:00Z' }] }); console.log('no error') } catch (e) { console.log(e.message) } })`
  const t0 = Date.now()
  const child = spawn(process.execPath, ['-e', code], { env: { ...process.env, TOKEN_TRACKER_HTTP_TIMEOUT_MS: '400', TOKEN_TRACKER_HOME: join(dir, 'tt') } })
  let out = ''; child.stdout.on('data', d => (out += d))
  await new Promise(r => child.on('close', r))
  srv.close()
  assert.match(out, /did not answer in time/)
  assert.ok(Date.now() - t0 < 5000)
  assert.ok(!out.includes('127.0.0.1'))
  // and the other way: nothing listening at all
  const out2 = spawnSync(process.execPath, ['-e', code.replace(url, 'http://127.0.0.1:1')], { env: { ...process.env, TOKEN_TRACKER_HTTP_TIMEOUT_MS: '2000', TOKEN_TRACKER_HOME: join(dir, 'tt') } }).stdout.toString()
  assert.match(out2, /could not reach the site/)
})

test('sync lock: a live process keeps it even when the lock is old; a dead one does not', () => {
  const lockFile = join(dir, 'tt', 'unit-sync.lock')
  mkdirSync(join(dir, 'tt'), { recursive: true })
  // held by this very process, 10 minutes ago (older than the old five-minute rule)
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() - 10 * 60_000 }))
  assert.equal(core.lock('unit'), null, 'a live holder is respected')
  // held by a process that is gone
  const dead = spawnSync(process.execPath, ['-e', '0'])
  writeFileSync(lockFile, JSON.stringify({ pid: dead.pid, at: Date.now() }))
  const release = core.lock('unit')
  assert.equal(typeof release, 'function', 'a dead holder is taken over')
  assert.equal(core.lock('unit'), null, 'now it is ours')
  release()
  assert.equal(existsSync(lockFile), false)
  writeFileSync(lockFile, 'not json')
  const again = core.lock('unit'); assert.equal(typeof again, 'function'); again()
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() - 2 * 3600_000 }))
  const old = core.lock('unit'); assert.equal(typeof old, 'function', 'older than 30 minutes: taken over even if the id is alive'); old()
})

test('notify log: parallel writers and rotation never corrupt a line or lose the newest events', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rot-'))
  const writer = id => `import('${join(root, 'collectors/lib/notify-log.mjs').replace(/\\/g, '/')}').then(m => { for (let i = 0; i < 300; i++) m.logEvent({ event: 'e', writer: ${id}, i, pad: 'x'.repeat(60) }) })`
  const env = { ...process.env, TOKEN_TRACKER_HOME: home, TOKEN_TRACKER_LOG_MAX: '30000' }
  await Promise.all([1, 2, 3, 4].map(id => new Promise(r => spawn(process.execPath, ['-e', writer(id)], { env }).on('close', r))))
  for (const f of ['notify.log', 'notify.log.1']) {
    if (!existsSync(join(home, f))) continue
    for (const line of readFileSync(join(home, f), 'utf8').split('\n').filter(Boolean)) assert.doesNotThrow(() => JSON.parse(line), `${f}: every line is whole`)
  }
  assert.ok(existsSync(join(home, 'notify.log.1')), 'it did rotate')
  const all = [...readFileSync(join(home, 'notify.log.1'), 'utf8').split('\n'), ...readFileSync(join(home, 'notify.log'), 'utf8').split('\n')].filter(Boolean).map(l => JSON.parse(l))
  // rotation drops the oldest events by design (the writers do not run in lockstep, so a whole writer may be gone);
  // what is kept of each writer must be its newest run with no hole in it, and the newest event of all must be there
  const writers = [...new Set(all.map(e => e.writer))]
  assert.ok(writers.length >= 1)
  for (const w of writers) {
    const kept = all.filter(e => e.writer === w).map(e => e.i).sort((a, b) => a - b)
    assert.equal(kept.at(-1) - kept[0] + 1, kept.length, `no event of writer ${w} is lost inside the kept run`)
  }
  assert.ok(all.some(e => e.i === 299), 'the newest events are kept')
})
