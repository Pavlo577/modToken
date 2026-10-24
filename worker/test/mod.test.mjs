// The Claude Code mod (hooks/register.ts, version 0.10: it reports the subscription limits only) run against a fake `$`:
// the mod itself needs Claude Code, its logic does not.
import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from '../../hooks/register.ts'

const LIMITS = [{ kind: 'five_hour', percentUsed: 12, resetsAt: '2026-10-24T15:00:00Z' }, { kind: 'seven_day', percentUsed: 3 }, { kind: 'other', percentUsed: 9 }]

/** A fake engine: handlers, the store, a fake disk (path → text), the environment, and every HTTP call, toast and status recorded. */
function engine({ files = {}, env = { HOME: '/home/u' }, limits = LIMITS, answer = () => ({ ok: true, status: 204, text: '' }), storeInit = {} } = {}) {
  const handlers = [], store = new Map(Object.entries(storeInit)), disk = new Map(Object.entries(files)), calls = [], toasts = [], statuses = [], commands = []
  const on = (event, matcher, hook) => {
    if (typeof matcher === 'function') { hook = matcher; matcher = undefined }
    handlers.push({ event, hook })
    return Object.assign(Promise.resolve(), { catch: () => undefined })
  }
  register(on)
  const $ = {
    store: { get: async k => store.get(k), set: async (k, v) => void store.set(k, v) },
    env: { get: async k => env[k] },
    fs: {
      read: async p => { if (!disk.has(p)) throw new Error('ENOENT'); return disk.get(p) },
      write: async (p, t) => void disk.set(p, t),
      exists: async p => disk.has(p),
    },
    http: { fetch: async (url, init) => { calls.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return answer(calls.length) } },
    session: { usage: async () => ({ rateLimits: limits }) },
    ui: { status: t => statuses.push(t), toast: t => toasts.push(t) },
    command: { register: async c => void commands.push(c.name) },
  }
  const run = (event, e) => handlers.find(h => h.event === event).hook($, e, async () => ({ text: '' }))
  const turn = (extra = {}) => run('turn.complete', { turnId: 't1', durationMs: 5, usage: { model: 'm', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, ...extra })
  return { run, turn, store, disk, calls, toasts, statuses, commands, handlers }
}
const CONFIG = '/home/u/.token-tracker/config.json'
const linked = { [CONFIG]: JSON.stringify({ url: 'https://site.example/', token: 'prog-token', device: 'pc', since: '2026-10-24T00:00:00Z' }) }

test('mod: it registers no commands any more (linking is the program\'s job) and sends no turns, only limits', async () => {
  const m = engine({ files: linked })
  assert.deepEqual(m.handlers.map(h => h.event).sort(), ['classic.SessionStart', 'turn.complete'])
  await m.run('classic.SessionStart', {})
  assert.deepEqual(m.commands, [])
  await m.turn()
  assert.equal(m.calls.length, 1)
  assert.deepEqual(m.calls[0].body, { rows: [], limits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: '2026-10-24T15:00:00Z' }, { kind: 'seven_day', percentUsed: 3 }] }) // no resetsAt: JSON leaves it out
  assert.equal(JSON.stringify(m.calls[0].body).includes('turn_id'), false)
})

test('mod: it uses the site and the token of the program\'s config; an unchanged reading is not sent again', async () => {
  const m = engine({ files: linked })
  await m.turn(); await m.turn()
  assert.equal(m.calls.length, 1, 'the same reading is sent once')
  assert.equal(m.calls[0].url, 'https://site.example/api/ingest')
  assert.equal(m.calls[0].headers['x-device-token'], 'prog-token')
  assert.equal(m.statuses.at(-1), 'ok')
})

test('mod: TOKEN_TRACKER_HOME and the Windows home (USERPROFILE) are honoured', async () => {
  const a = engine({ env: { TOKEN_TRACKER_HOME: 'D:\\tt\\' }, files: { 'D:\\tt/config.json': JSON.stringify({ token: 'x' }) } })
  await a.turn(); assert.equal(a.calls[0].headers['x-device-token'], 'x'); assert.equal(a.calls[0].url, 'https://track.brolafkodev.pp.ua/api/ingest')
  const b = engine({ env: { USERPROFILE: 'C:\\Users\\me' }, files: { 'C:\\Users\\me/.token-tracker/config.json': JSON.stringify({ token: 'w' }) } })
  await b.turn(); assert.equal(b.calls[0].headers['x-device-token'], 'w')
})

test('mod: a sub-agent\'s turn, a turn without usage, and an account without limits send nothing', async () => {
  const m = engine({ files: linked })
  await m.turn({ agentId: 'a1' }); await m.turn({ usage: undefined })
  assert.equal(m.calls.length, 0)
  const off = engine({ files: linked, limits: [] })
  await off.turn(); assert.equal(off.calls.length, 0, 'off a subscription there are no limits')
})

test('mod: a token this mod stored itself is handed over to the program\'s config once, from "now"', async () => {
  const m = engine({ storeInit: { deviceToken: 'old-token' } })
  await m.run('classic.SessionStart', {})
  const cfg = JSON.parse(m.disk.get(CONFIG))
  assert.deepEqual([cfg.token, cfg.url], ['old-token', 'https://track.brolafkodev.pp.ua'])
  assert.ok(Math.abs(Date.parse(cfg.since) - Date.now()) < 5000, 'the program collects the turns from this moment on')
  // not again: an existing config is never overwritten
  m.disk.set(CONFIG, JSON.stringify({ token: 'program-token', since: '2026-01-01T00:00:00Z' }))
  await m.run('classic.SessionStart', {})
  assert.equal(JSON.parse(m.disk.get(CONFIG)).token, 'program-token')
  // and the limits then go under the program's token
  await m.turn(); assert.equal(m.calls[0].headers['x-device-token'], 'program-token')
})

test('mod: while only the legacy token exists the limits still go, and the status says the turns come from the program', async () => {
  const m = engine({ storeInit: { deviceToken: 'old-token' } })
  m.$ = null
  await m.turn() // no session start yet: no hand-over, the stored token is used
  assert.equal(m.calls[0].headers['x-device-token'], 'old-token')
  assert.match(m.statuses.at(-1), /limits only: turns now come from the token-tracker program/)
})

test('mod: not linked says where to link and sends nothing; a revoked device and a failing server are named', async () => {
  const none = engine()
  await none.turn()
  assert.equal(none.calls.length, 0); assert.match(none.statuses.at(-1), /not linked: run the token-tracker program/)
  const revoked = engine({ files: linked, answer: () => ({ ok: false, status: 401 }) })
  await revoked.turn(); assert.match(revoked.statuses.at(-1), /device revoked or unknown/)
  const broken = engine({ files: linked, answer: () => ({ ok: false, status: 500 }) })
  await broken.turn(); assert.match(broken.statuses.at(-1), /HTTP 500/)
  await broken.turn(); assert.equal(broken.calls.length, 2, 'a reading that was not delivered is tried again')
  assert.equal(broken.toasts.length, 1, 'one failure is announced once')
})
