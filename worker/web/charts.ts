// Chart primitives drawn as SVG. Each takes a container element and redraws when it is resized.
import { el, svg, fmtAxis, responsive, release, DOW, monthLabel } from './util.ts'

export const COLORS = { out: '#ff7a1a', in: '#3d8bff', cache: '#9b7bff', ok: '#35c98c', muted: '#6f655c' }
export const HEAT = ['#2b2522', '#5b3418', '#8f4c14', '#cc640f', '#ff7a1a']

/** A label, a formatted value and an optional colour dot: one row of a tooltip. */
export type TipRow = [label: string, value: string, color?: string]

interface Tip {
  el: HTMLElement
  show(x: number, y: number, title: string, rows: TipRow[]): void
  hide(): void
}
type Host = HTMLElement & { _tip?: Tip }

function tooltip(container: Host): Tip {
  container.style.position = 'relative'
  const tip = el('div', { class: 'chart-tip' })
  container.append(tip)
  return {
    el: tip,
    show(x, y, title, rows) {
      tip.replaceChildren(
        el('div', { class: 'tt' }, title),
        ...rows.map(([label, value, color]) => el('div', { class: 'tr' }, color ? el('i', { style: `background:${color}` }) : '', el('span', {}, label), el('b', {}, value))),
      )
      tip.style.display = 'block'
      const w = tip.offsetWidth, W = container.clientWidth
      tip.style.left = Math.max(0, Math.min(W - w, x - w / 2)) + 'px'
      tip.style.top = Math.max(0, y - tip.offsetHeight - 12) + 'px'
    },
    hide() { tip.style.display = 'none' },
  }
}
// The container may have been emptied since the tooltip was made (another chart took its place): make a new one then.
const tipOf = (c: Host): Tip => (c._tip && c._tip.el.isConnected ? c._tip : (c._tip = tooltip(c)))

const niceMax = (v: number): number => {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  const f = v / p
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p
}
const ticks = (max: number, n = 4): number[] => Array.from({ length: n + 1 }, (_, i) => (max / n) * i)

/** Monotone cubic path through points, so the curve never overshoots the data. */
function smooth(pts: [number, number][]): string {
  const n = pts.length
  if (n === 1) return `M${pts[0][0]},${pts[0][1]}`
  if (n === 2) return `M${pts[0][0]},${pts[0][1]}L${pts[1][0]},${pts[1][1]}`
  const dx: number[] = [], m: number[] = [], t: number[] = []
  for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; m[i] = (pts[i + 1][1] - pts[i][1]) / dx[i] }
  t[0] = m[0]; t[n - 1] = m[n - 2]
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i])
  let d = `M${pts[0][0]},${pts[0][1]}`
  for (let i = 0; i < n - 1; i++) {
    d += `C${pts[i][0] + dx[i] / 3},${pts[i][1] + (t[i] * dx[i]) / 3},${pts[i + 1][0] - dx[i] / 3},${pts[i + 1][1] - (t[i + 1] * dx[i]) / 3},${pts[i + 1][0]},${pts[i + 1][1]}`
  }
  return d
}

/** Indexes of the category labels to print so that they do not overlap. */
const evenLabels = (n: number, width: number, minGap = 64): number[] => {
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(width / minGap))))
  const idx = Array.from({ length: n }, (_, i) => i).filter(i => i % every === 0)
  // always end on the last category, moving the previous label there when the two would touch
  if (idx.length && idx[idx.length - 1] !== n - 1) {
    if (n - 1 - idx[idx.length - 1] >= every * 0.9) idx.push(n - 1)
    else idx[idx.length - 1] = n - 1
  }
  return idx
}

function empty(container: HTMLElement, text = 'Немає даних за цей період'): void {
  release(container)
  container.replaceChildren(el('div', { class: 'empty' }, text))
}

export interface Series {
  label: string
  color: string
  values: number[]
  fmt?: (v: number) => string
}

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
}

