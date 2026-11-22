// Cost and subscription-limits tab.
import * as S from '../lib/stats.ts'
import { barChart } from '../charts/bar.ts'
import { COLORS } from '../charts/base.ts'
import { lineChart } from '../charts/line.ts'
import { PALETTE, providerColor, providerLabel } from '../core/palette.ts'
import { rangeTitle } from '../core/range.ts'
import { state } from '../core/state.ts'
import { otlpMarker } from '../core/bounds.ts'
import { get, need, q, store } from '../core/store.ts'
import { timeOf, tz } from '../core/time.ts'
import { $, el } from '../lib/dom.ts'
import { dayLabel, dayLong, fmt, fmtAxis, fmtPct, fmtUsd } from '../lib/format.ts'
import type { Bucket, LimitRow } from '../lib/types.ts'

// ---------- money
const untilText = (ms: number): string => {
  const m = Math.max(0, Math.round((ms - Date.now()) / 60_000))
  return m >= 1440 ? `${Math.floor(m / 1440)} дн ${Math.floor((m % 1440) / 60)} год` : m >= 60 ? `${Math.floor(m / 60)} год ${m % 60} хв` : `${m} хв`
}

const agoText = (ms: number): string => {
  const m = Math.round((Date.now() - ms) / 60_000)
  return m < 2 ? 'щойно' : m < 60 ? `${m} хв тому` : m < 1440 ? `${Math.round(m / 60)} год тому` : `${Math.round(m / 1440)} дн тому`
}

const PROVIDER_ORDER = ['claude', 'codex', 'antigravity']
const NOISE_WORDS = new Set(['5h', 'five', 'hour', 'session', '7d', 'seven', 'day', 'weekly', 'week', 'limit', 'remaining'])

const roundPct = (v: number): number => {
  const c = Math.min(100, Math.max(0, v))
  return c > 0 && c < 10 ? Math.round(c * 10) / 10 : Math.round(c)
}

const fmtLim = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, '')) + '%'

function kindMeta(k: string): [string, string] {
  if (k === 'five_hour') return ['Поточна сесія', '5 годин']
  if (k === 'seven_day') return ['Тиждень', '7 днів']
  if (k === 'seven_day_sonnet') return ['Тиждень · Sonnet', '7 днів']
  if (k === 'seven_day_opus') return ['Тиждень · Opus', '7 днів']
  const span = /(^|_)(5h|five_hour|five|hour|session)(_|$)/.test(k) ? '5 годин' : /(^|_)(7d|seven_day|week|weekly)(_|$)/.test(k) ? '7 днів' : ''
  const raw = k.split('_').filter(Boolean)
  const clean = raw.filter(w => !NOISE_WORDS.has(w))
  const words = clean.length ? clean : raw
  const title = words.map(w => (w === 'gpt' ? 'GPT' : w[0].toUpperCase() + w.slice(1))).join(' ')
  return [title || k, span]
}

const sortKinds = (keys: string[]): string[] => [...keys].sort((a, b) => {
  const pa = a === 'five_hour' ? 0 : a === 'seven_day' ? 1 : 2
  const pb = b === 'five_hour' ? 0 : b === 'seven_day' ? 1 : 2
  return pa !== pb ? pa - pb : a.localeCompare(b)
})

const sortProviders = (ps: string[]): string[] => [...ps].sort((a, b) => {
  const ia = PROVIDER_ORDER.indexOf(a), ib = PROVIDER_ORDER.indexOf(b)
  if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
  return a.localeCompare(b)
})

/** Limits are shown for one agent at a time in the chart: the chosen one, else Claude, else the first that reports any. */
const limitProvider = (limits: { provider: string }[]): string => state.provider || (limits.length && !limits.some(l => l.provider === 'claude') ? limits[0].provider : 'claude')

const emptyLimitsText = (lp: string): string => lp === 'codex'
  ? 'Ще немає даних про ліміти Codex. Їх надсилає плагін token-tracker для Codex, якого ставить команда встановлення (Пристрої → Додати пристрій; у Codex дозволь його хук): вони з\'являться після першої відповіді Codex.'
  : lp === 'antigravity'
    ? 'Ще немає даних про ліміти Antigravity. Їх надсилає плагін token-tracker / statusLine для Antigravity CLI (Пристрої → Додати пристрій): вони з\'являться після першої відповіді agy.'
    : 'Ще немає даних про ліміти. Їх надсилає мод token-tracker з пристроїв із підпискою (Пристрої → Додати пристрій): вони з\'являться після першої відповіді Claude.'

