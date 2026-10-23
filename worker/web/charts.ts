// Chart primitives drawn as SVG. Each takes a container element and redraws when it is resized.
import { el, svg, fmtAxis, responsive, release, DOW, monthLabel } from './util.ts'

export const COLORS = { out: '#ff7a1a', in: '#3d8bff', cache: '#9b7bff', ok: '#35c98c', muted: '#6f655c' }
export const HEAT = ['#2b2522', '#5b3418', '#8f4c14', '#cc640f', '#ff7a1a']
/** Level 0-4 of a colour: faint to full, over the empty-cell grey. */
export const shade = (color: string, level: number): string => (level <= 0 ? HEAT[0] : `color-mix(in srgb, ${color} ${[0, 35, 55, 78, 100][level]}%, ${HEAT[0]})`)

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

/** Nothing to draw: a message. With a height it keeps the chart's footprint (faint grid), so the page does not jump. */
export function empty(container: HTMLElement, text = 'Немає даних за цей період', height?: number): void {
  release(container)
  container.replaceChildren(height ? el('div', { class: 'empty-box', style: `height:${height}px` }, el('span', {}, text)) : el('div', { class: 'empty' }, text))
}

/** Largest "nice" number (1, 2, 2.5, 5 times a power of ten) that does not exceed v. */
const niceFloor = (v: number): number => {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  const f = v / p
  return (f >= 5 ? 5 : f >= 2.5 ? 2.5 : f >= 2 ? 2 : 1) * p
}

/**
 * Value-axis maximum when an extra series (the cache) shares the scale: fitted to the main series, so that its highest
 * point reaches at least the first grid line; the extra series is clipped at the top if it is larger.
 */
function sharedMax(mainMax: number, extraMax: number): number {
  const full = niceMax(Math.max(mainMax, extraMax))
  return Math.max(niceMax(mainMax), Math.min(full, niceFloor(4 * mainMax)))
}

/** Logarithmic value axis: one gridline per power of ten that spans all the values; zero sits on the bottom line. */
function logAxis(values: number[], top: number, ih: number): { ticks: number[]; y: (v: number) => number } {
  const pos = values.filter(v => v > 0)
  const lo = Math.floor(Math.log10(Math.min(...pos))), hi = Math.max(lo + 1, Math.ceil(Math.log10(Math.max(...pos))))
  return {
    ticks: Array.from({ length: hi - lo + 1 }, (_, k) => 10 ** (lo + k)),
    y: v => top + ih - ((Math.log10(Math.max(v, 10 ** lo)) - lo) / (hi - lo)) * ih,
  }
}

/** Small note inside the plot that the extra series runs off the top of the scale. */
const clipNote = (root: SVGElement, x: number, y: number, sec: Series): void => {
  root.append(svg('text', { x, y, class: 'ax', style: `fill:${sec.color}` }, `↑ ${sec.label.toLowerCase()} виходить за шкалу (значення в підказці)`))
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
  /** An extra series on the same scale, clipped at the top when far larger than the rest (cache reads). */
  secondary?: Series
  /** Logarithmic axis: values of very different size (the cache) all stay readable, nothing is clipped. */
  logScale?: boolean
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
    const max = sec ? sharedMax(Math.max(...totals), secTop) : niceMax(Math.max(...totals))
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
      const g = svg('g', { class: 'bar grow', style: `--d:${Math.min(600, i * 14)}ms` })
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

export interface HeatCell {
  value: number
  /** Short figure written on big calendar squares. */
  text?: string
  /** Own colour (a device's) instead of the orange heat scale; the level still sets how strong it is. */
  color?: string
  tip: TipRow[]
}

export interface HeatGridOptions {
  cells: HeatCell[][]
  rowLabel: (row: number) => string
  /** Label after the last column (e.g. the weekday), optional. */
  rightLabel?: (row: number) => string
  /** Label above a column, or null for none. */
  colLabel: (col: number) => string | null
  tipTitle: (row: number, col: number) => string
  maxCell?: number
  labelW?: number
  /** Cell height when it should differ from the width. */
  cellH?: number
}

/** Rows x columns of heat cells, coloured by value relative to the largest. */
export function heatGrid(container: HTMLElement, opts: HeatGridOptions): void {
  const host = container as Host
  const { cells } = opts
  const rows = cells.length, cols = cells[0]?.length ?? 0
  const max = Math.max(0, ...cells.flat().map(c => c.value))
  if (!(max > 0)) return empty(container, undefined, 18 + rows * ((opts.cellH ?? 22) + 2))
  responsive(container, W => {
    const labelW = opts.labelW ?? 28, topH = 18, gap = 2
    const rightW = opts.rightLabel ? 30 : 0
    const cw = Math.max(8, Math.min(opts.maxCell ?? 60, Math.floor((W - labelW - rightW) / cols) - gap))
    const ch = opts.cellH ?? cw
    const width = labelW + cols * (cw + gap) + rightW
    const height = topH + rows * (ch + gap)
    const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' })
    const step = cw < 22 ? 3 : cw < 30 ? 2 : 1
    for (let c = 0; c < cols; c += step) {
      const label = opts.colLabel(c)
      if (label != null) root.append(svg('text', { x: labelW + c * (cw + gap), y: 11, class: 'ax' }, label))
    }
    for (let r = 0; r < rows; r++) {
      const ty = topH + r * (ch + gap) + Math.min(ch, 14) - 3
      root.append(svg('text', { x: 0, y: ty, class: 'ax' }, opts.rowLabel(r)))
      if (opts.rightLabel) root.append(svg('text', { x: labelW + cols * (cw + gap) + 4, y: ty, class: 'ax' }, opts.rightLabel(r)))
    }
    const tip = tipOf(host)
    cells.forEach((row, r) => row.forEach((c, i) => {
      const lvl = c.value <= 0 ? 0 : Math.max(1, Math.ceil((c.value / max) * 4))
      const x = labelW + i * (cw + gap), y = topH + r * (ch + gap)
      const rect = svg('rect', { x, y, width: cw, height: ch, rx: 3, fill: c.color ? shade(c.color, lvl) : HEAT[lvl], class: 'cell' })
      rect.addEventListener('pointerenter', () => tip.show(x + cw / 2, y, opts.tipTitle(r, i), c.tip))
      rect.addEventListener('pointerleave', () => tip.hide())
      root.append(rect)
    }))
    place(container, root)
  })
}

/** Week x hour grid: cells[dow][hour], Monday first. */
export const hourGrid = (container: HTMLElement, opts: { cells: HeatCell[][]; tipTitle: (dow: number, hour: number) => string }): void =>
  heatGrid(container, { cells: opts.cells, rowLabel: r => DOW[r], colLabel: h => String(h), tipTitle: opts.tipTitle })

/** Puts a freshly drawn chart into its container, replacing the previous drawing but keeping the tooltip. */
function place(container: HTMLElement, root: Element): void {
  for (const c of [...container.children]) if (!c.classList.contains('chart-tip')) c.remove()
  container.prepend(root)
}

/** Heat level 0-4 for each value: quartiles of the non-zero ones, so a few huge days do not wash out the rest. */
function levels(values: number[]): (v: number) => number {
  const nz = values.filter(v => v > 0).sort((a, b) => a - b)
  const q = (p: number): number => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))]
  const cuts = nz.length ? [q(0.25), q(0.5), q(0.75)] : [0, 0, 0]
  return v => (v <= 0 ? 0 : v <= cuts[0] ? 1 : v <= cuts[1] ? 2 : v <= cuts[2] ? 3 : 4)
}

