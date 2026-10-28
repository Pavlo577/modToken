// The main chart's time steps: which ones a period offers, and the columns each one makes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_STEPS, STEP_CHOICES, cleanSteps, effectiveStep, halfKey, stepChoices, stepLabel, stepRange, validStep } from '../web/lib/steps.ts'
import { bucketGrid, turnGrid } from '../web/lib/grid.ts'
import { makeTz } from '../web/lib/stats.ts'

const utc = makeTz('UTC'), kyiv = makeTz('Europe/Kyiv')
const T = (o = {}) => ({ input: 0, output: 0, cache_read: 0, cache_creation: 0, duration_ms: 0, turns: 0, cost: 0, ...o })

test('steps: a day offers every record and 1 h, a week and a month add 12 and 24 hours; a bad saved choice falls back to the default', () => {
  assert.deepEqual(STEP_CHOICES.day, [0, 60])
  assert.deepEqual(STEP_CHOICES.week, [0, 60, 720, 1440])
  assert.deepEqual(STEP_CHOICES.month, STEP_CHOICES.week)
  assert.equal(validStep('day', 1440), DEFAULT_STEPS.day) // 24 h is not a step of a day
  assert.equal(validStep('week', 720), 720)
  assert.deepEqual(cleanSteps({ day: 5, week: 'x', month: 7 }), { day: 60, week: 1440, month: 1440, custom: 1440 }) // 5 minutes was removed
  assert.deepEqual(cleanSteps(null), DEFAULT_STEPS)
  assert.equal(stepRange('year'), null); assert.equal(stepRange('day'), 'day')
  assert.deepEqual([0, 60, 720, 1440].map(stepLabel), ['Кожен запис', '1 год', '12 год', '24 год'])
  assert.equal(halfKey('2026-10-28', 11), '2026-10-28T00'); assert.equal(halfKey('2026-10-28', 12), '2026-10-28T12')
})

test('grid: hourly, 12 hour and daily columns come from the loaded buckets', () => {
  const hours = new Map([['2026-10-27T23', T({ output: 5, turns: 1 })], ['2026-10-28T00', T({ output: 7, turns: 2 })], ['2026-10-28T11', T({ output: 1 })], ['2026-10-28T12', T({ output: 10 })]])
  const days = new Map([['2026-10-27', T({ output: 5 })], ['2026-10-28', T({ output: 18 })]])
  const aggOf = () => ({ hours, days })
  const f = { device: null, provider: null }
  const h = bucketGrid('2026-10-28', '2026-10-28', 60, aggOf)
  assert.equal(h.keys.length, 24); assert.equal(h.labels[3], '3:00'); assert.equal(h.rowsOf(f)[0].output, 7)
  const half = bucketGrid('2026-10-27', '2026-10-28', 720, aggOf)
  assert.deepEqual(half.keys, ['2026-10-27T00', '2026-10-27T12', '2026-10-28T00', '2026-10-28T12'])
  assert.deepEqual(half.rowsOf(f).map(t => t.output), [0, 5, 8, 10]) // 23:00 belongs to the second half of the 27th
  const d = bucketGrid('2026-10-27', '2026-10-28', 1440, aggOf)
  assert.deepEqual(d.rowsOf(f).map(t => t.output), [5, 18]); assert.equal(d.keys.length, 2)
})

test('grid: one column per turn, with the model in the tooltip and a note when only the latest turns fit', () => {
  const turn = (ts, o, extra = {}) => ({ ts, device: 'a', model: 'm1', session_id: 's', input: 1, output: o, cache_read: 0, cache_creation: 0, duration_ms: 5, sub: 0, provider: 'claude', ...extra })
  const turns = [turn('2026-10-28T10:00:05.000Z', 3), turn('2026-10-28T10:01:00.000Z', 4, { provider: 'codex' })]
  const g = turnGrid(utc, turns, 5000)
  assert.deepEqual(g.rowsOf({ device: null, provider: null }).map(t => t.output), [3, 4])
  assert.deepEqual(g.rowsOf({ device: null, provider: 'claude' }).map(t => t.output), [3, 0]) // keeps the places
  assert.deepEqual(g.extraTip(0), [['Модель', 'm1'], ['Пристрій', 'a']]); assert.match(g.tip(0), /10:00:05/)
  assert.equal(g.note, undefined); assert.match(turnGrid(utc, turns, 2).note, /2/)
  assert.deepEqual(turnGrid(utc, [], 5000).keys, [])
})

test('steps: a single custom day offers every record and 1 h; a longer interval also 12 and 24 hours', () => {
  assert.deepEqual(stepChoices('custom', 1), [0, 60])
  assert.deepEqual(stepChoices('custom', 2), [0, 60, 720, 1440])
  assert.deepEqual(stepChoices('custom', 399), [0, 60, 720, 1440])
  assert.deepEqual(stepChoices('week', 7), STEP_CHOICES.week)
  assert.deepEqual(stepChoices('day', 1), [0, 60])
})

test('steps: the saved step is used while the interval allows it, otherwise the default (a single custom day is hourly)', () => {
  assert.equal(effectiveStep('custom', 60, 3), 60)
  assert.equal(effectiveStep('custom', 5, 3), 1440) // a step saved before the minute steps were removed falls back
  assert.equal(effectiveStep('custom', 5, 90), 1440) // 5 minutes is not offered for an interval of your own
  assert.equal(effectiveStep('custom', 0, 1), 0)
  assert.equal(effectiveStep('custom', 1440, 1), 60) // a day has no 24 h step: hourly
  assert.equal(effectiveStep('custom', 720, 10), 720)
  assert.equal(effectiveStep('custom', undefined, 10), 1440)
  assert.equal(effectiveStep('day', 0), 0); assert.equal(effectiveStep('day', 5), 60); assert.equal(effectiveStep('month', 'x'), 1440)
  assert.equal(stepRange('custom'), 'custom')
})
