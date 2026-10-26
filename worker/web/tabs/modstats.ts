// The "Робота з агентом" cards of the Insights tab: what the token-tracker mod measured (GET /api/admin/mod-stats): context fill, turn time and
// pauses, sessions, permission prompts, and tokens by project.
import { barChart } from '../charts/bar.ts'
import { lineChart } from '../charts/line.ts'
import { COLORS } from '../charts/base.ts'
import { PALETTE } from '../core/palette.ts'
import type { Period } from '../core/range.ts'
import { get, q } from '../core/store.ts'
import { $, el } from '../lib/dom.ts'
import { dayLabel, dayLong, fmt, fmtPct, fmtUsd } from '../lib/format.ts'

interface Stat { n: number; avg: number; p50: number; p90: number; max: number }
interface ModStats {
  available: boolean
  context: { turn: Stat; sessions: number; over90: number; hist: { lo: number; hi: number; n: number }[] }
  time: { wall: Stat; think: Stat; breaks: number; wallSum: number; thinkSum: number; idleMs: number; outcomes: { outcome: string; n: number }[] }
  sessions: { count: number; length: Stat; turns: Stat; reasons: { reason: string; n: number }[] }
  permissions: { asks: number; denied: number; waitMs: number; turnsWithAsks: number }
  daily: { day: string; turns: number; wall_p50: number; context_p50: number; asks: number }[]
  projectNotes: { note: string | null; n: number }[]
  projects: { project: string | null; sessions: number; turns: number; output: number | null; input: number | null; cache_read: number | null; cost_micros: number | null }[]
}

const dur = (v: number): string => (v >= 3_600_000 ? (v / 3_600_000).toFixed(1) + ' год' : v >= 60_000 ? Math.round(v / 60_000) + ' хв' : v >= 10_000 ? Math.round(v / 1000) + ' с' : (v / 1000).toFixed(1) + ' с')
const line = (box: HTMLElement, rows: [string, string][]): void =>
  box.replaceChildren(...rows.map(([b, t]) => el('div', { class: 'summary-row' }, el('b', {}, b), el('span', {}, t))))
const END: Record<string, string> = { prompt_input_exit: 'вихід', clear: '/clear', logout: 'вихід з акаунта', resume: 'перехід до іншої сесії', other: 'інше', open: 'ще відкрита або без кінця' }
const OUTCOME: Record<string, string> = { answer: 'відповідь', aborted: 'перервано', refusal: 'відмова', error: 'помилка' }

export async function renderModStats(r: Period): Promise<void> {
  let d: ModStats
  try { d = await get<ModStats>('/mod-stats?' + q(r.from, r.to)) } catch { $('mod-off').classList.remove('hide'); $('mod-body').classList.add('hide'); return }
  $('mod-off').classList.toggle('hide', d.available)
  $('mod-body').classList.toggle('hide', !d.available)
  if (!d.available) return
  const days = d.daily.map(x => dayLabel(x.day)), tip = (i: number) => `${dayLong(d.daily[i].day)} · ${d.daily[i].turns} ходів`

  const c = d.context
  line($('mod-context-sum'), [
    ['Хід', `медіана ${c.turn.p50.toFixed(0)}% · p90 ${c.turn.p90.toFixed(0)}% · максимум ${c.turn.max.toFixed(0)}%`],
    ['Сесії', `${fmt(c.sessions)} · дійшли до 90%+: ${fmt(c.over90)} (${fmtPct(c.sessions ? c.over90 / c.sessions : null)})`],
  ])
  barChart($('mod-context-hist'), { labels: c.hist.map(h => `${h.lo}–${h.hi}%`), series: [{ label: 'Сесій', color: COLORS.cache, values: c.hist.map(h => h.n), fmt: v => fmt(v) }], height: 160, yFmt: v => fmt(v), tipTitle: i => `найвище заповнення ${c.hist[i].lo}–${c.hist[i].hi}%` })

  const t = d.time
  const active = t.wallSum + t.thinkSum
  line($('mod-time-sum'), [
    ['Хід', `медіана ${dur(t.wall.p50)} · p90 ${dur(t.wall.p90)} · найдовший ${dur(t.wall.max)} · ходів ${fmt(t.wall.n)}`],
    ['Пауза', `медіана ${dur(t.think.p50)} · p90 ${dur(t.think.p90)} · перерв понад ${dur(t.idleMs)}: ${fmt(t.breaks)}`],
    ['Активний час', `${dur(active)}: агент ${fmtPct(active ? t.wallSum / active : null)}, ти ${fmtPct(active ? t.thinkSum / active : null)}`],
    ['Як закінчуються ходи', t.outcomes.map(o => `${OUTCOME[o.outcome] ?? o.outcome} ${fmt(o.n)}`).join(' · ') || '—'],
  ])
  lineChart($('mod-time-chart'), { labels: days, height: 170, series: [{ label: 'Медіана ходу', color: COLORS.in, values: d.daily.map(x => x.wall_p50 / 1000), fmt: v => v.toFixed(1) + ' с' }], yFmt: v => Math.round(v) + ' с', tipTitle: tip })

  const s = d.sessions
  line($('mod-sessions-sum'), [
    ['Сесій', `${fmt(s.count)} · ходів у сесії: медіана ${fmt(s.turns.p50)}, p90 ${fmt(s.turns.p90)}`],
    ['Тривалість', `медіана ${dur(s.length.p50)} · p90 ${dur(s.length.p90)} · найдовша ${dur(s.length.max)}`],
  ])
  const maxR = Math.max(1, ...s.reasons.map(x => x.n))
  $('mod-sessions-end').replaceChildren(...s.reasons.map((x, i) => el('div', { class: 'hrow', style: `--c:${PALETTE[i % PALETTE.length]};grid-template-columns:minmax(110px,230px) 1fr auto` },
    el('span', { class: 'name' }, END[x.reason] ?? x.reason), el('div', { class: 'track' }, el('b', { style: `width:${(x.n / maxR) * 100}%` })), el('span', { class: 'val' }, fmt(x.n)))))

  const p = d.permissions
  line($('mod-perm-sum'), [
    ['Запитів дозволу', `${fmt(p.asks)} у ${fmt(p.turnsWithAsks)} ходах · відмов ${fmt(p.denied)} (${fmtPct(p.asks ? p.denied / p.asks : null)})`],
    ['Очікування', `${dur(p.waitMs)} разом · у середньому ${dur(p.asks ? p.waitMs / p.asks : 0)} на запит (від запиту до кінця інструмента)`],
  ])
  barChart($('mod-perm-chart'), { labels: days, series: [{ label: 'Запитів дозволу', color: COLORS.out, values: d.daily.map(x => x.asks), fmt: v => fmt(v) }], height: 160, yFmt: v => fmt(v), tipTitle: tip })

  const rows = d.projects
  $('mod-projects').replaceChildren(rows.length
    ? el('table', {}, el('thead', {}, el('tr', {}, ...['Проєкт', 'Сесій', 'Ходів', 'Вихідні', 'Нові вхідні', 'З кешу', 'Вартість'].map((h, i) => el('th', { class: i ? '' : 'l' }, h)))),
      el('tbody', {}, ...rows.map(x => el('tr', {}, el('td', { class: 'l' }, x.project == null ? 'невідомо' : x.project.startsWith('h:') ? `анонімний ${x.project.slice(2, 8)}` : x.project),
        ...[fmt(x.sessions), fmt(x.turns), fmt(x.output), fmt(x.input), fmt(x.cache_read), x.cost_micros ? fmtUsd(x.cost_micros / 1e6) : '—'].map(v => el('td', {}, v))))))
    : el('div', { class: 'empty' }, 'Немає сесій із проєктом за цей період'))
  const NOTE: Record<string, string> = { off: 'на пристрої вимкнено', no_repo: 'невідомо (сесія не в git-репозиторії)', repo_failed: 'не вдалося прочитати репозиторій', config_failed: 'мод не отримав налаштування', no_target: 'мод не знайшов адресу сайту чи токен' }
  if (d.projectNotes.length) $('mod-projects').append(el('p', { class: 'note' }, 'Проєкт невідомий: ' + d.projectNotes.map(x => `${x.note ? NOTE[x.note] ?? x.note : 'старіша версія моду'} ${fmt(x.n)}`).join(' · ')))
}

