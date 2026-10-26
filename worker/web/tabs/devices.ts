// The Devices tab: add a device (its token and the OpenTelemetry settings to paste), the device list, revoke.
import { api } from '../lib/api.ts'
import { $, el } from '../lib/dom.ts'
import { providerColor, providerLabel } from '../core/palette.ts'
import { fillHistoryDevices, initHistory } from './history.ts'
import { cloudEnv, cloudScript, pcInstallPs, pcInstallSh, settingsJson, shellEnv } from '../lib/setup.ts'
import type { DeviceRow } from '../lib/types.ts'

const PROJECT: Record<DeviceRow['project_mode'], string> = { off: 'Проєкт: не надсилати', name: 'Проєкт: назва', hash: 'Проєкт: хеш' }

/** What the mod may send about the session's repository; turning it down also forgets what was stored. */
function projectSelect(d: DeviceRow): HTMLElement {
  const sel = el('select', { 'aria-label': 'Проєкт у статистиці для ' + d.name, title: 'Що мод token-tracker надсилає про репозиторій сесії' },
    ...(Object.keys(PROJECT) as DeviceRow['project_mode'][]).map(k => el('option', { value: k, ...(k === d.project_mode ? { selected: '' } : {}) }, PROJECT[k]))) as HTMLSelectElement
  sel.onchange = async () => {
    const mode = sel.value as DeviceRow['project_mode']
    if (mode !== 'name' && d.project_mode !== mode && !confirm(mode === 'off' ? 'Не надсилати проєкт? Збережені проєкти цього пристрою буде забуто.' : 'Лише хеш? Збережені назви проєктів цього пристрою буде забуто.')) { sel.value = d.project_mode; return }
    try { await api('/devices/' + d.id, { method: 'PATCH', body: JSON.stringify({ project_mode: mode }) }); d.project_mode = mode } catch (err) { sel.value = d.project_mode; alert('Не вдалося змінити: ' + (err as Error).message) }
  }
  return sel
}

function deviceRow(d: DeviceRow): HTMLElement {
  const added = d.created_at.slice(0, 10)
  const seen = d.last_seen
  return el('div', { class: 'dev' },
    el('div', {}, el('b', {}, d.name), d.revoked ? el('span', { class: 'tag' }, 'відкликано') : '',
      ...[...d.providers].sort().map(p => el('span', { class: 'ptag', style: `border-color:${providerColor(p)};color:${providerColor(p)}`, title: 'Агент надсилав дані з цього пристрою' }, providerLabel(p))),
      el('small', {}, 'Додано ' + added + (seen ? ' · остання активність ' + new Date(seen).toLocaleString('uk-UA', { dateStyle: 'medium', timeStyle: 'short' }) : ' · ще не надсилав дані'))),
    d.revoked ? '' : el('div', { class: 'dev-actions' },
      projectSelect(d),
      el('button', { class: 'danger', onclick: async () => {
        if (!confirm(`Відкликати «${d.name}»? Він перестане надсилати дані.`)) return
        await api('/devices/' + d.id, { method: 'DELETE' })
        void loadDevices()
      } }, 'Відкликати')))
}

export async function loadDevices(): Promise<DeviceRow[]> {
  const list = await api<DeviceRow[]>('/devices')
  $('dev-list').replaceChildren(...(list.length ? list.map(deviceRow) : [el('div', { class: 'empty' }, 'Пристроїв ще немає')]))
  fillHistoryDevices(list)
  return list
}

export function initDevices(): void {
  initHistory()
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
  $('copy-pc-sh').onclick = copy('setup-pc-sh', $('copy-pc-sh'))
  $('copy-pc-ps').onclick = copy('setup-pc-ps', $('copy-pc-ps'))
  $('copy-cloud').onclick = copy('setup-cloud', $('copy-cloud'))
  $('copy-cloud-env').onclick = copy('setup-cloud-env', $('copy-cloud-env'))

  $('new-device').addEventListener('submit', async e => {
    e.preventDefault()
    const name = $<HTMLInputElement>('dev-name')
    try {
      const { token } = await api<{ token: string }>('/devices', { method: 'POST', body: JSON.stringify({ name: name.value, project_mode: $<HTMLSelectElement>('dev-project').value }) })
      $('setup-json').textContent = settingsJson(location.origin, token)
      $('setup-env').textContent = shellEnv(location.origin, token)
      $('setup-pc-sh').textContent = pcInstallSh(location.origin, token)
      $('setup-pc-ps').textContent = pcInstallPs(location.origin, token)
      $('setup-cloud').textContent = cloudScript()
      $('setup-cloud-env').textContent = cloudEnv(location.origin, token)
      $('setup-host').textContent = location.hostname
      $('setup-box').classList.remove('hide')
      name.value = ''
      void loadDevices()
    } catch (err) { alert('Не вдалося створити пристрій: ' + (err as Error).message) }
  })
}
