// The mod's endpoints drop what they do not read; the names of the dropped fields are remembered, never their values.
import test from 'node:test'
import assert from 'node:assert/strict'
import { droppedNames } from '../src/dropped.ts'

test('dropped: only unknown names are reported, with their path', () => {
  assert.deepEqual(droppedNames('limits', { limits: [{ kind: 'five_hour', percentUsed: 3, resetsAt: 'x', brand_new: 1 }], extra_top: 1 }), ['extra_top', 'limits.brand_new'])
  assert.deepEqual(droppedNames('activity', { session: { id: 's', started_at: 't', cwd: '/x' }, turns: [{ id: 'a', session: 's', ts: 't', wall_ms: 1, tokens: 5 }, { id: 'b', fresh_field: 2 }] }), ['session.cwd', 'turns.fresh_field', 'turns.tokens'])
  assert.deepEqual(droppedNames('import', { turns: [{ id: 'm', session: 's', ts: 't', model: 'x', input: 1, output: 2, cache_read: 0, cache_creation: 0, sub: false, first: true, duration_ms: 5 }] }), [])
})

test('dropped: values never appear, odd names are cleaned, the list is capped, garbage is harmless', () => {
  const secret = 'SECRET VALUE with spaces and me@example.com'
  const names = droppedNames('activity', { turns: [{ id: 'a', 'bad name!{}': secret, note: secret }], session: secret, [secret]: 1 })
  assert.equal(JSON.stringify(names).includes('SECRET VALUE'), false)
  assert.equal(JSON.stringify(names).includes('@'), false)
  const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => ['f' + i, i]))
  assert.equal(droppedNames('activity', many).length, 40)
  for (const bad of [null, 7, 'x', [], [1, 2]]) assert.deepEqual(droppedNames('limits', bad), [])
})
