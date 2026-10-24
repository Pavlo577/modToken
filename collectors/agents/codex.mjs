// OpenAI Codex: reads the rollout files Codex writes (~/.codex/sessions, ~/.codex/archived_sessions) line by line.
// Only token counts, timestamps, model names and ids leave the machine, never prompts, answers or tool output.
import { createReadStream, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { createCodexParser } from '../../worker/public/admin/parse-codex.mjs'
import { configFile, home, lock, post, readJson, self, writeJson } from '../lib/core.mjs'
import { BATCH } from '../lib/contract.mjs'
import { chainArgv, directOurs, isOurs as ours, stripOurs } from '../lib/notify-chain.mjs'
import { hasOurHook, hookCommand, isEmptyDoc, withHook, withoutHook } from '../lib/hooks-json.mjs'
import { findNotify, formatNotify } from '../lib/toml-notify.mjs'

const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
const configToml = join(codexHome, 'config.toml')
const hooksJson = join(codexHome, 'hooks.json')
const stateFile = join(home, 'codex-state.json')
const originalFile = join(home, 'notify-original.json') // the notify Codex had before ours took its place

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

export const rowSignature = t => JSON.stringify([
  t.provider, t.turn_id, t.session_id, t.ts, t.model,
  t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_creation_tokens,
  t.duration_ms, t.is_subagent,
])

/** A hook may name only a real rollout below Codex's sessions directories; symlink escapes are rejected. */
export function allowedRollout(file) {
  if (typeof file !== 'string' || !/^rollout-.*\.jsonl$/.test(basename(file))) return null
  let real
  try {
    real = realpathSync(resolve(file))
    if (!statSync(real).isFile()) return null
  } catch { return null }
  for (const dir of [join(codexHome, 'sessions'), join(codexHome, 'archived_sessions')]) {
    let root
    try { root = realpathSync(dir) } catch { continue }
    const rel = relative(root, real)
    if (rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)) return real
  }
  return null
}

const isOurs = argv => ours(argv, self)
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')
const backup = (file = configToml) => { // a name that is never taken: two copies in the same millisecond must not overwrite each other
  let to = `${file}.bak-${stamp()}`
  for (let n = 2; existsSync(to); n++) to = `${file}.bak-${stamp()}-${n}`
  copyFileSync(file, to)
  return to
}

