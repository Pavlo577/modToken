// The Devices tab: link codes, cloud token, device list and the old-history import.
import { api } from '../lib/api.ts'
import { $, el } from '../lib/dom.ts'
import { providerColor, providerLabel } from '../core/palette.ts'
import type { DeviceRow } from '../lib/types.ts'

interface Turn {
  turn_id: string
  [k: string]: unknown
}
interface Parser<T> {
  push(line: string): void
  finish(): T
}
interface ImportResult {
  inserted: number
  duplicates: number
  afterLink: number
}

/** Agents a device can be linked for, with what the user does with the code. */
const LINKABLE: { id: string; how: (code: string) => (Node | string)[] }[] = [
  { id: 'claude', how: code => ['У Claude Code на цьому пристрої виконай ', el('b', {}, `/tracker-link ${code}`), '.'] },
  { id: 'codex', how: () => ['Завантаж програму ', el('b', {}, 'token-tracker'), ' для своєї системи зі сторінки ', el('a', { href: 'https://github.com/Pavlo577/modToken/releases', target: '_blank', rel: 'noopener' }, 'Releases'), ', відкрий її (подвійний клік) і встав код, коли вона запитає.'] },
]

/** One row per device name: every agent linked under the same name is a token of its own, the dashboard merges them by name. */
interface DeviceGroup {
  name: string
  rows: DeviceRow[]
  providers: Set<string>
}

function group(list: DeviceRow[]): DeviceGroup[] {
  const out = new Map<string, DeviceGroup>()
  for (const d of list) {
    const key = d.revoked ? d.id : d.name // a revoked device stays a row of its own
    const g = out.get(key) ?? { name: d.name, rows: [], providers: new Set<string>() }
    g.rows.push(d)
    for (const p of d.providers) g.providers.add(p)
    out.set(key, g)
  }
  return [...out.values()]
}

let panelTimer: ReturnType<typeof setInterval> | undefined

/** The code for one more agent of an existing device, shown under its row. */
async function showCode(panel: HTMLElement, name: string, provider: string): Promise<void> {
  clearInterval(panelTimer)
  const how = LINKABLE.find(l => l.id === provider)?.how
  if (!how) return
  try {
    const { code, expires_at } = await api<{ code: string; expires_at: string }>('/codes', { method: 'POST', body: JSON.stringify({ name }) })
    const note = el('div', { class: 'sub' })
    const close = (): void => { clearInterval(panelTimer); panel.replaceChildren(); panel.classList.add('hide') }
    // The cross also voids the code: a closed panel can no longer show it, so it must not stay valid.
    const cancel = async (): Promise<void> => {
      try { await api('/codes/cancel', { method: 'POST', body: JSON.stringify({ code }) }); close() } catch (err) { alert('Не вдалося скасувати код: ' + (err as Error).message) }
    }
    const cross = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    cross.setAttribute('viewBox', '0 0 12 12'); cross.setAttribute('width', '12'); cross.setAttribute('height', '12')
    cross.innerHTML = '<path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>'
    panel.replaceChildren(
      el('button', { type: 'button', class: 'dev-x', 'aria-label': 'Закрити й скасувати код', title: 'Закрити й зробити код недійсним', onclick: () => void cancel() }, cross),
      el('div', { class: 'sub' }, `${providerLabel(provider)} для «${name}»:`),
      el('div', { class: 'code' }, code), note,
      el('p', { class: 'note', style: 'margin:6px 0 0' }, ...how(code)),
    )
    const tick = (): void => {
      const left = Math.max(0, Math.round((new Date(expires_at).getTime() - Date.now()) / 1000))
      note.textContent = left ? `Код діє ще ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} і прив'язує лише одну програму.` : 'Код прострочено. Створи новий.'
      if (!left) clearInterval(panelTimer)
    }
    tick(); panelTimer = setInterval(tick, 1000)
  } catch (err) {
    const msg = (err as Error).message
    panel.replaceChildren(el('div', { class: 'sub' }, msg === 'too many open codes' ? 'Забагато відкритих кодів, зачекай або використай наявні.' : 'Не вдалося створити код: ' + msg))
  }
}

