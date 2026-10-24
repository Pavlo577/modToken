// GitHub-style calendar heat map.
import { responsive, svg } from '../lib/dom.ts'
import { DOW, monthLabel } from '../lib/format.ts'
import { HEAT, empty, place, tipOf } from './base.ts'
import type { Host, TipRow } from './base.ts'

export interface CalendarOptions {
  from: string
  to: string
  days: Map<string, number>
  addDays: (day: string, n: number) => string
  /** 0 = Monday ... 6 = Sunday */
  dayOfWeek: (day: string) => number
  tipTitle: (day: string) => string
  tipValue: (day: string, value: number) => TipRow[]
}

/** GitHub-style calendar: weeks as columns, Monday first. */
export function calendarHeatmap(container: HTMLElement, opts: CalendarOptions): void {
  const host = container as Host
  const { from, to, days, addDays, dayOfWeek } = opts
  const list: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) list.push(d)
  const values = list.map(d => days.get(d) ?? 0)
  const nz = values.filter(v => v > 0).sort((a, b) => a - b)
  if (!nz.length) return empty(container)
  const q = (p: number): number => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))]
  const cuts = [q(0.25), q(0.5), q(0.75)]
  const level = (v: number): number => (v <= 0 ? 0 : v <= cuts[0] ? 1 : v <= cuts[1] ? 2 : v <= cuts[2] ? 3 : 4)
  const first = dayOfWeek(from)
  const weeks = Math.ceil((first + list.length) / 7)
  responsive(container, W => {
    const labelW = 30, topH = 20, gap = 3
    const cell = Math.max(8, Math.min(26, Math.floor((W - labelW) / weeks) - gap))
    const width = labelW + weeks * (cell + gap)
    const height = topH + 7 * (cell + gap)
    const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' })
    for (const r of [0, 2, 4]) root.append(svg('text', { x: 0, y: topH + r * (cell + gap) + cell - 2, class: 'ax' }, DOW[r]))
    let lastMonth = -1
    const tip = tipOf(host)
    list.forEach((d, i) => {
      const col = Math.floor((first + i) / 7), row = (first + i) % 7
      const month = +d.slice(5, 7)
      if ((row === 0 || i === 0) && month !== lastMonth && col * (cell + gap) < width - 40) {
        root.append(svg('text', { x: labelW + col * (cell + gap), y: 12, class: 'ax' }, monthLabel(month)))
        lastMonth = month
      }
      const x = labelW + col * (cell + gap), y = topH + row * (cell + gap)
      const r = svg('rect', { x, y, width: cell, height: cell, rx: 3, fill: HEAT[level(values[i])], class: 'cell' })
      r.addEventListener('pointerenter', () => tip.show(x + cell / 2, y, opts.tipTitle(d), opts.tipValue(d, values[i])))
      r.addEventListener('pointerleave', () => tip.hide())
      root.append(r)
    })
    place(container, root)
  })
}
