#!/usr/bin/env node
// Sends the token usage of OpenAI Codex CLI sessions to the tracker site.
// Reads the rollout files Codex writes (~/.codex/sessions, ~/.codex/archived_sessions) line by line; only token counts,
// timestamps, model names and ids leave the machine, never prompts, answers or tool output.
//
//   node collectors/codex.mjs link <CODE> [--url https://your-site]   once per device: a code made on the site (Devices tab)
//   node collectors/codex.mjs sync [--full]                           send what is new (--full: send everything again)
//   node collectors/codex.mjs notify [...]                            for Codex's `notify`: runs `sync` in the background
//   node collectors/codex.mjs status | setup
//
// The device token and the list of what was sent live in ~/.token-tracker (TOKEN_TRACKER_HOME). CODEX_HOME is honoured.
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, statSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { createCodexParser } from '../worker/public/admin/parse-codex.mjs'

const DEFAULT_URL = 'https://track.brolafkodev.pp.ua'
const BATCH = 300
const home = process.env.TOKEN_TRACKER_HOME || join(homedir(), '.token-tracker')
const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
const configFile = join(home, 'config.json')
const stateFile = join(home, 'codex-state.json')
const lockFile = join(home, 'codex-sync.lock')

const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback } }
const writeJson = (file, data, mode) => { mkdirSync(home, { recursive: true }); writeFileSync(file, JSON.stringify(data), { mode }) }
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }

// ---------------------------------------------------------------- link
async function link(code) {
  if (!code) throw new Error('usage: codex.mjs link <CODE> [--url https://your-site]')
  const url = (arg('--url') || readJson(configFile, {}).url || DEFAULT_URL).replace(/\/$/, '')
  const res = await fetch(`${url}/api/link`, { method: 'POST', body: JSON.stringify({ code }) })
  if (!res.ok) throw new Error(res.status === 403 ? 'the code is wrong, used or expired: make a new one on the site' : `site answered HTTP ${res.status}`)
  const { token, device } = await res.json()
  writeJson(configFile, { url, token }, 0o600)
  console.log(`linked as "${device}". Now run: ${command(shown)} sync`)
}

// ---------------------------------------------------------------- finding the rollouts
function rollouts() {
  const out = []
  const walk = dir => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/^rollout-.*\.jsonl$/.test(e.name)) out.push(p)
    }
  }
  walk(join(codexHome, 'sessions'))
  walk(join(codexHome, 'archived_sessions'))
  return out.sort((a, b) => (a.split(sep).pop() < b.split(sep).pop() ? -1 : 1)) // the names start with the start time
}

async function parseFile(path) {
  const key = relative(codexHome, path).split(sep).join('/').replace(/\.jsonl$/, '')
  const parser = createCodexParser(key)
  for await (const line of createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })) parser.push(line)
  return parser.finish()
}

