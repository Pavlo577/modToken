// Small DOM and formatting helpers shared by the dashboard modules.
export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id)
  if (!node) throw new Error(`#${id} is missing in index.html`)
  return node as T
}

type Attrs = Record<string, string | boolean | null | undefined | ((e: Event) => void)>
export type Kid = Node | string | null | undefined | false | Kid[]

const append = (parent: Element, kids: Kid[]): void => {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue
    if (Array.isArray(k)) append(parent, k)
    else parent.append(k)
  }
}

export const el = (tag: string, props: Attrs = {}, ...kids: Kid[]): HTMLElement => {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v == null) continue
    if (typeof v === 'function') n.addEventListener(k.slice(2), v)
    else if (k === 'style') n.style.cssText = String(v)
    else n.setAttribute(k, v === true ? '' : v)
  }
  append(n, kids)
  return n
}

export const svg = (tag: string, props: Record<string, string | number | null | undefined | false> = {}, ...kids: Kid[]): SVGElement => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [k, v] of Object.entries(props)) if (v != null && v !== false) k === 'style' ? ((n as SVGElement).style.cssText = String(v)) : n.setAttribute(k, String(v))
  append(n, kids)
  return n
}

export const fmt = (n: number | null | undefined): string => {
  const v = Number(n) || 0
  const a = Math.abs(v)
  return a >= 1e9 ? (v / 1e9).toFixed(2) + ' млрд' : a >= 1e6 ? (v / 1e6).toFixed(2) + ' млн' : a >= 1e4 ? (v / 1e3).toFixed(1) + ' тис' : a >= 1e3 ? (v / 1e3).toFixed(2) + ' тис' : String(Math.round(v))
}
export const fmtAxis = (n: number): string => {
  const a = Math.abs(n)
  return a >= 1e9 ? +(n / 1e9).toFixed(1) + 'B' : a >= 1e6 ? +(n / 1e6).toFixed(1) + 'M' : a >= 1e3 ? +(n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k' : String(Math.round(n * 10) / 10)
}
export const fmtUsd = (n: number): string => (n >= 100 ? '$' + Math.round(n).toLocaleString('en-US') : n >= 1 ? '$' + n.toFixed(2) : '$' + n.toFixed(3))
export const fmtPct = (f: number | null, d = 0): string => (f == null ? '—' : (f * 100).toFixed(d) + '%')
export const dur = (ms: number): string => {
  const m = Math.round((Number(ms) || 0) / 60000)
  return m >= 60 ? Math.floor(m / 60) + ' год ' + (m % 60) + ' хв' : m + ' хв'
}
export const durSec = (ms: number): string => {
  const s = Math.round((Number(ms) || 0) / 1000)
  return s >= 3600 ? `${Math.floor(s / 3600)} год ${Math.round((s % 3600) / 60)} хв` : s >= 60 ? `${Math.floor(s / 60)} хв ${s % 60} с` : s + ' с'
}

const MONTHS = ['січ', 'лют', 'бер', 'кві', 'тра', 'чер', 'лип', 'сер', 'вер', 'жов', 'лис', 'гру']
export const DOW = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд']
export const dayLabel = (day: string): string => { const [, m, d] = day.split('-'); return `${+d} ${MONTHS[+m - 1]}` }
export const dayLong = (day: string): string => { const [y, m, d] = day.split('-'); return `${+d} ${MONTHS[+m - 1]} ${y}` }
export const monthLabel = (m: number): string => MONTHS[m - 1]

export const api = async <T = unknown>(path: string, opts?: RequestInit): Promise<T> => {
  const r = await fetch('/api/admin' + path, opts)
  if (!r.ok) throw new Error((await r.text()) || String(r.status))
  return (r.status === 204 ? null : await r.json()) as T
}

type Observed = HTMLElement & { _ro?: ResizeObserver }

/** Stops redrawing a container: call before it shows something else (another chart, an empty message). */
export function release(container: HTMLElement): void {
  const c = container as Observed
  c._ro?.disconnect()
  c._ro = undefined
}

/** Redraws `draw` whenever the container's width changes (and once now); replaces any earlier drawing there. */
export function responsive(container: HTMLElement, draw: (width: number) => void): void {
  release(container)
  let width = 0
  const run = (): void => {
    const w = Math.floor(container.clientWidth)
    if (w > 0 && w !== width) { width = w; draw(w) }
  }
  const ro = new ResizeObserver(run)
  ;(container as Observed)._ro = ro
  ro.observe(container)
  run()
}

/** Grey shimmering placeholder in the shape of a chart, shown while its data loads. */
export function skeleton(container: HTMLElement, height = 220): void {
  release(container)
  const wave = 'M0,28 C6,22 10,30 16,24 S26,12 32,20 S42,32 50,22 S60,8 68,16 S80,30 88,20 S96,14 100,18'
  container.replaceChildren(el('div', { class: 'skel-chart', style: `height:${height}px` },
    ...[0, 1, 2, 3].map(i => el('i', { class: 'skel-grid skel', style: `top:${12 + i * 24}%` })),
    svg('svg', { viewBox: '0 0 100 40', preserveAspectRatio: 'none', 'aria-hidden': 'true' }, svg('path', { d: wave, fill: 'none', 'vector-effect': 'non-scaling-stroke' }))))
}

/** A KPI tile placeholder. */
export const skeletonTile = (): HTMLElement => el('div', { class: 'kpi' }, el('div', { class: 'skel', style: 'height:12px;width:60%' }), el('div', { class: 'skel', style: 'height:26px;width:75%;margin:12px 0 10px' }), el('div', { class: 'skel', style: 'height:10px;width:45%' }))
