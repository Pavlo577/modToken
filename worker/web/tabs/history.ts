// The "Import history" card of the Devices tab: reads Claude Code's local logs in the browser and sends only the numbers (see src/history.ts).
import { addLogLine, MAX_HISTORY_TURNS } from '../../src/history.ts'
import type { HistoryTurn } from '../../src/history.ts'
import { api } from '../lib/api.ts'
import { $ } from '../lib/dom.ts'
import type { DeviceRow } from '../lib/types.ts'

interface ImportResult { added: number; received: number; skipped_live: number; invalid: number }

export function fillHistoryDevices(list: DeviceRow[]): void {
  const sel = $<HTMLSelectElement>('hist-device')
  const keep = sel.value
  sel.replaceChildren(...list.filter(d => !d.revoked).map(d => Object.assign(document.createElement('option'), { value: d.id, textContent: d.name })))
  if (keep) sel.value = keep
  $<HTMLButtonElement>('hist-go').disabled = !sel.options.length
}

/** The lines of a file one by one, without holding the whole file (logs can be hundreds of megabytes). */
async function eachLine(file: File, on: (line: string) => void): Promise<void> {
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader()
  let rest = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    const lines = (rest + value).split('\n')
    rest = lines.pop() ?? ''
    for (const l of lines) on(l)
  }
  if (rest) on(rest)
}

export function initHistory(): void {
  $('hist-go').onclick = async () => {
    const files = [...($<HTMLInputElement>('hist-files').files ?? [])].filter(f => f.name.endsWith('.jsonl'))
    const status = $('hist-status')
    if (!files.length) { status.textContent = 'Вибери папку .claude/projects (або окремі .jsonl).'; return }
    const btn = $<HTMLButtonElement>('hist-go')
    btn.disabled = true
    try {
      const turns = new Map<string, HistoryTurn>()
      for (let i = 0; i < files.length; i++) {
        status.textContent = `Читаю файли: ${i + 1} з ${files.length}…`
        await eachLine(files[i]!, l => addLogLine(turns, l))
      }
      const all = [...turns.values()]
      const total: ImportResult = { added: 0, received: 0, skipped_live: 0, invalid: 0 }
      const device_id = $<HTMLSelectElement>('hist-device').value
      for (let i = 0; i < all.length; i += MAX_HISTORY_TURNS) {
        status.textContent = `Надсилаю: ${Math.min(i + MAX_HISTORY_TURNS, all.length)} з ${all.length}…`
        const r = await api<ImportResult>('/import', { method: 'POST', body: JSON.stringify({ device_id, turns: all.slice(i, i + MAX_HISTORY_TURNS) }) })
        for (const k of Object.keys(total) as (keyof ImportResult)[]) total[k] += r[k]
      }
      status.textContent = `Готово: знайдено ${all.length} відповідей, нових ${total.added}` +
        (total.skipped_live ? `, ${total.skipped_live} пропущено (ці дані вже приходять через OTLP)` : '') + (total.invalid ? `, ${total.invalid} відхилено` : '') + '.'
    } catch (err) {
      status.textContent = 'Не вдалося імпортувати: ' + (err as Error).message
    } finally { btn.disabled = false }
  }
}
