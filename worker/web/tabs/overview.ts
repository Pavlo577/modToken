// Overview tab: KPI tiles, the main chart and the one-day card.
import * as S from '../lib/stats.ts'
import { barChart } from '../charts/bar.ts'
import { COLORS, HEAT, empty } from '../charts/base.ts'
import type { Series } from '../charts/base.ts'
import { calendarHeatmap } from '../charts/calendar.ts'
import { lineChart } from '../charts/line.ts'
import { providerColor, providerLabel } from '../core/palette.ts'
import { otlpMarker } from '../core/bounds.ts'
import { currentStep, isRemote, localGrid, remoteGrid } from '../core/series.ts'
import type { Grid } from '../lib/grid.ts'
import { stepLabel } from '../lib/steps.ts'
import { rangeTitle } from '../core/range.ts'
import type { Period } from '../core/range.ts'
import { state } from '../core/state.ts'
import { ZERO, aggregate, compareAvailable, get, need, q, store } from '../core/store.ts'
import { pad, timeOf, tz, weekday } from '../core/time.ts'
import { $, el, skeleton } from '../lib/dom.ts'
import { dayLabel, dayLong, dur, durSec, fmt, fmtAxis, fmtPct, fmtUsd } from '../lib/format.ts'
import type { Bucket, Totals, TurnRow } from '../lib/types.ts'
import { mainHeight } from '../ui/layout.ts'

// ---------- overview
const arrow = (d: number | null): HTMLElement | '' => (d == null ? '' : el('span', { class: 'delta ' + (d >= 0 ? 'up' : 'down'), title: 'Порівняно з попереднім періодом (тиждень, місяць, рік або така сама кількість днів)' }, (d >= 0 ? '▲ ' : '▼ ') + Math.abs(Math.round(d * 100)) + '%'))

export function renderKpis(agg: S.Aggregate): void {
  const r = need().r
  const prev = aggregate({ fromMs: r.prevFrom, toMs: r.from })
  const t = agg.total, p = prev.total
  const tiles: [string, string, number | null, string, string][] = [
    ['Вихідні токени', fmt(t.output), S.delta(t.output, p.output), 'var(--out)', 'те, що написала модель'],
    ['Вхідні токени', fmt(S.freshInput(t)), S.delta(S.freshInput(t), S.freshInput(p)), 'var(--in)', 'нові, без читання з кешу'],
    ['Кеш-хіт', fmtPct(S.cacheHit(t)), null, 'var(--cache)', 'частка вхідних з кешу'],
    ['Ходів', String(t.turns), S.delta(t.turns, p.turns), 'var(--ok)', 'відповідей моделі'],
    ['Час відповідей', dur(t.duration_ms), S.delta(t.duration_ms, p.duration_ms), 'var(--warn)', 'сумарно'],
    ['Оцінка вартості', fmtUsd(t.cost), S.delta(t.cost, p.cost), 'var(--out)', 'за цінами API'],
  ]
  $('kpis').replaceChildren(...tiles.map(([l, v, d, c, s]) => el('div', { class: 'kpi', style: `--c:${c}` },
    el('div', { class: 'l' }, l), el('div', { class: 'v' }, v), el('div', { class: 's' }, arrow(d), s))))
}

type Def = [label: string, color: string, pick: (t: Totals) => number]

const OUT: Def = ['Вихідні', COLORS.out, t => t.output]

const IN: Def = ['Вхідні (нові)', COLORS.in, S.freshInput]

const ioDefs = (): Def[] => (state.ioHidden ? [] : state.io === 'in' ? [IN] : state.io === 'out' ? [OUT] : [OUT, IN])

const CACHE: Def = ['З кешу', COLORS.cache, t => t.cache_read]

/** One series per agent on the same scale: what the input / output buttons select, added up (input + output when both are on). */
function compareSeries(grid: Grid): Series[] {
  const picks = ioDefs().map(d => d[2])
  return store.providers.map(p => {
    const rows = grid.rowsOf({ device: state.device || null, provider: p })
    return { label: providerLabel(p), color: providerColor(p), values: rows.map(t => picks.reduce((sum, pick) => sum + pick(t), 0)), fmt }
  }).filter(s => s.values.some(v => v > 0))
}

let mainSeq = 0 // a slower request for a step the viewer has already left must not draw over the newer chart