function showAt(host: Host, target: HTMLElement, title: string, rows: TipRow[]): void {
  const h = host.getBoundingClientRect(), t = target.getBoundingClientRect()
  tipOf(host).show(t.left - h.left + t.width / 2, t.top - h.top, title, rows)
}

export interface MonthCalendarsOptions {
  from: string
  to: string
  days: Map<string, HeatCell>
  addDays: (day: string, n: number) => string
  /** 0 = Monday ... 6 = Sunday */
  dayOfWeek: (day: string) => number
  monthTitle: (month: string) => string // 'YYYY-MM'
  /** false when the month is named elsewhere (the pager). */
  showTitle?: boolean
  tipTitle: (day: string) => string
}

/** One small calendar per month, every date a heat square with its number. */
export function monthCalendars(container: HTMLElement, opts: MonthCalendarsOptions): void {
  const host = container as Host
  const { from, to, days, addDays, dayOfWeek } = opts
  const level = levels([...days.values()].map(c => c.value))
  if (![...days.values()].some(c => c.value > 0)) return empty(container)
  release(container)
  const months: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) if (!months.length || months[months.length - 1] !== d.slice(0, 7)) months.push(d.slice(0, 7))
  const blocks = months.map(m => {
    const grid = el('div', { class: 'mgrid' }, ...DOW.map(n => el('span', { class: 'mh' }, n)))
    const first = m + '-01'
    for (let i = 0; i < dayOfWeek(first); i++) grid.append(el('span', {}))
    const big = months.length === 1
    for (let d = first; d.slice(0, 7) === m; d = addDays(d, 1)) {
      if (d < from || d > to) { grid.append(el('span', { class: 'md off' }, String(+d.slice(8)))); continue }
      const c = days.get(d)
      const lvl = level(c?.value ?? 0)
      const cell = el('span', { class: `md l${lvl}`, style: c?.color ? `background:${shade(c.color, lvl)}` : '' }, String(+d.slice(8)), big && c?.text ? el('small', {}, c.text) : '')
      cell.addEventListener('pointerenter', () => showAt(host, cell, opts.tipTitle(d), c?.tip ?? []))
      cell.addEventListener('pointerleave', () => tipOf(host).hide())
      grid.append(cell)
    }
    return el('div', { class: months.length === 1 ? 'mcal big' : 'mcal' }, ...(opts.showTitle === false ? [] : [el('h3', {}, opts.monthTitle(m))]), grid)
  })
  container.replaceChildren(el('div', { class: 'mcals' }, ...blocks))
}

export interface MonthTile {
  label: string
  value: number
  text: string
  color?: string
  tipTitle: string
  tip: TipRow[]
}

/** One tile per month, coloured by its value, with the figure written on it. */
export function monthTiles(container: HTMLElement, tiles: MonthTile[]): void {
  const host = container as Host
  if (!tiles.some(t => t.value > 0)) return empty(container)
  release(container)
  const level = levels(tiles.map(t => t.value))
  container.replaceChildren(el('div', { class: 'mtiles' }, ...tiles.map(t => {
    const tile = el('div', { class: `mt l${level(t.value)}`, style: t.color ? `background:${shade(t.color, level(t.value))}` : '' }, el('span', {}, t.label), el('b', {}, t.value > 0 ? t.text : '—'))
    tile.addEventListener('pointerenter', () => showAt(host, tile, t.tipTitle, t.tip))
    tile.addEventListener('pointerleave', () => tipOf(host).hide())
    return tile
  })))
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
