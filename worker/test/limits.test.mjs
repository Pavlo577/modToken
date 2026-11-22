// POST /v1/limits reads only the window's name, a percent and a time; anything else in the body is dropped.
import test from 'node:test'
import assert from 'node:assert/strict'
import { limitsProvider, parseLimits, shouldStoreLimit } from '../src/limits.ts'

test('limits: well-formed readings are kept, the rest is dropped, nothing else survives', () => {
  const out = parseLimits({
    email: 'secret.person@example.com', limits: [
      { kind: 'five_hour', percentUsed: 38, resetsAt: '2026-10-26T01:40:00.000Z', cwd: '/home/SECRET' },
      { kind: 'seven_day', percentUsed: 11 },
      { kind: 'Bad Kind', percentUsed: 5 }, { kind: 'five_hour', percentUsed: 'x' }, null, { kind: 'spend_limit', percentUsed: 5000, resetsAt: 'not a date' },
    ],
  })
  assert.deepEqual(out, [
    { kind: 'five_hour', percent: 38, resets_at: '2026-10-26T01:40:00.000Z' },
    { kind: 'seven_day', percent: 11, resets_at: '' },
    { kind: 'spend_limit', percent: 1000, resets_at: '' },
  ])
  assert.equal(JSON.stringify(out).includes('SECRET') || JSON.stringify(out).includes('secret'), false)
})

test('limits: a body without a list is refused, an empty list is fine', () => {
  assert.equal(parseLimits([]), null)
  assert.equal(parseLimits({ rows: [] }), null)
  assert.deepEqual(parseLimits({ limits: [] }), [])
  assert.equal(parseLimits({ limits: Array.from({ length: 20 }, () => ({ kind: 'five_hour', percentUsed: 1 })) }).length, 8)
})

test('limits: the agent is codex only when the body says so; the mod sends none and is claude', () => {
  assert.equal(limitsProvider({ provider: 'codex', limits: [] }), 'codex')
  assert.equal(limitsProvider({ limits: [] }), 'claude')
  assert.equal(limitsProvider({ provider: 'gemini', limits: [] }), 'claude')
  assert.equal(limitsProvider(null), 'claude')
})

test('limits: allows alphanumeric pool names starting with a letter and rejects leading digits or spaces', () => {
  const out = parseLimits({
    limits: [
      { kind: 'gemini_4_argon_weekly', percentUsed: 12 },
      { kind: '4bad', percentUsed: 50 },
      { kind: 'Bad Kind', percentUsed: 50 },
    ],
  })
  assert.deepEqual(out, [{ kind: 'gemini_4_argon_weekly', percent: 12, resets_at: '' }])
})

test('limits: parseLimits validates observedAt range and shouldStoreLimit guards against 3-PC conflicts', () => {
  const now = Date.parse('2026-11-22T12:00:00.000Z')
  const parsed = parseLimits({
    limits: [
      { kind: 'five_hour', percentUsed: 20, resetsAt: '2026-11-22T17:00:00Z', observedAt: '2026-11-22T11:55:00Z' },
      { kind: 'seven_day', percentUsed: 10, observedAt: '2020-01-01T00:00:00Z' },
    ],
  }, now)
  assert.equal(parsed[0].observed_at, '2026-11-22T11:55:00.000Z')
  assert.equal('observed_at' in parsed[1], false)

  const last = { ts: '2026-11-22T12:00:00.000Z', percent_used: 35, resets_at: '2026-11-22T17:00:00.000Z', device_id: 'pc-1' }
  assert.equal(shouldStoreLimit(null, { ts: '2026-11-22T12:00:00.000Z', percent: 35, resets_at: '', device_id: 'pc-1' }), true)
  assert.equal(shouldStoreLimit(last, { ts: '2026-11-22T11:50:00.000Z', percent: 20, resets_at: '2026-11-22T17:00:00.000Z', device_id: 'pc-2' }), false, 'older out-of-order snapshot dropped')
  assert.equal(shouldStoreLimit(last, { ts: '2026-11-22T12:01:00.000Z', percent: 5, resets_at: '2026-11-22T12:00:00.000Z', device_id: 'pc-2' }), false, 'stale resets_at window dropped')
  assert.equal(shouldStoreLimit(last, { ts: '2026-11-22T12:01:00.000Z', percent: 35.02, resets_at: '2026-11-22T17:00:10.000Z', device_id: 'pc-2' }), false, 'cross-device unchanged % deduped')
  assert.equal(shouldStoreLimit(last, { ts: '2026-11-22T12:02:00.000Z', percent: 20, resets_at: '2026-11-22T17:00:00.000Z', device_id: 'pc-2' }), false, 'cross-device <5m drop ignored')
  assert.equal(shouldStoreLimit(last, { ts: '2026-11-22T12:02:00.000Z', percent: 20, resets_at: '2026-11-22T17:00:00.000Z', device_id: 'pc-1' }), true, 'same-device manual reset allowed')
  assert.equal(shouldStoreLimit(last, { ts: '2026-11-22T12:02:00.000Z', percent: 42, resets_at: '2026-11-22T17:00:00.000Z', device_id: 'pc-2' }), true, 'progress across devices stored')
})