/** Lines over evenly spaced categories (days or hours), with a crosshair and a tooltip. */
export function lineChart(container: HTMLElement, opts: LineOptions): void {
  const host = container as Host
  const { labels, series, height = 230, yFmt = fmtAxis, area = true } = opts
  const all = series.flatMap(s => s.values)
  if (!labels.length || !all.some(v => v > 0)) return empty(container)
  responsive(container, W => {
    const m = { l: 44, r: 14, t: 14, b: 26 }
    const iw = W - m.l - m.r, ih = height - m.t - m.b
    const lo = opts.yMin ?? 0
    const max = opts.yMax ?? niceMax(Math.max(...all))
    const x = (i: number): number => m.l + (labels.length === 1 ? iw / 2 : (iw * i) / (labels.length - 1))
    const y = (v: number): number => m.t + ih - ((v - lo) / (max - lo || 1)) * ih
    const uid = `g${container.id}`
    const root = svg('svg', { viewBox: `0 0 ${W} ${height}`, width: W, height, role: 'img' })
    const defs = svg('defs')
    series.forEach((s, k) => defs.append(svg('linearGradient', { id: `${uid}${k}`, x1: 0, x2: 0, y1: 0, y2: 1 },
      svg('stop', { offset: '0%', 'stop-color': s.color, 'stop-opacity': 0.28 }), svg('stop', { offset: '100%', 'stop-color': s.color, 'stop-opacity': 0 }))))
    root.append(defs)
    for (const t of ticks(max - lo).map(v => v + lo)) {
      root.append(svg('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: 'grid' }))
      root.append(svg('text', { x: m.l - 8, y: y(t) + 4, class: 'ax', 'text-anchor': 'end' }, yFmt(t)))
    }
    for (const i of evenLabels(labels.length, iw)) root.append(svg('text', { x: x(i), y: height - 6, class: 'ax', 'text-anchor': i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle' }, labels[i]))
    series.forEach((s, k) => {
      const pts = s.values.map((v, i): [number, number] => [x(i), y(v)])
      if (area && k < 2 && pts.length > 1) root.append(svg('path', { d: `${smooth(pts)}L${pts[pts.length - 1][0]},${m.t + ih}L${pts[0][0]},${m.t + ih}Z`, fill: `url(#${uid}${k})` }))
      root.append(svg('path', { d: smooth(pts), fill: 'none', stroke: s.color, 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))
      if (pts.length === 1) root.append(svg('circle', { cx: pts[0][0], cy: pts[0][1], r: 4, fill: s.color }))
    })
    const cross = svg('line', { y1: m.t, y2: m.t + ih, class: 'cross', style: 'display:none' })
    const dots = series.map(s => svg('circle', { r: 5, fill: '#14110f', stroke: s.color, 'stroke-width': 2.5, style: 'display:none' }))
    root.append(cross, ...dots)
    const hit = svg('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' })
    root.append(hit)
    container.querySelector('svg')?.remove()
    container.prepend(root)
    const tip = tipOf(host)
    const move = (e: Event): void => {
      const pe = e as PointerEvent
      const r = hit.getBoundingClientRect()
      const i = Math.max(0, Math.min(labels.length - 1, Math.round(((pe.clientX - r.left) / r.width) * (labels.length - 1))))
      cross.setAttribute('x1', String(x(i))); cross.setAttribute('x2', String(x(i))); cross.style.display = ''
      dots.forEach((d, k) => { d.setAttribute('cx', String(x(i))); d.setAttribute('cy', String(y(series[k].values[i]))); d.style.display = '' })
      tip.show(x(i), Math.min(...series.map(s => y(s.values[i]))), opts.tipTitle(i), series.map((s): TipRow => [s.label, (s.fmt ?? yFmt)(s.values[i]), s.color]))
    }
    const leave = (): void => { cross.style.display = 'none'; dots.forEach(d => (d.style.display = 'none')); tip.hide() }
    hit.addEventListener('pointermove', move); hit.addEventListener('pointerdown', move); hit.addEventListener('pointerleave', leave)
  })
}

export interface BarOptions {
  labels: string[]
  series: Series[]
  tipTitle: (i: number) => string
  height?: number
  yFmt?: (v: number) => string
  extraTip?: (i: number) => TipRow[]
}

/** Stacked bars over categories, rounded on top, with a tooltip. */
export function barChart(container: HTMLElement, opts: BarOptions): void {
  const host = container as Host
  const { labels, series, height = 230, yFmt = fmtAxis } = opts
  const totals = labels.map((_, i) => series.reduce((a, s) => a + s.values[i], 0))
  if (!labels.length || !totals.some(v => v > 0)) return empty(container)
  responsive(container, W => {
    const m = { l: 44, r: 8, t: 14, b: 26 }
    const iw = W - m.l - m.r, ih = height - m.t - m.b
    const max = niceMax(Math.max(...totals))
    const slotW = iw / labels.length
    const bw = Math.max(2, Math.min(34, slotW * 0.68))
    const y = (v: number): number => m.t + ih - (v / max) * ih
    const root = svg('svg', { viewBox: `0 0 ${W} ${height}`, width: W, height, role: 'img' })
    for (const t of ticks(max)) {
      root.append(svg('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: 'grid' }))
      root.append(svg('text', { x: m.l - 8, y: y(t) + 4, class: 'ax', 'text-anchor': 'end' }, yFmt(t)))
    }
    for (const i of evenLabels(labels.length, iw, 56)) root.append(svg('text', { x: m.l + slotW * (i + 0.5), y: height - 6, class: 'ax', 'text-anchor': 'middle' }, labels[i]))
    const groups = labels.map((_, i): [SVGElement, number, number] => {
      const cx = m.l + slotW * (i + 0.5)
      const g = svg('g', { class: 'bar' })
      g.append(svg('rect', { x: m.l + slotW * i, y: m.t, width: slotW, height: ih, class: 'bar-hit' }))
      let acc = 0
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
    container.querySelector('svg')?.remove()
    container.prepend(root)
    const tip = tipOf(host)
    groups.forEach(([g, cx, top], i) => {
      const show = (): void => {
        g.classList.add('on')
        tip.show(cx, y(top), opts.tipTitle(i), [...series.map((s): TipRow => [s.label, (s.fmt ?? yFmt)(s.values[i]), s.color]), ...(opts.extraTip?.(i) ?? [])])
      }
      g.addEventListener('pointerenter', show); g.addEventListener('pointerdown', show)
      g.addEventListener('pointerleave', () => { g.classList.remove('on'); tip.hide() })
    })
  })
}

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
    const cell = Math.max(8, Math.min(20, Math.floor((W - labelW) / weeks) - gap))
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
    container.querySelector('svg')?.remove()
    container.prepend(root)
  })
}

export interface HeatCell {
  value: number
  tip: TipRow[]
}

/** Week x hour grid: cells[dow][hour], Monday first. */
export function hourGrid(container: HTMLElement, opts: { cells: HeatCell[][]; tipTitle: (dow: number, hour: number) => string }): void {
  const host = container as Host
  const { cells } = opts
  const max = Math.max(...cells.flat().map(c => c.value))
  if (!(max > 0)) return empty(container)
  responsive(container, W => {
    const labelW = 28, topH = 18, gap = 2
    const cell = Math.max(8, Math.floor((W - labelW) / 24) - gap)
    const width = labelW + 24 * (cell + gap)
    const height = topH + 7 * (cell + gap)
    const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' })
    for (let h = 0; h < 24; h += 3) root.append(svg('text', { x: labelW + h * (cell + gap), y: 11, class: 'ax' }, String(h)))
    DOW.forEach((n, r) => root.append(svg('text', { x: 0, y: topH + r * (cell + gap) + cell - 2, class: 'ax' }, n)))
    const tip = tipOf(host)
    cells.forEach((row, r) => row.forEach((c, h) => {
      const lvl = c.value <= 0 ? 0 : Math.max(1, Math.ceil((c.value / max) * 4))
      const x = labelW + h * (cell + gap), y = topH + r * (cell + gap)
      const rect = svg('rect', { x, y, width: cell, height: cell, rx: 3, fill: HEAT[lvl], class: 'cell' })
      rect.addEventListener('pointerenter', () => tip.show(x + cell / 2, y, opts.tipTitle(r, h), c.tip))
      rect.addEventListener('pointerleave', () => tip.hide())
      root.append(rect)
    }))
    container.querySelector('svg')?.remove()
    container.prepend(root)
  })
}

/** Donut with the total in the middle. */
export function donut(container: HTMLElement, items: { label: string; value: number; color: string }[], center: [string, string]): void {
  const total = items.reduce((a, i) => a + i.value, 0)
  if (!(total > 0)) return empty(container, 'Немає даних')
  const size = 168, r = 62, w = 22, c = 2 * Math.PI * r
  const root = svg('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img' })
  root.append(svg('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: '#241f1c', 'stroke-width': w }))
  let off = 0
  for (const it of items) {
    const len = (it.value / total) * c
    const dash = Math.max(0, len - 2)
    root.append(svg('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: it.color, 'stroke-width': w, 'stroke-dasharray': `${dash} ${c - dash}`, 'stroke-dashoffset': -off, transform: `rotate(-90 ${size / 2} ${size / 2})` }))
    off += len
  }
  root.append(svg('text', { x: size / 2, y: size / 2 - 2, 'text-anchor': 'middle', class: 'donut-v' }, center[0]), svg('text', { x: size / 2, y: size / 2 + 16, 'text-anchor': 'middle', class: 'ax' }, center[1]))
  container.replaceChildren(root)
}
