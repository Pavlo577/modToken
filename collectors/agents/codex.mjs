// OpenAI Codex: reads the rollout files Codex writes (~/.codex/sessions, ~/.codex/archived_sessions) line by line.
// Only token counts, timestamps, model names and ids leave the machine, never prompts, answers or tool output.
import { createReadStream, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { createCodexParser } from '../../worker/public/admin/parse-codex.mjs'
import { configFile, home, lock, post, quoted, readJson, self, writeJson } from '../lib/core.mjs'

const BATCH = 300
const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
const configToml = join(codexHome, 'config.toml')
const stateFile = join(home, 'codex-state.json')

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

const sig = t => `${t.input_tokens},${t.output_tokens},${t.cache_read_tokens},${t.cache_creation_tokens}`

// The `notify` line of config.toml: only the top level counts (before the first [section]); a TOML array may span lines.
const topLevel = text => { const i = text.search(/^\s*\[/m); return i < 0 ? text : text.slice(0, i) }
const isOurs = text => /token-tracker|collectors[\\/]+(codex|token-tracker)\.mjs/.test(text) || text.includes(self[0].replace(/\\/g, '\\\\'))

export default {
  id: 'codex',
  title: 'OpenAI Codex',
  home: codexHome,

  detect: () => existsSync(codexHome),

  /**
   * Sends what is new. `onFile(i, total)` is called for each rollout file looked at.
   * Returns { files, scanned, rows, limits } and keeps `lastSync` / `lastError` in the state file.
   */
  async sync({ full = false, onFile } = {}) {
    const cfg = readJson(configFile, null)
    if (!cfg?.token) throw new Error('not linked yet: run the program without arguments, or: link <CODE>')
    const state = readJson(stateFile, { files: {}, sent: {}, limits: '' })
    if (!existsSync(codexHome)) return { files: 0, scanned: 0, rows: 0, limits: false, missing: true }
    const unlock = lock('codex')
    if (!unlock) return { files: 0, scanned: 0, rows: 0, limits: false, busy: true }
    const stats = { files: 0, scanned: 0, rows: 0, limits: false }
    try {
      let limits = [], limitsAt = ''
      const paths = rollouts()
      for (const [n, path] of paths.entries()) {
        onFile?.(n + 1, paths.length)
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

  notifyLine: () => `notify = [${quoted([...self, 'notify'])}]`,
  configToml,

  /** 'ours' | 'other' (someone else's notify, never touched) | 'none' | 'no-config' */
  notifyState() {
    let text
    try { text = readFileSync(configToml, 'utf8') } catch { return 'no-config' }
    const m = topLevel(text).match(/^\s*notify\s*=\s*(\[[\s\S]*?\]|.*)$/m)
    if (!m) return 'none'
    return isOurs(m[1]) ? 'ours' : 'other'
  },

  /** Adds our `notify` line at the very top of config.toml (a copy of the old file is kept next to it). */
  installNotify() {
    const state = this.notifyState()
    if (state === 'ours' || state === 'other') return { changed: false, state }
    const old = state === 'none' ? readFileSync(configToml, 'utf8') : ''
    let backup = null
    if (state === 'none') {
      backup = `${configToml}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
      copyFileSync(configToml, backup)
    } else mkdirSync(codexHome, { recursive: true })
    writeFileSync(configToml, `# token-tracker: tells the collector that a Codex turn ended (it reads no text)\n${this.notifyLine()}\n${old ? '\n' + old : ''}`)
    return { changed: true, state, backup }
  },
}
