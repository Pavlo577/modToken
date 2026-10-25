// The statusLine log keeps the SHAPE of the input only: numbers, flags and ISO times as they are, other strings by length.
import test from 'node:test'
import assert from 'node:assert/strict'
import { statuslineShape } from '../src/statusline.ts'

test('statusline: numbers, flags and ISO times are kept, text never is', () => {
  const shape = statuslineShape({
    cwd: '/home/SECRETUSER/project', model: { id: 'SECRET-model', display_name: 'SECRET' },
    rate_limits: { five_hour: { used_percentage: 42.5, resets_at: '2026-10-25T23:00:00Z' }, seven_day: { used_percentage: 7 } },
    exceeds: false, list: [{ a: 1 }, { a: 2 }], nothing: null,
  })
  assert.equal(JSON.stringify(shape).includes('SECRET'), false)
  assert.deepEqual(shape, {
    cwd: 'str:24', 'model.id': 'str:12', 'model.display_name': 'str:6',
    'rate_limits.five_hour.used_percentage': 42.5, 'rate_limits.five_hour.resets_at': '2026-10-25T23:00:00Z', 'rate_limits.seven_day.used_percentage': 7,
    exceeds: false, 'list[].a': 2, nothing: null,
  })
})

test('statusline: the number of paths and the depth are bounded', () => {
  const wide = Object.fromEntries(Array.from({ length: 1000 }, (_, k) => [`k${k}`, k]))
  assert.equal(Object.keys(statuslineShape(wide)).length, 300)
  let deep = { x: 1 }
  for (let k = 0; k < 20; k++) deep = { d: deep }
  assert.deepEqual(statuslineShape(deep), {})
})