export function renderMain(agg: S.Aggregate): void {
  const r = need().r
  const { view } = state
  const yFmt = fmtAxis
  const valFmt = fmt
  $('main-chart').replaceChildren()
  $('main-chart').style.minHeight = mainHeight() + 'px' // the same footprint in every view, so nothing below moves
  $('main-legend').replaceChildren()

  if (view === 'cal') {
    $('main-title').textContent = 'Календар активності'
    $('main-sub').textContent = 'Останні 12 місяців, за твоїм часовим поясом'
    const to = r.today, from = S.addDays(to, -364)
    void get<Bucket[]>('/buckets?' + q(tz.startOfDay(from), tz.startOfDay(S.addDays(to, 1)))).then(buckets => {
      if (state.view !== 'cal') return
      const a = S.aggregate(buckets, tz, { device: state.device || null, provider: state.provider || null, prices: store.prices })
      if (state.ioHidden) { empty($('main-chart'), 'Увімкни вхідні та/або вихідні токени (кнопка з оком)', 190); return }
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

  const seq = ++mainSeq
  const step = currentStep(r)
  if (!isRemote(step)) return drawMain(localGrid(r, step), r, step)
  skeleton($('main-chart'), mainHeight())
  remoteGrid(r).then(grid => { if (seq === mainSeq) drawMain(grid, r, step) }, (e: Error) => { if (seq === mainSeq) empty($('main-chart'), 'Не вдалося завантажити: ' + e.message, mainHeight()) })
}

const stepText = (step: number): string => (step === 1440 ? 'по днях' : step === 60 ? 'по годинах' : step === 0 ? 'кожен запис' : `крок ${stepLabel(step)}`)

function drawMain(grid: Grid, r: Period, step: number): void {
  const { view } = state
  const yFmt = fmtAxis
  const valFmt = fmt
  $('main-legend').replaceChildren()
  const keys = grid.keys
  const rows = grid.rowsOf({ device: state.device || null, provider: state.provider || null })
  const labels = grid.labels
  const compare = state.compare && compareAvailable()
  let series: Series[] = compare ? compareSeries(grid) : ioDefs().map(([label, color, pick]) => ({ label, color, values: rows.map(pick), fmt: valFmt }))
  // the cache is far larger than the rest: logarithmic axis, or one linear scale fitted to input/output with the cache clipped at the top
  let secondary: Series | undefined = state.metric === 'all' && !compare ? { label: CACHE[0], color: CACHE[1], values: rows.map(CACHE[2]), fmt: valFmt } : undefined
  if (!series.length && secondary) { series = [secondary]; secondary = undefined } // the cache alone: an ordinary chart
  if (!series.length) {
    empty($('main-chart'), compare ? 'Нічого показувати: увімкни вхідні та/або вихідні токени (кнопка з оком)' : 'Нічого не вибрано: увімкни вхідні та вихідні токени (кнопка з оком) або кеш', mainHeight())
    $('main-sub').textContent = rangeTitle(r)
    return
  }
  $('main-title').textContent = 'Токени'
  $('main-sub').textContent = `${rangeTitle(r)} · ${stepText(step)}${grid.note ? ' · ' + grid.note : ''}${compare ? ' · за агентами: ' + (state.io === 'in' ? 'нові вхідні' : state.io === 'out' ? 'вихідні' : 'вхідні + вихідні') : ''}`
  $('main-legend').replaceChildren(...[...series, ...(secondary ? [{ ...secondary, label: secondary.label }] : [])].map(s => el('span', {}, el('i', { style: `background:${s.color}` }), s.label)))
  const logScale = !!secondary && state.scale === 'log'
  const opts = {
    labels, series, secondary, yFmt, height: mainHeight(), logScale, marker: otlpMarker(keys, grid.unit), labelGap: grid.labelGap,
    tipTitle: (i: number): string => grid.tip(i),
    extraTip: (i: number): [string, string][] => [['Ходів', String(rows[i].turns)], ...(grid.extraTip?.(i) ?? [])],
  }
  if (view === 'bars') barChart($('main-chart'), opts)
  else lineChart($('main-chart'), opts)
}

/** The day the card shows: in the "День" period the pager's, otherwise the card's own choice. */
const cardDay = (): string => (state.range === 'day' ? need().r.fromDay : state.day || need().r.today)

export async function renderDay(): Promise<void> {
  const day = cardDay()
  const own = state.range !== 'day' // the card's own picker is for the other periods; in "День" the pager above drives the day
  for (const id of ['day-prev', 'day-next', 'day', 'day-today']) $(id).classList.toggle('hide', !own)
  $<HTMLInputElement>('day').value = day
  $('day-sub').textContent = `${weekday(day)}, ${dayLong(day)}`
  const from = tz.startOfDay(day), to = tz.startOfDay(S.addDays(day, 1))
  let turns: TurnRow[]
  try { turns = await get<TurnRow[]>('/turns?' + q(from, to)) } catch (e) {
    empty($('day-chart'), 'Не вдалося завантажити: ' + (e as Error).message, 200)
    return
  }
  if (cardDay() !== day) return
  if (state.device) turns = turns.filter(t => t.device === state.device)
  if (state.provider) turns = turns.filter(t => t.provider === state.provider)
  const hrs = Array.from({ length: 24 }, () => ({ output: 0, input: 0, turns: 0 }))
  let out = 0, inp = 0, ms = 0
  for (const t of turns) {
    const h = tz.parts(Date.parse(t.ts)).h
    const turn = !t.kind || t.kind === 'main' // a turn = the main loop's row; sub-agent, background and step rows only add tokens
    hrs[h].output += t.output; hrs[h].input += S.freshInput(t); if (turn) hrs[h].turns++
    out += t.output; inp += S.freshInput(t); ms += t.duration_ms
  }
  const main = turns.filter(t => !t.kind || t.kind === 'main')
  const facts: [string, string][] = [['Вихідні', fmt(out)], ['Вхідні (нові)', fmt(inp)], ['Ходів', String(main.length)], ['Активний час', dur(ms)]]
  if (main.length) facts.push(['Перший хід', timeOf(Date.parse(main[0].ts))], ['Останній хід', timeOf(Date.parse(main[main.length - 1].ts))])
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

/** Day picker of the one-day card. */
export function initOverview(): void {
  const setDay = (d: string): void => { const today = need().r.today; state.day = d > today ? today : d; void renderDay() }
  $('day').onchange = () => { const v = $<HTMLInputElement>('day').value; if (v) setDay(v) }
  $('day-prev').onclick = () => setDay(S.addDays(state.day || need().r.today, -1))
  $('day-next').onclick = () => setDay(S.addDays(state.day || need().r.today, 1))
  $('day-today').onclick = () => setDay(need().r.today)
}
