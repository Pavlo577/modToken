// Pure functions behind the dashboard: time zones, grouping, cost.
// No DOM here, so all of it is tested in Node (test/stats.test.mjs).
import type { Bucket, Counts, PriceEntry, Prices, SessionRow, Totals } from './types.ts'

const DAY = 86_400_000
const pad = (n: number): string => String(n).padStart(2, '0')

/** Calendar math on 'YYYY-MM-DD' strings (no time zone involved). */
export const addDays = (day: string, n: number): string => new Date(Date.parse(day + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10)
export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY)
export const dayList = (from: string, to: string): string[] => Array.from({ length: Math.max(0, daysBetween(from, to) + 1) }, (_, i) => addDays(from, i))

export interface LocalParts {
  y: number
  m: number
  d: number
  h: number
  min: number
  day: string
  /** 0 = Monday ... 6 = Sunday */
  dow: number
}

export interface Tz {
  tz: string
  parts(ms: number): LocalParts
  offsetMs(ms: number): number
  startOfDay(day: string): number
  today(now?: number): string
}

/** A viewer's time zone: local calendar parts of an instant, and local midnights back to UTC. */
export function makeTz(tz: string): Tz {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  const cache = new Map<number, LocalParts>()
  const parts = (ms: number): LocalParts => {
    const key = Math.floor(ms / 60_000)
    let p = cache.get(key)
    if (!p) {
      const o: Record<string, string> = {}
      for (const { type, value } of dtf.formatToParts(ms)) o[type] = value
      const y = +o.year, m = +o.month, d = +o.day, h = +o.hour === 24 ? 0 : +o.hour, min = +o.minute
      p = { y, m, d, h, min, day: `${y}-${pad(m)}-${pad(d)}`, dow: (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7 }
      if (cache.size > 50_000) cache.clear()
      cache.set(key, p)
    }
    return p
  }
  const offsetMs = (ms: number): number => {
    const p = parts(ms)
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - Math.floor(ms / 60_000) * 60_000
  }
  const startOfDay = (day: string): number => {
    const guess = Date.parse(day + 'T00:00:00Z')
    let t = guess - offsetMs(guess)
    const off2 = offsetMs(t)
    if (guess - off2 !== t) t = guess - off2
    return t
  }
  return { tz, parts, offsetMs, startOfDay, today: (now = Date.now()) => parts(now).day }
}

/** The UTC instants [from, to) that cover the local days `fromDay` to `toDay` (inclusive). */
export const rangeMs = (tz: Tz, fromDay: string, toDay: string): { from: number; to: number } => ({
  from: tz.startOfDay(fromDay),
  to: tz.startOfDay(addDays(toDay, 1)),
})

// ---- prices
export function priceFor(model: string, prices: Prices | null): PriceEntry | null {
  let best: PriceEntry | null = null
  const id = String(model)
  for (const p of prices?.models ?? []) {
    if (!id.startsWith(p.match) || (best && p.match.length <= best.match.length)) continue
    const rest = id.slice(p.match.length)
    // exact entries (generated from the community list) cover the model and its dated copies only: "gpt-5.6" is not "gpt-5.6-pro"
    // other entries are prefixes that end at the end of the id or at a "-" / "_": "gpt-5" is not "gpt-5.6-sol" or "gpt-50"
    const ok = p.exact ? rest === '' || /^-\d{4}-\d{2}-\d{2}$/.test(rest) : rest === '' || /^[-_]/.test(rest)
    if (ok) best = p
  }
  return best
}

type Usage = Partial<Pick<Counts, 'input' | 'output' | 'cache_read' | 'cache_creation'>>

export function costOf(row: Usage, model: string | null, prices: Prices | null): number | null {
  const p = model ? priceFor(model, prices) : null
  if (!p) return null
  return ((row.input || 0) * p.input + (row.output || 0) * p.output + (row.cache_read || 0) * p.cache_read + (row.cache_creation || 0) * p.cache_write) / 1e6
}

const zero = (): Totals => ({ input: 0, output: 0, cache_read: 0, cache_creation: 0, duration_ms: 0, turns: 0, cost: 0 })
const add = (t: Totals, r: Partial<Counts>, cost: number): void => {
  t.input += r.input || 0; t.output += r.output || 0; t.cache_read += r.cache_read || 0; t.cache_creation += r.cache_creation || 0
  t.duration_ms += r.duration_ms || 0; t.turns += r.turns || 0; t.cost += cost || 0
}
const slot = <K>(m: Map<K, Totals>, k: K): Totals => m.get(k) ?? m.set(k, zero()).get(k)!

/** New input: what the model had to read fresh (plain input plus cache writes), not what came from the cache. */
export const freshInput = (t: Usage): number => (t.input || 0) + (t.cache_creation || 0)

export interface Cell {
  output: number
  /** new input, see freshInput */
  input: number
  turns: number
}

export interface Aggregate {
  /** by local day 'YYYY-MM-DD' */
  days: Map<string, Totals>
  models: Map<string, Totals>
  devices: Map<string, Totals>
  /** by local hour 'YYYY-MM-DDTHH' */
  hours: Map<string, Totals>
  /** matrix[dow][hour], Monday first, local time */
  matrix: Cell[][]
  total: Totals
  unpriced: string[]
}

export interface AggregateOptions {
  fromMs?: number
  toMs?: number
  device?: string | null
  provider?: string | null
  prices?: Prices | null
}

/**
 * Hourly UTC buckets -> everything the charts need, in the viewer's time zone.
 * `bucket.h` is 'YYYY-MM-DDTHH' (UTC). `fromMs`/`toMs` clip to the shown range; `device` and `provider` filter.
 */
export function aggregate(buckets: Bucket[], tz: Tz, { fromMs = -Infinity, toMs = Infinity, device = null, provider = null, prices = null }: AggregateOptions = {}): Aggregate {
  const days = new Map<string, Totals>(), models = new Map<string, Totals>(), devices = new Map<string, Totals>(), hours = new Map<string, Totals>()
  const unpriced = new Set<string>()
  const matrix: Cell[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ output: 0, input: 0, turns: 0 })))
  const total = zero()
  for (const b of buckets) {
    if (device && b.device !== device) continue
    if (provider && b.provider !== provider) continue
    const ms = Date.parse(b.h + ':00:00Z')
    if (ms < fromMs || ms >= toMs) continue
    const p = tz.parts(ms)
    const cost = costOf(b, b.model, prices)
    if (cost === null && prices) unpriced.add(b.model)
    const c = cost ?? 0
    add(slot(days, p.day), b, c)
    add(slot(models, b.model), b, c)
    add(slot(devices, b.device), b, c)
    add(slot(hours, `${p.day}T${pad(p.h)}`), b, c)
    const cell = matrix[p.dow][p.h]
    cell.output += b.output || 0; cell.input += freshInput(b); cell.turns += b.turns || 0
    add(total, b, c)
  }
  return { days, models, devices, hours, matrix, total, unpriced: [...unpriced] }
}