function renderLimitRow(l: S.LimitNow): HTMLElement {
  const [title, span] = kindMeta(l.kind)
  const used = roundPct(l.percent)
  const left = Math.round((100 - used) * 10) / 10
  const isLeft = state.limitMode === 'left'
  const barPct = isLeft ? left : used
  const color = isLeft
    ? (left <= 10 ? 'var(--bad)' : left <= 30 ? 'var(--warn)' : 'var(--ok)')
    : (used >= 90 ? 'var(--bad)' : used >= 70 ? 'var(--warn)' : 'var(--out)')
  const f = S.forecast(l)
  const resetMs = l.resets_at ? Date.parse(l.resets_at) : 0
  const when = l.isStale
    ? 'вікно вже скинулось, нове почнеться з наступним запитом'
    : resetMs > 0 && Number.isFinite(resetMs)
      ? `скидання через ${untilText(resetMs)} (${timeOf(resetMs)}, ${dayLabel(tz.parts(resetMs).day)})`
      : ''
  const fc = f ? (f.willFill ? `За поточного темпу ліміт закінчиться близько ${timeOf(f.fullAt)}, ${dayLabel(tz.parts(f.fullAt).day)}, до скидання.` : 'За поточного темпу ліміту вистачить до скидання.') : ''
  const pctEl = isLeft
    ? el('span', { class: 'limit-pct' }, 'залишилось ', el('strong', {}, fmtLim(left)), ` · використано ${fmtLim(used)}`)
    : el('span', { class: 'limit-pct' }, 'використано ', el('strong', {}, fmtLim(used)), ` · залишилось ${fmtLim(left)}`)
  const meterChildren: HTMLElement[] = []
  if (barPct > 0) meterChildren.push(el('b', { style: `width:${barPct}%;background:${color}` }, barPct >= 10 ? fmtLim(barPct) : ''))
  meterChildren.push(el('span', { class: 'rest hatch' }))
  return el('div', { class: 'limit' },
    el('div', { class: 'row1' },
      el('div', { class: 'limit-title' }, el('b', {}, span ? `${title} · ${span}` : title), pctEl),
      when ? el('span', {}, when) : el('span', {})),
    el('div', { class: 'meter' }, ...meterChildren),
    el('p', { class: 'note', style: 'margin:8px 0 0' }, `${l.resetAt ? `Ліміт скинуто достроково близько ${timeOf(l.resetAt)}, ${dayLabel(tz.parts(l.resetAt).day)}. ` : ''}${fc ? fc + ' ' : ''}Виміряно: ${l.device}, ${agoText(Date.parse(l.ts))}.`))
}

