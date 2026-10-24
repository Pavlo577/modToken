// Analytics tab.
import * as S from '../lib/stats.ts'
import { COLORS } from '../charts/base.ts'
import { donut } from '../charts/donut.ts'
import { lineChart } from '../charts/line.ts'
import { PALETTE } from '../core/palette.ts'
import { $, el } from '../lib/dom.ts'
import { dayLabel, dayLong, fmt, fmtPct } from '../lib/format.ts'
import { renderActivity } from './activity.ts'

export function renderAnalytics(agg: S.Aggregate): void {
  renderActivity(agg)
  const active = [...agg.days].filter(([, t]) => S.cacheHit(t) != null).sort(([a], [b]) => (a < b ? -1 : 1))
  $('cache-sub').textContent = `У середньому ${fmtPct(S.cacheHit(agg.total))} вхідних даних береться з кешу замість повної обробки`
  const hits = active.map(([, t]) => (S.cacheHit(t) ?? 0) * 100)
  lineChart($('cache-chart'), {
    labels: active.map(([d]) => dayLabel(d)), height: 200, yMax: 100, yMin: hits.length ? Math.max(0, Math.floor((Math.min(...hits) - 2) / 5) * 5) : 0,
    series: [{ label: 'З кешу', color: COLORS.cache, values: hits, fmt: v => v.toFixed(1) + '%' }],
    yFmt: v => +v.toFixed(1) + '%', tipTitle: i => dayLong(active[i][0]),
  })

  const models = [...agg.models].sort((a, b) => b[1].output - a[1].output)
  const color = (i: number): string => PALETTE[i % PALETTE.length]
  const totalOut = agg.total.output
  donut($('model-donut'), models.map(([label, t], i) => ({ label, value: t.output, color: color(i) })), [fmt(totalOut), 'вихідних'])
  $('model-list').replaceChildren(...models.map(([m, t], i) => el('div', {}, el('i', { style: `background:${color(i)}` }), el('span', {}, m), el('b', {}, fmt(t.output)), el('span', { class: 'pc' }, fmtPct(totalOut ? t.output / totalOut : 0)))))
  const devices = [...agg.devices].sort((a, b) => b[1].output - a[1].output)
  const max = Math.max(1, ...devices.map(([, t]) => t.output))
  $('device-bars').replaceChildren(...(devices.length ? devices.map(([n, t], i) => el('div', { class: 'hrow', style: `--c:${color(i)}` }, el('span', { class: 'name', title: n }, n),
    el('div', { class: 'track' }, el('b', { style: `width:${(t.output / max) * 100}%` }), el('span', { class: 'hatch' })), el('span', { class: 'val' }, fmt(t.output)))) : [el('div', { class: 'empty' }, 'Немає даних')]))
}