interface CheckSide { input: number; output: number; cache_read: number; cache_creation: number; turns: number }
interface Check { available: boolean; sessions: { device: string; session_id: string; first_ts: string; mod: CheckSide | null; otlp: CheckSide | null }[] }

/** The otlp-check card: shown only while the diagnostics mod sends anything. */
export async function renderCheck(r: Period): Promise<void> {
  let d: Check
  try { d = await get<Check>('/check?' + q(r.from, r.to)) } catch { $('check-card').classList.add('hide'); return }
  $('check-card').classList.toggle('hide', !d.available)
  if (!d.available) return
  const both = d.sessions.filter(s => s.mod && s.otlp)
  const sum = (k: keyof CheckSide, side: 'mod' | 'otlp') => both.reduce((a, s) => a + (s[side]?.[k] ?? 0), 0)
  const diff = (a: number, b: number) => (b ? `${a >= b ? '+' : ''}${fmtPct((a - b) / b, 1)}` : a ? 'лише в моді' : '0')
  line($('check-sum'), [
    ['Сесій', `в обох ${fmt(both.length)} · лише в моді ${fmt(d.sessions.filter(s => !s.otlp).length)} · лише в OTLP ${fmt(d.sessions.filter(s => !s.mod).length)}`],
    ...(['output', 'input', 'cache_read', 'cache_creation'] as const).map((k): [string, string] => [
      { output: 'Вихідні', input: 'Вхідні', cache_read: 'З кешу', cache_creation: 'Запис у кеш' }[k],
      `мод ${fmt(sum(k, 'mod'))} · OTLP ${fmt(sum(k, 'otlp'))} · різниця ${diff(sum(k, 'mod'), sum(k, 'otlp'))}`]),
  ])
  const cell = (s: CheckSide | null, k: keyof CheckSide) => (s ? fmt(s[k]) : '—')
  $('check-table').replaceChildren(el('table', {},
    el('thead', {}, el('tr', {}, ...['Сесія', 'Пристрій', 'Ходів мод/OTLP', 'Вихідні мод', 'Вихідні OTLP', 'Різниця', 'З кешу мод', 'З кешу OTLP'].map((h, i) => el('th', { class: i ? '' : 'l' }, h)))),
    el('tbody', {}, ...d.sessions.slice(0, 40).map(s => el('tr', {},
      el('td', { class: 'l', title: s.session_id }, s.session_id.slice(0, 8)),
      ...[s.device, `${cell(s.mod, 'turns')}/${cell(s.otlp, 'turns')}`, cell(s.mod, 'output'), cell(s.otlp, 'output'),
        s.mod && s.otlp ? diff(s.mod.output, s.otlp.output) : s.mod ? 'лише в моді' : 'лише в OTLP', cell(s.mod, 'cache_read'), cell(s.otlp, 'cache_read')].map(v => el('td', {}, v)))))))
}
