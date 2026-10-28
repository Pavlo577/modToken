// How far back the pages go (the month of the oldest turn) and since when OTLP counts the tokens.
import type { Marker } from '../charts/base.ts'
import { dayLong } from '../lib/format.ts'
import type { KeyUnit } from '../lib/grid.ts'
import { halfKey } from '../lib/steps.ts'
import { state } from './state.ts'
import { store } from './store.ts'
import { pad, tz } from './time.ts'

/** The day of the oldest turn (today while there is no data). */
export const firstDay = (): string => (store.first ? tz.parts(Date.parse(store.first)).day : tz.today())
export const firstMonth = (): string => firstDay().slice(0, 7)
export const currentMonth = (): string => tz.today().slice(0, 7)

/** Months a calendar may show: from the oldest turn's month to the current one. */
export const inReach = (month: string): boolean => month >= firstMonth() && month <= currentMonth()

/**
 * A vertical line on a chart whose columns are `keys` (written as `unit` says): from there on the tokens are counted from OTLP, before it they
 * may be incomplete. Of the devices shown, the earliest start counts; nothing is drawn when OTLP covers the whole chart.
 */
export function otlpMarker(keys: string[], unit: KeyUnit): Marker | undefined {
  const starts = store.devices.filter(d => d.otlp_since && (!state.device || d.name === state.device)).map(d => Date.parse(d.otlp_since as string))
  if (!starts.length || !keys.length) return undefined
  const ms = Math.min(...starts)
  const p = tz.parts(ms)
  let stamp: string, frac = 0
  switch (unit.unit) {
    case 'day': stamp = p.day; frac = (p.h * 60 + p.min) / 1440; break
    case 'hour': stamp = `${p.day}T${pad(p.h)}`; frac = p.min / 60; break
    case 'half': stamp = halfKey(p.day, p.h); frac = ((p.h % 12) * 60 + p.min) / 720; break
    case 'ts': stamp = new Date(ms).toISOString(); break
  }
  if (stamp < keys[0]) return undefined
  const idx = keys.findIndex(k => k >= stamp)
  const at = idx < 0 ? keys.length : idx + (keys[idx] === stamp ? frac : 0)
  if (at <= 0) return undefined
  return { at, title: `Від ${dayLong(p.day)}, ${pad(p.h)}:${pad(p.min)} токени пишуться через OpenTelemetry. Раніше дані можуть бути неповні: імпорт історії або старий збір.` }
}