function deviceRow(g: DeviceGroup): HTMLElement {
  const active = g.rows.filter(d => !d.revoked)
  const revoked = active.length === 0
  const subscription = g.rows.some(d => d.billing === 'subscription')
  const added = g.rows.map(d => d.created_at).sort()[0]!.slice(0, 10)
  const seen = g.rows.map(d => d.last_seen).filter((t): t is string => Boolean(t)).sort().pop()
  const missing = LINKABLE.filter(l => !g.providers.has(l.id))
  const panel = el('div', { class: 'dev-panel hide' })
  const menu = el('div', { class: 'dev-menu hide' }, ...missing.map(l => el('button', { type: 'button', onclick: () => {
    menu.classList.add('hide'); panel.classList.remove('hide'); void showCode(panel, g.name, l.id)
  } }, providerLabel(l.id))))
  return el('div', { class: 'dev' },
    el('div', {}, el('b', {}, g.name), revoked ? el('span', { class: 'tag' }, 'відкликано') : '',
      ...[...g.providers].sort().map(p => el('span', { class: 'ptag', style: `border-color:${providerColor(p)};color:${providerColor(p)}`, title: 'Агент надсилав дані з цього пристрою' }, providerLabel(p))),
      el('span', { class: 'tag', title: subscription ? 'Пристрій надсилає ліміти підписки' : 'Пристрій не надсилав ліміти підписки: оплата (підписка, кредити чи API) невідома' }, subscription ? 'підписка' : 'тип оплати невизначений'),
      el('small', {}, 'Додано ' + added + (seen ? ' · остання активність ' + new Date(seen).toLocaleString('uk-UA', { dateStyle: 'medium', timeStyle: 'short' }) : ' · ще не надсилав дані'))),
    revoked ? '' : el('div', { class: 'dev-actions' },
      el('button', { type: 'button', disabled: missing.length === 0, title: missing.length ? 'Створити код для ще одного агента на цьому пристрої' : 'Усі підтримувані агенти вже підключені', onclick: () => menu.classList.toggle('hide') }, missing.length ? 'Додати провайдера' : 'Додано всі'),
      el('button', { class: 'danger', onclick: async () => {
        const what = g.providers.size ? ` (${[...g.providers].map(providerLabel).join(', ')})` : ''
        if (!confirm(`Відкликати «${g.name}»? Усі агенти цього пристрою${what} перестануть надсилати дані.`)) return
        for (const d of active) await api('/devices/' + d.id, { method: 'DELETE' })
        void loadDevices()
      } }, 'Відкликати')),
    menu, panel)
}

export async function loadDevices(): Promise<DeviceRow[]> {
  const list = await api<DeviceRow[]>('/devices')
  const groups = group(list)
  const importable = groups.filter(g => g.rows.some(d => !d.revoked))
  // the oldest token of a name takes the imported history (a Claude import only counts turns from before the device was linked)
  const oldest = (g: DeviceGroup): DeviceRow => g.rows.filter(d => !d.revoked).sort((a, b) => a.created_at.localeCompare(b.created_at))[0]!
  $('import-device').replaceChildren(...(importable.length ? importable.map(g => el('option', { value: oldest(g).id }, g.name)) : [el('option', { value: '' }, 'Спершу додай пристрій')]))
  $('dev-list').replaceChildren(...(groups.length ? groups.map(deviceRow) : [el('div', { class: 'empty' }, 'Пристроїв ще немає')]))
  return list
}

