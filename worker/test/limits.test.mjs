// POST /v1/limits reads only the window's name, a percent and a time; anything else in the body is dropped.
import test from 'node:test'
import assert from 'node:assert/strict'
import { limitsProvider, parseLimits } from '../src/limits.ts'

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
