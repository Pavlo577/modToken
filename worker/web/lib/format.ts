// Number, duration and date formatting (Ukrainian).

export const fmt = (n: number | null | undefined): string => {
  const v = Number(n) || 0
  const a = Math.abs(v)
  return a >= 1e9 ? (v / 1e9).toFixed(2) + ' млрд' : a >= 1e6 ? (v / 1e6).toFixed(2) + ' млн' : a >= 1e4 ? (v / 1e3).toFixed(1) + ' тис' : a >= 1e3 ? (v / 1e3).toFixed(2) + ' тис' : String(Math.round(v))
}

export const fmtAxis = (n: number): string => {
  const a = Math.abs(n)
  return a >= 1e9 ? +(n / 1e9).toFixed(1) + 'B' : a >= 1e6 ? +(n / 1e6).toFixed(1) + 'M' : a >= 1e3 ? +(n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k' : String(Math.round(n * 10) / 10)
}

export const fmtUsd = (n: number): string => (n >= 100 ? '$' + Math.round(n).toLocaleString('en-US') : n >= 1 ? '$' + n.toFixed(2) : '$' + n.toFixed(3))

export const fmtPct = (f: number | null, d = 0): string => (f == null ? '—' : (f * 100).toFixed(d) + '%')

export const dur = (ms: number): string => {
  const m = Math.round((Number(ms) || 0) / 60000)
  return m >= 60 ? Math.floor(m / 60) + ' год ' + (m % 60) + ' хв' : m + ' хв'
}

export const durSec = (ms: number): string => {
  const s = Math.round((Number(ms) || 0) / 1000)
  return s >= 3600 ? `${Math.floor(s / 3600)} год ${Math.round((s % 3600) / 60)} хв` : s >= 60 ? `${Math.floor(s / 60)} хв ${s % 60} с` : s + ' с'
}

const MONTHS = ['січ', 'лют', 'бер', 'кві', 'тра', 'чер', 'лип', 'сер', 'вер', 'жов', 'лис', 'гру']

export const DOW = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд']

export const dayLabel = (day: string): string => { const [, m, d] = day.split('-'); return `${+d} ${MONTHS[+m - 1]}` }

export const dayLong = (day: string): string => { const [y, m, d] = day.split('-'); return `${+d} ${MONTHS[+m - 1]} ${y}` }

export const monthLabel = (m: number): string => MONTHS[m - 1]
