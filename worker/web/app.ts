// Dashboard entry: wires the modules together and starts the first load.
// Layout: lib/ pure helpers, core/ state and data, charts/ SVG charts, ui/ controls, tabs/ one file per tab.
import { load } from './core/load.ts'
import { state } from './core/state.ts'
import { store } from './core/store.ts'
import { api, signOut } from './lib/api.ts'
import { $ } from './lib/dom.ts'
import type { Prices } from './lib/types.ts'
import { startLive } from './core/live.ts'
import { initDevices } from './tabs/devices.ts'
import { initOverview } from './tabs/overview.ts'
import { initControls, setTab, syncControls } from './ui/controls.ts'

$('logout').addEventListener('click', () => { if (confirm('Вийти? Сеанс Cloudflare Access завершиться, наступний вхід видасть новий токен.')) signOut() })
api<{ email: string }>('/me').then(m => { $('who').textContent = m.email; $('av').textContent = m.email.slice(0, 2).toUpperCase() }).catch(() => { $('who').textContent = 'не вдалося визначити користувача' })

initDevices()

initControls()

initOverview()

syncControls()

setTab(state.tab)

fetch('prices.json').then(r => r.json() as Promise<Prices>).then(p => { store.prices = p }).catch(() => {}).finally(() => void load().then(startLive))
