// Dashboard: loads the data once per period, regroups it in the viewer's time zone and draws the tabs.
import { $, el, api, skeleton, skeletonTile, fmt, fmtUsd, fmtPct, fmtAxis, dur, durSec, dayLabel, dayLong, DOW } from './util.ts'
import { lineChart, barChart, calendarHeatmap, hourGrid, heatGrid, monthCalendars, monthTiles, donut, COLORS, HEAT } from './charts.ts'
import type { HeatCell, TipRow } from './charts.ts'
import type { Series } from './charts.ts'
import * as S from './stats.ts'
import { initDevices, loadDevices } from './devices.ts'
import { dropdown } from './dropdown.ts'
import type { Bucket, LimitRow, Prices, SessionRow, TurnRow, Totals } from './types.ts'

type Tab = 'overview' | 'analytics' | 'money' | 'sessions' | 'devices'
type View = 'line' | 'bars' | 'cal'
type Metric = 'io' | 'all' // 'all' adds the cache reads
/** Which of the two to draw: both, only input (arrow down) or only output (arrow up). */
type IoMode = 'both' | 'in' | 'out'
const IO_NEXT: Record<IoMode, IoMode> = { both: 'in', in: 'out', out: 'both' }

interface State {
  tab: Tab
  range: string // 'today' | 'week' | 'month' | 'year' | 'custom'
  /** A day inside the shown week / month / year; '' means today. Not saved. */
  anchor: string
  /** Year view of the activity card: month tiles or month calendars; '' = by length of the period. */
  actMode: '' | 'min' | 'detail'
  /** Activity card: colour each cell by the device that used the most (all devices only). */
  topDevice: boolean
  from: string
  to: string
  device: string
  view: View
  metric: Metric
  io: IoMode
  /** Main chart with the cache on: 'log' = logarithmic, 'linear' = one linear scale, cache clipped at the top. */
  scale: 'log' | 'linear'
  day: string
}

