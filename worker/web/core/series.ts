// The columns of the main chart for the chosen time step: the hourly buckets already loaded (60 min, 12 h, 24 h) or a request of their own (5, 15, 30 min, every record).
import { bucketGrid, seriesGrid, turnGrid } from '../lib/grid.ts'
import type { Filter, Grid, SeriesRow } from '../lib/grid.ts'
import { SERIES_STEPS, stepRange } from '../lib/steps.ts'
import type { TurnRow } from '../lib/types.ts'
import type { Period } from './range.ts'
import { state } from './state.ts'
import { aggregate, get, q } from './store.ts'
import { tz } from './time.ts'

export const TURN_LIMIT = 5000

/** The shown period's step in minutes (0 = every record): the choice for a day, a week or a month; a single custom day is hourly, anything else daily. */
export function currentStep(r: Period): number {
  const sr = stepRange(state.range)
  if (sr) return state.steps[sr]
  return r.len === 1 ? 60 : 1440
}

/** Needs a request of its own (the hourly buckets are too coarse). */
export const isRemote = (step: number): boolean => step === 0 || SERIES_STEPS.includes(step)

const aggOf = (f: Filter) => aggregate({ device: f.device, provider: f.provider })

export const localGrid = (r: Period, step: number): Grid => bucketGrid(r.fromDay, r.toDay, step === 720 ? 720 : step === 1440 ? 1440 : 60, aggOf)

export async function remoteGrid(r: Period, step: number): Promise<Grid> {
  if (step === 0) {
    let turns = await get<TurnRow[]>('/turns?' + q(r.from, r.to) + '&last=1')
    if (state.device) turns = turns.filter(t => t.device === state.device)
    if (state.provider) turns = turns.filter(t => t.provider === state.provider)
    return turnGrid(tz, turns, TURN_LIMIT)
  }
  const rows = await get<SeriesRow[]>(`/series?${q(r.from, r.to)}&step=${step}&off=${Math.round(tz.offsetMs(r.from) / 60_000)}`)
  return seriesGrid(tz, r.from, r.to, step, rows)
}
