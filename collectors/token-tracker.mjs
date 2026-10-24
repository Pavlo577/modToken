#!/usr/bin/env node
// Token Tracker collector: sends the token usage of AI coding agents (Claude Code, OpenAI Codex) to the tracker site.
// Only token counts, timestamps, model names and ids leave the machine, never prompts, answers or tool output.
//
//   (no arguments)                       the guide: sets everything up the first time, then shows the status and sends what is new
//   link <CODE> [--url https://site]     once per device: a code made on the site (Devices tab)
//   sync [--agent claude|codex] [--full]  send what is new (--full: send everything again)
//   import [--agent claude]              send the history from before this device was linked (safe to repeat)
//   hook-stop [--agent claude|codex]     for the agent's Stop hook: runs `sync` for the finished session in the background (default codex)
//   notify [...]                         for Codex's `notify` (older way): runs `sync` in the background
//   status | setup | log                 for scripts (log: what Codex's notify did, no texts)
//
// The device token and the list of what was sent live in ~/.token-tracker (TOKEN_TRACKER_HOME). CODEX_HOME and CLAUDE_CONFIG_DIR are honoured.
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import claude from './agents/claude.mjs'
import codex from './agents/codex.mjs'
import { AGENTS } from './agents/index.mjs'
import { arg, command, configFile, link, readJson, self, shown, writeJson } from './lib/core.mjs'
import { withHook } from './lib/hooks-json.mjs'
import { otlpState, withOtlp, withoutOtlp } from './lib/otlp-claude.mjs'
import { errorCategory, logEvent, readLog } from './lib/notify-log.mjs'
import { interactive } from './wizard.mjs'

const agentOf = id => AGENTS.find(a => a.id === id)
/** Collected by default: Codex when it is on the machine, Claude Code only when the user chose it. */
const isEnabled = a => (a.enabled ?? a.detect).call(a)
/** A rollout is Codex's, any other log is Claude Code's. */
const guessAgent = file => (/rollout-.*\.jsonl$/i.test(file ?? '') ? 'codex' : 'claude')

async function sync() {
  const full = process.argv.includes('--full')
  const file = arg('--file')
  const wanted = arg('--agent') ?? (file ? guessAgent(file) : null)
  if (wanted && !agentOf(wanted)) throw new Error(`unknown agent "${wanted}" (${AGENTS.map(a => a.id).join(', ')})`)
  for (const agent of wanted ? [agentOf(wanted)] : AGENTS.filter(isEnabled)) {
    let r
    try { r = await agent.sync({ full, only: file }) } catch (e) { logEvent({ event: 'sync_failed', agent: agent.id, error: errorCategory(e) }); throw e }
    logEvent({ event: 'sync_finished', agent: agent.id, rows: r.rows, scanned: r.scanned })
    if (r.missing) console.log(`${agent.title}: no data in ${agent.home}`)
    else if (r.busy) console.log(`${agent.title}: another sync is running`)
    else console.log(`${agent.title}: ${r.files} files, ${r.scanned} read, ${r.rows} turns sent${r.limits ? ', limits updated' : ''}`)
  }
}

async function importHistory() {
  const agent = agentOf(arg('--agent') ?? 'claude')
  if (!agent?.importHistory) throw new Error('only Claude Code has an old history to import (Codex sends everything with sync)')
  const r = await agent.importHistory()
  if (r.missing) console.log(`${agent.title}: no logs in ${agent.home}`)
  else if (r.busy) console.log(`${agent.title}: another run is busy`)
  else console.log(`${agent.title}: found ${r.turns} turns in ${r.files} files, added ${r.inserted}, already there ${r.duplicates}, newer than the device ${r.afterLink} (collected live)`)
}

/** Starts `file list...` without a shell (so quotes in paths and in the JSON stay as they are); resolves with how it ended. */
const startDownstream = (file, list) => new Promise(resolve => {
  const t0 = Date.now()
  let child
  try { child = spawn(file, list, { shell: false, detached: true, stdio: 'ignore', windowsHide: true }) } catch (e) { return resolve({ error: errorCategory(e) }) }
  // Not waited for longer than 10 s and never killed: the other program may work longer on purpose.
  const timer = setTimeout(() => { child.unref(); resolve({ running: true }) }, 10_000)
  child.on('error', e => { clearTimeout(timer); resolve({ error: errorCategory(e) }) })
  child.on('exit', (exitCode, signal) => { clearTimeout(timer); resolve({ exitCode, signal, durationMs: Date.now() - t0 }) })
})

