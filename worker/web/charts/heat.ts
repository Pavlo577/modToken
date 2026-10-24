// Heat grids, month calendars and month tiles (the activity card).
import { el, release, responsive, svg } from '../lib/dom.ts'
import { DOW } from '../lib/format.ts'
import { HEAT, clickable, empty, place, shade, showAt, tipOf } from './base.ts'
import type { Host, TipRow } from './base.ts'
import { levels } from './scale.ts'

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
  /** Makes the cells clickable. */
  onCell?: (row: number, col: number) => void
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
      if (opts.onCell) { rect.classList.add('click'); rect.addEventListener('click', () => opts.onCell?.(r, i)) }
      root.append(rect)
    }))
    place(container, root)
  })
}

/** Week x hour grid: cells[dow][hour], Monday first. */
export const hourGrid = (container: HTMLElement, opts: { cells: HeatCell[][]; tipTitle: (dow: number, hour: number) => string }): void =>
  heatGrid(container, { cells: opts.cells, rowLabel: r => DOW[r], colLabel: h => String(h), tipTitle: opts.tipTitle })

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
  /** Clicking a day / a month title (when shown). */
  onDay?: (day: string) => void
  onMonth?: (month: string) => void
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
      const cell = el('span', { class: `md l${lvl}${opts.onDay ? ' click' : ''}`, style: c?.color ? `background:${shade(c.color, lvl)}` : '' }, String(+d.slice(8)), big && c?.text ? el('small', {}, c.text) : '')
      cell.addEventListener('pointerenter', () => showAt(host, cell, opts.tipTitle(d), c?.tip ?? []))
      cell.addEventListener('pointerleave', () => tipOf(host).hide())
      if (opts.onDay) clickable(cell, () => opts.onDay?.(d))
      grid.append(cell)
    }
    return el('div', { class: months.length === 1 ? 'mcal big' : 'mcal' }, ...(opts.showTitle === false ? [] : [clickable(el('h3', { class: opts.onMonth ? 'click' : '' }, opts.monthTitle(m)), opts.onMonth && (() => opts.onMonth?.(m)))]), grid)
  })
  container.replaceChildren(el('div', { class: 'mcals' }, ...blocks))
}

export interface MonthTile {
  /** 'YYYY-MM' */
  key: string
  label: string
  value: number
  text: string
  color?: string
  tipTitle: string
  tip: TipRow[]
}

/** One tile per month, coloured by its value, with the figure written on it. */
export function monthTiles(container: HTMLElement, tiles: MonthTile[], onPick?: (month: string) => void): void {
  const host = container as Host
  if (!tiles.some(t => t.value > 0)) return empty(container)
  release(container)
  const level = levels(tiles.map(t => t.value))
  container.replaceChildren(el('div', { class: 'mtiles' }, ...tiles.map(t => {
    const tile = el('div', { class: `mt l${level(t.value)}`, style: t.color ? `background:${shade(t.color, level(t.value))}` : '' }, el('span', {}, t.label), el('b', {}, t.value > 0 ? t.text : '—'))
    tile.addEventListener('pointerenter', () => showAt(host, tile, t.tipTitle, t.tip))
    tile.addEventListener('pointerleave', () => tipOf(host).hide())
    if (onPick) tile.classList.add('click')
    return clickable(tile, onPick && (() => onPick(t.key)))
  })))
}
