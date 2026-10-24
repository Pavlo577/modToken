// Sessions and records tab.
import * as S from '../lib/stats.ts'
import { PALETTE } from '../core/palette.ts'
import { state } from '../core/state.ts'
import { need, store } from '../core/store.ts'
import { pad, tz } from '../core/time.ts'
import { $, el } from '../lib/dom.ts'
import { dayLabel, dur, fmt, fmtPct, fmtUsd } from '../lib/format.ts'

// ---------- sessions
export function renderSessions(agg: S.Aggregate): void {
  const d = need()
  const sessions = d.sessions.filter(s => !state.device || s.device === state.device)
  const rec = S.records(agg.days, sessions, tz)
  const tiles: [string, string, string][] = [
    ['Найкращий день', rec.bestDay ? dayLabel(rec.bestDay.day) : '—', rec.bestDay ? `${fmt(rec.bestDay.output)} вихідних, ${rec.bestDay.turns} ходів` : ''],
    ['Серія днів поспіль', String(rec.streak), 'з активністю, до сьогодні'],
    ['Найдовша сесія', rec.longest ? dur(rec.longest.ms) : '—', rec.longest ? `${rec.longest.device}, ${dayLabel(tz.parts(Date.parse(rec.longest.first_ts)).day)}` : ''],
    ['Найбільша сесія', rec.biggest ? fmt(rec.biggest.output) : '—', rec.biggest ? `вихідних, ${rec.biggest.turns} ходів` : ''],
    ['Найбільше ходів за день', rec.mostTurns ? String(rec.mostTurns.turns) : '—', rec.mostTurns ? dayLabel(rec.mostTurns.day) : ''],
    ['Активних днів', String(rec.activeDays), `з ${d.r.len} у періоді`],
  ]
  $('records').replaceChildren(...tiles.map(([l, v, s], i) => el('div', { class: 'kpi rec', style: `--c:${PALETTE[i]}` }, el('div', { class: 'l' }, l), el('div', { class: 'v' }, v), el('div', { class: 's' }, s))))
  const top = sessions.slice(0, 15)
  $('sessions').replaceChildren(top.length ? el('table', {},
    el('thead', {}, el('tr', {}, el('th', { class: 'l' }, 'Початок'), el('th', { class: 'l' }, 'Пристрій'), ...['Тривалість', 'Ходів', 'Вихідні', 'Вхідні (нові)', 'Кеш-хіт', '≈ Вартість'].map(h => el('th', {}, h)))),
    el('tbody', {}, ...top.map(s => {
      const p = tz.parts(Date.parse(s.first_ts))
      return el('tr', {}, el('td', { class: 'l' }, `${dayLabel(p.day)}, ${pad(p.h)}:${pad(p.min)}`), el('td', { class: 'l' }, s.device),
        el('td', {}, dur(Date.parse(s.last_ts) - Date.parse(s.first_ts))), el('td', {}, String(s.turns)), el('td', {}, fmt(s.output)), el('td', {}, fmt(S.freshInput(s))),
        el('td', {}, fmtPct(S.cacheHit(s))), el('td', {}, fmtUsd(S.costOf(s, s.model, store.prices) ?? 0)))
    }))) : el('div', { class: 'empty' }, 'Немає сесій за цей період'))
}
