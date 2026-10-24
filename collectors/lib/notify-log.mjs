// A small diagnostic log of what Codex's notify did: ~/.token-tracker/notify.log, one JSON object per line.
// Only service fields go in: event names, times, exit codes, program names, yes/no flags. Never the JSON Codex passes
// (it holds the prompt and the answer) and never any of its text.
import { appendFileSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { home } from './core.mjs'

export const logFile = join(home, 'notify.log')
const MAX_BYTES = 200_000, KEEP_LINES = 300

/** Adds one event (never throws: a log must not break the notify). */
export function logEvent(event) {
  try {
    mkdirSync(home, { recursive: true })
    appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n')
    if (statSync(logFile).size > MAX_BYTES) writeFileSync(logFile, readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-KEEP_LINES).join('\n') + '\n')
  } catch { /* no log, the work goes on */ }
}

/** The last `n` events, oldest first. */
export function readLog(n = 40) {
  try {
    return readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-n).flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
  } catch { return [] }
}

const CALLS = ['notify_received', 'hook_received']

/** The newest call from Codex (the Stop hook or the notify) and what followed it: { at, via, events[] }, or null if Codex never called us. */
export function lastNotify() {
  const all = readLog(300)
  let i = -1
  all.forEach((e, k) => { if (CALLS.includes(e.event)) i = k })
  if (i < 0) return null
  const events = []
  for (const e of all.slice(i + 1)) { if (CALLS.includes(e.event)) break; events.push(e) }
  return { at: all[i].at, via: all[i].event === 'hook_received' ? 'hook' : 'notify', received: all[i], events }
}

/** One line for the status screen. */
export function summarize(n) {
  if (!n) return null
  const down = n.events.filter(e => e.event.startsWith('downstream_')).pop()
  const sync = n.events.filter(e => e.event.startsWith('sync_')).pop()
  const parts = []
  if (down) {
    parts.push(down.event === 'downstream_finished' ? `стара команда завершилась з кодом ${down.exitCode} (${down.durationMs} мс)`
      : down.event === 'downstream_missing' ? `стару команду не знайдено (${down.program}): Codex, схоже, оновився`
      : down.event === 'downstream_failed' ? `стара команда не вдалась (${down.exitCode ?? down.error})`
      : down.event === 'downstream_still_running' ? 'стара команда ще працювала через 10 с (лишена без змін)'
      : 'стара команда запущена')
  }
  if (n.via === 'hook') parts.unshift('Stop-hook')
  parts.push(!sync ? 'синхронізація: ще не завершилась' : sync.event === 'sync_finished' ? `синхронізація: надіслано ${sync.rows} ходів` : sync.event === 'sync_failed' ? `синхронізація не вдалась: ${sync.error}` : 'синхронізація запущена')
  return parts.join('; ')
}
