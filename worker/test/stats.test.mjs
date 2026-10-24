import test from 'node:test'
import assert from 'node:assert/strict'
import { freshInput, makeTz, addDays, dayList, rangeMs, aggregate, priceFor, costOf, cacheHit, delta, records } from '../web/lib/stats.ts'
import { readFileSync } from 'node:fs'

const prices = JSON.parse(readFileSync(new URL('../public/admin/prices.json', import.meta.url), 'utf8'))
const kyiv = makeTz('Europe/Kyiv')
const utc = makeTz('UTC')

test('calendar helpers', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01')
  assert.deepEqual(dayList('2026-02-27', '2026-03-02'), ['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02'])
})

test('local day and hour follow the time zone, including daylight saving', () => {
  // 2026-10-24 21:30 UTC is already 25 Oct in Kyiv (UTC+3 until the clocks go back on 25 Oct 04:00 local)
  assert.equal(kyiv.parts(Date.parse('2026-10-24T21:30:00Z')).day, '2026-10-25')
  assert.equal(kyiv.parts(Date.parse('2026-10-24T21:30:00Z')).h, 0)
  // winter time: UTC+2
  assert.equal(kyiv.parts(Date.parse('2026-12-10T22:30:00Z')).day, '2026-12-11')
  assert.equal(kyiv.parts(Date.parse('2026-12-10T22:30:00Z')).h, 0)
  assert.equal(utc.parts(Date.parse('2026-12-10T22:30:00Z')).day, '2026-12-10')
})

test('local midnight converts back to the right UTC instant', () => {
  assert.equal(new Date(kyiv.startOfDay('2026-07-01')).toISOString(), '2026-06-30T21:00:00.000Z') // UTC+3
  assert.equal(new Date(kyiv.startOfDay('2026-12-01')).toISOString(), '2026-11-30T22:00:00.000Z') // UTC+2
  assert.equal(new Date(kyiv.startOfDay('2026-10-25')).toISOString(), '2026-10-24T21:00:00.000Z') // day the clocks change
  const r = rangeMs(kyiv, '2026-10-25', '2026-10-25')
  assert.equal((r.to - r.from) / 3_600_000, 25) // a 25-hour day
})

test('Monday is row 0 of the week grid', () => {
  assert.equal(utc.parts(Date.parse('2026-10-26T12:00:00Z')).dow, 0) // Monday
  assert.equal(utc.parts(Date.parse('2026-10-25T12:00:00Z')).dow, 6) // Sunday
})

const bk = (h, o = {}) => ({ h, device: 'a', model: 'claude-sonnet-5-5', input: 10, output: 100, cache_read: 1000, cache_creation: 50, duration_ms: 1000, turns: 2, sub: 0, ...o })

test('aggregate regroups UTC hours into the viewer\'s days', () => {
  const buckets = [bk('2026-10-24T21'), bk('2026-10-24T22'), bk('2026-10-25T10', { device: 'b' })]
  const k = aggregate(buckets, kyiv, { prices })
  assert.deepEqual([...k.days.keys()].sort(), ['2026-10-25']) // all three are the 25th in Kyiv
  assert.equal(k.days.get('2026-10-25').output, 300)
  const u = aggregate(buckets, utc, { prices })
  assert.deepEqual([...u.days.keys()].sort(), ['2026-10-24', '2026-10-25'])
  assert.equal(u.devices.get('b').output, 100)
  assert.equal(aggregate(buckets, utc, { device: 'a' }).total.output, 200)
  assert.equal(aggregate(buckets, utc, { fromMs: Date.parse('2026-10-25T00:00:00Z') }).total.output, 100)
})

test('week x hour matrix uses local time', () => {
  const k = aggregate([bk('2026-10-26T07')], kyiv) // Monday 10:00 in Kyiv (UTC+2 after 25 Oct)
  assert.equal(k.matrix[0][9].output, 100) // 07:00Z = 09:00 local (winter time)
})

