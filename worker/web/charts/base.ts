// Shared pieces of the SVG charts: colours, tooltip, placing a drawing, clickable cells.
import { el, release, svg } from '../lib/dom.ts'

export const COLORS = { out: '#ff7a1a', in: '#3d8bff', cache: '#9b7bff', ok: '#35c98c', muted: '#6f655c' }

export const HEAT = ['#2b2522', '#5b3418', '#8f4c14', '#cc640f', '#ff7a1a']

/** Level 0-4 of a colour: faint to full, over the empty-cell grey. */
export const shade = (color: string, level: number): string => (level <= 0 ? HEAT[0] : `color-mix(in srgb, ${color} ${[0, 35, 55, 78, 100][level]}%, ${HEAT[0]})`)

/** A vertical line at `at` (in columns from the left edge: 2.5 = the middle of the third), with an explanation on hover. */
export interface Marker { at: number; title: string }

/** Draws the line and its caption; `x` is where the line goes, `left` is the left edge of the plot. */
export function drawMarker(root: Element, x: number, top: number, bottom: number, left: number, m: Marker): void {
  const near = x - left < 150 // no room on the left for the caption
  root.append(
    svg('line', { x1: x, x2: x, y1: top, y2: bottom, class: 'mark' }, svg('title', {}, m.title)),
    svg('text', { x: near ? x + 5 : x - 5, y: top + 10, class: 'mark-t', 'text-anchor': near ? 'start' : 'end' }, near ? 'повні дані (OTLP) →' : '← можуть бути неповні', svg('title', {}, m.title)),
  )
}

/** A label, a formatted value and an optional colour dot: one row of a tooltip. */
export type TipRow = [label: string, value: string, color?: string]

interface Tip {
  el: HTMLElement
  show(x: number, y: number, title: string, rows: TipRow[]): void
  hide(): void
}

export type Host = HTMLElement & { _tip?: Tip }

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
export const tipOf = (c: Host): Tip => (c._tip && c._tip.el.isConnected ? c._tip : (c._tip = tooltip(c)))

/** Nothing to draw: a message. With a height it keeps the chart's footprint (faint grid), so the page does not jump. */
export function empty(container: HTMLElement, text = 'Немає даних за цей період', height?: number): void {
  release(container)
  container.replaceChildren(height ? el('div', { class: 'empty-box', style: `height:${height}px` }, el('span', {}, text)) : el('div', { class: 'empty' }, text))
}

/** Puts a freshly drawn chart into its container, replacing the previous drawing but keeping the tooltip. */
export function place(container: HTMLElement, root: Element): void {
  for (const c of [...container.children]) if (!c.classList.contains('chart-tip')) c.remove()
  container.prepend(root)
}

/** Makes an HTML element act as a button: click, Enter and Space. */
export function clickable<T extends HTMLElement>(node: T, run?: (() => void) | undefined): T {
  if (!run) return node
  node.tabIndex = 0
  node.setAttribute('role', 'button')
  node.addEventListener('click', run)
  node.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run() } })
  return node
}

export function showAt(host: Host, target: HTMLElement, title: string, rows: TipRow[]): void {
  const h = host.getBoundingClientRect(), t = target.getBoundingClientRect()
  tipOf(host).show(t.left - h.left + t.width / 2, t.top - h.top, title, rows)
}

export interface Series {
  label: string
  color: string
  values: number[]
  fmt?: (v: number) => string
}

/** Small note inside the plot that the extra series runs off the top of the scale. */
export const clipNote = (root: SVGElement, x: number, y: number, sec: Series): void => {
  root.append(svg('text', { x, y, class: 'ax', style: `fill:${sec.color}` }, `↑ ${sec.label.toLowerCase()} виходить за шкалу (значення в підказці)`))
}