const hasSeparator = p => /[\\/]/.test(p)

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

  try { spawn(self[0], [...self.slice(1), 'sync'], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref(); logEvent({ event: 'sync_started' }) } catch (e) { logEvent({ event: 'sync_failed', error: errorCategory(e) }) }

  if (!then.length) return
  const program = basename(then[0])
  if (hasSeparator(then[0]) && !existsSync(then[0])) return logEvent({ event: 'downstream_missing', program }) // e.g. Codex moved its helper on an update
  // only counts: an argument may be a secret (--token ...), so no value of it is ever logged
  logEvent({ event: 'downstream_started', program, argumentCount: then.length - 1, hasJsonPayload: Boolean(payload) })
  const r = await startDownstream(then[0], [...then.slice(1), ...(payload ? [payload] : [])])
  if (r.running) logEvent({ event: 'downstream_still_running', program })
  else if (r.error) logEvent({ event: 'downstream_failed', program, error: r.error })
  else logEvent({ event: r.exitCode === 0 ? 'downstream_finished' : 'downstream_failed', program, exitCode: r.exitCode, signal: r.signal ?? null, durationMs: r.durationMs })
}

/**
 * An agent's `Stop` hook (Codex: hooks.json, Claude Code: settings.json): the agent writes a JSON about the finished turn on stdin
 * (session id, the path of the session file, the last answer ...). Only the path of the session file is used (to sync just that file);
 * the answer is never kept or printed. `--agent claude|codex` says whose hook it is (default codex).
 * Nothing is printed and the exit code is always 0: a Stop hook that prints JSON with "decision":"block" would make the agent go on.
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
  const agent = arg('--agent') === 'claude' ? 'claude' : 'codex'
  const named = typeof j.transcript_path === 'string' ? j.transcript_path : ''
  const file = (agent === 'codex' ? /rollout-.*\.jsonl$/i : /\.jsonl$/i).test(named) ? named : null
  logEvent({ event: 'hook_received', agent, hook: typeof j.hook_event_name === 'string' ? j.hook_event_name : null, hasSessionId: Boolean(j.session_id), hasTurnId: Boolean(j.turn_id), hasTranscript: Boolean(file), model: typeof j.model === 'string' ? j.model : null })
  try {
    spawn(self[0], [...self.slice(1), 'sync', '--agent', agent, ...(file ? ['--file', file] : [])], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref()
    logEvent({ event: 'sync_started', agent, scope: file ? 'file' : 'all' })
  } catch (e) { logEvent({ event: 'sync_failed', agent, error: errorCategory(e) }) }
}

function log() {
  const events = readLog(Number(arg('--last')) || 30)
  if (!events.length) return console.log('notify.log is empty: Codex has not called this program yet.')
  for (const e of events) { const { at, event, ...rest } = e; console.log(`${at}  ${event}${Object.keys(rest).length ? '  ' + JSON.stringify(rest) : ''}`) }
}

function status() {
  const cfg = readJson(configFile, null)
  console.log(`site:        ${cfg?.url ?? 'not linked'}`)
  for (const agent of AGENTS) {
    const st = agent.status()
    console.log(`${agent.title} home:`.padEnd(18) + `${agent.home}${agent.detect() ? '' : ' (not found)'}`)
    console.log(`  last sync:   ${st.lastSync ?? 'never'}; ${st.turns} turns sent from ${st.files} files`)
  }
}

function setup() {
  const hookDoc = JSON.stringify(withHook({}, codex.hookCommand()), null, 2).replace(/^/gm, '     ')
  const claudeDoc = JSON.stringify(withHook({}, claude.hookCommand()), null, 2).replace(/^/gm, '     ')
  console.log(`The easy way: run ${command(shown)} with no arguments and answer its questions. By hand:
1. Link this device once (make a code on the site: Devices tab, same device name as your Claude one):
     ${command(shown)} link <CODE>
2. Send what is already there:
     ${command(shown)} sync
3. Claude Code: its turns are read from its logs; keep that up to date with a Stop hook. Add this to ${claude.hooksJson}, next to any hooks it already has (the mod only reports the subscription limits):
${claudeDoc}
   It prints nothing and reads no text; the history from before this device was linked: ${command(shown)} import
4. Codex: keep it up to date with Codex's Stop hook (recommended; the only default). Add this to ${codex.hooksJson}, next to any hooks it already has:
${hookDoc}
   Codex runs it after each turn and may ask you once to trust the new hook. It prints nothing and reads no text.

Fallback only: use \`notify\` instead when your Codex is too old for hooks, or the Stop hook is unavailable or declined (never both). Add this line at the top level of ${codex.configToml} (before any [section]):
     ${codex.notifyLine()}
   Codex has a single notify command: if another program already uses it, run the guide (no arguments), which chains the two.
   Without either, run "sync" from cron / a systemd timer / Windows Task Scheduler every few minutes.`)
}

/**
 * `otlp-headers`: run by Claude Code (setting `otelHeadersHelper`) to get the headers of its OTLP export, so the device token
 * stays in config.json (mode 600) and is not copied into settings.json. Prints one JSON object and nothing else.
 */