async function importFolder(): Promise<void> {
  const input = $<HTMLInputElement>('import-files'), status = $('import-status')
  const deviceId = $<HTMLSelectElement>('import-device').value
  const path = (f: File): string => f.webkitRelativePath || f.name
  const isCodex = (f: File): boolean => /^rollout-.*\.jsonl$/.test(f.name)
  // history.jsonl of Codex holds the typed prompts and no usage: never even opened
  const files = [...(input.files ?? [])].filter(f => f.name.endsWith('.jsonl') && f.name !== 'history.jsonl').sort((a, b) => path(a).localeCompare(path(b)))
  const seen = new Set<string>()
  if (!deviceId) { status.textContent = 'Спершу додай пристрій.'; input.value = ''; return }
  if (!files.length) { status.textContent = 'У вибраній папці нема файлів .jsonl. Потрібна папка projects (Claude) або sessions (Codex).'; input.value = ''; return }
  // parse.mjs stays plain JavaScript: the cloud hook and /tracker-import share it, so it is loaded at run time.
  const parserUrl = './parse.mjs', codexUrl = './parse-codex.mjs'
  const { createParser } = (await import(/* @vite-ignore */ parserUrl)) as { createParser: (key: string, seen: Set<string>) => Parser<Turn[]> }
  const { createCodexParser } = (await import(/* @vite-ignore */ codexUrl)) as { createCodexParser: (key: string) => Parser<{ turns: Turn[] }> }
  const total = { inserted: 0, duplicates: 0, afterLink: 0, turns: 0 }
  input.disabled = true
  try {
    for (const [i, file] of files.entries()) {
      status.textContent = `Файл ${i + 1} з ${files.length}: ${file.name}`
      const key = path(file).split('/').slice(1).join('/').replace(/\.jsonl$/, '') || file.name
      const codex = isCodex(file)
      const parser: Parser<Turn[] | { turns: Turn[] }> = codex ? createCodexParser(key) : createParser(key, seen)
      const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        const parts = (buf + value).split('\n')
        buf = parts.pop() ?? ''
        for (const line of parts) parser.push(line)
      }
      if (buf) parser.push(buf)
      const done = parser.finish()
      const turns = Array.isArray(done) ? done : done.turns
      total.turns += turns.length
      for (let k = 0; k < turns.length; k += 300) {
        const r = await api<ImportResult>('/import', { method: 'POST', body: JSON.stringify({ device_id: deviceId, rows: turns.slice(k, k + 300) }) })
        total.inserted += r.inserted; total.duplicates += r.duplicates; total.afterLink += r.afterLink
      }
    }
    status.textContent = `Готово: знайдено ${total.turns} ходів, додано ${total.inserted}, вже були ${total.duplicates}, новіших за прив'язку пропущено ${total.afterLink} (їх збирає мод).`
  } catch (e) {
    status.textContent = 'Не вдалося імпортувати: ' + (e as Error).message + '. Повтори, вже надіслане не задублюється.'
  } finally {
    input.disabled = false; input.value = ''
  }
}

export function initDevices(): void {
  $('import-files').addEventListener('change', () => void importFolder())

  $('cloud-form').addEventListener('submit', async e => {
    e.preventDefault()
    try {
      const { token } = await api<{ token: string }>('/cloud-device', { method: 'POST', body: JSON.stringify({ name: $<HTMLInputElement>('cloud-name').value }) })
      $('cloud-script').textContent = `curl -fsSL https://raw.githubusercontent.com/Pavlo577/modToken/main/cloud/setup.sh | bash -s -- ${location.origin}`
      $('cloud-host').textContent = location.hostname
      $('cloud-token').textContent = token
      $('cloud-box').classList.remove('hide')
      void loadDevices()
    } catch (err) { alert('Не вдалося створити токен: ' + (err as Error).message) }
  })

  const copy = (id: string, btn: HTMLElement) => async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText($(id).textContent ?? '')
      const t = btn.textContent
      btn.textContent = 'Скопійовано'
      setTimeout(() => (btn.textContent = t), 1500)
    } catch { alert('Не вдалося скопіювати, виділи текст вручну.') }
  }
  $('copy-script').onclick = copy('cloud-script', $('copy-script'))
  $('copy-token').onclick = copy('cloud-token', $('copy-token'))

  let timer: ReturnType<typeof setInterval> | undefined
  $('new-code').addEventListener('submit', async e => {
    e.preventDefault()
    const name = $<HTMLInputElement>('dev-name')
    try {
      const { code, expires_at } = await api<{ code: string; expires_at: string }>('/codes', { method: 'POST', body: JSON.stringify({ name: name.value }) })
      $('code').textContent = code
      $('code-box').classList.remove('hide')
      clearInterval(timer)
      const tick = (): void => {
        const left = Math.max(0, Math.round((new Date(expires_at).getTime() - Date.now()) / 1000))
        $('code-note').textContent = left ? `На пристрої: /tracker-link ${code} · діє ще ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'Код прострочено. Створи новий.'
        if (!left) clearInterval(timer)
      }
      tick(); timer = setInterval(tick, 1000)
      name.value = ''
    } catch (err) {
      const msg = (err as Error).message
      alert(msg === 'too many open codes' ? 'Забагато відкритих кодів, зачекай або використай наявні.' : 'Не вдалося створити код: ' + msg)
    }
  })
}
