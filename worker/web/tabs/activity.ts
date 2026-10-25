// The activity card of the Analytics tab: the grid fits the shown period.
import * as S from '../lib/stats.ts'
import { COLORS } from '../charts/base.ts'
import type { TipRow } from '../charts/base.ts'
import { heatGrid, hourGrid, monthCalendars, monthTiles } from '../charts/heat.ts'
import type { HeatCell } from '../charts/heat.ts'
import { actions } from '../core/actions.ts'
import { load } from '../core/load.ts'
import { devColor } from '../core/palette.ts'
import { persist, state } from '../core/state.ts'
import { currentMonth, firstMonth, inReach } from '../core/bounds.ts'
import { ZERO, aggregate, get, need, q, store } from '../core/store.ts'
import { lastOfMonth, monthName, pad, tz, weekday } from '../core/time.ts'
import { $, el, skeleton } from '../lib/dom.ts'
import { DOW, dayLong, fmt, fmtUsd } from '../lib/format.ts'
import type { Totals, TurnRow } from '../lib/types.ts'
import { SKELETON_AFTER_MS, press } from '../ui/layout.ts'

// ---------- analytics
const totalsTip = (output: number, freshIn: number, turns: number): TipRow[] =>
  [['Вихідні', fmt(output), COLORS.out], ['Вхідні (нові)', fmt(freshIn), COLORS.in], ['Ходів', String(turns)]]

let activitySeq = 0

/** Jumps the whole page to one day (today has its own button), or to a month. */
function goDay(day: string): void {
  state.range = day === tz.today() ? 'today' : 'custom'
  state.from = state.to = day
  state.anchor = ''
  persist(); actions.syncControls(); void load()
}

function goMonth(month: string): void {
  state.range = 'month'
  state.anchor = month >= tz.today().slice(0, 7) ? '' : month + '-01'
  persist(); actions.syncControls(); void load()
}

/** "When do you work": the grid fits the period (a day, a week, a month, a year or your own span). */
export function renderActivity(agg: S.Aggregate): void {
  const r = need().r
  const title = $('act-title'), sub = $('act-sub'), box = $('hour-grid')
  const seq = ++activitySeq
  const long = r.len > 31 // a year, or your own span longer than a month: tiles or calendars
  // up to a month: minimal = calendar, detailed = day x hour grid; longer: minimal = month tiles, detailed = calendars
  const mode = state.actMode || (long && !(state.range === 'year' || r.len > 366) ? 'detail' : 'min')
  $('act-mode').classList.toggle('hide', r.len <= 7)
  press($('act-mode'), 'm', mode)

  // "most used" mode: each cell takes the colour of the device that used the most in it
  const topMode = state.topDevice && !state.device && store.deviceNames.length > 1
  const per = new Map<string, S.Aggregate>()
  if (topMode) for (const n of store.deviceNames) per.set(n, aggregate({ device: n }))
  const leader = (value: (a: S.Aggregate) => number | undefined): { color: string; name: string } | undefined => {
    if (!topMode) return undefined
    let best = '', max = 0
    for (const [n, a] of per) { const v = value(a) ?? 0; if (v > max) { max = v; best = n } }
    return best ? { color: devColor(best), name: best } : undefined
  }
  const tinted = (cell: HeatCell, w: { color: string; name: string } | undefined): HeatCell =>
    w ? { ...cell, color: w.color, tip: [...cell.tip, ['Найбільше', w.name, w.color] as TipRow] } : cell
  $('act-legend').classList.toggle('hide', !topMode)
  $('act-legend').replaceChildren(...(topMode ? store.deviceNames.map(n => el('span', {}, el('i', { style: `background:${devColor(n)}` }), n)) : []))

  const calendars = (): void => {
    const days = new Map<string, HeatCell>()
    for (const [d, t] of agg.days) days.set(d, tinted({ value: t.output, text: fmt(t.output), tip: totalsTip(t.output, S.freshInput(t), t.turns) }, leader(a => a.days.get(d)?.output)))
    monthCalendars(box, {
      from: r.fromDay < firstMonth() + '-01' ? firstMonth() + '-01' : r.fromDay, to: r.toDay > lastOfMonth(currentMonth()) ? lastOfMonth(currentMonth()) : r.toDay, days, addDays: S.addDays,
      dayOfWeek: d => tz.parts(tz.startOfDay(d) + 12 * 3_600_000).dow,
      monthTitle: m => `${monthName(m)} ${m.slice(0, 4)}`,
      showTitle: state.range !== 'month', // the pager already names the month
      onDay: goDay,
      onMonth: goMonth,
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
        if (state.provider && t.provider !== state.provider) continue
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
      colLabel: h => String(h), labelW: 24, maxCell: 60, cellH: 18, onCell: i => goDay(days[i]),
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
    monthTiles(box, list.filter(inReach).map(m => {
      const t = months.get(m)
      const name = `${new Intl.DateTimeFormat('uk-UA', { month: 'short', timeZone: 'UTC' }).format(Date.parse(m + '-15T12:00:00Z')).replace('.', '')} ${m.slice(0, 4)}`
      let best = '', max = 0
      if (topMode) for (const [n, sums] of byDevice) { const v = sums.get(m) ?? 0; if (v > max) { max = v; best = n } }
      const tip: TipRow[] = t ? [...totalsTip(t.output, S.freshInput(t), t.turns), ['Вартість', fmtUsd(t.cost)]] : []
      if (best) tip.push(['Найбільше', best, devColor(best)])
      return { key: m, label: name, value: t?.output ?? 0, text: fmt(t?.output ?? 0), color: best ? devColor(best) : undefined, tipTitle: `${monthName(m)} ${m.slice(0, 4)}`, tip }
    }), goMonth)
  }
}
