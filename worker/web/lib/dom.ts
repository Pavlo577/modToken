// DOM helpers shared by the dashboard modules.

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
