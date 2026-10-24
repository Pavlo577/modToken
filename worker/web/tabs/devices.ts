// The Devices tab: add a device (its token and the OpenTelemetry settings to paste), the device list, revoke.
import { api } from '../lib/api.ts'
import { $, el } from '../lib/dom.ts'
import { providerColor, providerLabel } from '../core/palette.ts'
import { settingsJson, shellEnv } from '../lib/setup.ts'
import type { DeviceRow } from '../lib/types.ts'

function deviceRow(d: DeviceRow): HTMLElement {
  const added = d.created_at.slice(0, 10)
  const seen = d.last_seen
  return el('div', { class: 'dev' },
    el('div', {}, el('b', {}, d.name), d.revoked ? el('span', { class: 'tag' }, 'відкликано') : '',
      ...[...d.providers].sort().map(p => el('span', { class: 'ptag', style: `border-color:${providerColor(p)};color:${providerColor(p)}`, title: 'Агент надсилав дані з цього пристрою' }, providerLabel(p))),
      el('small', {}, 'Додано ' + added + (seen ? ' · остання активність ' + new Date(seen).toLocaleString('uk-UA', { dateStyle: 'medium', timeStyle: 'short' }) : ' · ще не надсилав дані'))),
    d.revoked ? '' : el('div', { class: 'dev-actions' },
      el('button', { class: 'danger', onclick: async () => {
        if (!confirm(`Відкликати «${d.name}»? Він перестане надсилати дані.`)) return
        await api('/devices/' + d.id, { method: 'DELETE' })
        void loadDevices()
      } }, 'Відкликати')))
}

export async function loadDevices(): Promise<DeviceRow[]> {
  const list = await api<DeviceRow[]>('/devices')
  $('dev-list').replaceChildren(...(list.length ? list.map(deviceRow) : [el('div', { class: 'empty' }, 'Пристроїв ще немає')]))
  return list
}

export function initDevices(): void {
  const copy = (id: string, btn: HTMLElement) => async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText($(id).textContent ?? '')
      const t = btn.textContent
      btn.textContent = 'Скопійовано'
      setTimeout(() => (btn.textContent = t), 1500)
    } catch { alert('Не вдалося скопіювати, виділи текст вручну.') }
  }
  $('copy-json').onclick = copy('setup-json', $('copy-json'))
  $('copy-env').onclick = copy('setup-env', $('copy-env'))

  $('new-device').addEventListener('submit', async e => {
    e.preventDefault()
    const name = $<HTMLInputElement>('dev-name')
    try {
      const { token } = await api<{ token: string }>('/devices', { method: 'POST', body: JSON.stringify({ name: name.value }) })
      $('setup-json').textContent = settingsJson(location.origin, token)
      $('setup-env').textContent = shellEnv(location.origin, token)
      $('setup-host').textContent = location.hostname
      $('setup-box').classList.remove('hide')
      name.value = ''
      void loadDevices()
    } catch (err) { alert('Не вдалося створити пристрій: ' + (err as Error).message) }
  })
}
