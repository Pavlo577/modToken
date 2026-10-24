// The Claude Code mod (hooks/register.ts) run against a fake `$`: the mod itself needs Claude Code, its logic does not.
import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from '../../hooks/register.ts'

/** A fake engine: handlers are collected, the store, the toasts, the status line and every HTTP call are recorded. */
function engine({ sessionId = 'sess-1', usage = async () => ({ rateLimits: [] }), answer = () => ({ ok: true, status: 204, text: '' }) } = {}) {
  const handlers = [], commands = [], store = new Map(), calls = [], toasts = [], statuses = []
  const on = (event, matcher, hook) => {
    if (typeof matcher === 'function') { hook = matcher; matcher = undefined }
    handlers.push({ event, matcher, hook })
    return Object.assign(Promise.resolve(), { catch: () => undefined })
  }
  register(on)
  const $ = {
    store: { get: async k => store.get(k), set: async (k, v) => void store.set(k, v) },
    http: { fetch: async (url, init) => { const body = JSON.parse(init.body); calls.push({ url, headers: init.headers, body }); return answer({ url, body }, calls.length) } },
    session: { id: async () => { if (sessionId instanceof Error) throw sessionId; return sessionId }, usage },
    ui: { status: t => statuses.push(t), toast: t => toasts.push(t) },
    command: { register: async c => void commands.push(c.name) },
    clock: { now: async () => Date.parse('2026-10-24T10:00:00Z') },
  }
  const run = (event, e, matcher) => handlers.find(h => h.event === event && (!matcher || h.matcher?.command === matcher)).hook($, e, async x => ({ text: '' }))
  const turn = (id = 't1', extra = {}) => run('turn.complete', { turnId: id, durationMs: 1234, usage: { model: 'claude-x', input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 }, ...extra })
  return { $, run, turn, store, calls, toasts, statuses, commands, handlers }
}

test('mod: /tracker-setup is gone: only link and import are registered, and the site is fixed', async () => {
  const m = engine()
  await m.run('session.start', {})
  assert.deepEqual(m.commands.sort(), ['tracker-import', 'tracker-link'])
  assert.equal(m.handlers.some(h => h.matcher?.command === 'tracker-setup'), false)
  await m.store.set('backendUrl', 'https://evil.example') // an old value of the removed setting is ignored
  await m.store.set('deviceToken', 'tok')
  await m.turn()
  assert.equal(m.calls[0].url, 'https://track.brolafkodev.pp.ua/api/ingest')
  assert.equal(m.calls[0].headers['x-device-token'], 'tok')
})

test('mod: the row carries the numbers of the turn and the real session id, even when session start was never seen', async () => {
  const m = engine({ sessionId: 'real-session' })
  m.store.set('deviceToken', 'tok')
  await m.turn('turn-9')
  const rows = m.calls[0].body
  const row = Array.isArray(rows) ? rows[0] : rows.rows[0]
  assert.deepEqual([row.session_id, row.turn_id, row.model, row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_creation_tokens, row.duration_ms, row.is_subagent],
    ['real-session', 'turn-9', 'claude-x', 10, 5, 3, 1, 1234, false])
  await m.turn('t-sub', { agentId: 'a1' })
  assert.equal(m.calls[1].body.at(-1).is_subagent, true)
})

test('mod: if the session cannot say its id, the one remembered at session start is used, else "unknown"', async () => {
  const a = engine({ sessionId: new Error('no id') })
  a.store.set('deviceToken', 'tok')
  await a.run('classic.SessionStart', { session_id: 'from-start' })
  a.calls.length = 0
  await a.turn()
  assert.equal(a.calls[0].body.at(-1).session_id, 'from-start')
  const b = engine({ sessionId: new Error('no id') })
  b.store.set('deviceToken', 'tok')
  await b.turn()
  assert.equal(b.calls[0].body.at(-1).session_id, 'unknown')
})

test('mod: a row the server refuses (HTTP 400) is dropped, the good ones in the queue still arrive', async () => {
  const bad = { turn_id: 'bad' }
  const m = engine({ answer: ({ body }, n) => {
    const rows = Array.isArray(body) ? body : body.rows
    return rows.some(r => r.turn_id === bad.turn_id) && rows.length > 1 ? { ok: false, status: 400 } : rows[0].turn_id === 'bad' ? { ok: false, status: 400 } : { ok: true, status: 204 }
  } })
  m.store.set('deviceToken', 'tok')
  m.store.set('queue', [{ session_id: 's', turn_id: 'a', ts: '2026-10-24T09:00:00Z', model: 'm', input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0, duration_ms: 1, is_subagent: false },
    { session_id: 's', turn_id: 'bad', ts: '2026-10-24T09:01:00Z', model: 'm', input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0, duration_ms: 1, is_subagent: false }])
  await m.turn('new')
  const delivered = m.calls.filter(c => (Array.isArray(c.body) ? c.body : c.body.rows).length === 1).map(c => (Array.isArray(c.body) ? c.body : c.body.rows)[0].turn_id)
  assert.deepEqual(delivered.sort(), ['a', 'bad', 'new'].sort(), 'each row was tried alone')
  assert.deepEqual(m.store.get('queue'), [], 'nothing is left in the queue: the bad row is gone, the good ones are sent')
  assert.ok(m.toasts.some(t => /1 turn\(s\) refused by the server and skipped/.test(t)))
  assert.equal(m.statuses.at(-1), 'ok')
})

test('mod: other failures keep every row queued (no connection, HTTP 500), and a later turn sends them', async () => {
  let down = true
  const m = engine({ answer: () => (down ? { ok: false, status: 500 } : { ok: true, status: 204 }) })
  m.store.set('deviceToken', 'tok')
  await m.turn('t1'); await m.turn('t2')
  assert.equal(m.store.get('queue').length, 2)
  assert.match(m.statuses.at(-1), /HTTP 500, 2 turn\(s\) queued/)
  down = false
  await m.turn('t3')
  assert.deepEqual(m.store.get('queue'), [])
  assert.deepEqual(m.calls.at(-1).body.map(r => r.turn_id), ['t1', 't2', 't3'])
  // a revoked device says so
  const r = engine({ answer: () => ({ ok: false, status: 401 }) })
  r.store.set('deviceToken', 'tok'); await r.turn()
  assert.match(r.statuses.at(-1), /device revoked/)
})

test('mod: subscription limits are sent with the row, only when they changed', async () => {
  const limits = [{ kind: 'five_hour', percentUsed: 12, resetsAt: '2026-10-24T15:00:00Z' }, { kind: 'seven_day', percentUsed: 3 }, { kind: 'other', percentUsed: 9 }]
  const m = engine({ usage: async () => ({ rateLimits: limits }) })
  m.store.set('deviceToken', 'tok')
  await m.turn('a'); await m.turn('b')
  assert.deepEqual(m.calls[0].body.limits.map(l => l.kind), ['five_hour', 'seven_day'])
  assert.equal(Array.isArray(m.calls[1].body), true, 'the unchanged reading is not sent again')
})

test('mod: not linked says so and sends nothing', async () => {
  const m = engine()
  await m.turn()
  assert.equal(m.calls.length, 0)
  assert.match(m.statuses.at(-1), /not linked/)
})
