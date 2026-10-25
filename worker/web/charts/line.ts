// Line chart.
import { responsive, svg } from '../lib/dom.ts'
import { fmtAxis } from '../lib/format.ts'
import { clipNote, drawMarker, empty, place, tipOf } from './base.ts'
import type { Host, Marker, Series, TipRow } from './base.ts'
import { evenLabels, logAxis, niceMax, sharedMax, smooth, ticks } from './scale.ts'

export interface LineOptions {
  labels: string[]
  series: Series[]
  tipTitle: (i: number) => string
  height?: number
  yFmt?: (v: number) => string
  yMax?: number
  /** lower end of the value axis (default 0) */
  yMin?: number
  area?: boolean
  /** An extra series on the same scale, clipped at the top when far larger than the rest (cache reads). */
  secondary?: Series
  /** Logarithmic axis: values of very different size (the cache) all stay readable, nothing is clipped. */
  logScale?: boolean
  /** A vertical line: data before it may be incomplete. */
  marker?: Marker
}

/** Lines over evenly spaced categories (days or hours), with a crosshair and a tooltip. */
export function lineChart(container: HTMLElement, opts: LineOptions): void {
  const host = container as Host
  const { labels, series, height = 230, yFmt = fmtAxis, area = true, secondary: sec } = opts
  const all = series.flatMap(s => s.values)
  if (!labels.length || !all.some(v => v > 0)) return empty(container, undefined, height)
  let first = true // draw the lines in only the first time, not on every resize
  responsive(container, W => {
    const animate = first
    first = false
    const m = { l: 44, r: 14, t: 14, b: 26 }
    const iw = W - m.l - m.r, ih = height - m.t - m.b
    const lo = opts.yMin ?? 0
    const secTop = sec ? Math.max(...sec.values) : 0
    const logOn = !!opts.logScale && [...all, ...(sec?.values ?? [])].some(v => v > 0)
    const lg = logOn ? logAxis([...all, ...(sec?.values ?? [])], m.t, ih) : null
    const max = opts.yMax ?? (sec ? sharedMax(Math.max(...all), secTop) : niceMax(Math.max(...all)))
    const x = (i: number): number => m.l + (labels.length === 1 ? iw / 2 : (iw * i) / (labels.length - 1))
    const y = (v: number): number => (lg ? lg.y(v) : m.t + ih - ((v - lo) / (max - lo || 1)) * ih)
    const yc = (v: number): number => (lg ? lg.y(v) : y(Math.min(v, max))) // clipped at the top of the scale
    const plot: { s: Series; y: (v: number) => number }[] = [...series.map(s => ({ s, y })), ...(sec ? [{ s: sec, y: yc }] : [])]
    const uid = `g${container.id}`
    const root = svg('svg', { viewBox: `0 0 ${W} ${height}`, width: W, height, role: 'img', class: animate ? 'anim' : '' })
    const defs = svg('defs')
    series.forEach((s, k) => defs.append(svg('linearGradient', { id: `${uid}${k}`, x1: 0, x2: 0, y1: 0, y2: 1 },
      svg('stop', { offset: '0%', 'stop-color': s.color, 'stop-opacity': 0.28 }), svg('stop', { offset: '100%', 'stop-color': s.color, 'stop-opacity': 0 }))))
    root.append(defs)
    for (const t of lg ? lg.ticks : ticks(max - lo).map(v => v + lo)) {
      root.append(svg('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: 'grid' }))
      root.append(svg('text', { x: m.l - 8, y: y(t) + 4, class: 'ax', 'text-anchor': 'end' }, yFmt(t)))
    }
    for (const i of evenLabels(labels.length, iw)) root.append(svg('text', { x: x(i), y: height - 6, class: 'ax', 'text-anchor': i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle' }, labels[i]))
    plot.forEach(({ s, y: yf }, k) => {
      const pts = s.values.map((v, i): [number, number] => [x(i), yf(v)])
      if (area && !lg && k < 2 && pts.length > 1) root.append(svg('path', { d: `${smooth(pts)}L${pts[pts.length - 1][0]},${m.t + ih}L${pts[0][0]},${m.t + ih}Z`, fill: `url(#${uid}${k})`, class: 'fade' }))
      const extra = s === sec // the cache: thinner and fainter so the main lines stay readable
      root.append(svg('path', { d: smooth(pts), fill: 'none', stroke: s.color, 'stroke-width': extra ? 1.7 : 2.4, 'stroke-opacity': extra ? 0.7 : 1, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', pathLength: 1, class: 'draw' }))
      if (pts.length === 1) root.append(svg('circle', { cx: pts[0][0], cy: pts[0][1], r: 4, fill: s.color }))
    })
    if (sec && !lg && secTop > max) clipNote(root, m.l + 6, m.t + 12, sec)
    if (opts.marker) drawMarker(root, labels.length === 1 ? x(0) : Math.min(m.l + iw, Math.max(m.l, x(opts.marker.at - 0.5))), m.t, m.t + ih, m.l, opts.marker)
    const cross = svg('line', { y1: m.t, y2: m.t + ih, class: 'cross', style: 'display:none' })
    const dots = plot.map(({ s }) => svg('circle', { r: 5, fill: '#14110f', stroke: s.color, 'stroke-width': 2.5, style: 'display:none' }))
    root.append(cross, ...dots)
    const hit = svg('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' })
    root.append(hit)
    place(container, root)
    const tip = tipOf(host)
    const move = (e: Event): void => {
      const pe = e as PointerEvent
      const r = hit.getBoundingClientRect()
      const i = Math.max(0, Math.min(labels.length - 1, Math.round(((pe.clientX - r.left) / r.width) * (labels.length - 1))))
      cross.setAttribute('x1', String(x(i))); cross.setAttribute('x2', String(x(i))); cross.style.display = ''
      dots.forEach((d, k) => { d.setAttribute('cx', String(x(i))); d.setAttribute('cy', String(plot[k].y(plot[k].s.values[i]))); d.style.display = '' })
      tip.show(x(i), Math.min(...plot.map(p => p.y(p.s.values[i]))), opts.tipTitle(i), plot.map(({ s }): TipRow => [s.label, (s.fmt ?? yFmt)(s.values[i]), s.color]))
    }
    const leave = (): void => { cross.style.display = 'none'; dots.forEach(d => (d.style.display = 'none')); tip.hide() }
    hit.addEventListener('pointermove', move); hit.addEventListener('pointerdown', move); hit.addEventListener('pointerleave', leave)
  })
}
