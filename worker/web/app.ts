// Dashboard entry: wires the modules together and starts the first load.
// Layout: lib/ pure helpers, core/ state and data, charts/ SVG charts, ui/ controls, tabs/ one file per tab.
import { load } from './core/load.ts'
import { persist, state } from './core/state.ts'
import { store } from './core/store.ts'
import { api, signOut } from './lib/api.ts'
import { $ } from './lib/dom.ts'
import type { Prices } from './lib/types.ts'
import { startLive } from './core/live.ts'
import { initDevices } from './tabs/devices.ts'
import { initControls, setTab, syncControls } from './ui/controls.ts'
import { render } from './ui/render.ts'

// the account menu under the avatar: the e-mail, Devices and sign-out
const meMenu = $('me-menu'), av = $('av')
const openMe = (open: boolean): void => { meMenu.classList.toggle('hide', !open); av.setAttribute('aria-expanded', String(open)) }
av.addEventListener('click', e => { e.stopPropagation(); openMe(meMenu.classList.contains('hide')) })
document.addEventListener('click', e => { if (!$('me').contains(e.target as Node)) openMe(false) })
document.addEventListener('keydown', e => { if (e.key === 'Escape') openMe(false) })
meMenu.querySelector<HTMLElement>('[data-tab="devices"]')!.addEventListener('click', () => { openMe(false); setTab('devices') })
$('budget-set').addEventListener('click', () => {
  openMe(false)
  const v = prompt('Денний поріг у доларах (оцінка за API-цінами, усі агенти й пристрої). Порожньо або 0 вимикає попередження.', state.budget ? String(state.budget) : '')
  if (v === null) return
  const n = Number(v.replace(',', '.').replace(/[$\s]/g, ''))
  if (!Number.isFinite(n) || n < 0) { alert('Потрібне число, наприклад 20'); return }
  state.budget = n; persist(); render()
})
$('logout').addEventListener('click', () => { openMe(false); if (confirm('Вийти? Сеанс Cloudflare Access завершиться, наступний вхід видасть новий токен.')) signOut() })
api<{ email: string }>('/me').then(m => { $('who').textContent = m.email; $('me-email').textContent = m.email; av.textContent = m.email.slice(0, 2).toUpperCase(); av.title = m.email })
  .catch(() => { $('who').textContent = 'не вдалося визначити користувача' })

initDevices()

initControls()

syncControls()

setTab(state.tab)

fetch('prices.json').then(r => r.json() as Promise<Prices>).then(p => { store.prices = p }).catch(() => {}).finally(() => void load().then(startLive))
