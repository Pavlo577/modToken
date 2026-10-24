#!/usr/bin/env node
// Token Tracker collector: sends the token usage of AI coding agents (now: OpenAI Codex) to the tracker site.
// Only token counts, timestamps, model names and ids leave the machine, never prompts, answers or tool output.
//
//   (no arguments)                       the guide: sets everything up the first time, then shows the status and sends what is new
//   link <CODE> [--url https://site]     once per device: a code made on the site (Devices tab)
//   sync [--full]                        send what is new (--full: send everything again)
//   hook-stop                            for Codex's Stop hook (hooks.json): runs `sync` for the finished session in the background
//   notify [...]                         for Codex's `notify` (older way): runs `sync` in the background
//   status | setup | log                 for scripts (log: what Codex's notify did, no texts)
//
// The device token and the list of what was sent live in ~/.token-tracker (TOKEN_TRACKER_HOME). CODEX_HOME is honoured.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import codex from './agents/codex.mjs'
import { arg, command, configFile, link, readJson, self, shown } from './lib/core.mjs'
import { logEvent, readLog } from './lib/notify-log.mjs'
import { interactive } from './wizard.mjs'

async function sync() {
  const full = process.argv.includes('--full')
  let r
  try { r = await codex.sync({ full, only: arg('--file') }) } catch (e) { logEvent({ event: 'sync_failed', error: e instanceof Error ? e.message : String(e) }); throw e }
  logEvent({ event: 'sync_finished', rows: r.rows, scanned: r.scanned })
  if (r.missing) console.log(`no Codex data in ${codex.home}`)
  else if (r.busy) console.log('another sync is running')
  else console.log(`Codex: ${r.files} files, ${r.scanned} read, ${r.rows} turns sent${r.limits ? ', limits updated' : ''}`)
}

/** Starts `file list...` without a shell (so quotes in paths and in the JSON stay as they are); resolves with how it ended. */
const startDownstream = (file, list) => new Promise(resolve => {
  const t0 = Date.now()
  let child
  try { child = spawn(file, list, { shell: false, detached: true, stdio: 'ignore', windowsHide: true }) } catch (e) { return resolve({ error: e.code ?? e.message }) }
  // Not waited for longer than 10 s and never killed: the other program may work longer on purpose.
  const timer = setTimeout(() => { child.unref(); resolve({ running: true }) }, 10_000)
  child.on('error', e => { clearTimeout(timer); resolve({ error: e.code ?? e.message }) })
  child.on('exit', (exitCode, signal) => { clearTimeout(timer); resolve({ exitCode, signal, durationMs: Date.now() - t0 }) })
})

