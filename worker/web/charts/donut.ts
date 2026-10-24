// Donut chart.
import { svg } from '../lib/dom.ts'
import { empty } from './base.ts'

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
