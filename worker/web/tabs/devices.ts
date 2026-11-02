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

/** One entry of the plugins' own log (GET /api/admin/plugin-log): a kind, counts, an error's type and stage, the plugin's version. */
interface PluginEntry { device_id: string; ts: string; kind: string; service: string; n?: number; total?: number; error?: string; stage?: string; version?: string }

const PLUGIN_NAME: Record<string, string> = { 'codex-plugin': 'Плагін Codex', 'claude-mod': 'Мод Claude' }
const STAGE: Record<string, string> = { limits: 'ліміти', history: 'імпорт історії', import: 'імпорт історії' }

const ago = (ts: string): string => {
  const m = Math.round((Date.now() - Date.parse(ts)) / 60_000)
  return m < 2 ? 'щойно' : m < 60 ? `${m} хв тому` : m < 1440 ? `${Math.round(m / 60)} год тому` : `${Math.round(m / 1440)} дн тому`
}

/** What an entry says, in words. */
function entryText(e: PluginEntry): string {
  switch (e.kind) {
    case 'limits': return `ліміти надіслано${e.n ? ` (вікон: ${e.n})` : ''}`
    case 'history_hook': return 'хук імпорту історії запустився'
    case 'history_imported': return `історію імпортовано: додано ${e.n ?? 0} з ${e.total ?? 0}`
    case 'import': return `/tracker-import: додано ${e.n ?? 0} з ${e.total ?? 0}`
    case 'error': return `помилка ${e.error ?? ''}${e.stage ? ` (${STAGE[e.stage] ?? e.stage})` : ''}`
    default: return e.kind
  }
}

const SERVICE_OF: Record<string, string> = { claude: 'claude-mod', codex: 'codex-plugin' }
/** The plugin sends its limits after every turn (to the log at most once an hour): silent when the agent worked over two hours after them. */
const SILENT_MS = 2 * 3_600_000

/** Per plugin of the device: its version, the last limits and import, and a failure newer than the last success; then the log itself.
 *  A plugin whose agent worked on the device (OTLP) but which sent no limits since is "silent": not installed, not approved, or failing. */
function pluginBox(entries: PluginEntry[], seen: Record<string, string> = {}): HTMLElement | '' {
  const silent = Object.entries(seen).flatMap(([provider, ts]) => {
    const service = SERVICE_OF[provider]
    if (!service || Date.now() - Date.parse(ts) > 7 * 86_400_000) return [] // the agent itself has not worked here for a week
    const limits = entries.find(e => e.service === service && e.kind === 'limits')
    return !limits || Date.parse(ts) - Date.parse(limits.ts) > SILENT_MS ? [{ service, ts, limits }] : []
  })
  if (!entries.length && !silent.length) return ''
  const quiet = silent.filter(x => !entries.some(e => e.service === x.service)).map(x => el('div', { class: 'plug bad' },
    el('b', {}, PLUGIN_NAME[x.service] ?? x.service),
    el('span', { title: 'Агент працював на цьому пристрої, а від плагіна нічого не надходило: перевірте, чи плагін встановлено й хуки дозволено' },
      `плагін мовчить: агент працював ${ago(x.ts)}, від плагіна нічого`)))
  const lines = [...new Set(entries.map(e => e.service))].map(service => {
    const own = entries.filter(e => e.service === service) // newest first
    const limits = own.find(e => e.kind === 'limits'), hist = own.find(e => e.kind === 'history_imported' || e.kind === 'import')
    const err = own.find(e => e.kind === 'error')
    const failing = err && (!limits || err.ts > limits.ts)
    const mute = silent.find(x => x.service === service)
    return el('div', { class: 'plug' + (failing || mute ? ' bad' : '') },
      el('b', {}, `${PLUGIN_NAME[service] ?? service}${own[0].version ? ' ' + own[0].version : ''}`),
      el('span', {}, [mute ? `плагін мовчить: агент працював ${ago(mute.ts)}, останні ліміти ${limits ? ago(limits.ts) : 'ще не надсилав'}`
        : limits ? `останні ліміти від плагіна ${ago(limits.ts)}` : 'ліміти ще не надсилав', hist ? `${entryText(hist)} (${ago(hist.ts)})` : '', failing ? `${entryText(err)} ${ago(err.ts)}` : ''].filter(Boolean).join(' · ')))
  })
  const log = el('div', { class: 'plug-log hide' }, ...entries.slice(0, 20).map(e => el('div', {},
    el('small', {}, new Date(e.ts).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' })), ` ${PLUGIN_NAME[e.service] ?? e.service}: ${entryText(e)}`)))
  const toggle = el('button', { type: 'button', class: 'link', onclick: () => { log.classList.toggle('hide'); toggle.textContent = log.classList.contains('hide') ? 'Журнал плагіна' : 'Сховати журнал' } }, 'Журнал плагіна')
  return el('div', { class: 'plugins' }, ...quiet, ...lines, ...(entries.length ? [toggle, log] : []))
}

function deviceRow(d: DeviceRow, log: PluginEntry[] = []): HTMLElement {
  const added = d.created_at.slice(0, 10)
  const seen = d.last_seen
  return el('div', { class: 'dev' },
    el('div', {}, el('b', {}, d.name), d.revoked ? el('span', { class: 'tag' }, 'відкликано') : '',
      ...[...d.providers].sort().map(p => el('span', { class: 'ptag', style: `border-color:${providerColor(p)};color:${providerColor(p)}`, title: 'Агент надсилав дані з цього пристрою' }, providerLabel(p))),
      el('small', {}, 'Додано ' + added + (seen ? ' · остання активність ' + new Date(seen).toLocaleString('uk-UA', { dateStyle: 'medium', timeStyle: 'short' }) : ' · ще не надсилав дані')),
      pluginBox(log.filter(e => e.device_id === d.id), d.revoked ? {} : d.seen)),
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
  const [list, log] = await Promise.all([api<DeviceRow[]>('/devices'), api<PluginEntry[]>('/plugin-log').catch(() => [] as PluginEntry[])])
  $('dev-list').replaceChildren(...(list.length ? list.map(d => deviceRow(d, log)) : [el('div', { class: 'empty' }, 'Пристроїв ще немає')]))
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
