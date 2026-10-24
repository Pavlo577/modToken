// Bar chart.
import { responsive, svg } from '../lib/dom.ts'
import { fmtAxis } from '../lib/format.ts'
import { clipNote, empty, place, tipOf } from './base.ts'
import type { Host, Series, TipRow } from './base.ts'
import { evenLabels, logAxis, niceMax, sharedMax, smooth, ticks } from './scale.ts'

export interface BarOptions {
  labels: string[]
  series: Series[]
  tipTitle: (i: number) => string
  height?: number
  yFmt?: (v: number) => string
  extraTip?: (i: number) => TipRow[]
  /** Drawn as a line over the bars on the same scale, clipped at the top when larger. */
  secondary?: Series
  /** Logarithmic axis; the bars are then side by side instead of stacked, the extra series is a bar too. */
  logScale?: boolean
  /** A fixed top of the value axis (otherwise fitted to the data). */
  yMax?: number
}

/** Stacked bars over categories, rounded on top, with a tooltip. */
export function barChart(container: HTMLElement, opts: BarOptions): void {
  const host = container as Host
  const { labels, series, height = 230, yFmt = fmtAxis, secondary: sec } = opts
  const totals = labels.map((_, i) => series.reduce((a, s) => a + s.values[i], 0))
  if (!labels.length || !totals.some(v => v > 0)) return empty(container, undefined, height)
  let first = true
  responsive(container, W => {
    const animate = first
    first = false
    const m = { l: 44, r: 8, t: 14, b: 26 }
    const iw = W - m.l - m.r, ih = height - m.t - m.b
    const secTop = sec ? Math.max(...sec.values) : 0
    const list = [...series, ...(sec ? [sec] : [])]
    const lg = opts.logScale && list.some(l => l.values.some(v => v > 0)) ? logAxis(list.flatMap(l => l.values), m.t, ih) : null
    const max = opts.yMax ?? (sec ? sharedMax(Math.max(...totals), secTop) : niceMax(Math.max(...totals)))
    const slotW = iw / labels.length
    const bw = Math.max(2, Math.min(34, slotW * 0.68))
    const y = (v: number): number => (lg ? lg.y(v) : m.t + ih - (Math.min(v, max) / max) * ih)
    const ys = y
    const root = svg('svg', { viewBox: `0 0 ${W} ${height}`, width: W, height, role: 'img', class: animate ? 'anim' : '' })
    for (const t of lg ? lg.ticks : ticks(max)) {
      root.append(svg('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: 'grid' }))
      root.append(svg('text', { x: m.l - 8, y: y(t) + 4, class: 'ax', 'text-anchor': 'end' }, yFmt(t)))
    }
    for (const i of evenLabels(labels.length, iw, 56)) root.append(svg('text', { x: m.l + slotW * (i + 0.5), y: height - 6, class: 'ax', 'text-anchor': 'middle' }, labels[i]))
    const groups = labels.map((_, i): [SVGElement, number, number] => {
      const cx = m.l + slotW * (i + 0.5)
      const g = svg('g', { class: 'bar grow', style: `--d:${Math.min(600, i * 14)}ms;--base:${m.t + ih}px` })
      g.append(svg('rect', { x: m.l + slotW * i, y: m.t, width: slotW, height: ih, class: 'bar-hit' }))
      let acc = 0
      if (lg) { // side by side, each from the bottom line up to its value
        const n = list.length, w = Math.max(2, Math.min(34, (slotW * 0.8) / n))
        list.forEach((s, j) => {
          const top = y(s.values[i])
          if (s.values[i] > 0) g.append(svg('rect', { x: cx - (w * n) / 2 + j * w + 0.5, y: top, width: Math.max(1, w - 1), height: m.t + ih - top, rx: Math.min(3, w / 3), fill: s.color }))
        })
        return [g, cx, Math.max(...list.map(s => s.values[i]))]
      }
      const live = series.filter(s => s.values[i] > 0)
      live.forEach((s, n) => {
        const y1 = y(acc + s.values[i]), y0 = y(acc)
        const h = Math.max(1.5, y0 - y1 - (n > 0 ? 2 : 0))
        const top = n === live.length - 1
        const r = Math.min(5, bw / 2, h)
        const yy = y0 - h
        g.append(svg('path', {
          d: top ? `M${cx - bw / 2},${yy + h}V${yy + r}Q${cx - bw / 2},${yy} ${cx - bw / 2 + r},${yy}H${cx + bw / 2 - r}Q${cx + bw / 2},${yy} ${cx + bw / 2},${yy + r}V${yy + h}Z`
            : `M${cx - bw / 2},${yy}H${cx + bw / 2}V${yy + h}H${cx - bw / 2}Z`,
          fill: s.color,
        }))
        acc += s.values[i]
      })
      return [g, cx, acc]
    })
    root.append(...groups.map(([g]) => g))
    if (sec && !lg && labels.length > 1) root.append(svg('path', { d: smooth(sec.values.map((v, i): [number, number] => [m.l + slotW * (i + 0.5), ys(v)])), fill: 'none', stroke: sec.color, 'stroke-width': 1.7, 'stroke-opacity': 0.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', pathLength: 1, class: 'draw', style: 'pointer-events:none' }))
    if (sec && !lg && secTop > max) clipNote(root, m.l + 6, m.t + 12, sec)
    place(container, root)
    const tip = tipOf(host)
    groups.forEach(([g, cx, top], i) => {
      const show = (): void => {
        g.classList.add('on')
        tip.show(cx, lg ? y(top) : Math.min(y(top), sec ? ys(sec.values[i]) : Infinity), opts.tipTitle(i), [...series.map((s): TipRow => [s.label, (s.fmt ?? yFmt)(s.values[i]), s.color]), ...(sec ? [[sec.label, (sec.fmt ?? yFmt)(sec.values[i]), sec.color] as TipRow] : []), ...(opts.extraTip?.(i) ?? [])])
      }
      g.addEventListener('pointerenter', show); g.addEventListener('pointerdown', show)
      g.addEventListener('pointerleave', () => { g.classList.remove('on'); tip.hide() })
    })
  })
}