interface Range {
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

interface Data {
  r: Range
  buckets: Bucket[]
  sessions: SessionRow[]
  limits: LimitRow[]
}

const tz = S.makeTz(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
const PALETTE = ['#ff7a1a', '#3d8bff', '#9b7bff', '#35c98c', '#ffc24a', '#ff5d8f', '#6fd3e8']
const pad = (n: number): string => String(n).padStart(2, '0')
const iso = (ms: number): string => new Date(ms).toISOString()

let saved: Partial<State> = {}
try { saved = JSON.parse(localStorage.getItem('tt-state') || '{}') as Partial<State> } catch { /* private mode: start with defaults */ }
const OLD_RANGES: Record<string, string> = { '7': 'week', '30': 'month', '90': 'month', '365': 'year' }
const state: State = { range: 'month', from: '', to: '', device: '', view: 'line', metric: 'io', io: 'both', scale: 'log', day: '', actMode: '', topDevice: false, ...saved, anchor: '', tab: 'overview' }
state.range = OLD_RANGES[state.range] ?? state.range
if (!(state.io in IO_NEXT)) state.io = 'both'
if (state.metric !== 'all') state.metric = 'io' // the old 'cost' choice is gone
const persist = (): void => {
  try { localStorage.setItem('tt-state', JSON.stringify({ range: state.range, from: state.from, to: state.to, device: state.device, view: state.view, metric: state.metric, io: state.io, scale: state.scale, actMode: state.actMode, topDevice: state.topDevice })) } catch { /* ignore */ }
}

let prices: Prices | null = null
let deviceNames: string[] = []
let data: Data | null = null
const memo = new Map<string, { t: number; v: unknown }>()
const get = async <T>(path: string): Promise<T> => {
  const hit = memo.get(path)
  if (hit && Date.now() - hit.t < 45_000) return hit.v as T
  const v = await api<T>(path)
  memo.set(path, { t: Date.now(), v })
  if (memo.size > 40) memo.delete(memo.keys().next().value as string)
  return v
}
const q = (a: number, b: number): string => `from=${encodeURIComponent(iso(a))}&to=${encodeURIComponent(iso(b))}`
const need = (): Data => { if (!data) throw new Error('data not loaded'); return data }

// ---------- period
const monthName = (month: string): string => new Intl.DateTimeFormat('uk-UA', { month: 'long', timeZone: 'UTC' }).format(Date.parse(month + '-15T12:00:00Z'))
const lastOfMonth = (month: string): string => new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).toISOString().slice(0, 10)

function currentRange(): Range {
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

/** How long loading may take before grey placeholders appear instead of the old charts. */
const SKELETON_AFTER_MS = 250

async function load(): Promise<void> {
  // placeholders only if loading is slow; a quick load goes straight to the charts
  const slow = setTimeout(() => {
    $('kpis').replaceChildren(...Array.from({ length: 6 }, skeletonTile))
    for (const [id, h] of [['main-chart', 260], ['day-chart', 200], ['hour-grid', 200], ['cache-chart', 200], ['cost-chart', 220], ['limits-chart', 200]] as const) skeleton($(id), h)
  }, SKELETON_AFTER_MS)
  const r = currentRange()
  const now = Date.now()
  const histFrom = r.prevFrom
  try {
    const [buckets, sessions, limits] = await Promise.all([
      get<Bucket[]>('/buckets?' + q(histFrom, r.to)),
      get<SessionRow[]>('/sessions?' + q(r.from, r.to)),
      get<LimitRow[]>('/limits?' + q(Math.max(Math.min(r.from, now - 60 * 86_400_000), now - 395 * 86_400_000), Math.max(r.to, now + 1))),
    ])
    clearTimeout(slow)
    data = { r, buckets, sessions, limits }
    const names = [...new Set(buckets.map(b => b.device))].sort()
    deviceNames = names
    if (state.device && !names.includes(state.device)) state.device = ''
    deviceMenu.set([{ value: '', label: 'Усі пристрої' }, ...names.map(n => ({ value: n, label: n }))], state.device)
    render()
  } catch (e) {
    clearTimeout(slow)
    $('kpis').replaceChildren(el('div', { class: 'empty', style: 'grid-column:1/-1' }, 'Не вдалося завантажити: ' + (e as Error).message))
  }
}

const aggregate = (opts: S.AggregateOptions = {}): S.Aggregate => {
  const d = need()
  return S.aggregate(d.buckets, tz, { fromMs: d.r.from, toMs: d.r.to, device: state.device || null, prices, ...opts })
}
const rangeTitle = (r: Range): string => (r.len === 1 ? dayLong(r.fromDay) : `${dayLong(r.fromDay)} — ${dayLong(r.toDay)}`)

// ---------- overview
const arrow = (d: number | null): HTMLElement | '' => (d == null ? '' : el('span', { class: 'delta ' + (d >= 0 ? 'up' : 'down'), title: 'Порівняно з попереднім періодом (тиждень, місяць, рік або така сама кількість днів)' }, (d >= 0 ? '▲ ' : '▼ ') + Math.abs(Math.round(d * 100)) + '%'))

function renderKpis(agg: S.Aggregate): void {
  const r = need().r
  const prev = aggregate({ fromMs: r.prevFrom, toMs: r.from })
  const t = agg.total, p = prev.total
  const tiles: [string, string, number | null, string, string][] = [
    ['Вихідні токени', fmt(t.output), S.delta(t.output, p.output), 'var(--out)', 'те, що написав Claude'],
    ['Вхідні токени', fmt(S.freshInput(t)), S.delta(S.freshInput(t), S.freshInput(p)), 'var(--in)', 'нові, без читання з кешу'],
    ['Кеш-хіт', fmtPct(S.cacheHit(t)), null, 'var(--cache)', 'частка вхідних з кешу'],
    ['Ходів', String(t.turns), S.delta(t.turns, p.turns), 'var(--ok)', 'відповідей Claude'],
    ['Час відповідей', dur(t.duration_ms), S.delta(t.duration_ms, p.duration_ms), 'var(--warn)', 'сумарно'],
    ['Оцінка вартості', fmtUsd(t.cost), S.delta(t.cost, p.cost), 'var(--out)', 'за цінами API'],
  ]
  $('kpis').replaceChildren(...tiles.map(([l, v, d, c, s]) => el('div', { class: 'kpi', style: `--c:${c}` },
    el('div', { class: 'l' }, l), el('div', { class: 'v' }, v), el('div', { class: 's' }, arrow(d), s))))
}

type Def = [label: string, color: string, pick: (t: Totals) => number]
const OUT: Def = ['Вихідні', COLORS.out, t => t.output]
const IN: Def = ['Вхідні (нові)', COLORS.in, S.freshInput]
const ioDefs = (): Def[] => (state.io === 'in' ? [IN] : state.io === 'out' ? [OUT] : [OUT, IN])
const CACHE: Def = ['З кешу', COLORS.cache, t => t.cache_read]
/** Height of the main chart: grows with the window, at most 70% of it. */
const mainHeight = (): number => Math.round(Math.max(300, Math.min(window.innerHeight * 0.5, window.innerHeight * 0.7)))
const ZERO: Totals = { input: 0, output: 0, cache_read: 0, cache_creation: 0, duration_ms: 0, turns: 0, cost: 0 }

function renderMain(agg: S.Aggregate): void {
  const r = need().r
  const { view } = state
  const yFmt = fmtAxis
  const valFmt = fmt
  $('main-chart').replaceChildren()
  $('main-legend').replaceChildren()

  if (view === 'cal') {
    $('main-title').textContent = 'Календар активності'
    $('main-sub').textContent = 'Останні 12 місяців, за твоїм часовим поясом'
    const to = r.today, from = S.addDays(to, -364)
    void get<Bucket[]>('/buckets?' + q(tz.startOfDay(from), tz.startOfDay(S.addDays(to, 1)))).then(buckets => {
      if (state.view !== 'cal') return
      const a = S.aggregate(buckets, tz, { device: state.device || null, prices })
      const picks = ioDefs() // the cache is not shown here
      const days = new Map([...a.days].map(([d, t]) => [d, picks.reduce((sum, [, , pick]) => sum + pick(t), 0)]))
      const label = state.io === 'in' ? 'Нові вхідні' : state.io === 'out' ? 'Вихідні' : 'Нові вхідні + вихідні'
      calendarHeatmap($('main-chart'), {
        from, to, days, addDays: S.addDays,
        dayOfWeek: d => tz.parts(tz.startOfDay(d) + 12 * 3_600_000).dow,
        tipTitle: dayLong,
        tipValue: (d, v) => [[label, fmt(v)], ['Ходів', String(a.days.get(d)?.turns ?? 0)]],
      })
    })
    $('main-legend').replaceChildren(el('span', { style: 'display:flex;gap:6px;align-items:center' }, 'Менше', ...HEAT.map(c => el('i', { style: `background:${c};width:14px;height:14px;border-radius:4px;margin:0` })), 'Більше'))
    return
  }

  const hourly = r.len === 1
  const keys = hourly ? Array.from({ length: 24 }, (_, h) => `${r.fromDay}T${pad(h)}`) : S.dayList(r.fromDay, r.toDay)
  const src = hourly ? agg.hours : agg.days
  const rows = keys.map(k => src.get(k) ?? ZERO)
  const labels = keys.map(k => (hourly ? `${+k.slice(11)}:00` : dayLabel(k)))
  const series: Series[] = ioDefs().map(([label, color, pick]) => ({ label, color, values: rows.map(pick), fmt: valFmt }))
  // the cache is far larger than the rest: logarithmic axis, or one linear scale fitted to input/output with the cache clipped at the top
  const secondary: Series | undefined = state.metric === 'all' ? { label: CACHE[0], color: CACHE[1], values: rows.map(CACHE[2]), fmt: valFmt } : undefined
  $('main-title').textContent = 'Токени'
  $('main-sub').textContent = `${rangeTitle(r)} · ${hourly ? 'по годинах' : 'по днях'}`
  $('main-legend').replaceChildren(...[...series, ...(secondary ? [{ ...secondary, label: secondary.label }] : [])].map(s => el('span', {}, el('i', { style: `background:${s.color}` }), s.label)))
  const opts = {
    labels, series, secondary, yFmt, height: mainHeight(), logScale: !!secondary && state.scale === 'log',
    tipTitle: (i: number): string => (hourly ? `${dayLong(r.fromDay)}, ${keys[i].slice(11)}:00` : dayLong(keys[i])),
    extraTip: (i: number): [string, string][] => [['Ходів', String(rows[i].turns)]],
  }
  if (view === 'bars') barChart($('main-chart'), opts)
  else lineChart($('main-chart'), opts)
}

// ---------- one day
const weekday = (day: string): string => new Intl.DateTimeFormat('uk-UA', { weekday: 'long', timeZone: 'UTC' }).format(Date.parse(day + 'T12:00:00Z'))
const timeOf = (ms: number): string => { const p = tz.parts(ms); return `${pad(p.h)}:${pad(p.min)}` }

async function renderDay(): Promise<void> {
  const day = state.day || need().r.today
  $<HTMLInputElement>('day').value = day
  $('day-sub').textContent = `${weekday(day)}, ${dayLong(day)}`
  const from = tz.startOfDay(day), to = tz.startOfDay(S.addDays(day, 1))
  let turns: TurnRow[]
  try { turns = await get<TurnRow[]>('/turns?' + q(from, to)) } catch (e) {
    $('day-chart').replaceChildren(el('div', { class: 'empty' }, 'Не вдалося завантажити: ' + (e as Error).message))
    return
  }
  if ((state.day || need().r.today) !== day) return
  if (state.device) turns = turns.filter(t => t.device === state.device)
  const hrs = Array.from({ length: 24 }, () => ({ output: 0, input: 0, turns: 0 }))
  let out = 0, inp = 0, ms = 0
  for (const t of turns) {
    const h = tz.parts(Date.parse(t.ts)).h
    hrs[h].output += t.output; hrs[h].input += S.freshInput(t); hrs[h].turns++
    out += t.output; inp += S.freshInput(t); ms += t.duration_ms
  }
  const facts: [string, string][] = [['Вихідні', fmt(out)], ['Вхідні (нові)', fmt(inp)], ['Ходів', String(turns.length)], ['Активний час', dur(ms)]]
  if (turns.length) facts.push(['Перший хід', timeOf(Date.parse(turns[0].ts))], ['Останній хід', timeOf(Date.parse(turns[turns.length - 1].ts))])
  $('day-summary').replaceChildren(...facts.map(([l, v]) => el('div', {}, el('b', {}, v), l)))
  barChart($('day-chart'), {
    labels: hrs.map((_, h) => `${h}:00`), height: 200,
    series: [{ label: 'Вихідні', color: COLORS.out, values: hrs.map(h => h.output), fmt }, { label: 'Вхідні (нові)', color: COLORS.in, values: hrs.map(h => h.input), fmt }],
    tipTitle: i => `${dayLong(day)}, ${i}:00–${i}:59`, extraTip: i => [['Ходів', String(hrs[i].turns)]],
  })
  const shown = turns.slice(-80).reverse()
  $('day-turns').replaceChildren(shown.length ? el('table', {},
    el('thead', {}, el('tr', {}, el('th', { class: 'l' }, 'Час'), el('th', { class: 'l' }, 'Пристрій'), el('th', { class: 'l' }, 'Модель'), el('th', {}, 'Вихідні'), el('th', {}, 'Вхідні (нові)'), el('th', {}, 'З кешу'), el('th', {}, 'Тривалість'))),
    el('tbody', {}, ...shown.map(t => el('tr', {}, el('td', { class: 'l' }, timeOf(Date.parse(t.ts))), el('td', { class: 'l' }, t.device), el('td', { class: 'l' }, t.model),
      el('td', {}, fmt(t.output)), el('td', {}, fmt(S.freshInput(t))), el('td', {}, fmt(t.cache_read)), el('td', {}, t.duration_ms ? durSec(t.duration_ms) : '—'))))) : el('div', { class: 'empty' }, 'У цей день ходів не було'))
}

// ---------- analytics
const totalsTip = (output: number, freshIn: number, turns: number): TipRow[] =>
  [['Вихідні', fmt(output), COLORS.out], ['Вхідні (нові)', fmt(freshIn), COLORS.in], ['Ходів', String(turns)]]

let activitySeq = 0
const devColor = (name: string): string => PALETTE[Math.max(0, deviceNames.indexOf(name)) % PALETTE.length]

/** "When do you work": the grid fits the period (a day, a week, a month, a year or your own span). */
function renderActivity(agg: S.Aggregate): void {
  const r = need().r
  const title = $('act-title'), sub = $('act-sub'), box = $('hour-grid')
  const seq = ++activitySeq
  const long = r.len > 31 // a year, or your own span longer than a month: tiles or calendars
  // up to a month: minimal = calendar, detailed = day x hour grid; longer: minimal = month tiles, detailed = calendars
  const mode = state.actMode || (long && !(state.range === 'year' || r.len > 366) ? 'detail' : 'min')
  $('act-mode').classList.toggle('hide', r.len <= 7)
  press($('act-mode'), 'm', mode)

  // "most used" mode: each cell takes the colour of the device that used the most in it
  const topMode = state.topDevice && !state.device && deviceNames.length > 1
  const per = new Map<string, S.Aggregate>()
  if (topMode) for (const n of deviceNames) per.set(n, aggregate({ device: n }))
  const leader = (value: (a: S.Aggregate) => number | undefined): { color: string; name: string } | undefined => {
    if (!topMode) return undefined
    let best = '', max = 0
    for (const [n, a] of per) { const v = value(a) ?? 0; if (v > max) { max = v; best = n } }
    return best ? { color: devColor(best), name: best } : undefined
  }
  const tinted = (cell: HeatCell, w: { color: string; name: string } | undefined): HeatCell =>
    w ? { ...cell, color: w.color, tip: [...cell.tip, ['Найбільше', w.name, w.color] as TipRow] } : cell
  $('act-legend').classList.toggle('hide', !topMode)
  $('act-legend').replaceChildren(...(topMode ? deviceNames.map(n => el('span', {}, el('i', { style: `background:${devColor(n)}` }), n)) : []))

  const calendars = (): void => {
    const days = new Map<string, HeatCell>()
    for (const [d, t] of agg.days) days.set(d, tinted({ value: t.output, text: fmt(t.output), tip: totalsTip(t.output, S.freshInput(t), t.turns) }, leader(a => a.days.get(d)?.output)))
    monthCalendars(box, {
      from: r.fromDay, to: r.toDay, days, addDays: S.addDays,
      dayOfWeek: d => tz.parts(tz.startOfDay(d) + 12 * 3_600_000).dow,
      monthTitle: m => `${monthName(m)} ${m.slice(0, 4)}`,
      showTitle: state.range !== 'month', // the pager already names the month
      tipTitle: d => `${weekday(d)}, ${dayLong(d)}`,
    })
  }
  if (r.len === 1) {
    title.textContent = 'Активність за день'
    sub.textContent = `${dayLong(r.fromDay)}: вихідні токени по 5 хвилин (стовпець: година, рядок: 5 хвилин)`
    const slow = setTimeout(() => { if (seq === activitySeq) skeleton(box, 300) }, SKELETON_AFTER_MS)
    void get<TurnRow[]>('/turns?' + q(r.from, r.to)).then(all => {
      clearTimeout(slow)
      if (seq !== activitySeq) return
      // acc[five-minute slot][hour]
      const acc = Array.from({ length: 12 }, () => Array.from({ length: 24 }, () => ({ output: 0, input: 0, turns: 0, by: new Map<string, number>() })))
      for (const t of all) {
        if (state.device && t.device !== state.device) continue
        const p = tz.parts(Date.parse(t.ts)), a = acc[Math.floor(p.min / 5)][p.h]
        a.output += t.output; a.input += S.freshInput(t); a.turns++
        a.by.set(t.device, (a.by.get(t.device) ?? 0) + t.output)
      }
      heatGrid(box, {
        cells: acc.map(row => row.map(a => {
          let best = '', max = 0
          if (topMode) for (const [n, v] of a.by) if (v > max) { max = v; best = n }
          return tinted({ value: a.output, tip: totalsTip(a.output, a.input, a.turns) }, best ? { color: devColor(best), name: best } : undefined)
        })),
        rowLabel: m => `:${pad(m * 5)}`, colLabel: h => String(h), maxCell: 80, cellH: 22, labelW: 36,
        tipTitle: (m, h) => `${pad(h)}:${pad(m * 5)}–${pad(h)}:${pad(m * 5 + 4)}`,
      })
    }).catch((e: Error) => { clearTimeout(slow); if (seq === activitySeq) box.replaceChildren(el('div', { class: 'empty' }, 'Не вдалося завантажити: ' + e.message)) })
  } else if (r.len <= 7) {
    title.textContent = 'Коли ти працюєш'
    sub.textContent = 'Вихідні токени за днем тижня й годиною (за твоїм часовим поясом)'
    hourGrid(box, {
      cells: agg.matrix.map((row, d) => row.map((c, h) => tinted({ value: c.output, tip: totalsTip(c.output, c.input, c.turns) }, leader(a => a.matrix[d][h].output)))),
      tipTitle: (row, h) => `${DOW[row]}, ${h}:00–${h}:59`,
    })
  } else if (!long && mode === 'min') {
    title.textContent = 'Активність по днях'
    sub.textContent = 'Вихідні токени за кожен день'
    calendars()
  } else if (!long) {
    title.textContent = 'Активність по днях і годинах'
    sub.textContent = 'Вихідні токени: рядок це день, клітинка це година (за твоїм часовим поясом)'
    const days = S.dayList(r.fromDay, r.toDay)
    heatGrid(box, {
      cells: days.map(d => Array.from({ length: 24 }, (_, h) => {
        const key = `${d}T${pad(h)}`, t = agg.hours.get(key)
        return tinted({ value: t?.output ?? 0, tip: t ? totalsTip(t.output, S.freshInput(t), t.turns) : [] }, leader(a => a.hours.get(key)?.output))
      })),
      rowLabel: i => String(+days[i].slice(8)),
      rightLabel: i => DOW[tz.parts(tz.startOfDay(days[i]) + 12 * 3_600_000).dow],
      colLabel: h => String(h), labelW: 24, maxCell: 60, cellH: 18,
      tipTitle: (i, h) => `${weekday(days[i])}, ${dayLong(days[i])}, ${h}:00–${h}:59`,
    })
  } else if (mode === 'detail') {
    title.textContent = 'Активність по днях'
    sub.textContent = 'Вихідні токени за кожен день, календарі по місяцях'
    calendars()
  } else {
    title.textContent = 'Активність по місяцях'
    sub.textContent = 'Вихідні токени за кожен місяць'
    const sumByMonth = (a: S.Aggregate): Map<string, number> => {
      const m = new Map<string, number>()
      for (const [d, t] of a.days) m.set(d.slice(0, 7), (m.get(d.slice(0, 7)) ?? 0) + t.output)
      return m
    }
    const months = new Map<string, Totals>()
    for (const [d, t] of agg.days) {
      const m = months.get(d.slice(0, 7)) ?? { ...ZERO }
      for (const k of Object.keys(m) as (keyof Totals)[]) m[k] += t[k]
      months.set(d.slice(0, 7), m)
    }
    const byDevice = new Map([...per].map(([n, a]) => [n, sumByMonth(a)] as const))
    const list: string[] = []
    for (let d = r.fromDay; d <= r.toDay; d = S.addDays(d, 1)) if (!list.length || list[list.length - 1] !== d.slice(0, 7)) list.push(d.slice(0, 7))
    monthTiles(box, list.map(m => {
      const t = months.get(m)
      const name = `${new Intl.DateTimeFormat('uk-UA', { month: 'short', timeZone: 'UTC' }).format(Date.parse(m + '-15T12:00:00Z')).replace('.', '')} ${m.slice(0, 4)}`
      let best = '', max = 0
      if (topMode) for (const [n, sums] of byDevice) { const v = sums.get(m) ?? 0; if (v > max) { max = v; best = n } }
      const tip: TipRow[] = t ? [...totalsTip(t.output, S.freshInput(t), t.turns), ['Вартість', fmtUsd(t.cost)]] : []
      if (best) tip.push(['Найбільше', best, devColor(best)])
      return { label: name, value: t?.output ?? 0, text: fmt(t?.output ?? 0), color: best ? devColor(best) : undefined, tipTitle: `${monthName(m)} ${m.slice(0, 4)}`, tip }
    }))
  }
}

function renderAnalytics(agg: S.Aggregate): void {
  renderActivity(agg)
  const active = [...agg.days].filter(([, t]) => S.cacheHit(t) != null).sort(([a], [b]) => (a < b ? -1 : 1))
  $('cache-sub').textContent = `У середньому ${fmtPct(S.cacheHit(agg.total))} вхідних даних береться з кешу замість повної обробки`
  const hits = active.map(([, t]) => (S.cacheHit(t) ?? 0) * 100)
  lineChart($('cache-chart'), {
    labels: active.map(([d]) => dayLabel(d)), height: 200, yMax: 100, yMin: hits.length ? Math.max(0, Math.floor((Math.min(...hits) - 2) / 5) * 5) : 0,
    series: [{ label: 'З кешу', color: COLORS.cache, values: hits, fmt: v => v.toFixed(1) + '%' }],
    yFmt: v => +v.toFixed(1) + '%', tipTitle: i => dayLong(active[i][0]),
  })

  const models = [...agg.models].sort((a, b) => b[1].output - a[1].output)
  const color = (i: number): string => PALETTE[i % PALETTE.length]
  const totalOut = agg.total.output
  donut($('model-donut'), models.map(([label, t], i) => ({ label, value: t.output, color: color(i) })), [fmt(totalOut), 'вихідних'])
  $('model-list').replaceChildren(...models.map(([m, t], i) => el('div', {}, el('i', { style: `background:${color(i)}` }), el('span', {}, m), el('b', {}, fmt(t.output)), el('span', { class: 'pc' }, fmtPct(totalOut ? t.output / totalOut : 0)))))
  const devices = [...agg.devices].sort((a, b) => b[1].output - a[1].output)
  const max = Math.max(1, ...devices.map(([, t]) => t.output))
  $('device-bars').replaceChildren(...(devices.length ? devices.map(([n, t], i) => el('div', { class: 'hrow', style: `--c:${color(i)}` }, el('span', { class: 'name', title: n }, n),
    el('div', { class: 'track' }, el('b', { style: `width:${(t.output / max) * 100}%` }), el('span', { class: 'hatch' })), el('span', { class: 'val' }, fmt(t.output)))) : [el('div', { class: 'empty' }, 'Немає даних')]))
}

// ---------- money
const untilText = (ms: number): string => {
  const m = Math.max(0, Math.round((ms - Date.now()) / 60_000))
  return m >= 1440 ? `${Math.floor(m / 1440)} дн ${Math.floor((m % 1440) / 60)} год` : m >= 60 ? `${Math.floor(m / 60)} год ${m % 60} хв` : `${m} хв`
}
const agoText = (ms: number): string => {
  const m = Math.round((Date.now() - ms) / 60_000)
  return m < 2 ? 'щойно' : m < 60 ? `${m} хв тому` : m < 1440 ? `${Math.round(m / 60)} год тому` : `${Math.round(m / 1440)} дн тому`
}

function renderLimits(): void {
  const d = need()
  const rows = d.limits.filter(l => !state.device || l.device === state.device)
  const latest = S.latestLimits(rows)
  const kinds = ([['five_hour', 'Поточна сесія', '5 годин'], ['seven_day', 'Тиждень', '7 днів']] as const).filter(([k]) => latest[k])
  if (!kinds.length) {
    $('limits').replaceChildren(el('div', { class: 'empty' }, 'Ще немає даних про ліміти. Їх надсилає мод версії 0.9 і новіші з пристроїв із підпискою (хмарні сесії ліміти не передають): вони з\'являться після першої відповіді Claude.'))
  } else {
    $('limits').replaceChildren(...kinds.map(([k, title, span]) => {
      const l = latest[k], pct = Math.min(100, l.percent)
      const color = pct >= 90 ? 'var(--bad)' : pct >= 70 ? 'var(--warn)' : 'var(--out)'
      const f = S.forecast(l)
      const resetMs = l.resets_at ? Date.parse(l.resets_at) : 0
      const when = l.isStale ? 'вікно вже скинулось, нове почнеться з наступним запитом' : `скидання через ${untilText(resetMs)} (${timeOf(resetMs)}, ${dayLabel(tz.parts(resetMs).day)})`
      const fc = f ? (f.willFill ? `За поточного темпу ліміт закінчиться близько ${timeOf(f.fullAt)}, ${dayLabel(tz.parts(f.fullAt).day)}, до скидання.` : 'За поточного темпу ліміту вистачить до скидання.') : ''
      return el('div', { class: 'limit' },
        el('div', { class: 'row1' }, el('b', {}, `${title} · ${span}`), el('span', {}, when)),
        el('div', { class: 'meter' }, el('b', { style: `width:${pct}%;background:${color}` }, pct >= 12 ? `${pct.toFixed(pct < 10 ? 1 : 0)}%` : ''), el('span', { class: 'rest hatch' })),
        el('p', { class: 'note', style: 'margin:8px 0 0' }, `${pct < 12 ? `Використано ${pct.toFixed(1)}%. ` : ''}${l.resetAt ? `Ліміт скинуто достроково близько ${timeOf(l.resetAt)}, ${dayLabel(tz.parts(l.resetAt).day)}. ` : ''}${fc} Виміряно: ${l.device}, ${agoText(Date.parse(l.ts))}.`))
    }))
  }

  // history: highest reading per local day
  const byDay = new Map<string, Record<string, number>>()
  for (const l of rows) {
    const day = tz.parts(Date.parse(l.ts)).day
    const e = byDay.get(day) ?? {}
    e[l.kind] = Math.max(e[l.kind] ?? 0, l.percent)
    byDay.set(day, e)
  }
  const days = [...byDay.keys()].sort()
  const pctFmt = (v: number): string => v.toFixed(1) + '%'
  lineChart($('limits-chart'), {
    labels: days.map(dayLabel), height: 200, yMax: 100, yFmt: v => Math.round(v) + '%',
    series: [
      { label: '7 днів', color: COLORS.out, values: days.map(x => byDay.get(x)?.seven_day ?? 0), fmt: pctFmt },
      { label: '5 годин', color: COLORS.in, values: days.map(x => byDay.get(x)?.five_hour ?? 0), fmt: pctFmt },
    ],
    tipTitle: i => dayLong(days[i]),
  })

  // efficiency: what each past week cost per 1% of the limit (account-wide)
  // only devices that reported limits count: others (cloud credits, API key) do not draw on the subscription
  const subDevices = new Set(d.limits.map(l => l.device))
  // the last ten weeks of usage are fetched on their own, so this does not depend on the period shown
  const recent = tz.startOfDay(S.addDays(d.r.today, -70))
  void get<Bucket[]>('/buckets?' + q(recent, Date.now() + 3_600_000)).then(buckets => {
  const wins = S.efficiency(S.weeklyWindows(d.limits).filter(w => w.peak > 0).slice(-8), buckets.filter(b => subDevices.has(b.device)), prices)
  const maxTok = Math.max(1, ...wins.map(w => w.tokensPerPct ?? 0))
  $('efficiency').replaceChildren(...(wins.length ? wins.reverse().map(w => el('div', { class: 'hrow', style: 'grid-template-columns:minmax(90px,130px) 1fr auto;margin-bottom:12px;--c:var(--in)' },
    el('span', { class: 'name', title: w.reset ? 'Ліміт скинуто вручну до кінця тижня' : '' }, `${dayLabel(tz.parts(w.start + 3_600_000).day)} – ${dayLabel(tz.parts(w.end - 3_600_000).day)}${w.reset ? ' · скинуто' : ''}`),
    el('div', { class: 'track' }, el('b', { style: `width:${((w.tokensPerPct ?? 0) / maxTok) * 100}%` }), el('span', { class: 'hatch' })),
    el('span', { class: 'val', title: `Використано ${w.peak.toFixed(0)}% ліміту${w.peak >= 99.5 ? ' (вичерпано)' : ''} за цей період` }, `${fmt(w.tokensPerPct)} / 1% · ${fmtUsd(w.costPerPct ?? 0)}`))) : [el('div', { class: 'empty' }, 'З\'явиться, коли накопичаться виміри хоча б за один тиждень')]))
  }).catch(() => {})
}

function renderCost(agg: S.Aggregate): void {
  const d = need()
  const total = agg.total
  const days = S.dayList(d.r.fromDay, d.r.toDay)
  const models = [...agg.models].sort((a, b) => b[1].cost - a[1].cost)
  const perDay = total.cost / Math.max(1, days.length)
  $('cost-sub').textContent = `${rangeTitle(d.r)} · за публічними цінами API від ${prices?.updated ?? '—'}`
  const facts: [string, string][] = [['Разом', fmtUsd(total.cost)], ['У середньому за день', fmtUsd(perDay)], ['Прогноз на 30 днів', fmtUsd(perDay * 30)], ['Ходів', String(total.turns)]]
  $('cost-summary').replaceChildren(...facts.map(([l, v]) => el('div', {}, el('b', {}, v), l)))
  $('cost-legend').replaceChildren(...models.map(([m], i) => el('span', {}, el('i', { style: `background:${PALETTE[i % PALETTE.length]}` }), m)))
  const perModelDay = new Map<string, number>()
  for (const b of d.buckets) {
    if (state.device && b.device !== state.device) continue
    const ms = Date.parse(b.h + ':00:00Z')
    if (ms < d.r.from || ms >= d.r.to) continue
    const key = `${tz.parts(ms).day}|${b.model}`
    perModelDay.set(key, (perModelDay.get(key) ?? 0) + (S.costOf(b, b.model, prices) ?? 0))
  }
  barChart($('cost-chart'), {
    labels: days.map(dayLabel), height: 220, yFmt: v => '$' + fmtAxis(v),
    series: models.map(([m], i) => ({ label: m, color: PALETTE[i % PALETTE.length], values: days.map(x => perModelDay.get(`${x}|${m}`) ?? 0), fmt: fmtUsd })),
    tipTitle: i => dayLong(days[i]),
  })
  $('cost-table').replaceChildren(el('table', {},
    el('thead', {}, el('tr', {}, el('th', { class: 'l' }, 'Модель'), ...['Вхідні', 'Вихідні', 'Кеш: читання', 'Кеш: запис', 'Вартість', 'Частка'].map(h => el('th', {}, h)))),
    el('tbody', {}, ...models.map(([m, t]) => el('tr', {}, el('td', { class: 'l' }, m), el('td', {}, fmt(t.input)), el('td', {}, fmt(t.output)), el('td', {}, fmt(t.cache_read)), el('td', {}, fmt(t.cache_creation)),
      el('td', {}, fmtUsd(t.cost)), el('td', {}, fmtPct(total.cost ? t.cost / total.cost : 0)))))))
  $('cost-note').textContent = `Це оцінка за цінами API, а не рахунок: підписка оплачується окремо. Запис у кеш рахується за ціною для 1 години. Ціни лежать у файлі prices.json (оновлено ${prices?.updated ?? '—'}).` +
    (agg.unpriced.length ? ` Без ціни, у вартість не входять: ${agg.unpriced.join(', ')}.` : '')
}

// ---------- sessions
function renderSessions(agg: S.Aggregate): void {
  const d = need()
  const sessions = d.sessions.filter(s => !state.device || s.device === state.device)
  const rec = S.records(agg.days, sessions, tz)
  const tiles: [string, string, string][] = [
    ['Найкращий день', rec.bestDay ? dayLabel(rec.bestDay.day) : '—', rec.bestDay ? `${fmt(rec.bestDay.output)} вихідних, ${rec.bestDay.turns} ходів` : ''],
    ['Серія днів поспіль', String(rec.streak), 'з активністю, до сьогодні'],
    ['Найдовша сесія', rec.longest ? dur(rec.longest.ms) : '—', rec.longest ? `${rec.longest.device}, ${dayLabel(tz.parts(Date.parse(rec.longest.first_ts)).day)}` : ''],
    ['Найбільша сесія', rec.biggest ? fmt(rec.biggest.output) : '—', rec.biggest ? `вихідних, ${rec.biggest.turns} ходів` : ''],
    ['Найбільше ходів за день', rec.mostTurns ? String(rec.mostTurns.turns) : '—', rec.mostTurns ? dayLabel(rec.mostTurns.day) : ''],
    ['Активних днів', String(rec.activeDays), `з ${d.r.len} у періоді`],
  ]
  $('records').replaceChildren(...tiles.map(([l, v, s], i) => el('div', { class: 'kpi rec', style: `--c:${PALETTE[i]}` }, el('div', { class: 'l' }, l), el('div', { class: 'v' }, v), el('div', { class: 's' }, s))))
  const top = sessions.slice(0, 15)
  $('sessions').replaceChildren(top.length ? el('table', {},
    el('thead', {}, el('tr', {}, el('th', { class: 'l' }, 'Початок'), el('th', { class: 'l' }, 'Пристрій'), ...['Тривалість', 'Ходів', 'Вихідні', 'Вхідні (нові)', 'Кеш-хіт', '≈ Вартість'].map(h => el('th', {}, h)))),
    el('tbody', {}, ...top.map(s => {
      const p = tz.parts(Date.parse(s.first_ts))
      return el('tr', {}, el('td', { class: 'l' }, `${dayLabel(p.day)}, ${pad(p.h)}:${pad(p.min)}`), el('td', { class: 'l' }, s.device),
        el('td', {}, dur(Date.parse(s.last_ts) - Date.parse(s.first_ts))), el('td', {}, String(s.turns)), el('td', {}, fmt(s.output)), el('td', {}, fmt(S.freshInput(s))),
        el('td', {}, fmtPct(S.cacheHit(s))), el('td', {}, fmtUsd(S.costOf(s, s.model, prices) ?? 0)))
    }))) : el('div', { class: 'empty' }, 'Немає сесій за цей період'))
}

// ---------- wiring
const offsetText = (): string => {
  const m = tz.offsetMs(Date.now()) / 60_000
  return (m < 0 ? '−' : '+') + pad(Math.floor(Math.abs(m) / 60)) + ':' + pad(Math.abs(m) % 60)
}

function render(): void {
  if (!data) return
  const agg = aggregate()
  $('tzchip').textContent = `${tz.tz} · UTC${offsetText()}`
  $('dev-mode').classList.toggle('hide', !(state.tab === 'analytics' && !state.device && deviceNames.length > 1))
  press($('dev-mode'), 't', state.topDevice ? 'top' : '')
  if (state.tab === 'overview') { renderKpis(agg); renderMain(agg); void renderDay() }
  else if (state.tab === 'analytics') renderAnalytics(agg)
  else if (state.tab === 'money') { renderLimits(); renderCost(agg) }
  else if (state.tab === 'sessions') renderSessions(agg)
}

const press = (group: HTMLElement, attr: string, value: string): void =>
  group.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset[attr] === value)))

