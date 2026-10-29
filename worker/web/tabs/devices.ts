// The Devices tab: add a device (its token and the OpenTelemetry settings to paste), the device list, a new token to set a device up again, revoke.
import { api } from '../lib/api.ts'
import { $, el } from '../lib/dom.ts'
import { providerColor, providerLabel } from '../core/palette.ts'
import { fillHistoryDevices, initHistory } from './history.ts'
import { setupPlan, type Agent, type Place, type Step } from '../lib/setup.ts'
import type { DeviceRow } from '../lib/types.ts'

/** Shows the setup steps for a token (a new device's, or a device's new one); set by initDevices. */
let showSetup: (token: string, device: string) => void = () => {}

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
    el('div', { class: 'dev-actions' }, ...(d.revoked ? [] : [
      projectSelect(d),
      el('button', { title: 'Показати команди встановлення ще раз: пристрій отримає новий токен', onclick: async () => {
        if (!confirm(`Новий токен для «${d.name}»? Пристрій і його дані лишаються, але старий токен перестане діяти: на цьому пристрої треба буде ще раз виконати команду встановлення (для кожного агента, що там працює).`)) return
        try {
          const { token } = await api<{ token: string }>('/devices/' + d.id + '/token', { method: 'POST' })
          showSetup(token, d.name)
        } catch (err) { alert('Не вдалося видати токен: ' + (err as Error).message) }
      } }, 'Новий токен'),
      el('button', { class: 'danger', title: 'Токен перестане діяти; дані пристрою лишаються в статистиці', onclick: async () => {
        if (!confirm(`Відкликати «${d.name}»? Він перестане надсилати дані; те, що вже надіслав, лишиться в статистиці.`)) return
        await api('/devices/' + d.id, { method: 'DELETE' })
        void loadDevices()
      } }, 'Відкликати')]),
      deleteButton(d)))
}

/** Deletes the device with everything it sent: its numbers leave the statistics. */
const deleteButton = (d: DeviceRow): HTMLElement => el('button', { class: 'danger', title: 'Видалити пристрій разом з усіма його даними', onclick: async () => {
  if (!confirm(`Видалити «${d.name}» разом з усіма його даними (токени, ліміти, сесії)? Статистика за минулі дні зменшиться. Скасувати це не можна.`)) return
  try {
    await api('/devices/' + d.id + '?purge=1', { method: 'DELETE' })
    void loadDevices()
  } catch (err) { alert('Не вдалося видалити: ' + (err as Error).message) }
} }, 'Видалити')

export async function loadDevices(): Promise<DeviceRow[]> {
  const list = await api<DeviceRow[]>('/devices')
  $('dev-list').replaceChildren(...(list.length ? list.map(deviceRow) : [el('div', { class: 'empty' }, 'Пристроїв ще немає')]))
  fillHistoryDevices(list)
  return list
}

/** Step text with `code` in backticks: plain text nodes and <code>, never HTML. */
const withCode = (text: string): (string | HTMLElement)[] => text.split('`').map((part, i) => (i % 2 ? el('code', {}, part) : part))

async function copyText(text: string, btn: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    const t = btn.textContent
    btn.textContent = 'Скопійовано'
    setTimeout(() => (btn.textContent = t), 1500)
  } catch { alert('Не вдалося скопіювати, виділи текст вручну.') }
}

const stepNodes = (steps: Step[], numbered: boolean): HTMLElement[] => steps.flatMap((st, i) => [
  el('p', { class: 'sub', style: 'margin:16px 0 6px' }, numbered && steps.length > 1 ? el('b', {}, `${i + 1}. `) : '', ...withCode(st.text)),
  ...(st.code !== undefined ? [el('pre', { class: 'snip' }, st.code), el('button', { type: 'button', onclick: (e: Event) => void copyText(st.code ?? '', e.currentTarget as HTMLElement) }, 'Копіювати')] : []),
])

/** A segmented choice: the pressed button's data-v, and a callback when it changes. */
function choice<T extends string>(id: string, onChange: (v: T) => void): () => T {
  const box = $(id)
  const buttons = [...box.querySelectorAll<HTMLButtonElement>('button')]
  for (const b of buttons) b.addEventListener('click', () => {
    for (const x of buttons) x.setAttribute('aria-pressed', String(x === b))
    onChange(b.dataset.v as T)
  })
  return () => (buttons.find(b => b.getAttribute('aria-pressed') === 'true')?.dataset.v ?? buttons[0].dataset.v) as T
}

export function initDevices(): void {
  initHistory()
  let token = '' // the token being set up: shown once, kept only while the page is open so the choice can still change
  const render = (): void => {
    if (!token) return
    const plan = setupPlan(agent(), place(), location.origin, token)
    $('setup-steps').replaceChildren(...stepNodes(plan.steps, true))
    $('setup-manual').replaceChildren(...stepNodes(plan.manual, false))
  }
  const agent = choice<Agent>('setup-agent', render)
  const place = choice<Place>('setup-place', render)
  $('setup-manual-btn').addEventListener('click', () => {
    const box = $('setup-manual')
    box.classList.toggle('hide')
    $('setup-manual-btn').textContent = box.classList.contains('hide') ? 'Встановити вручну' : 'Сховати ручне встановлення'
  })

  showSetup = (t, device) => {
    token = t
    render()
    $('setup-for').textContent = `Налаштування для «${device}»: обери агента й місце вгорі, команда вже з токеном цього пристрою.`
    $('setup-manual').classList.add('hide')
    $('setup-manual-btn').textContent = 'Встановити вручну'
    $('setup-box').classList.remove('hide')
    $('setup-pick').scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  $('new-device').addEventListener('submit', async e => {
    e.preventDefault()
    const name = $<HTMLInputElement>('dev-name')
    try {
      const r = await api<{ token: string }>('/devices', { method: 'POST', body: JSON.stringify({ name: name.value, project_mode: $<HTMLSelectElement>('dev-project').value }) })
      showSetup(r.token, name.value.trim())
      name.value = ''
      void loadDevices()
    } catch (err) { alert('Не вдалося створити пристрій: ' + (err as Error).message) }
  })
}