/** Share of the prompt that was served from cache, 0..1 (null when there was no prompt). */
export const cacheHit = (t: Usage): number | null => {
  const all = (t.input || 0) + (t.cache_read || 0) + (t.cache_creation || 0)
  return all ? (t.cache_read || 0) / all : null
}

/** Change against the previous period of the same length, as a fraction (null when there is no baseline). */
export const delta = (now: number, before: number): number | null => (before > 0 ? now / before - 1 : null)

// ---- records
export interface Records {
  bestDay: { day: string; output: number; turns: number } | null
  mostTurns: { day: string; turns: number } | null
  streak: number
  longest: (SessionRow & { ms: number }) | null
  biggest: SessionRow | null
  activeDays: number
}

export function records(daysAgg: Map<string, Totals>, sessions: SessionRow[], tz: Tz, now = Date.now()): Records {
  let bestDay: Records['bestDay'] = null, mostTurns: Records['mostTurns'] = null
  for (const [day, t] of daysAgg) {
    if (!bestDay || t.output > bestDay.output) bestDay = { day, output: t.output, turns: t.turns }
    if (!mostTurns || t.turns > mostTurns.turns) mostTurns = { day, turns: t.turns }
  }
  const active = new Set([...daysAgg].filter(([, t]) => t.turns > 0).map(([d]) => d))
  const today = tz.today(now)
  let streak = 0
  // today may still be empty without breaking the streak
  for (let d = active.has(today) ? today : addDays(today, -1); active.has(d) && streak <= 3650; d = addDays(d, -1)) streak++
  const dur = (s: SessionRow): number => Date.parse(s.last_ts) - Date.parse(s.first_ts)
  let longest: SessionRow | null = null, biggest: SessionRow | null = null
  for (const s of sessions) {
    if (!longest || dur(s) > dur(longest)) longest = s
    if (!biggest || s.output > biggest.output) biggest = s
  }
  return { bestDay, mostTurns, streak, longest: longest && { ...longest, ms: dur(longest) }, biggest, activeDays: active.size }
}