const hasSeparator = p => /[\\/]/.test(p)
/** A JSON argument is shown as <json>: it carries the prompt and the answer. */
const safeArg = a => (/^\s*[{[]/.test(a) ? '<json>' : a)

async function notify() {
  // Codex adds one JSON argument (the last prompt and answer) at the end. It is only checked for which fields it has (never stored),
  // used as the signal to sync, and passed on untouched to the command given after --then (the notify that was there before ours).
  const args = process.argv.slice(3)
  const payload = args.length && args[args.length - 1].startsWith('{') ? args.pop() : null
  const at = args.indexOf('--then')
  const then = at >= 0 ? args.slice(at + 1) : []
  let seen = {}
  try {
    const j = JSON.parse(payload ?? 'null') ?? {}
    seen = { type: typeof j.type === 'string' ? j.type : null, hasThreadId: Boolean(j['thread-id']), hasTurnId: Boolean(j['turn-id']), hasInputMessages: Boolean(j['input-messages']), hasAssistantMessage: Boolean(j['last-assistant-message']) }
  } catch { seen = { type: null, payload: payload ? 'not readable' : 'none' } }
  logEvent({ event: 'notify_received', ...seen, then: then.length ? basename(then[0]) : null })

  try { spawn(self[0], [...self.slice(1), 'sync'], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref(); logEvent({ event: 'sync_started' }) } catch (e) { logEvent({ event: 'sync_failed', error: e.code ?? e.message }) }

  if (!then.length) return
  const program = basename(then[0])
  if (hasSeparator(then[0]) && !existsSync(then[0])) return logEvent({ event: 'downstream_missing', program }) // e.g. Codex moved its helper on an update
  logEvent({ event: 'downstream_started', program, arguments: [...then.slice(1).map(safeArg), ...(payload ? ['<json>'] : [])] })
  const r = await startDownstream(then[0], [...then.slice(1), ...(payload ? [payload] : [])])
  if (r.running) logEvent({ event: 'downstream_still_running', program })
  else if (r.error) logEvent({ event: 'downstream_failed', program, error: r.error })
  else logEvent({ event: r.exitCode === 0 ? 'downstream_finished' : 'downstream_failed', program, exitCode: r.exitCode, signal: r.signal ?? null, durationMs: r.durationMs })
}

/**
 * Codex's `Stop` hook: Codex writes a JSON about the finished turn on stdin (session id, turn id, model, the path of the session file,
 * the last answer ...). Only the path of the session file is used (to sync just that file); the answer is never kept or printed.
 * Nothing is printed and the exit code is always 0: a Stop hook that prints JSON with "decision":"block" would make Codex go on.
 */
async function hookStop() {
  let raw = ''
  try {
    process.stdin.setEncoding('utf8')
    raw = await new Promise(resolve => {
      let s = ''
      const t = setTimeout(() => resolve(s), 3000)
      process.stdin.on('data', d => { s += d; if (s.length > 5_000_000) { clearTimeout(t); resolve(s) } })
      process.stdin.on('end', () => { clearTimeout(t); resolve(s) })
      process.stdin.on('error', () => { clearTimeout(t); resolve(s) })
    })
  } catch { /* no stdin */ }
  let j = {}
  try { j = JSON.parse(raw) ?? {} } catch { /* not JSON */ }
  const file = typeof j.transcript_path === 'string' && /rollout-.*\.jsonl$/i.test(j.transcript_path) ? j.transcript_path : null
  logEvent({ event: 'hook_received', hook: typeof j.hook_event_name === 'string' ? j.hook_event_name : null, hasSessionId: Boolean(j.session_id), hasTurnId: Boolean(j.turn_id), hasTranscript: Boolean(file), model: typeof j.model === 'string' ? j.model : null })
  try {
    spawn(self[0], [...self.slice(1), 'sync', ...(file ? ['--file', file] : [])], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref()
    logEvent({ event: 'sync_started', scope: file ? 'file' : 'all' })
  } catch (e) { logEvent({ event: 'sync_failed', error: e.code ?? e.message }) }
}

function log() {
  const events = readLog(Number(arg('--last')) || 30)
  if (!events.length) return console.log('notify.log is empty: Codex has not called this program yet.')
  for (const e of events) { const { at, event, ...rest } = e; console.log(`${at}  ${event}${Object.keys(rest).length ? '  ' + JSON.stringify(rest) : ''}`) }
}

function status() {
  const cfg = readJson(configFile, null), st = codex.status()
  console.log(`site:        ${cfg?.url ?? 'not linked'}`)
  console.log(`Codex home:  ${codex.home}${codex.detect() ? '' : ' (not found)'}`)
  console.log(`last sync:   ${st.lastSync ?? 'never'}; ${st.turns} turns sent from ${st.files} files`)
}

function setup() {
  console.log(`The easy way: run ${command(shown)} with no arguments and answer its questions. By hand:
1. Link this device once (make a code on the site: Devices tab, same device name as your Claude one):
     ${command(shown)} link <CODE>
2. Send what is already there:
     ${command(shown)} sync
3. Keep it up to date: add this line at the top level of ${codex.configToml} (before any [section]):
     ${codex.notifyLine()}
   Codex then runs it after each turn; it only wakes the collector and reads nothing from what Codex passes.
   Or run "sync" from cron / a systemd timer / Windows Task Scheduler every few minutes.`)
}

function usage(bad) {
  console.log(`token-tracker: sends Codex token usage (numbers only, never your prompts or answers) to your tracker site.
usage: ${command(shown)} [link <CODE> | sync [--full] | notify | status | setup]
Without arguments, in a terminal window, it guides you through the setup and then shows the status.`)
  process.exitCode = bad ? 2 : 0
}

const [first, a1] = process.argv.slice(2)
const cmd = first?.startsWith('--') ? undefined : first // "--url https://site" alone still opens the guide
try {
  if (cmd === 'link') {
    const { device } = await link(a1, arg('--url'))
    console.log(`linked as "${device}". Now run: ${command(shown)} sync`)
  } else if (cmd === 'sync') await sync()
  else if (cmd === 'notify') await notify()
  else if (cmd === 'hook-stop') await hookStop()
  else if (cmd === 'log') log()
  else if (cmd === 'status') status()
  else if (cmd === 'setup') setup()
  else if (!cmd && process.stdin.isTTY && process.stdout.isTTY) await interactive()
  else usage(Boolean(cmd))
} catch (e) {
  console.error('Error: ' + (e instanceof Error ? e.message : e))
  process.exitCode = 1
}
