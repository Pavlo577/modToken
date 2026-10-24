// Claude Code on this machine: its session logs (~/.claude/projects/**/*.jsonl, or $CLAUDE_CONFIG_DIR/projects) become turns.
// Only token counts, timestamps, model names and ids leave the machine, never prompts, answers or tool output.
//
// The turns come from the logs, by the same parser as the dashboard's import and the cloud hook (worker/public/admin/parse.mjs):
// a turn is one prompt and everything the model did until the next one. Claude Code tells us a turn ended with its `Stop` hook
// (~/.claude/settings.json), which gives the path of the session log; the numbers are read from that file.
// The subscription limits are not in the logs: the mod (hooks/register.ts) sends them.
//
// Which turns this collects: the ones that ended at or after `since` (config.json: the moment this device was linked here, or the moment
// the mod handed over to this program). Older ones are history: `importHistory` sends them under other ids (imp:) that the Worker only
// accepts for the time before the device existed, and ignores when it has them already; the mod (before it was limits-only) sent
// the ones in between.
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { createParser } from '../../worker/public/admin/parse.mjs'
import { BATCH } from '../lib/contract.mjs'
import { command, configFile, home, lock, post, postImport, readJson, self, writeJson } from '../lib/core.mjs'
import { otlpState, withOtlp, withoutOtlp } from '../lib/otlp-claude.mjs'
import { hasOurHook, isEmptyDoc, withHook, withoutHook } from '../lib/hooks-json.mjs'

const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const projectsDir = join(claudeHome, 'projects')
const settingsJson = join(claudeHome, 'settings.json')
const stateFile = join(home, 'claude-state.json')
const STATE_MAX_TURNS = 20_000

