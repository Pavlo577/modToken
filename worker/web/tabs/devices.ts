// The Devices tab: add a device grouped by agent (its token and the OpenTelemetry settings to paste), rename, a new token, revoke.
import { load } from '../core/load.ts'
import { providerColor, providerLabel } from '../core/palette.ts'
import { api } from '../lib/api.ts'
import { $, el, svg } from '../lib/dom.ts'
import { guessSetup, modtokenCliPs, modtokenCliSh, setupPlan, type Agent, type Place, type Step } from '../lib/setup.ts'
import type { DeviceRow } from '../lib/types.ts'
import { fillHistoryDevices, initHistory } from './history.ts'

/** Shows the setup steps for a token (a new device's, or a device's new one); set by initDevices. */
let showSetup: (token: string, device: string, providers?: string[]) => void = () => {}
let pickAgentForAdd: (agent: Agent) => void = () => {}

/** The agent and place last chosen for each device (by name), in this browser: preselected when its commands are shown again. */
const SETUP_KEY = 'tt-setup'
const savedSetups = (): Record<string, { agent?: string; place?: string }> => { try { return JSON.parse(localStorage.getItem(SETUP_KEY) || '{}') } catch { return {} } }
const saveSetup = (device: string, agent: string, place: string): void => {
  try { localStorage.setItem(SETUP_KEY, JSON.stringify({ ...savedSetups(), [device]: { agent, place } })) } catch { /* private mode */ }
}
const renameSavedSetup = (oldName: string, newName: string): void => {
  try {
    const cur = savedSetups()
    if (cur[oldName]) {
      cur[newName] = cur[oldName]
      if (oldName !== newName) delete cur[oldName]
      localStorage.setItem(SETUP_KEY, JSON.stringify(cur))
    }
  } catch { /* private mode */ }
}

const AGENTS: Agent[] = ['claude', 'codex', 'antigravity']
const PLACE_LABEL: Record<Place, string> = { windows: 'Windows', linux: 'Ubuntu / macOS', cloud: 'Хмара' }
const SERVICE_AGENT: Record<string, Agent> = { 'claude-mod': 'claude', 'codex-plugin': 'codex', 'antigravity-plugin': 'antigravity' }
const defaultPlace = (): Place => (typeof navigator !== 'undefined' && /Win/i.test(navigator.userAgent) ? 'windows' : 'linux')

