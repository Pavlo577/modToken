// The Devices tab: link codes, cloud token, device list and the old-history import.
import { api } from '../lib/api.ts'
import { $, el } from '../lib/dom.ts'
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

export async function loadDevices(): Promise<DeviceRow[]> {
  const list = await api<DeviceRow[]>('/devices')
  const active = list.filter(d => !d.revoked)
  $('import-device').replaceChildren(...(active.length ? active.map(d => el('option', { value: d.id }, d.name)) : [el('option', { value: '' }, 'Спершу додай пристрій')]))
  $('dev-list').replaceChildren(...(list.length ? list.map(d => el('div', { class: 'dev' },
    el('div', {}, el('b', {}, d.name), d.revoked ? el('span', { class: 'tag' }, 'відкликано') : '',
      el('span', { class: 'tag', title: d.billing === 'subscription' ? 'Пристрій надсилає ліміти підписки' : 'Пристрій не надсилав ліміти підписки: оплата (підписка, кредити чи API) невідома' }, d.billing === 'subscription' ? 'підписка' : 'тип оплати невизначений'),
      el('small', {}, 'Додано ' + d.created_at.slice(0, 10) + (d.last_seen ? ' · остання активність ' + new Date(d.last_seen).toLocaleString('uk-UA', { dateStyle: 'medium', timeStyle: 'short' }) : ' · ще не надсилав дані'))),
    d.revoked ? '' : el('button', { class: 'danger', onclick: async () => {
      if (confirm(`Відкликати «${d.name}»? Пристрій перестане надсилати дані.`)) { await api('/devices/' + d.id, { method: 'DELETE' }); void loadDevices() }
    } }, 'Відкликати'))) : [el('div', { class: 'empty' }, 'Пристроїв ще немає')]))
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
