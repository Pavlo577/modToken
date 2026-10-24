// The shown period (today / week / month / year / custom) as concrete days and instants.
import * as S from '../lib/stats.ts'
import { dayLabel, dayLong } from '../lib/format.ts'
import { state } from './state.ts'
import { lastOfMonth, monthName, tz } from './time.ts'

export interface Period {
  today: string
  fromDay: string
  toDay: string
  from: number
  to: number
  len: number
  prevFrom: number
  /** Text for the pager: which week / month / year is shown. */
  label: string
}

export function currentRange(): Period {
  const today = tz.today()
  const at = state.anchor || today
  let fromDay = today, toDay = today, prevDay = ''
  let label = ''
  if (state.range === 'custom') {
    fromDay = state.from || S.addDays(today, -29); toDay = state.to || today
    if (fromDay > toDay) [fromDay, toDay] = [toDay, fromDay]
    if (S.daysBetween(fromDay, toDay) > 399) fromDay = S.addDays(toDay, -399)
  } else if (state.range === 'week') {
    fromDay = S.addDays(at, -tz.parts(tz.startOfDay(at) + 12 * 3_600_000).dow); toDay = S.addDays(fromDay, 6)
    prevDay = S.addDays(fromDay, -7)
    label = `${dayLabel(fromDay)} – ${dayLong(toDay)}`
  } else if (state.range === 'month') {
    fromDay = at.slice(0, 7) + '-01'; toDay = lastOfMonth(at.slice(0, 7))
    prevDay = S.addDays(fromDay, -1).slice(0, 7) + '-01'
    label = `${monthName(at.slice(0, 7))} ${at.slice(0, 4)}`
  } else if (state.range === 'year') {
    fromDay = at.slice(0, 4) + '-01-01'; toDay = at.slice(0, 4) + '-12-31'
    prevDay = `${+at.slice(0, 4) - 1}-01-01`
    label = at.slice(0, 4)
  }
  const { from, to } = S.rangeMs(tz, fromDay, toDay)
  const len = S.daysBetween(fromDay, toDay) + 1
  let prevFrom = tz.startOfDay(prevDay || S.addDays(fromDay, -len))
  // the Worker serves at most 400 days at a time: where the previous period does not fit, skip the comparison
  if (to - prevFrom > 395 * 86_400_000) prevFrom = from
  return { today, fromDay, toDay, from, to, len, prevFrom, label }
}

export const rangeTitle = (r: Period): string => (r.len === 1 ? dayLong(r.fromDay) : `${dayLong(r.fromDay)} — ${dayLong(r.toDay)}`)