/** `[exe]` or `[node, script]` as a command line for Claude Code's hook shell (bash; on Windows Git Bash: forward slashes, double quotes). */
export function claudeHookCommand(selfCommand, platform = process.platform) {
  const q = a => (platform === 'win32' ? `"${a.replace(/\\/g, '/')}"` : `'${a.replace(/'/g, `'\\''`)}'`)
  return [...selfCommand.map(q), 'hook-stop', '--agent', 'claude'].join(' ')
}

function transcripts(dir) {
  const out = []
  const walk = d => {
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.jsonl')) out.push(p)
    }
  }
  walk(dir)
  return out.sort()
}

/** A hook may name only a real log below the projects directory (symlinks that lead out are refused). */
export function allowedTranscript(file) {
  if (typeof file !== 'string' || !file.endsWith('.jsonl')) return null
  let real, root
  try {
    real = realpathSync(file)
    if (!statSync(real).isFile()) return null
    root = realpathSync(projectsDir)
  } catch { return null }
  const rel = relative(root, real)
  return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? real : null
}

async function parseInto(parser, path) {
  for await (const line of createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })) parser.push(line)
  return parser.finish()
}

const signature = t => JSON.stringify([t.session_id, t.ts, t.model, t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_creation_tokens, t.duration_ms, t.is_subagent])
const keyOf = path => basename(path, '.jsonl') // the session id: the name of the log
const asRow = t => ({ ...t, provider: 'claude', turn_id: t.turn_id.replace(/^imp:/, 'cc:') })

export default {
  id: 'claude',
  title: 'Claude Code',
  home: claudeHome,

  detect: () => existsSync(claudeHome),

  /**
   * Claude Code is collected only when the user chose it: its Stop hook is ours, or the guide enabled it. (A user who set the program up
   * for Codex alone must not start sending Claude turns without having said so.)
   */
  enabled() { return readJson(configFile, {}).sources?.claude === 'otlp' || this.hookState() === 'ours' || readJson(stateFile, {}).enabled === true },
  enable() { const st = readJson(stateFile, { files: {}, sent: {} }); st.enabled = true; writeJson(stateFile, st) },

  /**
   * Sends the turns that ended since `config.since`. `only`: the log a hook named (and the logs of the session's sub-agents beside it).
   * Returns { files, scanned, rows, limits: false }; keeps `lastSync` / `lastError` in its state file.
   */
  async sync({ full = false, onFile, only } = {}) {
    const cfg = readJson(configFile, null)
    if (!cfg?.token) throw new Error('not linked yet: run the program without arguments, or: link <CODE>')
    if (cfg.sources?.claude === 'otlp') return { files: 0, scanned: 0, rows: 0, limits: false, otlp: true } // OTLP is the source: reading the logs too would count twice
    if (!existsSync(projectsDir)) return { files: 0, scanned: 0, rows: 0, limits: false, missing: true }
    const unlock = lock('claude')
    if (!unlock) return { files: 0, scanned: 0, rows: 0, limits: false, busy: true }
    const state = readJson(stateFile, { files: {}, sent: {} })
    state.files ??= {}; state.sent ??= {}
    state.since ??= new Date().toISOString() // a device linked before this program knew `since`: from now on
    const sinceMs = Date.parse(cfg.since ?? state.since)
    const stats = { files: 0, scanned: 0, rows: 0, limits: false }
    try {
      let paths = transcripts(projectsDir)
      if (only) {
        const main = allowedTranscript(only)
        const family = main ? [main, ...transcripts(join(dirname(main), basename(main, '.jsonl')))] : []
        paths = family
      }
      const seen = new Set() // the same message in two logs (a copied session) is counted once
      for (const [n, path] of paths.entries()) {
        onFile?.(n + 1, paths.length)
        stats.files++
        const st = statSync(path)
        const fileSig = `${st.size}:${Math.floor(st.mtimeMs)}`
        if (!full && !only && state.files[path] === fileSig) continue
        stats.scanned++
        const turns = (await parseInto(createParser(keyOf(path), seen), path)).map(asRow).filter(t => Date.parse(t.ts) >= sinceMs)
        const fresh = turns.filter(t => full || state.sent[t.turn_id]?.sig !== signature(t))
        for (let i = 0; i < fresh.length; i += BATCH) await post(cfg, { rows: fresh.slice(i, i + BATCH) })
        for (const t of fresh) state.sent[t.turn_id] = { sig: signature(t), at: t.ts }
        stats.rows += fresh.length
        state.files[path] = fileSig // only after the rows of this file were accepted
        writeJson(stateFile, state)
      }
      // bounded: forget the oldest remembered turns and the logs that are gone (a forgotten turn is at worst sent again, which is harmless)
      const present = new Set(transcripts(projectsDir))
      for (const p of Object.keys(state.files)) if (!present.has(p)) delete state.files[p]
      const ids = Object.keys(state.sent)
      if (ids.length > STATE_MAX_TURNS) for (const id of ids.sort((a, b) => Date.parse(state.sent[a].at) - Date.parse(state.sent[b].at)).slice(0, ids.length - STATE_MAX_TURNS)) delete state.sent[id]
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

  /**
   * The history from before this device existed: every turn of every log, as `imp:<path>:<n>` (the Worker keeps only the ones older than
   * the device and ignores repeats, so this is safe to run again and on a device that was linked long ago).
   * Returns { files, turns, inserted, duplicates, afterLink }.
   */
  async importHistory({ onFile } = {}) {
    const cfg = readJson(configFile, null)
    if (!cfg?.token) throw new Error('not linked yet: run the program without arguments, or: link <CODE>')
    const total = { files: 0, turns: 0, inserted: 0, duplicates: 0, afterLink: 0 }
    if (!existsSync(projectsDir)) return { ...total, missing: true }
    const unlock = lock('claude')
    if (!unlock) return { ...total, busy: true }
    try {
      const seen = new Set()
      const paths = transcripts(projectsDir)
      for (const [n, path] of paths.entries()) {
        onFile?.(n + 1, paths.length)
        const key = relative(projectsDir, path).split(sep).join('/').replace(/\.jsonl$/, '') // the same key the website import builds
        const turns = await parseInto(createParser(key, seen), path)
        total.files++; total.turns += turns.length
        for (let i = 0; i < turns.length; i += BATCH) {
          const r = await postImport(cfg, turns.slice(i, i + BATCH).map(t => ({ ...t, provider: 'claude' })))
          total.inserted += r.inserted ?? 0; total.duplicates += r.duplicates ?? 0; total.afterLink += r.afterLink ?? 0
        }
      }
      return total
    } finally { unlock() }
  },

  status() {
    const st = readJson(stateFile, null)
    return { lastSync: st?.lastSync ?? null, lastError: st?.lastError ?? null, turns: Object.keys(st?.sent ?? {}).length, files: Object.keys(st?.files ?? {}).length }
  },

  // ---- the Stop hook in ~/.claude/settings.json (hooks live side by side there; the cloud setup script adds its own, which this ignores)
  hooksJson: settingsJson,
  hookCommand: () => claudeHookCommand(self),

  /** 'ours' | 'none' | 'unreadable' (not valid JSON: never touched). */
  hookState() {
    if (!existsSync(settingsJson)) return 'none'
    try { return hasOurHook(JSON.parse(readFileSync(settingsJson, 'utf8')), self) ? 'ours' : 'none' } catch { return 'unreadable' }
  },

  installHook() {
    const state = this.hookState()
    if (state === 'ours' || state === 'unreadable') return { changed: false, state }
    const had = existsSync(settingsJson)
    const copy = had ? backup(settingsJson) : null
    const doc = had ? JSON.parse(readFileSync(settingsJson, 'utf8')) : {}
    mkdirSync(claudeHome, { recursive: true })
    writeFileSync(settingsJson, JSON.stringify(withHook(doc, this.hookCommand()), null, 2) + '\n')
    return { changed: true, state, backup: copy }
  },

  removeHook() {
    if (this.hookState() !== 'ours') return { changed: false }
    const copy = backup(settingsJson)
    const doc = withoutHook(JSON.parse(readFileSync(settingsJson, 'utf8')), self)
    if (isEmptyDoc(doc)) unlinkSync(settingsJson)
    else writeFileSync(settingsJson, JSON.stringify(doc, null, 2) + '\n')
    return { changed: true, backup: copy }
  },
  // ---- OTLP: Claude Code exports its API requests to the site itself (the main way); the log collector and the Stop hook then step aside
  otlpHelper() { return command([...self, 'otlp-headers']) },
  /** 'ours' | 'none' | 'other' (the user's own OpenTelemetry settings) | 'unreadable' | 'unlinked' */
  otlpState() {
    const url = readJson(configFile, {}).url
    if (!url) return 'unlinked'
    if (!existsSync(settingsJson)) return 'none'
    try { return otlpState(JSON.parse(readFileSync(settingsJson, 'utf8')), url, this.otlpHelper()) } catch { return 'unreadable' }
  },
  enableOtlp() {
    const cfg = readJson(configFile, null)
    if (!cfg?.token) throw new Error('not linked yet: run the program without arguments, or: link <CODE>')
    const had = existsSync(settingsJson)
    const copy = had ? backup(settingsJson) : null
    mkdirSync(claudeHome, { recursive: true })
    writeFileSync(settingsJson, JSON.stringify(withOtlp(had ? JSON.parse(readFileSync(settingsJson, 'utf8')) : {}, cfg.url, this.otlpHelper()), null, 2) + '\n')
    writeJson(configFile, { ...cfg, sources: { ...cfg.sources, claude: 'otlp' } }, 0o600)
    if (this.hookState() === 'ours') this.removeHook() // the same turns would be counted twice
    return { backup: copy }
  },
  disableOtlp() {
    const cfg = readJson(configFile, null)
    if (!cfg?.token) throw new Error('not linked yet')
    const copy = existsSync(settingsJson) ? backup(settingsJson) : null
    if (copy) {
      const doc = withoutOtlp(JSON.parse(readFileSync(settingsJson, 'utf8')), cfg.url, this.otlpHelper())
      if (isEmptyDoc(doc)) unlinkSync(settingsJson)
      else writeFileSync(settingsJson, JSON.stringify(doc, null, 2) + '\n')
    }
    const { claude: _off, ...sources } = cfg.sources ?? {}
    writeJson(configFile, { ...cfg, sources }, 0o600)
    return { backup: copy }
  },
}

function backup(file) { // a name that is never taken
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let to = `${file}.bak-${stamp}`
  for (let n = 2; existsSync(to); n++) to = `${file}.bak-${stamp}-${n}`
  copyFileSync(file, to)
  return to
}