export function renderLimits(): void {
  const d = need()
  const allRows: LimitRow[] = d.limits.filter(l => !state.device || l.device === state.device)
  const presentProviders = sortProviders([...new Set(allRows.map(l => l.provider || 'claude'))])
  const lp = limitProvider(d.limits)
  const others = [...new Set(d.limits.map(l => l.provider))].filter(p => p !== lp)

  if (!state.provider && presentProviders.length > 1) {
    $('limits-sub').textContent = 'Дані з останнього виміру по кожному агенту з підпискою'
    $('limits').replaceChildren(...presentProviders.map(p => {
      const pRows = allRows.filter(l => (l.provider || 'claude') === p)
      const latest = S.latestLimits(pRows)
      const kinds = sortKinds(Object.keys(latest))
      return el('div', { class: 'limit-group' },
        el('div', { class: 'limit-head' }, el('i', { style: `background:${providerColor(p)}` }), el('b', {}, providerLabel(p))),
        ...kinds.map(k => renderLimitRow(latest[k])))
    }))
  } else {
    const shownProvider = !state.provider && presentProviders.length === 1 ? presentProviders[0] : lp
    const pRows = allRows.filter(l => (l.provider || 'claude') === shownProvider)
    $('limits-sub').textContent = `${providerLabel(shownProvider)}: дані з останньої відповіді API на пристроях із підпискою` + (!state.provider && others.length ? `. Інші агенти (${others.map(providerLabel).join(', ')}): обери їх зверху` : '')
    const latest = S.latestLimits(pRows)
    const kinds = sortKinds(Object.keys(latest))
    if (!kinds.length) $('limits').replaceChildren(el('div', { class: 'empty' }, emptyLimitsText(shownProvider)))
    else $('limits').replaceChildren(...kinds.map(k => renderLimitRow(latest[k])))
  }

  $('limits-chart-sub').textContent = `${providerLabel(lp)}: найвищий відсоток за день` + (!state.provider && others.length ? ' (обери агента зверху для інших)' : '')
  $('efficiency-sub').textContent = !state.provider && others.length
    ? `${providerLabel(lp)}: скільки токенів і доларів API-вартості припадає на 1% тижневого ліміту`
    : 'Скільки токенів і доларів API-вартості припадає на 1% тижневого ліміту'

  const limits = d.limits.filter(l => l.provider === lp)
  const rows = limits.filter(l => !state.device || l.device === state.device)

  // history: highest reading per local day
  const byDay = new Map<string, Record<string, number>>()
  for (const l of rows) {
    const day = tz.parts(Date.parse(l.ts)).day
    const e = byDay.get(day) ?? {}
    e[l.kind] = Math.max(e[l.kind] ?? 0, l.percent)
    byDay.set(day, e)
  }
  const days = [...byDay.keys()].sort()
  const pctFmt = (v: number): string => v.toFixed(1) + '%'
  lineChart($('limits-chart'), {
    labels: days.map(dayLabel), height: 200, yMax: 100, yFmt: v => Math.round(v) + '%',
    series: [
      { label: '7 днів', color: COLORS.out, values: days.map(x => byDay.get(x)?.seven_day ?? 0), fmt: pctFmt },
      { label: '5 годин', color: COLORS.in, values: days.map(x => byDay.get(x)?.five_hour ?? 0), fmt: pctFmt },
    ],
    tipTitle: i => dayLong(days[i]),
  })

  // efficiency: what each past week cost per 1% of the limit (account-wide)
  // only devices that reported limits count: others (cloud credits, API key) do not draw on the subscription
  const subDevices = new Set(limits.map(l => l.device))
  // the last ten weeks of usage are fetched on their own, so this does not depend on the period shown
  const recent = tz.startOfDay(S.addDays(d.r.today, -70))
  void get<Bucket[]>('/buckets?' + q(recent, Date.now() + 3_600_000)).then(buckets => {
  const wins = S.efficiency(S.weeklyWindows(limits).filter(w => w.peak > 0).slice(-8), buckets.filter(b => b.provider === lp && subDevices.has(b.device)), store.prices)
  const maxTok = Math.max(1, ...wins.map(w => w.tokensPerPct ?? 0))
  $('efficiency').replaceChildren(...(wins.length ? wins.reverse().map(w => el('div', { class: 'hrow', style: 'grid-template-columns:minmax(90px,130px) 1fr auto;margin-bottom:12px;--c:var(--in)' },
    el('span', { class: 'name', title: w.reset ? 'Ліміт скинуто вручну до кінця тижня' : '' }, `${dayLabel(tz.parts(w.start + 3_600_000).day)} – ${dayLabel(tz.parts(w.end - 3_600_000).day)}${w.reset ? ' · скинуто' : ''}`),
    el('div', { class: 'track' }, el('b', { style: `width:${((w.tokensPerPct ?? 0) / maxTok) * 100}%` }), el('span', { class: 'hatch' })),
    el('span', { class: 'val', title: `Використано ${w.peak.toFixed(0)}% ліміту${w.peak >= 99.5 ? ' (вичерпано)' : ''} за цей період` }, `${fmt(w.tokensPerPct)} / 1% · ${fmtUsd(w.costPerPct ?? 0)}`))) : [el('div', { class: 'empty' }, 'З\'явиться, коли накопичаться виміри хоча б за один тиждень')]))
  }).catch(() => {})
}

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
    tipTitle: i => dayLong(days[i]), marker: otlpMarker(days, { unit: 'day' }),
  })
  $('cost-table').replaceChildren(el('table', {},
    el('thead', {}, el('tr', {}, el('th', { class: 'l' }, 'Модель'), ...['Вхідні', 'Вихідні', 'Кеш: читання', 'Кеш: запис', 'Вартість', 'Частка'].map(h => el('th', {}, h)))),
    el('tbody', {}, ...models.map(([m, t]) => el('tr', {}, el('td', { class: 'l' }, m), el('td', {}, fmt(t.input)), el('td', {}, fmt(t.output)), el('td', {}, fmt(t.cache_read)), el('td', {}, fmt(t.cache_creation)),
      el('td', {}, fmtUsd(t.cost)), el('td', {}, fmtPct(total.cost ? t.cost / total.cost : 0)))))))
  $('cost-note').textContent = `Це оцінка за цінами API, а не рахунок: підписка оплачується окремо. Запис у кеш рахується за ціною для 1 години. Ціни лежать у файлі prices.json (оновлено ${store.prices?.updated ?? '—'}).` +
    (agg.unpriced.length ? ` Без ціни, у вартість не входять: ${agg.unpriced.join(', ')}.` : '')
}