function setTab(tab: Tab): void {
  state.tab = tab
  press($('nav'), 'tab', tab)
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('hide', s.id !== 'tab-' + tab))
  $('controls').classList.toggle('hide', tab === 'devices')
  // the date pager lives in the activity card on Analytics and in the controls bar elsewhere
  // (and the time zone chip: in the card's corner on Analytics, at the end of the controls elsewhere)
  const pager = $('pager')
  if (tab === 'analytics') { $('act-pager').append(pager, $('custom')); $('act-tz').append($('tzchip')) }
  else { $('range').after(pager); $('act-mode').after($('custom')); $('controls').append($('tzchip')); $('act-mode').classList.add('hide') }
  if (tab === 'devices') void loadDevices().catch(() => {})
  else render()
}

const IO_ICON: Record<IoMode, string> = {
  both: '<path d="M8 20V5M8 5l-4 4M8 5l4 4"/><path d="M16 4v15M16 19l-4-4M16 19l4-4"/>',
  in: '<path d="M12 4v15M12 19l-5-5M12 19l5-5"/>',
  out: '<path d="M12 20V5M12 5l-5 5M12 5l5 5"/>',
}

function syncControls(): void {
  press($('range'), 'r', state.range)
  press($('view'), 'v', state.view)
  const io = $('io-mode')
  io.dataset.mode = state.io
  $('io-icon').innerHTML = IO_ICON[state.io]
  const ioName: Record<IoMode, string> = { both: 'вхідні та вихідні', in: 'лише вхідні', out: 'лише вихідні' }
  io.dataset.tip = `Показуються ${ioName[state.io]} токени. Натисни, щоб ${IO_NEXT[state.io] === 'in' ? 'лише вхідні' : IO_NEXT[state.io] === 'out' ? 'лише вихідні' : 'вхідні та вихідні'}`
  $('scale-mode').classList.toggle('hide', !(state.metric === 'all' && state.view !== 'cal'))
  press($('scale-mode'), 's', state.scale)
  const cache = $<HTMLButtonElement>('cache-on'), off = state.view === 'cal'
  cache.setAttribute('aria-pressed', String(state.metric === 'all' && !off))
  cache.setAttribute('aria-disabled', String(off))
  cache.dataset.tip = off ? 'У режимі «Календар» кеш не відображається' : state.metric === 'all' ? 'Кеш показується. Натисни, щоб сховати' : 'Показати кеш'
  $('custom').classList.toggle('hide', state.range !== 'custom')
  const paged = state.range === 'week' || state.range === 'month' || state.range === 'year'
  $('pager').classList.toggle('hide', !paged)
  if (paged) {
    const r = currentRange()
    $('pg-label').textContent = r.label
    $<HTMLButtonElement>('pg-next').disabled = r.toDay >= r.today
  }
  const today = tz.today()
  $<HTMLInputElement>('from').value = state.from || S.addDays(today, -29)
  $<HTMLInputElement>('to').value = state.to || today
}

