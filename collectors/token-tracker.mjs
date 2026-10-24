#!/usr/bin/env node
// Token Tracker collector: sends the token usage of AI coding agents (now: OpenAI Codex) to the tracker site.
// Only token counts, timestamps, model names and ids leave the machine, never prompts, answers or tool output.
//
//   (no arguments)                       the guide: sets everything up the first time, then shows the status and sends what is new
//   link <CODE> [--url https://site]     once per device: a code made on the site (Devices tab)
//   sync [--full]                        send what is new (--full: send everything again)
//   notify [...]                         for Codex's `notify`: runs `sync` in the background
//   status | setup                       for scripts
//
// The device token and the list of what was sent live in ~/.token-tracker (TOKEN_TRACKER_HOME). CODEX_HOME is honoured.
import { spawn } from 'node:child_process'
import codex from './agents/codex.mjs'
import { arg, command, configFile, link, readJson, self, shown } from './lib/core.mjs'
import { interactive } from './wizard.mjs'

async function sync() {
  const full = process.argv.includes('--full')
  const r = await codex.sync({ full })
  if (r.missing) console.log(`no Codex data in ${codex.home}`)
  else if (r.busy) console.log('another sync is running')
  else console.log(`Codex: ${r.files} files, ${r.scanned} read, ${r.rows} turns sent${r.limits ? ', limits updated' : ''}`)
}

function notify() {
  // Codex adds one JSON argument (the last prompt and answer) at the end: it is never read here, only passed on untouched to the
  // command given after --then (the notify that was there before ours), and used as the signal to sync.
  const args = process.argv.slice(3)
  const payload = args.length && args[args.length - 1].startsWith('{') ? args.pop() : null
  const at = args.indexOf('--then')
  const then = at >= 0 ? args.slice(at + 1) : []
  const run = (file, list) => { try { spawn(file, list, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref() } catch { /* a missing program must not stop the other */ } }
  run(self[0], [...self.slice(1), 'sync'])
  if (then.length) run(then[0], [...then.slice(1), ...(payload ? [payload] : [])])
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
  else if (cmd === 'notify') notify()
  else if (cmd === 'status') status()
  else if (cmd === 'setup') setup()
  else if (!cmd && process.stdin.isTTY && process.stdout.isTTY) await interactive()
  else usage(Boolean(cmd))
} catch (e) {
  console.error('Error: ' + (e instanceof Error ? e.message : e))
  process.exitCode = 1
}
