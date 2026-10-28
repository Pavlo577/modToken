// The columns of the main chart for a time step: their keys, labels and tooltips, and the totals in each column. Pure (the time zone and the data come in).
import { dayLabel, dayLong } from './format.ts'
import { halfKey } from './steps.ts'
import { dayList } from './stats.ts'
import type { Tz } from './stats.ts'
import type { Totals, TurnRow } from './types.ts'

export interface Filter { device: string | null; provider: string | null }

/** How the keys of a grid are written, so a vertical marker can find its place (core/bounds.ts). */
export type KeyUnit = { unit: 'day' } | { unit: 'hour' } | { unit: 'half' } | { unit: 'ts' }

export interface Grid {
  keys: string[]
  labels: string[]
  /** Wider labels (date and time) need more room between them. */
  labelGap: number
  tip: (i: number) => string
  extraTip?: (i: number) => [string, string][]
  rowsOf: (f: Filter) => Totals[]
  unit: KeyUnit
  /** Shown after the period's title (e.g. that only the latest turns are drawn). */
  note?: string
}

const pad = (n: number): string => String(n).padStart(2, '0')
const zero = (): Totals => ({ input: 0, output: 0, cache_read: 0, cache_creation: 0, duration_ms: 0, turns: 0, cost: 0 })
const addTo = (a: Totals, b: Partial<Totals>): void => { a.input += b.input || 0; a.output += b.output || 0; a.cache_read += b.cache_read || 0; a.cache_creation += b.cache_creation || 0; a.duration_ms += b.duration_ms || 0; a.turns += b.turns || 0; a.cost += b.cost || 0 }
const clock = (h: number, m: number): string => `${pad(h)}:${pad(m)}`

/** What S.aggregate offers: totals per local day and per local hour (`YYYY-MM-DDTHH`). */
export interface Aggregated { days: Map<string, Totals>; hours: Map<string, Totals> }

/** Steps that come from the hourly buckets: 60 minutes, 12 hours, 24 hours. */
export function bucketGrid(fromDay: string, toDay: string, step: 60 | 720 | 1440, aggOf: (f: Filter) => Aggregated): Grid {
  const days = dayList(fromDay, toDay), one = days.length === 1
  if (step === 1440) {
    return { keys: days, labels: days.map(dayLabel), labelGap: 64, tip: i => dayLong(days[i]), unit: { unit: 'day' }, rowsOf: f => { const a = aggOf(f).days; return days.map(d => a.get(d) ?? zero()) } }
  }
  if (step === 720) {
    const keys = days.flatMap(d => [`${d}T00`, `${d}T12`])
    return {
      keys, labelGap: 90, unit: { unit: 'half' },
      labels: keys.map(k => `${one ? '' : dayLabel(k.slice(0, 10)) + ' '}${k.slice(11)}:00`),
      tip: i => `${dayLong(keys[i].slice(0, 10))}, ${keys[i].slice(11) === '00' ? '0:00–11:59' : '12:00–23:59'}`,
      rowsOf: f => {
        const h = aggOf(f).hours
        return keys.map(k => { const t = zero(), base = Number(k.slice(11)); for (let x = base; x < base + 12; x++) { const r = h.get(`${k.slice(0, 10)}T${pad(x)}`); if (r) addTo(t, r) } return t })
      },
    }
  }
  const keys = days.flatMap(d => Array.from({ length: 24 }, (_, h) => `${d}T${pad(h)}`))
  return {
    keys, labelGap: one ? 64 : 90, unit: { unit: 'hour' },
    labels: keys.map(k => (one ? `${+k.slice(11)}:00` : `${dayLabel(k.slice(0, 10))} ${k.slice(11)}:00`)),
    tip: i => `${dayLong(keys[i].slice(0, 10))}, ${+keys[i].slice(11)}:00`,
    rowsOf: f => { const h = aggOf(f).hours; return keys.map(k => h.get(k) ?? zero()) },
  }
}

/** One column per turn (the turns that pass the viewer's device and agent choice; `rowsOf` keeps their places and zeroes the ones another filter drops). */
export function turnGrid(tz: Tz, turns: TurnRow[], limit: number): Grid {
  const first = turns.length ? tz.parts(Date.parse(turns[0].ts)).day : '', last = turns.length ? tz.parts(Date.parse(turns[turns.length - 1].ts)).day : ''
  const one = first === last
  const local = turns.map(t => { const p = tz.parts(Date.parse(t.ts)); return { day: p.day, time: `${clock(p.h, p.min)}:${pad(Math.floor(((Date.parse(t.ts) % 60_000) + 60_000) % 60_000 / 1000))}` } })
  return {
    keys: turns.map(t => t.ts), labelGap: one ? 64 : 100, unit: { unit: 'ts' },
    labels: local.map(l => (one ? l.time.slice(0, 5) : `${dayLabel(l.day)} ${l.time.slice(0, 5)}`)),
    tip: i => `${dayLong(local[i].day)}, ${local[i].time}`,
    extraTip: i => [['Модель', turns[i].model], ['Пристрій', turns[i].device]],
    note: turns.length >= limit ? `показано останні ${limit} ходів` : undefined,
    rowsOf: f => turns.map(t => {
      const z = zero()
      if ((!f.device || t.device === f.device) && (!f.provider || t.provider === f.provider)) addTo(z, { input: t.input, output: t.output, cache_read: t.cache_read, cache_creation: t.cache_creation, duration_ms: t.duration_ms, turns: !t.kind || t.kind === 'main' ? 1 : 0 }) // a turn = the main loop's call, as everywhere else
      return z
    }),
  }
}

