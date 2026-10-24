// Pure functions behind the dashboard: time zones, grouping, cost, subscription limits.
// No DOM here, so all of it is tested in Node (test/stats.test.mjs).
import type { Bucket, Counts, LimitRow, PriceEntry, Prices, SessionRow, Totals } from './types.ts'

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
  for (const p of prices?.models ?? []) if (String(model).startsWith(p.match) && (!best || p.match.length > best.match.length)) best = p
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
  prices?: Prices | null
}

/**
 * Hourly UTC buckets -> everything the charts need, in the viewer's time zone.
 * `bucket.h` is 'YYYY-MM-DDTHH' (UTC). `fromMs`/`toMs` clip to the shown range; `device` filters.
 */
export function aggregate(buckets: Bucket[], tz: Tz, { fromMs = -Infinity, toMs = Infinity, device = null, prices = null }: AggregateOptions = {}): Aggregate {
  const days = new Map<string, Totals>(), models = new Map<string, Totals>(), devices = new Map<string, Totals>(), hours = new Map<string, Totals>()
  const unpriced = new Set<string>()
  const matrix: Cell[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ output: 0, input: 0, turns: 0 })))
  const total = zero()
  for (const b of buckets) {
    if (device && b.device !== device) continue
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

// ---- subscription limits
export interface LimitNow extends LimitRow {
  isStale: boolean
  /** When the current window really began, if it began with a manual limit reset (not the usual rollover). */
  resetAt?: number
}

const SPAN: Record<string, number> = { five_hour: 5 * 3_600_000, seven_day: 7 * DAY }
const SAME_MS = 60_000 // resets_at readings this close are the same window
const RESET_DROP = 3 // a fall of more than this many percent inside one window means it was reset by hand
const EARLY_MS = 30 * 60_000 // a window whose successor shows up this much before its resets_at was cut short

export interface Window {
  start: number
  end: number
  peak: number
  /** Ended early: the limit was reset by hand (or exhausted and then reset). */
  reset: boolean
  /** Began right after such a reset. */
  afterReset: boolean
}

/**
 * Windows of one kind in the snapshots. A new one starts when resets_at moves on, or when the percent falls
 * inside the same resets_at (the "reset limits" button). A window that was cut short ends where its successor
 * was first seen, and the successor starts there instead of resets_at minus the full span.
 */
function windowsOf(rows: LimitRow[], kind: string): Window[] {
  const span = SPAN[kind] ?? 7 * DAY
  const list = rows.filter(r => r.kind === kind && r.resets_at).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  const segs: { resets: number; firstTs: number; peak: number; last: number }[] = []
  for (const r of list) {
    const resets = Date.parse(r.resets_at as string), ts = Date.parse(r.ts)
    const cur = segs[segs.length - 1]
    if (cur && resets < cur.resets - SAME_MS) continue // a device that lagged behind and still reports the old window
    if (cur && Math.abs(resets - cur.resets) < SAME_MS && r.percent >= cur.last - RESET_DROP) {
      cur.peak = Math.max(cur.peak, r.percent)
      cur.last = r.percent
      continue
    }
    segs.push({ resets, firstTs: ts, peak: r.percent, last: r.percent })
  }
  const out: Window[] = []
  segs.forEach((sg, i) => {
    const next = segs[i + 1], prev = out[i - 1]
    const reset = !!next && next.firstTs < sg.resets - EARLY_MS
    out.push({
      start: prev?.reset ? prev.end : sg.resets - span,
      end: reset ? next.firstTs : sg.resets,
      peak: sg.peak, reset, afterReset: !!prev?.reset,
    })
  })
  return out
}

/** Latest reading per window kind; a window that has already reset counts as 0. */
export function latestLimits(rows: LimitRow[], now = Date.now()): Record<string, LimitNow> {
  const latest: Record<string, LimitRow> = {}
  for (const r of rows) if (!latest[r.kind] || r.ts > latest[r.kind].ts) latest[r.kind] = r
  const out: Record<string, LimitNow> = {}
  for (const [k, r] of Object.entries(latest)) {
    const stale = !!r.resets_at && Date.parse(r.resets_at) <= now
    const win = windowsOf(rows, k).at(-1)
    out[k] = { ...r, isStale: stale, percent: stale ? 0 : r.percent, resetAt: win?.afterReset && !stale ? win.start : undefined }
  }
  return out
}

/** The seven-day windows seen in the snapshots: peak percent, when each started and ended. */
export const weeklyWindows = (rows: LimitRow[]): Window[] => windowsOf(rows, 'seven_day')

export interface Forecast {
  fullAt: number
  willFill: boolean
}

/** At the current pace: when the window fills up, and whether that is before it resets. */
export function forecast(limit: Pick<LimitNow, 'kind' | 'percent' | 'resets_at'> & { isStale?: boolean; resetAt?: number } | undefined, now = Date.now()): Forecast | null {
  if (!limit || !limit.resets_at || limit.isStale || limit.percent <= 0) return null
  const end = Date.parse(limit.resets_at)
  const start = Math.max(end - (SPAN[limit.kind] ?? 7 * DAY), limit.resetAt ?? 0)
  const elapsed = now - start
  if (elapsed <= 0) return null
  const fullAt = start + (elapsed * 100) / limit.percent
  return { fullAt, willFill: fullAt < end }
}

export interface WindowEfficiency extends Window {
  tokens: number
  cost: number
  tokensPerPct: number | null
  costPerPct: number | null
}

/** Plan efficiency: what a window's worth of use cost per 1% of the limit, from the hourly buckets. */
export function efficiency(windows: Window[], buckets: Bucket[], prices: Prices | null): WindowEfficiency[] {
  return windows.map(w => {
    const t = zero()
    for (const b of buckets) {
      const ms = Date.parse(b.h + ':00:00Z')
      if (ms >= w.start && ms < w.end) add(t, b, costOf(b, b.model, prices) ?? 0)
    }
    const per = w.peak > 0 ? w.peak : null
    return { ...w, tokens: t.input + t.output, cost: t.cost, tokensPerPct: per ? (t.input + t.output) / per : null, costPerPct: per ? t.cost / per : null }
  })
}