function otlpHeaders() {
  const cfg = readJson(configFile, null)
  if (!cfg?.token) { process.exitCode = 1; return }
  console.log(JSON.stringify({ 'x-device-token': cfg.token }))
}

/** `otlp enable|disable|status`: Claude Code exports its API-request events straight to the site instead of the log collector (one source per agent). */
function otlp() {
  const cfg = readJson(configFile, null)
  const file = join(claude.home, 'settings.json')
  const helper = command([...self, 'otlp-headers'])
  const doc = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const url = cfg?.url
  const what = a1 ?? 'status'
  if (what === 'status') {
    console.log(`Claude Code over OTLP: ${url ? otlpState(doc, url, helper) === 'ours' ? 'on' : 'off' : 'not linked'}`)
  } else if (what === 'enable' || what === 'disable') {
    if (!cfg?.token) throw new Error('not linked yet: run the program without arguments, or: link <CODE>')
    if (existsSync(file)) copyFileSync(file, `${file}.token-tracker-backup`)
    if (what === 'enable') {
      writeFileSync(file, JSON.stringify(withOtlp(doc, url, helper), null, 2) + '\n')
      writeJson(configFile, { ...cfg, sources: { ...cfg.sources, claude: 'otlp' } }, 0o600)
      if (claude.hookState() === 'ours') claude.removeHook() // the log collector would count the same turns again
      console.log('Claude Code will export its API requests to the site (new sessions only). Restart Claude Code.')
    } else {
      writeFileSync(file, JSON.stringify(withoutOtlp(doc, url, helper), null, 2) + '\n')
      const { claude: _off, ...sources } = cfg.sources ?? {}
      writeJson(configFile, { ...cfg, sources }, 0o600)
      console.log('Claude Code OTLP export removed. Run "setup" to use the log collector again.')
    }
  } else usage(true)
}

function usage(bad) {
  console.log(`token-tracker: sends Claude Code and Codex token usage (numbers only, never your prompts or answers) to your tracker site.
usage: ${command(shown)} [link <CODE> | sync [--agent claude|codex] [--full] | import | hook-stop [--agent claude|codex] | notify | status | setup | otlp enable|disable|status | log]
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
  else if (cmd === 'import') await importHistory()
  else if (cmd === 'notify') await notify()
  else if (cmd === 'hook-stop') await hookStop()
  else if (cmd === 'otlp-headers') otlpHeaders()
  else if (cmd === 'otlp') otlp()
  else if (cmd === 'log') log()
  else if (cmd === 'status') status()
  else if (cmd === 'setup') setup()
  else if (!cmd && process.stdin.isTTY && process.stdout.isTTY) await interactive()
  else usage(Boolean(cmd))
} catch (e) {
  console.error('Error: ' + (e instanceof Error ? e.message : e))
  process.exitCode = 1
}