const icon = (paths: string[], size = 15): SVGElement =>
  svg('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    ...paths.map(d => svg('path', { d })))

const ICON_EDIT = ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z']
const ICON_KEY = ['m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4', 'm21 2-9.6 9.6', 'M7.5 12a4.5 4.5 0 1 0 4.5 4.5 4.5 4.5 0 0 0-4.5-4.5Z']
const ICON_REVOKE = ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z', 'm4.93 4.93 14.14 14.14']
const ICON_TRASH = ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M10 11v6', 'M14 11v6']
const ICON_COPY = ['M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2', 'M16 2H10a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6Z']
const ICON_CHECK = ['M20 6 9 17l-5-5']
const ICON_PLUS = ['M12 5v14', 'M5 12h14']

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

const PLUGIN_NAME: Record<string, string> = { 'codex-plugin': 'Плагін Codex', 'claude-mod': 'Мод Claude', 'antigravity-plugin': 'Плагін Antigravity' }
const STAGE: Record<string, string> = { limits: 'ліміти', history: 'імпорт історії', import: 'імпорт історії', statusline: 'статус-бар', activity: 'активність' }

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

const SERVICE_OF: Record<string, string> = { claude: 'claude-mod', codex: 'codex-plugin', antigravity: 'antigravity-plugin' }
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

/** Which agent section(s) a device belongs to: any agent it already reported data for (OTLP turns or plugin log), else its guessed/saved agent. */
function deviceAgents(d: DeviceRow, log: PluginEntry[]): Agent[] {
  const fromData = new Set<Agent>()
  for (const p of d.providers) if ((AGENTS as readonly string[]).includes(p)) fromData.add(p as Agent)
  for (const e of log) if (e.device_id === d.id && SERVICE_AGENT[e.service]) fromData.add(SERVICE_AGENT[e.service])
  if (fromData.size) return AGENTS.filter(a => fromData.has(a))
  const pick = guessSetup(d.name, d.providers, savedSetups()[d.name], { agent: 'claude', place: defaultPlace() })
  return [pick.agent]
}

function deviceRow(d: DeviceRow, sectionAgent: Agent, log: PluginEntry[] = []): HTMLElement {
  const added = d.created_at.slice(0, 10)
  const seen = d.seen?.[sectionAgent] ?? d.last_seen
  const pick = guessSetup(d.name, [sectionAgent], savedSetups()[d.name], { agent: sectionAgent, place: defaultPlace() })
  const sectionService = SERVICE_OF[sectionAgent]
  const sectionLog = log.filter(e => e.device_id === d.id && (!sectionService || e.service === sectionService))
  const sectionSeen = d.revoked ? {} : (d.seen?.[sectionAgent] ? { [sectionAgent]: d.seen[sectionAgent] } : {})
  const otherAgents = d.providers.filter(p => p !== sectionAgent)

  const doRename = async () => {
    const raw = prompt('Нова назва пристрою:', d.name)
    if (raw === null) return
    const next = raw.trim()
    if (!next || next === d.name) return
    try {
      await api('/devices/' + d.id, { method: 'PATCH', body: JSON.stringify({ name: next }) })
      renameSavedSetup(d.name, next)
      void loadDevices()
      void load()
    } catch (err) { alert('Не вдалося перейменувати: ' + (err as Error).message) }
  }

  return el('div', { class: 'dev' + (d.revoked ? ' revoked' : '') },
    el('div', { class: 'dev-main' },
      el('div', { class: 'dev-title-row' },
        el('b', { class: 'dev-name', title: 'Натисни, щоб перейменувати пристрій', onclick: doRename }, d.name),
        el('button', { type: 'button', class: 'icon-btn ghost', 'data-tip': 'Перейменувати пристрій', 'aria-label': 'Перейменувати ' + d.name, onclick: doRename }, icon(ICON_EDIT, 13)),
        el('span', { class: 'dev-place', title: 'Середовище пристрою' }, PLACE_LABEL[pick.place]),
        d.revoked ? el('span', { class: 'tag', style: 'margin-left:0' }, 'відкликано') : '',
        ...otherAgents.sort().map(p => el('span', { class: 'ptag', style: `border-color:${providerColor(p)};color:${providerColor(p)}`, title: 'Цей токен також надсилав дані від іншого агента' }, '+ ' + providerLabel(p)))),
      el('small', {}, 'Додано ' + added + (seen ? ' · активність ' + new Date(seen).toLocaleString('uk-UA', { dateStyle: 'medium', timeStyle: 'short' }) : ' · ще не надсилав дані')),
      pluginBox(sectionLog, sectionSeen)),
    el('div', { class: 'dev-actions' },
      ...(d.revoked ? [] : [
        projectSelect(d),
        el('button', { type: 'button', class: 'icon-btn', 'data-tip': 'Новий токен і команди встановлення', 'aria-label': 'Новий токен для ' + d.name, onclick: async () => {
          if (!confirm(`Новий токен для «${d.name}»? Пристрій і його дані лишаються, але старий токен перестане діяти: на цьому пристрої треба буде ще раз виконати команду встановлення.`)) return
          try {
            const { token } = await api<{ token: string }>('/devices/' + d.id + '/token', { method: 'POST' })
            showSetup(token, d.name, [sectionAgent])
          } catch (err) { alert('Не вдалося видати токен: ' + (err as Error).message) }
        } }, icon(ICON_KEY)),
        el('button', { type: 'button', class: 'icon-btn danger', 'data-tip': 'Відкликати токен (зупинити прийом даних)', 'aria-label': 'Відкликати ' + d.name, onclick: async () => {
          if (!confirm(`Відкликати «${d.name}»? Він перестане надсилати дані; те, що вже надіслав, лишиться в статистиці.`)) return
          await api('/devices/' + d.id, { method: 'DELETE' })
          void loadDevices()
        } }, icon(ICON_REVOKE))]),
      deleteButton(d)))
}

/** Deletes the device with everything it sent: its numbers leave the statistics. */
const deleteButton = (d: DeviceRow): HTMLElement => el('button', { type: 'button', class: 'icon-btn danger', 'data-tip': 'Видалити пристрій разом з усіма даними', 'aria-label': 'Видалити ' + d.name, onclick: async () => {
  if (!confirm(`Видалити «${d.name}» разом з усіма його даними (токени, ліміти, сесії)? Статистика за минулі дні зменшиться. Скасувати це не можна.`)) return
  try {
    await api('/devices/' + d.id + '?purge=1', { method: 'DELETE' })
    void loadDevices()
  } catch (err) { alert('Не вдалося видалити: ' + (err as Error).message) }
} }, icon(ICON_TRASH))

const countWord = (n: number): string => (n === 0 ? 'немає пристроїв' : n === 1 ? '1 пристрій' : n < 5 ? `${n} пристрої` : `${n} пристроїв`)

export async function loadDevices(): Promise<DeviceRow[]> {
  const [list, log] = await Promise.all([api<DeviceRow[]>('/devices'), api<PluginEntry[]>('/plugin-log').catch(() => [] as PluginEntry[])])
  const byAgent = new Map<Agent, DeviceRow[]>(AGENTS.map(a => [a, []]))
  for (const d of list) {
    for (const a of deviceAgents(d, log)) byAgent.get(a)?.push(d)
  }
  const groups = AGENTS.map(a => {
    const devs = byAgent.get(a) ?? []
    const activeDevs = devs.filter(d => !d.revoked)
    const revokedDevs = devs.filter(d => d.revoked)
    const color = providerColor(a)
    const label = providerLabel(a)
    return el('div', { class: 'dev-group' },
      el('div', { class: 'dev-group-head' },
        el('div', { class: 'dev-group-title' },
          el('i', { style: `background:${color}` }),
          el('span', {}, label),
          el('span', { class: 'dev-group-count' }, `· ${countWord(activeDevs.length)}${revokedDevs.length ? ` (+${revokedDevs.length} відкл.)` : ''}`)),
        el('button', { type: 'button', class: 'dev-group-add', 'data-tip': `Додати пристрій для ${label}`, onclick: () => pickAgentForAdd(a) }, icon(ICON_PLUS, 14), `Додати`)),
      ...(activeDevs.length
        ? activeDevs.map(d => deviceRow(d, a, log))
        : [el('div', { class: 'dev-group-empty' }, `Для ${label} немає активних пристроїв.`)]),
      ...(revokedDevs.length
        ? [el('details', { class: 'revoked-fold' },
            el('summary', {}, `Відкликані пристрої (${revokedDevs.length})`),
            ...revokedDevs.map(d => deviceRow(d, a, log)))]
        : []))
  })
  $('dev-list').replaceChildren(...groups)
  fillHistoryDevices(list)
  return list
}

/** Step text with `code` in backticks: plain text nodes and <code>, never HTML. */
const withCode = (text: string): (string | HTMLElement)[] => text.split('`').map((part, i) => (i % 2 ? el('code', {}, part) : part))

async function copyText(text: string, btn: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    const prev = [...btn.childNodes]
    const prevTip = btn.getAttribute('data-tip')
    btn.classList.add('ok')
    btn.setAttribute('data-tip', 'Скопійовано!')
    if (btn.classList.contains('icon-btn')) btn.replaceChildren(icon(ICON_CHECK))
    else btn.replaceChildren(icon(ICON_CHECK, 13), 'Скопійовано')
    setTimeout(() => {
      btn.classList.remove('ok')
      if (prevTip) btn.setAttribute('data-tip', prevTip); else btn.removeAttribute('data-tip')
      btn.replaceChildren(...prev)
    }, 1500)
  } catch { alert('Не вдалося скопіювати, виділи текст вручну.') }
}

