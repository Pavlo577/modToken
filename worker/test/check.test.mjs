// POST /v1/check (diagnostics) keeps a turn's numbers, model and ids only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCheck } from '../src/check.ts'

test('check: the numbers of a turn are kept, nothing else survives, malformed turns are dropped', () => {
  const ok = { id: 'turn-1', session: 'sess-1', ts: '2026-10-25T23:00:00Z', model: 'claude-opus-5-5', input: 2, output: 568, cache_read: 131459, cache_creation: 165, duration_ms: 6082.4, sub: true }
  const out = parseCheck({ email: 'secret.person@example.com', turns: [{ ...ok, answer: 'SECRET' }, { ...ok, id: 'x y' }, { ...ok, output: -1 }, { ...ok, id: 't2', model: 'SECRET model with spaces' }, null] })
  assert.equal(JSON.stringify(out).includes('SECRET') || JSON.stringify(out).includes('secret'), false)
  assert.deepEqual(out[0], { id: 'turn-1', session: 'sess-1', ts: '2026-10-25T23:00:00.000Z', model: 'claude-opus-5-5', input: 2, output: 568, cache_read: 131459, cache_creation: 165, duration_ms: 6082, sub: true })
  assert.equal(out.length, 2)
  assert.equal(out[1].model, 'unknown')
  assert.equal(parseCheck({}), null)
})
