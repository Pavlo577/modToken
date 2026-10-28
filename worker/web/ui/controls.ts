// The controls bar and the tab strip: reflect the state in the page and react to clicks.
import * as S from '../lib/stats.ts'
import { actions } from '../core/actions.ts'
import { firstDay } from '../core/bounds.ts'
import { providerLabel } from '../core/palette.ts'
import { load } from '../core/load.ts'
import { currentRange } from '../core/range.ts'
import { IO_NEXT, asTab, persist, state } from '../core/state.ts'
import type { IoMode, Tab, View } from '../core/state.ts'
import { aggregate, compareAvailable, store } from '../core/store.ts'
import { lastOfMonth, tz } from '../core/time.ts'
import { effectiveStep, stepChoices, stepLabel, stepRange } from '../lib/steps.ts'
import { $, el } from '../lib/dom.ts'
import { renderActivity } from '../tabs/activity.ts'
import { loadDevices } from '../tabs/devices.ts'
import { dropdown } from './dropdown.ts'
import { clicked, press } from './layout.ts'
import { render } from './render.ts'

export function setTab(tab: Tab): void {
  state.tab = tab
  persist()
  if (location.hash.slice(1) !== tab) history.replaceState(null, '', '#' + tab)
  press($('nav'), 'tab', tab)
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('hide', s.id !== 'tab-' + tab))
  $('controls').classList.toggle('hide', tab === 'devices')
  // the date pager lives in the activity card on Analytics and in the controls bar elsewhere
  // (and the time zone chip: in the card's corner on Analytics, at the end of the controls elsewhere)
  const pager = $('pager')
  if (tab === 'analytics') { $('act-pager').append(pager, $('custom')); $('act-tz').append($('tzchip')) }
  else { $('range').after(pager); $('act-mode').after($('custom')); $('controls').append($('tzchip')); $('act-mode').classList.add('hide') }
  if (tab === 'devices') void loadDevices().catch(() => {})
  else actions.render()
}

const IO_ICON: Record<IoMode, string> = {
  // both: the two arrows in their series colours (output up, input down)
  both: '<path style="stroke:var(--out)" d="M8 20V5M8 5l-4 4M8 5l4 4"/><path style="stroke:var(--in)" d="M16 4v15M16 19l-4-4M16 19l4-4"/>',
  in: '<path d="M12 4v15M12 19l-5-5M12 19l5-5"/>',
  out: '<path d="M12 20V5M12 5l-5 5M12 5l5 5"/>',
}

export function syncControls(): void {
  press($('range'), 'r', state.range)
  press($('view'), 'v', state.view)
  const io = $('io-mode'), hide = $('io-off')
  hide.setAttribute('aria-pressed', String(state.ioHidden))
  hide.dataset.tip = state.ioHidden ? 'Вхідні та вихідні сховані. Натисни, щоб показати' : 'Сховати вхідні та вихідні (залишити лише кеш)'
  io.classList.toggle('dim', state.ioHidden)
  io.dataset.mode = state.io
  $('io-icon').innerHTML = IO_ICON[state.io]
  const ioName: Record<IoMode, string> = { both: 'вхідні та вихідні токени', in: 'лише вхідні токени', out: 'лише вихідні токени' }
  const ioNext: Record<IoMode, string> = { both: 'лише вхідні', in: 'лише вихідні', out: 'вхідні та вихідні' }
  io.dataset.tip = state.ioHidden ? 'Вхідні та вихідні сховані. Натисни, щоб показати' : `Показуються ${ioName[state.io]}. Натисни, щоб ${ioNext[state.io]}`
  // the scale choice matters only when the cache shares the chart with input/output
  $('scale-mode').classList.toggle('hide', !(state.metric === 'all' && state.view !== 'cal' && !state.ioHidden && !(state.compare && compareAvailable())))
  press($('scale-mode'), 's', state.scale)
  const cache = $<HTMLButtonElement>('cache-on'), comparing = state.compare && compareAvailable(), off = state.view === 'cal' || comparing
  cache.setAttribute('aria-pressed', String(state.metric === 'all' && !off))
  cache.setAttribute('aria-disabled', String(off))
  cache.dataset.tip = comparing ? 'У режимі порівняння кеш не відображається' : off ? 'У режимі «Календар» кеш не відображається' : state.metric === 'all' ? 'Кеш показується. Натисни, щоб сховати' : 'Показати кеш'
  // comparison: one series per agent; needs more than one agent in the data, all of them selected, and a line / bar chart
  const cmp = $<HTMLButtonElement>('compare'), cmpOff = !compareAvailable()
  cmp.setAttribute('aria-pressed', String(state.compare && !cmpOff))
  cmp.setAttribute('aria-disabled', String(cmpOff))
  cmp.dataset.tip = store.providers.length < 2 ? 'Порівняння з\'явиться, коли буде дані від кількох агентів' : state.view === 'cal' ? 'У режимі «Календар» порівняння немає' : state.provider ? 'Вибери «Усі агенти», щоб порівняти їх' : state.compare ? 'Порівняння ввімкнено: кожен агент своїм кольором. Натисни, щоб вимкнути' : 'Порівняти агентів: кожен своїм кольором на одній шкалі'
  // the main chart's time step: for a day, a week, a month and an interval of your own (not a year), and not in the calendar view
  const sr = stepRange(state.range), stepBox = $('step')
  stepBox.classList.toggle('hide', !sr || state.view === 'cal')
  if (sr) {
    const len = currentRange().len, now = effectiveStep(sr, state.steps[sr], len)
    stepBox.replaceChildren(...stepChoices(sr, len).map(m => el('button', { 'data-m': String(m), 'aria-pressed': String(now === m) }, stepLabel(m))))
  }
  $('custom').classList.toggle('hide', state.range !== 'custom')
  const paged = state.range === 'day' || state.range === 'week' || state.range === 'month' || state.range === 'year'
  $('pager').classList.toggle('hide', !paged)
  if (paged) {
    const r = currentRange()
    $('pg-label').textContent = r.label
    $<HTMLButtonElement>('pg-next').disabled = r.toDay >= r.today
    $<HTMLButtonElement>('pg-prev').disabled = r.fromDay <= firstDay() // nothing older than the first turn
    $('pg-reset').classList.toggle('hide', !(state.range === 'day' && state.anchor && state.anchor < r.today)) // only while another day than today is shown
  }
  const today = tz.today()
  for (const id of ['from', 'to']) { const i = $<HTMLInputElement>(id); i.min = firstDay(); i.max = today }
  $<HTMLInputElement>('from').value = state.from || S.addDays(today, -29)
  $<HTMLInputElement>('to').value = state.to || today
}

