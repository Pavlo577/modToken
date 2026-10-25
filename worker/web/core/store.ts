// What was loaded for the shown period, cached requests and the regrouping by time zone.
import * as S from '../lib/stats.ts'
import { api } from '../lib/api.ts'
import type { Bucket, DeviceRow, LimitRow, Prices, SessionRow, Totals } from '../lib/types.ts'
import type { Period } from './range.ts'
import { state } from './state.ts'
import { iso, tz } from './time.ts'

export const ZERO: Totals = { input: 0, output: 0, cache_read: 0, cache_creation: 0, duration_ms: 0, turns: 0, cost: 0 }

interface Data {
  r: Period
  buckets: Bucket[]
  sessions: SessionRow[]
  limits: LimitRow[]
}

/** Loaded data and lists shared by the tabs. */
export const store: { data: Data | null; prices: Prices | null; deviceNames: string[]; providers: string[]; first: string | null; devices: DeviceRow[] } =
  { data: null, prices: null, deviceNames: [], providers: [], first: null, devices: [] }

const memo = new Map<string, { t: number; v: unknown }>()

export const get = async <T>(path: string): Promise<T> => {
  const hit = memo.get(path)
  if (hit && Date.now() - hit.t < 45_000) return hit.v as T
  const v = await api<T>(path)
  memo.set(path, { t: Date.now(), v })
  if (memo.size > 40) memo.delete(memo.keys().next().value as string)
  return v
}

export const q = (a: number, b: number): string => `from=${encodeURIComponent(iso(a))}&to=${encodeURIComponent(iso(b))}`

export const need = (): Data => { if (!store.data) throw new Error('data not loaded'); return store.data }

export const aggregate = (opts: S.AggregateOptions = {}): S.Aggregate => {
  const d = need()
  return S.aggregate(d.buckets, tz, { fromMs: d.r.from, toMs: d.r.to, device: state.device || null, provider: state.provider || null, prices: store.prices, ...opts })
}

/** The agent comparison needs data from several agents, all of them selected, and a line / bar chart. */
export const compareAvailable = (): boolean => store.providers.length > 1 && !state.provider && state.view !== 'cal'

/** Fixed-scale button: not in the calendar, and not on a logarithmic axis (that one is fitted to its own values). */
export const fixedScaleAvailable = (): boolean => state.view !== 'cal' && !(state.metric === 'all' && state.scale === 'log' && !state.ioHidden && !(state.compare && compareAvailable()))