export default {
  id: 'codex',
  title: 'OpenAI Codex',
  home: codexHome,

  detect: () => existsSync(codexHome),

  /**
   * Sends what is new. `onFile(i, total)` is called for each rollout file looked at.
   * Returns { files, scanned, rows, limits } and keeps `lastSync` / `lastError` in the state file.
   */
  async sync({ full = false, onFile, only } = {}) {
    const cfg = readJson(configFile, null)
    if (!cfg?.token) throw new Error('not linked yet: run the program without arguments, or: link <CODE>')
    const state = readJson(stateFile, { files: {}, sent: {}, limits: '' })
    if (!existsSync(codexHome)) return { files: 0, scanned: 0, rows: 0, limits: false, missing: true }
    const unlock = lock('codex')
    if (!unlock) return { files: 0, scanned: 0, rows: 0, limits: false, busy: true }
    const stats = { files: 0, scanned: 0, rows: 0, limits: false }
    try {
      let limits = [], limitsAt = 0
      // `only`: the one rollout a hook named (it must look like a rollout file and exist); else every rollout
      const paths = only ? [allowedRollout(only)].filter(Boolean) : rollouts()
      for (const [n, path] of paths.entries()) {
        onFile?.(n + 1, paths.length)
        stats.files++
        const st = statSync(path)
        const fileSig = `${st.size}:${Math.floor(st.mtimeMs)}`
        if (!full && state.files[path] === fileSig) continue
        stats.scanned++
        const { turns, limits: l, limitsAt: fileLimitsAt } = await parseFile(path)
        if (l.length && fileLimitsAt !== null && fileLimitsAt >= limitsAt) { limits = l; limitsAt = fileLimitsAt }
        const fresh = turns.filter(t => full || state.sent[t.turn_id] !== rowSignature(t))
        for (let i = 0; i < fresh.length; i += BATCH) await post(cfg, { rows: fresh.slice(i, i + BATCH) })
        for (const t of fresh) state.sent[t.turn_id] = rowSignature(t)
        stats.rows += fresh.length
        state.files[path] = fileSig // only after the rows of this file were accepted
        writeJson(stateFile, state)
      }
      const limitsSig = JSON.stringify(limits)
      if (limits.length && (full || limitsSig !== state.limits)) {
        await post(cfg, { rows: [], limits })
        state.limits = limitsSig
        stats.limits = true
      }
      state.lastSync = new Date().toISOString()
      delete state.lastError
      writeJson(stateFile, state)
      return stats
    } catch (e) {
      state.lastError = { at: new Date().toISOString(), message: e instanceof Error ? e.message : String(e) }
      writeJson(stateFile, state)
      throw e
    } finally { unlock() }
  },

  /** What the state file knows: no texts in it, only counters, ids and times. */
  status() {
    const st = readJson(stateFile, null)
    return { lastSync: st?.lastSync ?? null, lastError: st?.lastError ?? null, turns: Object.keys(st?.sent ?? {}).length, files: Object.keys(st?.files ?? {}).length }
  },

  /** The notify of this program: a bare one, or wrapping `then` (the command that was there first). */
  notifyArgv: then => [...self, 'notify', ...(then?.length ? ['--then', ...then] : [])],
  notifyLine(then) { return formatNotify(this.notifyArgv(then)) },
  configToml,

  /**
   * 'ours' | 'other' (a notify of another program) | 'none' | 'no-config'.
   * 'other' also with `argv` (what it runs, null if it cannot be read as plain strings).
   */
  notifyInfo() {
    let text
    try { text = readFileSync(configToml, 'utf8') } catch { return { state: 'no-config' } }
    const f = findNotify(text)
    if (!f) return { state: 'none' }
    if (f.argv && isOurs(f.argv)) return { state: 'ours', argv: f.argv }
    if (!f.argv && isOurs([text.slice(f.start, f.end)])) return { state: 'ours', argv: null }
    return { state: 'other', argv: f.argv }
  },
  notifyState() { return this.notifyInfo().state },

  /**
   * Puts our `notify` into config.toml; a copy of the old file is kept next to it.
   * No notify yet: our line is added at the top. Another program's notify: only with `chain`, then ours runs first and
   * starts that command afterwards with the same arguments (Codex allows a single notify command); the old one is remembered.
   */
  installNotify({ chain = false } = {}) {
    const info = this.notifyInfo()
    if (info.state === 'ours') return { changed: false, state: 'ours' }
    if (info.state === 'no-config' || info.state === 'none') {
      mkdirSync(codexHome, { recursive: true })
      const old = info.state === 'none' ? readFileSync(configToml, 'utf8') : ''
      const copy = info.state === 'none' ? backup() : null
      writeFileSync(configToml, `# token-tracker: tells the collector that a Codex turn ended (it reads no text)\n${this.notifyLine()}\n${old ? '\n' + old : ''}`)
      return { changed: true, state: info.state, backup: copy }
    }
    if (!chain || !info.argv?.length) return { changed: false, state: 'other', argv: info.argv }
    const text = readFileSync(configToml, 'utf8'), f = findNotify(text)
    const copy = backup()
    writeJson(originalFile, { argv: info.argv, text: text.slice(f.start, f.end), at: new Date().toISOString() })
    writeFileSync(configToml, `${text.slice(0, f.start)}# token-tracker runs together with the command that was here before (kept in ${originalFile})\n${formatNotify(this.chainArgv(info.argv))}${text.slice(f.end)}`)
    return { changed: true, state: 'other', chained: info.argv, backup: copy }
  },

  /** What the notify becomes when our command joins `argv`: the line shown to the user before anything is written. */
  chainArgv: argv => chainArgv(argv, self),
  chainLine(argv) { return formatNotify(this.chainArgv(argv)) },

  hooksJson,
  hookCommand: () => hookCommand(self),

  /** 'ours' | 'none' (hooks.json without ours, or no file) | 'unreadable' (not valid JSON: never touched). */
  hookState() {
    if (!existsSync(hooksJson)) return 'none'
    try { return hasOurHook(JSON.parse(readFileSync(hooksJson, 'utf8')), self) ? 'ours' : 'none' } catch { return 'unreadable' }
  },

  /** Adds our Stop hook next to the others in hooks.json; a copy of the old file is kept. Codex asks the user to trust a new hook. */
  installHook() {
    const state = this.hookState()
    if (state === 'ours' || state === 'unreadable') return { changed: false, state }
    const had = existsSync(hooksJson)
    const copy = had ? backup(hooksJson) : null
    const doc = had ? JSON.parse(readFileSync(hooksJson, 'utf8')) : {}
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(hooksJson, JSON.stringify(withHook(doc, hookCommand(self)), null, 2) + '\n')
    return { changed: true, state, backup: copy }
  },

  /** Takes our hook out again, leaving every other hook; an empty file is removed. */
  removeHook() {
    if (this.hookState() !== 'ours') return { changed: false }
    const copy = backup(hooksJson)
    const doc = withoutHook(JSON.parse(readFileSync(hooksJson, 'utf8')), self)
    if (isEmptyDoc(doc)) unlinkSync(hooksJson)
    else writeFileSync(hooksJson, JSON.stringify(doc, null, 2) + '\n')
    return { changed: true, backup: copy }
  },

  /**
   * Things wrong with the notify now: our program moved, or the command kept next to ours is gone (Codex moves its helpers when it updates).
   * [{ kind, program }]; empty when all is well or our notify is not connected.
   */
  notifyProblems() {
    const info = this.notifyInfo()
    if (info.state !== 'ours' || !info.argv) return []
    const out = []
    const gone = (kind, argv) => { if (argv?.[0] && /[\\/]/.test(argv[0]) && !existsSync(argv[0])) out.push({ kind, program: argv[0] }) }
    gone('ours', directOurs(info.argv, self) ? info.argv : null)
    gone('other', stripOurs(info.argv, self))
    return out
  },

  /** Turns our notify off: what was there before comes back, or the line is removed if there was nothing. */
  restoreNotify() {
    const info = this.notifyInfo()
    if (info.state !== 'ours' || !info.argv) return { changed: false, state: info.state }
    const text = readFileSync(configToml, 'utf8'), f = findNotify(text)
    const copy = backup()
    const saved = readJson(originalFile, null)
    const left = stripOurs(info.argv, self)
    // the line as it was before we came, if it is what is left; else a fresh one; nothing when nothing is left
    const statement = !left ? '' : saved?.argv && JSON.stringify(saved.argv) === JSON.stringify(left) ? saved.text : formatNotify(left)
    // the comment line we wrote above the statement goes with it
    const before = text.slice(0, f.start).replace(/(^|\n)[ \t]*# token-tracker[^\n]*\n$/, '$1')
    writeFileSync(configToml, `${before}${statement}${text.slice(f.end)}`.replace(/^\n+/, ''))
    try { unlinkSync(originalFile) } catch { /* none */ }
    return { changed: true, restored: left, backup: copy }
  },
}