/** Moves the shown week / month / year back or forward by one. */
const step = (dir: -1 | 1): void => {
  if (dir < 0 && currentRange().fromDay <= firstDay()) return
  const at = state.anchor || tz.today()
  if (state.range === 'day') state.anchor = S.addDays(at, dir)
  else if (state.range === 'week') state.anchor = S.addDays(at, 7 * dir)
  else if (state.range === 'month') state.anchor = dir < 0 ? S.addDays(at.slice(0, 7) + '-01', -1) : S.addDays(lastOfMonth(at.slice(0, 7)), 1)
  else state.anchor = `${+at.slice(0, 4) + dir}-${at.slice(5)}`
  if (state.anchor >= tz.today()) state.anchor = ''
  syncControls(); void load()
}

/** Connects every control to the state; call once. */
export function initControls(): void {
  $('nav').addEventListener('click', e => { const b = clicked(e); if (b) setTab(b.dataset.tab as Tab) })
  window.addEventListener('hashchange', () => { const t = asTab(location.hash.slice(1)); if (t && t !== state.tab) setTab(t) })
  $('range').addEventListener('click', e => {
    const b = clicked(e); if (!b) return
    state.range = b.dataset.r ?? 'month'; state.anchor = ''; persist(); syncControls(); void load()
  })
  $('step').addEventListener('click', e => {
    const b = clicked(e), sr = stepRange(state.range)
    if (!b || !sr) return
    state.steps[sr] = Number(b.dataset.m); persist(); syncControls(); render()
  })
  $('pg-reset').onclick = () => { state.anchor = ''; syncControls(); void load() }
  $('pg-prev').onclick = () => step(-1)
  $('pg-next').onclick = () => step(1)
  $('dev-mode').addEventListener('click', e => { const b = clicked(e); if (!b) return; state.topDevice = b.dataset.t === 'top'; persist(); press($('dev-mode'), 't', b.dataset.t ?? ''); renderActivity(aggregate()) })
  $('act-mode').addEventListener('click', e => { const b = clicked(e); if (!b) return; state.actMode = b.dataset.m as 'min' | 'detail'; persist(); renderActivity(aggregate()) })
  const dateChanged = (): void => { state.from = $<HTMLInputElement>('from').value; state.to = $<HTMLInputElement>('to').value; persist(); void load() }
  $('from').onchange = dateChanged
  $('to').onchange = dateChanged
  const deviceMenu = dropdown($('device'), v => { state.device = v; persist(); render() })
  $('view').addEventListener('click', e => { const b = clicked(e); if (!b) return; state.view = b.dataset.v as View; persist(); syncControls(); render() })
  $('scale-mode').addEventListener('click', e => { const b = clicked(e); if (!b) return; state.scale = b.dataset.s === 'linear' ? 'linear' : 'log'; persist(); syncControls(); render() })
  $('compare').onclick = () => { if (!compareAvailable()) return; state.compare = !state.compare; persist(); syncControls(); render() }
  $('io-off').onclick = () => { state.ioHidden = !state.ioHidden; persist(); syncControls(); render() }
  // hidden: the first press only shows them again (in the mode they had); then the presses cycle the modes
  $('io-mode').onclick = () => { if (state.ioHidden) state.ioHidden = false; else state.io = IO_NEXT[state.io]; persist(); syncControls(); render() }
  $('cache-on').onclick = () => {
    if (state.view === 'cal' || (state.compare && compareAvailable())) return
    state.metric = state.metric === 'all' ? 'io' : 'all'; persist(); syncControls(); render()
  }
  // which agent to show: only when the data comes from more than one
  const providerBox = $('provider')
  providerBox.addEventListener('click', e => { const b = clicked(e); if (!b) return; state.provider = b.dataset.p ?? ''; persist(); press(providerBox, 'p', state.provider); syncControls(); render() })
  actions.setProviders = names => {
    providerBox.classList.toggle('hide', names.length < 2)
    providerBox.replaceChildren(...['', ...names].map(n => el('button', { 'data-p': n, 'aria-pressed': String(n === state.provider) }, n ? providerLabel(n) : 'Усі агенти')))
  }
  actions.render = render
  actions.syncControls = syncControls
  actions.setDevices = names => deviceMenu.set([{ value: '', label: 'Усі пристрої' }, ...names.map(n => ({ value: n, label: n }))], state.device)
}
