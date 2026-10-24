// The viewer's time zone and the small date/time helpers built on it.
import * as S from '../lib/stats.ts'

export const tz = S.makeTz(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')

export const pad = (n: number): string => String(n).padStart(2, '0')

export const iso = (ms: number): string => new Date(ms).toISOString()

// ---------- period
export const monthName = (month: string): string => new Intl.DateTimeFormat('uk-UA', { month: 'long', timeZone: 'UTC' }).format(Date.parse(month + '-15T12:00:00Z'))

export const lastOfMonth = (month: string): string => new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).toISOString().slice(0, 10)

// ---------- one day
export const weekday = (day: string): string => new Intl.DateTimeFormat('uk-UA', { weekday: 'long', timeZone: 'UTC' }).format(Date.parse(day + 'T12:00:00Z'))

export const timeOf = (ms: number): string => { const p = tz.parts(ms); return `${pad(p.h)}:${pad(p.min)}` }

// ---------- wiring
export const offsetText = (): string => {
  const m = tz.offsetMs(Date.now()) / 60_000
  return (m < 0 ? '−' : '+') + pad(Math.floor(Math.abs(m) / 60)) + ':' + pad(Math.abs(m) % 60)
}