const clicked = (e: Event): HTMLButtonElement | null => (e.target as HTMLElement).closest('button')

$('nav').addEventListener('click', e => { const b = clicked(e); if (b) setTab(b.dataset.tab as Tab) })
$('range').addEventListener('click', e => {
  const b = clicked(e); if (!b) return
  state.range = b.dataset.r ?? 'month'; state.anchor = ''; persist(); syncControls(); void load()
})
/** Moves the shown week / month / year back or forward by one. */
const step = (dir: -1 | 1): void => {
  const at = state.anchor || tz.today()
  if (state.range === 'week') state.anchor = S.addDays(at, 7 * dir)
  else if (state.range === 'month') state.anchor = dir < 0 ? S.addDays(at.slice(0, 7) + '-01', -1) : S.addDays(lastOfMonth(at.slice(0, 7)), 1)
  else state.anchor = `${+at.slice(0, 4) + dir}-${at.slice(5)}`
  if (state.anchor >= tz.today()) state.anchor = ''
  syncControls(); void load()
}
$('pg-prev').onclick = () => step(-1)
$('pg-next').onclick = () => step(1)
$('dev-mode').addEventListener('click', e => { const b = clicked(e); if (!b) return; state.topDevice = b.dataset.t === 'top'; persist(); press($('dev-mode'), 't', b.dataset.t ?? ''); renderActivity(aggregate()) })
$('act-mode').addEventListener('click', e => { const b = clicked(e); if (!b) return; state.actMode = b.dataset.m as 'min' | 'detail'; persist(); renderActivity(aggregate()) })
const dateChanged = (): void => { state.from = $<HTMLInputElement>('from').value; state.to = $<HTMLInputElement>('to').value; persist(); void load() }
$('from').onchange = dateChanged
$('to').onchange = dateChanged
const deviceMenu = dropdown($('device'), v => { state.device = v; persist(); render() })

