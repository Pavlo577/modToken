// The main chart's time steps: which ones a period offers, and the columns each one makes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_STEPS, STEP_CHOICES, cleanSteps, halfKey, stepLabel, stepRange, validStep } from '../web/lib/steps.ts'
import { bucketGrid, seriesGrid, turnGrid } from '../web/lib/grid.ts'
import { makeTz } from '../web/lib/stats.ts'

const utc = makeTz('UTC'), kyiv = makeTz('Europe/Kyiv')
const T = (o = {}) => ({ input: 0, output: 0, cache_read: 0, cache_creation: 0, duration_ms: 0, turns: 0, cost: 0, ...o })

test('steps: a day offers 0-60 minutes, a week and a month add 12 and 24 hours; a bad saved choice falls back to the default', () => {
  assert.deepEqual(STEP_CHOICES.day, [0, 5, 15, 30, 60])
  assert.deepEqual(STEP_CHOICES.week, [0, 5, 15, 30, 60, 720, 1440])
  assert.deepEqual(STEP_CHOICES.month, STEP_CHOICES.week)
  assert.equal(validStep('day', 1440), DEFAULT_STEPS.day) // 24 h is not a step of a day
  assert.equal(validStep('week', 720), 720)
  assert.deepEqual(cleanSteps({ day: 5, week: 'x', month: 7 }), { day: 5, week: 1440, month: 1440 })
  assert.deepEqual(cleanSteps(null), DEFAULT_STEPS)
  assert.equal(stepRange('year'), null); assert.equal(stepRange('day'), 'day')
  assert.deepEqual([0, 5, 60, 720, 1440].map(stepLabel), ['Кожен запис', '5 хв', '1 год', '12 год', '24 год'])
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

test('grid: 5, 15 and 30 minute columns cover the whole period, rows land in their column and obey the filters', () => {
  const from = utc.startOfDay('2026-10-28'), to = utc.startOfDay('2026-10-29')
  const rows = [
    { t: from + 15 * 60_000, device: 'a', provider: 'claude', input: 1, output: 10, cache_read: 0, cache_creation: 0, turns: 1, duration_ms: 0 },
    { t: from + 15 * 60_000, device: 'b', provider: 'codex', input: 2, output: 20, cache_read: 0, cache_creation: 0, turns: 1, duration_ms: 0 },
  ]
  const g = seriesGrid(utc, from, to, 15, rows)
  assert.equal(g.keys.length, 96); assert.equal(g.keys[1], '2026-10-28T00:15'); assert.equal(g.labels[1], '00:15')
  assert.equal(g.rowsOf({ device: null, provider: null })[1].output, 30)
  assert.equal(g.rowsOf({ device: 'a', provider: null })[1].output, 10)
  assert.equal(g.rowsOf({ device: null, provider: 'codex' })[1].output, 20)
  assert.equal(seriesGrid(utc, from, to, 5, []).keys.length, 288); assert.equal(seriesGrid(utc, from, to, 30, []).keys.length, 48)
  assert.match(g.tip(1), /00:15–00:30/)
})

test('grid: the columns follow the viewer\'s clock, also on the day the clocks go back (25 hours)', () => {
  const from = kyiv.startOfDay('2026-10-25'), to = kyiv.startOfDay('2026-10-26')
  assert.equal(to - from, 25 * 3_600_000)
  const g = seriesGrid(kyiv, from, to, 60, [])
  assert.equal(g.keys.length, 24) // the repeated 03:00 shares one column
  assert.equal(seriesGrid(kyiv, kyiv.startOfDay('2026-10-24'), kyiv.startOfDay('2026-10-25'), 30, []).keys[0], '2026-10-24T00:00')
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
