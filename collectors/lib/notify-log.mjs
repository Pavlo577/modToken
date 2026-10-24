// A small diagnostic log of what Codex's notify did: ~/.token-tracker/notify.log, one JSON object per line.
// Only service fields go in: event names, times, exit codes, program names, yes/no flags. Never the JSON Codex passes
// (it holds the prompt and the answer) and never any of its text.
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { home } from './core.mjs'

export const logFile = join(home, 'notify.log')
const olderFile = `${logFile}.1`
const MAX_BYTES = Number(process.env.TOKEN_TRACKER_LOG_MAX) || 200_000

/**
 * A short, stable name for a failure: the log keeps these, never the message of an error (messages of file and process errors
 * carry local paths). The fixed list of codes is all that can come out.
 */
export function errorCategory(e) {
  const code = String(e?.code ?? ''), msg = String(e?.message ?? e ?? '')
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || /did not answer in time/.test(msg)) return 'timeout'
  const http = /HTTP (\d{3})/.exec(msg)
  if (http) return `http_${http[1]}`
  if (/token was rejected/.test(msg)) return 'auth'
  if (/not linked/.test(msg)) return 'not_linked'
  if (/could not reach the site|fetch failed/.test(msg) || ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code)) return 'network'
  if (['ENOENT', 'EACCES', 'EPERM', 'EMFILE', 'ENOSPC', 'E2BIG', 'EBUSY'].includes(code)) return `os_${code.toLowerCase()}`
  return 'unknown'
}

/**
 * Adds one event (never throws: a log must not break the notify). The log is never rewritten: when it grows past the limit the whole file
 * is renamed to notify.log.1 (one atomic step, replacing the older copy) and the next append starts a new one, so a process that writes at
 * the same moment can lose nothing; a rename that fails (another process has the file open on Windows, or another one was first) is skipped.
 */
export function logEvent(event) {
  try {
    mkdirSync(home, { recursive: true })
    appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n')
    if (statSync(logFile).size > MAX_BYTES) {
      try { if (statSync(logFile).size > MAX_BYTES) renameSync(logFile, olderFile) } catch { /* somebody else rotated, or the file is busy */ }
    }
  } catch { /* no log, the work goes on */ }
}

/** The last `n` events, oldest first. */
export function readLog(n = 40) {
  const lines = file => { try { return readFileSync(file, 'utf8').split('\n').filter(Boolean) } catch { return [] } }
  return [...lines(olderFile), ...lines(logFile)].slice(-n).flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
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