test('prices: longest model prefix wins, cost per million tokens', () => {
  assert.equal(priceFor('claude-opus-5-5-20260101', prices).match, 'claude-opus-5-5')
  assert.equal(priceFor('claude-opus-5', prices).match, 'claude-opus-5')
  assert.equal(priceFor('gpt-x', prices), null)
  // sonnet 5.5: 1M input $2 + 1M output $10 + 1M cache read $0.10 + 1M cache write $4
  assert.ok(Math.abs(costOf({ input: 1e6, output: 1e6, cache_read: 1e6, cache_creation: 1e6 }, 'claude-sonnet-5-5', prices) - 16.1) < 1e-9)
  assert.equal(aggregate([bk('2026-10-24T10', { model: 'mystery' })], utc, { prices }).unpriced[0], 'mystery')
})

test('cache hit and delta', () => {
  assert.equal(cacheHit({ input: 100, cache_read: 800, cache_creation: 100 }), 0.8)
  assert.equal(cacheHit({ input: 0, cache_read: 0, cache_creation: 0 }), null)
  assert.equal(delta(150, 100), 0.5)
  assert.equal(delta(5, 0), null)
})

test('records: best day, streak ending today, longest session', () => {
  const now = Date.parse('2026-10-25T12:00:00Z')
  const days = aggregate([bk('2026-10-23T10'), bk('2026-10-24T10', { output: 900 }), bk('2026-10-25T09')], utc).days
  const r = records(days, [{ first_ts: '2026-10-24T10:00:00Z', last_ts: '2026-10-24T12:00:00Z', output: 5 }, { first_ts: '2026-10-25T10:00:00Z', last_ts: '2026-10-25T10:10:00Z', output: 50 }], utc, now)
  assert.equal(r.bestDay.day, '2026-10-24')
  assert.equal(r.streak, 3)
  assert.equal(r.longest.ms, 2 * 3_600_000)
  assert.equal(r.biggest.output, 50)
  // yesterday is the last active day: the streak survives an empty today
  assert.equal(records(days, [], utc, Date.parse('2026-10-26T01:00:00Z')).streak, 3)
  assert.equal(records(days, [], utc, Date.parse('2026-10-28T01:00:00Z')).streak, 0)
})

test('new input is plain input plus cache writes, never cache reads', () => {
  assert.equal(freshInput({ input: 10, cache_creation: 500, cache_read: 99999 }), 510)
  const k = aggregate([bk('2026-10-26T07', { input: 10, cache_creation: 50, cache_read: 1000 })], utc)
  assert.equal(k.matrix[0][7].input, 60)
})

test('aggregate can keep one provider (rows without one count as everything)', () => {
  const buckets = [bk('2026-10-24T10', { provider: 'claude' }), bk('2026-10-24T11', { provider: 'codex', output: 7, model: 'gpt-5-codex' }), bk('2026-10-24T12', { provider: 'codex', output: 5 })]
  assert.equal(aggregate(buckets, kyiv, { prices }).total.output, 112)
  assert.equal(aggregate(buckets, kyiv, { prices, provider: 'codex' }).total.output, 12)
  assert.equal(aggregate(buckets, kyiv, { prices, provider: 'claude' }).total.output, 100)
  assert.equal(aggregate(buckets, kyiv, { prices, provider: 'gemini' }).total.output, 0)
})

test('a price applies to its own model and dated or suffixed ids, not to another version', () => {
  const p = { updated: '', source: '', note: '', models: [{ match: 'gpt-5', input: 1, output: 2, cache_read: 0, cache_write: 1 }, { match: 'gpt-5-mini', input: 3, output: 4, cache_read: 0, cache_write: 3 }, { match: 'claude-sonnet-5', input: 9, output: 9, cache_read: 0, cache_write: 9 }] }
  assert.equal(priceFor('gpt-5', p).input, 1)
  assert.equal(priceFor('gpt-5-2025-08-07', p).input, 1)
  assert.equal(priceFor('gpt-5-mini-2025-08-07', p).input, 3)
  assert.equal(priceFor('gpt-5.6-sol', p), null)
  assert.equal(priceFor('gpt-50', p), null)
  assert.equal(priceFor('claude-sonnet-5-5-20260101', p).input, 9)
})
