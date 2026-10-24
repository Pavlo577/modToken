// The controls bar and the tab strip: reflect the state in the page and react to clicks.
import * as S from '../lib/stats.ts'
import { actions } from '../core/actions.ts'
import { load } from '../core/load.ts'
import { currentRange } from '../core/range.ts'
import { IO_NEXT, asTab, persist, state } from '../core/state.ts'
import type { IoMode, Tab, View } from '../core/state.ts'
import { aggregate } from '../core/store.ts'
import { lastOfMonth, tz } from '../core/time.ts'
import { $ } from '../lib/dom.ts'
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
  $('scale-mode').classList.toggle('hide', !(state.metric === 'all' && state.view !== 'cal' && !state.ioHidden))
  press($('scale-mode'), 's', state.scale)
  const cache = $<HTMLButtonElement>('cache-on'), off = state.view === 'cal'
  cache.setAttribute('aria-pressed', String(state.metric === 'all' && !off))
  cache.setAttribute('aria-disabled', String(off))
  cache.dataset.tip = off ? 'У режимі «Календар» кеш не відображається' : state.metric === 'all' ? 'Кеш показується. Натисни, щоб сховати' : 'Показати кеш'
  $('custom').classList.toggle('hide', state.range !== 'custom')
  const paged = state.range === 'week' || state.range === 'month' || state.range === 'year'
  $('pager').classList.toggle('hide', !paged)
  if (paged) {
    const r = currentRange()
    $('pg-label').textContent = r.label
    $<HTMLButtonElement>('pg-next').disabled = r.toDay >= r.today
  }
  const today = tz.today()
  $<HTMLInputElement>('from').value = state.from || S.addDays(today, -29)
  $<HTMLInputElement>('to').value = state.to || today
}

/** Moves the shown week / month / year back or forward by one. */
const step = (dir: -1 | 1): void => {
  const at = state.anchor || tz.today()
  if (state.range === 'week') state.anchor = S.addDays(at, 7 * dir)
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
  $('io-off').onclick = () => { state.ioHidden = !state.ioHidden; persist(); syncControls(); render() }
  // hidden: the first press only shows them again (in the mode they had); then the presses cycle the modes
  $('io-mode').onclick = () => { if (state.ioHidden) state.ioHidden = false; else state.io = IO_NEXT[state.io]; persist(); syncControls(); render() }
  $('cache-on').onclick = () => {
    if (state.view === 'cal') return
    state.metric = state.metric === 'all' ? 'io' : 'all'; persist(); syncControls(); render()
  }
  actions.render = render
  actions.syncControls = syncControls
  actions.setDevices = names => deviceMenu.set([{ value: '', label: 'Усі пристрої' }, ...names.map(n => ({ value: n, label: n }))], state.device)
}
