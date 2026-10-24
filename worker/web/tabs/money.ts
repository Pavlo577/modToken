// Cost tab: an estimate at API prices.
import * as S from '../lib/stats.ts'
import { barChart } from '../charts/bar.ts'
import { COLORS } from '../charts/base.ts'
import { lineChart } from '../charts/line.ts'
import { PALETTE, providerLabel } from '../core/palette.ts'
import { rangeTitle } from '../core/range.ts'
import { state } from '../core/state.ts'
import { get, need, q, store } from '../core/store.ts'
import { timeOf, tz } from '../core/time.ts'
import { $, el } from '../lib/dom.ts'
import { dayLabel, dayLong, fmt, fmtAxis, fmtPct, fmtUsd } from '../lib/format.ts'
import type { Bucket } from '../lib/types.ts'

export function renderCost(agg: S.Aggregate): void {
  const d = need()
  const total = agg.total
  const days = S.dayList(d.r.fromDay, d.r.toDay)
  const models = [...agg.models].sort((a, b) => b[1].cost - a[1].cost)
  const perDay = total.cost / Math.max(1, days.length)
  $('cost-sub').textContent = `${rangeTitle(d.r)} · за публічними цінами API від ${store.prices?.updated ?? '—'}`
  const facts: [string, string][] = [['Разом', fmtUsd(total.cost)], ['У середньому за день', fmtUsd(perDay)], ['Прогноз на 30 днів', fmtUsd(perDay * 30)], ['Ходів', String(total.turns)]]
  $('cost-summary').replaceChildren(...facts.map(([l, v]) => el('div', {}, el('b', {}, v), l)))
  $('cost-legend').replaceChildren(...models.map(([m], i) => el('span', {}, el('i', { style: `background:${PALETTE[i % PALETTE.length]}` }), m)))
  const perModelDay = new Map<string, number>()
  for (const b of d.buckets) {
    if (state.device && b.device !== state.device) continue
    if (state.provider && b.provider !== state.provider) continue
    const ms = Date.parse(b.h + ':00:00Z')
    if (ms < d.r.from || ms >= d.r.to) continue
    const key = `${tz.parts(ms).day}|${b.model}`
    perModelDay.set(key, (perModelDay.get(key) ?? 0) + (S.costOf(b, b.model, store.prices) ?? 0))
  }
  barChart($('cost-chart'), {
    labels: days.map(dayLabel), height: 220, yFmt: v => '$' + fmtAxis(v),
    series: models.map(([m], i) => ({ label: m, color: PALETTE[i % PALETTE.length], values: days.map(x => perModelDay.get(`${x}|${m}`) ?? 0), fmt: fmtUsd })),
    tipTitle: i => dayLong(days[i]),
  })
  $('cost-table').replaceChildren(el('table', {},
    el('thead', {}, el('tr', {}, el('th', { class: 'l' }, 'Модель'), ...['Вхідні', 'Вихідні', 'Кеш: читання', 'Кеш: запис', 'Вартість', 'Частка'].map(h => el('th', {}, h)))),
    el('tbody', {}, ...models.map(([m, t]) => el('tr', {}, el('td', { class: 'l' }, m), el('td', {}, fmt(t.input)), el('td', {}, fmt(t.output)), el('td', {}, fmt(t.cache_read)), el('td', {}, fmt(t.cache_creation)),
      el('td', {}, fmtUsd(t.cost)), el('td', {}, fmtPct(total.cost ? t.cost / total.cost : 0)))))))
  $('cost-note').textContent = `Це оцінка за цінами API, а не рахунок: підписка оплачується окремо. Запис у кеш рахується за ціною для 1 години. Ціни лежать у файлі prices.json (оновлено ${store.prices?.updated ?? '—'}).` +
    (agg.unpriced.length ? ` Без ціни, у вартість не входять: ${agg.unpriced.join(', ')}.` : '')
}