const stepNodes = (steps: Step[], numbered: boolean): HTMLElement[] => steps.flatMap((st, i) => [
  el('p', { class: 'sub', style: 'margin:14px 0 6px' }, numbered && steps.length > 1 ? el('b', {}, `${i + 1}. `) : '', ...withCode(st.text)),
  ...(st.code !== undefined ? [el('div', { class: 'snip-row' },
    el('pre', { class: 'snip' }, st.code),
    el('button', { type: 'button', class: 'icon-btn primary', 'data-tip': 'Копіювати команду', 'aria-label': 'Копіювати', onclick: (e: Event) => void copyText(st.code ?? '', e.currentTarget as HTMLElement) }, icon(ICON_COPY)))] : []),
])

/** A segmented choice: the pressed button's data-v, a way to press one, and a callback when the viewer changes it. */
function choice<T extends string>(id: string, onChange: (v: T) => void): { get: () => T; set: (v: T) => void } {
  const box = $(id)
  const buttons = [...box.querySelectorAll<HTMLButtonElement>('button')]
  const set = (v: T): void => { for (const x of buttons) x.setAttribute('aria-pressed', String(x.dataset.v === v)) }
  for (const b of buttons) b.addEventListener('click', () => { set(b.dataset.v as T); onChange(b.dataset.v as T) })
  return { get: () => (buttons.find(b => b.getAttribute('aria-pressed') === 'true')?.dataset.v ?? buttons[0].dataset.v) as T, set }
}