// ---------------------------------------------------------------- sending
async function post(cfg, body) {
  const res = await fetch(`${cfg.url}/api/ingest`, { method: 'POST', headers: { 'x-device-token': cfg.token, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (res.status === 401) throw new Error('the device token was rejected (revoked?): link again with a new code')
  if (!res.ok) throw new Error(`site answered HTTP ${res.status}`)
}

const sig = t => `${t.input_tokens},${t.output_tokens},${t.cache_read_tokens},${t.cache_creation_tokens}`

function lock() {
  try { if (Date.now() - statSync(lockFile).mtimeMs > 5 * 60_000) unlinkSync(lockFile) } catch { /* no lock */ }
  try { mkdirSync(home, { recursive: true }); closeSync(openSync(lockFile, 'wx')); return true } catch { return false }
}
const unlock = () => { try { unlinkSync(lockFile) } catch { /* gone */ } }

async function sync() {
  const cfg = readJson(configFile, null)
  if (!cfg?.token) throw new Error('not linked yet: node collectors/codex.mjs link <CODE>')
  if (!existsSync(codexHome)) { console.log(`no Codex data in ${codexHome}`); return }
  if (!lock()) { console.log('another sync is running'); return }
  try {
    const state = readJson(stateFile, { files: {}, sent: {}, limits: '' })
    const full = process.argv.includes('--full')
    const stats = { files: 0, scanned: 0, rows: 0 }
    let limits = [], limitsAt = ''
    for (const path of rollouts()) {
      stats.files++
      const st = statSync(path)
      const fileSig = `${st.size}:${Math.floor(st.mtimeMs)}`
      if (!full && state.files[path] === fileSig) continue
      stats.scanned++
      const { turns, limits: l } = await parseFile(path)
      if (l.length && st.mtime.toISOString() >= limitsAt) { limits = l; limitsAt = st.mtime.toISOString() }
      const fresh = turns.filter(t => full || state.sent[t.turn_id] !== sig(t))
      for (let i = 0; i < fresh.length; i += BATCH) await post(cfg, { rows: fresh.slice(i, i + BATCH) })
      for (const t of fresh) state.sent[t.turn_id] = sig(t)
      stats.rows += fresh.length
      state.files[path] = fileSig // only after the rows of this file were accepted
      writeJson(stateFile, state)
    }
    const limitsSig = JSON.stringify(limits)
    if (limits.length && (full || limitsSig !== state.limits)) {
      await post(cfg, { rows: [], limits })
      state.limits = limitsSig
    }
    state.lastSync = new Date().toISOString()
    writeJson(stateFile, state)
    console.log(`Codex: ${stats.files} files, ${stats.scanned} read, ${stats.rows} turns sent${limits.length ? ', limits updated' : ''}`)
  } finally { unlock() }
}

// ---------------------------------------------------------------- the rest
// Run as a script ("node codex.mjs") or as the single file made by "bun build --compile" (release binary): how to start itself again.
const compiled = /\$bunfs|~BUN/.test(import.meta.url)
const self = compiled ? [process.execPath] : [process.execPath, fileURLToPath(import.meta.url)]
const shown = compiled ? [process.execPath] : ['node', fileURLToPath(import.meta.url)]
const quoted = list => list.map(a => `"${a.replace(/\\/g, '\\\\')}"`).join(', ')
const command = list => list.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')

function notify() {
  // Codex passes a JSON argument with the last prompt and answer: it is never read here, only used as a signal.
  const child = spawn(self[0], [...self.slice(1), 'sync'], { detached: true, stdio: 'ignore' })
  child.unref()
}

function status() {
  const cfg = readJson(configFile, null), st = readJson(stateFile, null)
  console.log(`site:        ${cfg?.url ?? 'not linked'}`)
  console.log(`Codex home:  ${codexHome}${existsSync(codexHome) ? '' : ' (not found)'}`)
  console.log(`last sync:   ${st?.lastSync ?? 'never'}; ${Object.keys(st?.sent ?? {}).length} turns sent from ${Object.keys(st?.files ?? {}).length} files`)
}

function setup() {
  console.log(`1. Link this device once (make a code on the site: Devices tab, same device name as your Claude one):
     ${command(shown)} link <CODE>
2. Send what is already there:
     ${command(shown)} sync
3. Keep it up to date: add this line at the top level of ${join(codexHome, 'config.toml')} (before any [section]):
     notify = [${quoted([...shown, 'notify'])}]
   Codex then runs it after each turn; it only wakes the collector and reads nothing from what Codex passes.
   Or run "sync" from cron / a systemd timer / Windows Task Scheduler every few minutes.`)
}

async function usage(cmd) {
  console.log(`token-tracker: sends Codex token usage (numbers only, never your prompts or answers) to your tracker site.

usage: ${command(shown)} link <CODE> | sync [--full] | notify | status | setup

This is a command-line program: open a terminal (Windows: PowerShell or cmd) in the folder where it is and run, in order:
  ${command(shown)} link <CODE>     (the code is made on the site: Devices tab)
  ${command(shown)} sync
  ${command(shown)} setup           (prints the line that keeps it up to date after every Codex turn)`)
  process.exitCode = cmd ? 2 : 0
  // Started by a double click on Windows the window would vanish before it can be read.
  if (!cmd && process.platform === 'win32' && process.stdin.isTTY) {
    process.stdout.write('\nPress Enter to close...')
    await new Promise(done => { process.stdin.once('data', done); process.stdin.resume() })
  }
}

const [cmd, a1] = process.argv.slice(2)
try {
  if (cmd === 'link') await link(a1)
  else if (cmd === 'sync') await sync()
  else if (cmd === 'notify') notify()
  else if (cmd === 'status') status()
  else if (cmd === 'setup') setup()
  else await usage(cmd)
} catch (e) {
  console.error('Error: ' + (e instanceof Error ? e.message : e))
  process.exitCode = 1
}