$('view').addEventListener('click', e => { const b = clicked(e); if (!b) return; state.view = b.dataset.v as View; persist(); syncControls(); render() })
$('scale-mode').addEventListener('click', e => { const b = clicked(e); if (!b) return; state.scale = b.dataset.s === 'linear' ? 'linear' : 'log'; persist(); syncControls(); render() })
$('io-mode').onclick = () => { state.io = IO_NEXT[state.io]; persist(); syncControls(); render() }
$('cache-on').onclick = () => {
  if (state.view === 'cal') return
  state.metric = state.metric === 'all' ? 'io' : 'all'; persist(); syncControls(); render()
}
const setDay = (d: string): void => { const today = need().r.today; state.day = d > today ? today : d; void renderDay() }
$('day').onchange = () => { const v = $<HTMLInputElement>('day').value; if (v) setDay(v) }
$('day-prev').onclick = () => setDay(S.addDays(state.day || need().r.today, -1))
$('day-next').onclick = () => setDay(S.addDays(state.day || need().r.today, 1))
$('day-today').onclick = () => setDay(need().r.today)

api<{ email: string }>('/me').then(m => { $('who').textContent = m.email; $('av').textContent = m.email.slice(0, 2).toUpperCase() }).catch(() => { $('who').textContent = 'не вдалося визначити користувача' })
initDevices()
syncControls()
fetch('prices.json').then(r => r.json() as Promise<Prices>).then(p => { prices = p }).catch(() => {}).finally(() => void load())