export function initDevices(): void {
  initHistory()
  let token = '' // the token being set up: shown once, kept only while the page is open so the choice can still change
  let device = ''
  const updatePlaceholder = (): void => {
    const input = $<HTMLInputElement>('dev-name')
    input.placeholder = `Назва (необов'язково — авто з ПК або ${agent.get()}-${place.get()})`
  }
  const render = (): void => {
    updatePlaceholder()
    if (!token) return
    saveSetup(device, agent.get(), place.get()) // remembered for the next time this device's commands are shown
    const plan = setupPlan(agent.get(), place.get(), location.origin, token)
    $('setup-steps').replaceChildren(...stepNodes(plan.steps, true))
    $('setup-manual').replaceChildren(...stepNodes(plan.manual, false))
  }
  const agent = choice<Agent>('setup-agent', render)
  const place = choice<Place>('setup-place', render)
  place.set(defaultPlace())
  updatePlaceholder()

  // Populate the `modtoken` console manager card & its copy icon buttons
  const winCmd = modtokenCliPs(), shCmd = modtokenCliSh()
  $('mt-cmd-win').textContent = winCmd
  $('mt-cmd-sh').textContent = shCmd
  const winBtn = $('copy-mt-win'), shBtn = $('copy-mt-sh')
  winBtn.replaceChildren(icon(ICON_COPY))
  shBtn.replaceChildren(icon(ICON_COPY))
  winBtn.addEventListener('click', () => void copyText(winCmd, winBtn))
  shBtn.addEventListener('click', () => void copyText(shCmd, shBtn))
  document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach(btn => {
    btn.prepend(icon(ICON_COPY, 12))
    btn.addEventListener('click', () => void copyText(btn.dataset.copy ?? '', btn))
  })

  pickAgentForAdd = (a: Agent) => {
    agent.set(a)
    updatePlaceholder()
    $('setup-pick').scrollIntoView({ behavior: 'smooth', block: 'start' })
    $<HTMLInputElement>('dev-name').focus()
  }

  $('setup-manual-btn').addEventListener('click', () => {
    const box = $('setup-manual')
    box.classList.toggle('hide')
    $('setup-manual-btn').textContent = box.classList.contains('hide') ? 'Встановити вручну' : 'Сховати ручне встановлення'
  })

  showSetup = (t, name, providers = []) => {
    token = t; device = name
    const pick = guessSetup(name, providers, savedSetups()[name], { agent: agent.get(), place: place.get() })
    agent.set(pick.agent); place.set(pick.place)
    render()
    $('setup-for').textContent = `Налаштування для «${name}»: виконай кроки нижче (якщо назву не вводили, інсталятор автоматично підставить ім'я комп'ютера).`
    $('setup-manual').classList.add('hide')
    $('setup-manual-btn').textContent = 'Встановити вручну'
    $('setup-box').classList.remove('hide')
    $('setup-pick').scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  $('new-device').addEventListener('submit', async e => {
    e.preventDefault()
    const name = $<HTMLInputElement>('dev-name')
    const curAgent = agent.get(), curPlace = place.get()
    try {
      const r = await api<{ token: string; device: string }>('/devices', {
        method: 'POST',
        body: JSON.stringify({ name: name.value.trim(), agent: curAgent, place: curPlace, project_mode: $<HTMLSelectElement>('dev-project').value }),
      })
      const createdName = r.device || name.value.trim() || `${curAgent}-${curPlace}`
      saveSetup(createdName, curAgent, curPlace)
      showSetup(r.token, createdName, [curAgent])
      name.value = ''
      void loadDevices()
    } catch (err) { alert('Не вдалося створити пристрій: ' + (err as Error).message) }
  })
}
