// Google Antigravity CLI / IDE: reads the conversation databases it keeps (~/.gemini/antigravity/conversations/<id>.db, read-only).
// Only token counts, times, model names and ids leave the machine: `steps.metadata` and `gen_metadata.data` are decoded field by
// field (lib/antigravity-pb.mjs), and `steps.step_payload`, where the content lives, is never selected.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { configFile, home, lock, post, readJson, writeJson } from '../lib/core.mjs'
import { BATCH } from '../lib/contract.mjs'
import { openSqlite } from '../lib/antigravity-db.mjs'
import { readGeneration, readStep } from '../lib/antigravity-pb.mjs'

const stateFile = join(home, 'antigravity-state.json')
const stateMaxTurns = Math.max(1, Number(process.env.TOKEN_TRACKER_STATE_MAX_TURNS) || 10_000)
const stateRetentionMs = Math.max(1, Number(process.env.TOKEN_TRACKER_STATE_RETENTION_DAYS) || 90) * 86_400_000

/** The CLI and the IDE keep their own homes; `ANTIGRAVITY_HOME` (a list, separated like PATH) replaces both. */
const homes = () => process.env.ANTIGRAVITY_HOME
  ? process.env.ANTIGRAVITY_HOME.split(delimiter).filter(Boolean)
  : [join(homedir(), '.gemini', 'antigravity'), join(homedir(), '.gemini', 'antigravity-ide')]

function databases() {
  const out = []
  for (const h of homes()) {
    let names
    try { names = readdirSync(join(h, 'conversations')) } catch { continue }
    for (const n of names) if (/\.db$/.test(n)) out.push({ path: join(h, 'conversations', n), home: h })
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1))
}

/** The database changes in its `-wal` file first, so both count for "did it change". */
function signature(path) {
  const part = p => { try { const s = statSync(p); return `${s.size}:${Math.floor(s.mtimeMs)}` } catch { return '-' } }
  return `${part(path)}|${part(path + '-wal')}`
}

/**
 * The turns of one conversation: a turn is one input of the user and every model call until the next one (they share the
 * `turn` id of the step metadata); its tokens are the sum of its calls. Pure, so the tests can feed it synthetic steps.
 * @param {{ conversation: string, steps: ReturnType<typeof readStep>[], generations: ReturnType<typeof readGeneration>[], subagent?: boolean }} c
 */
export function buildTurns({ conversation, steps, generations, subagent = false }) {
  const modelOf = new Map(generations.filter(g => g?.message && g.model).map(g => [g.message, g.model]))
  const turns = new Map()
  steps.forEach((s, n) => {
    if (!s) return
    const key = s.turn || `step-${n}`
    const t = turns.get(key) ?? { start: 0, end: 0, calls: new Set(), input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: '' }
    turns.set(key, t)
    if (s.created && (!t.start || s.created < t.start)) t.start = s.created
    if (!s.usage || (s.usage.message && t.calls.has(s.usage.message))) return // no tokens, or the same call twice
    if (s.usage.message) t.calls.add(s.usage.message)
    t.input += s.usage.input
    t.output += s.usage.output
    t.cacheRead += s.usage.cacheRead
    t.cacheWrite += s.usage.cacheWrite
    t.end = Math.max(t.end, s.ended || s.started || s.created)
    t.model = modelOf.get(s.usage.message) || t.model
    t.used = true
  })
  const rows = []
  for (const [key, t] of turns) {
    if (!t.used || !t.end) continue
    rows.push({
      provider: 'antigravity', turn_id: `antigravity:${conversation}:${key}`, session_id: conversation, ts: new Date(t.end).toISOString(),
      model: t.model || 'unknown', input_tokens: t.input, output_tokens: t.output, cache_read_tokens: t.cacheRead, cache_creation_tokens: t.cacheWrite,
      duration_ms: t.start && t.end > t.start ? t.end - t.start : 0, is_subagent: subagent,
    })
  }
  return rows
}

/** Which conversations are helpers of another one (the summaries database of the same home). */
async function childConversations(h) {
  try {
    const db = await openSqlite(join(h, 'conversation_summaries.db'), { readOnly: true })
    try { return new Set(db.all('SELECT conversation_id FROM conversation_parents').map(r => r.conversation_id)) } finally { db.close() }
  } catch { return new Set() }
}

export async function parseDatabase(path, children = new Set()) {
  const conversation = basename(path).replace(/\.db$/, '')
  const db = await openSqlite(path, { readOnly: true })
  try {
    const steps = db.all('SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx').map(r => readStep(r.metadata))
    const generations = db.all('SELECT data FROM gen_metadata').map(r => readGeneration(r.data))
    let parents = 0
    try { parents = db.all('SELECT COUNT(*) AS n FROM parent_references')[0]?.n ?? 0 } catch { /* an older layout has no such table */ }
    return buildTurns({ conversation, steps, generations, subagent: children.has(conversation) || parents > 0 })
  } finally { db.close() }
}

export const rowSignature = t => JSON.stringify([t.provider, t.turn_id, t.session_id, t.ts, t.model, t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_creation_tokens, t.duration_ms, t.is_subagent])
const savedSignature = v => (typeof v === 'string' ? v : v?.sig)

/** Keep the state bounded: files that are gone are forgotten, old turns too (a forgotten turn can only cause a safe idempotent resend). */
export function compactState(state, present, now = Date.now()) {
  state.files ??= {}
  state.sent ??= {}
  for (const p of Object.keys(state.files)) if (!present.has(p)) delete state.files[p]
  const keep = Object.entries(state.sent)
    .map(([id, value]) => ({ id, value, at: Date.parse(value?.at ?? '') || 0 }))
    .filter(x => !x.at || x.at >= now - stateRetentionMs)
    .sort((a, b) => b.at - a.at).slice(0, stateMaxTurns)
  state.sent = Object.fromEntries(keep.map(x => [x.id, x.value]))
  return state
}

export default {
  id: 'antigravity',
  title: 'Google Antigravity',
  get home() { return homes()[0] },

  detect: () => homes().some(h => existsSync(join(h, 'conversations'))),

  /** Sends what is new. Returns { files, scanned, rows, limits } and keeps `lastSync` / `lastError` in the state file. */
  async sync({ full = false, onFile } = {}) {
    const cfg = readJson(configFile, null)
    if (!cfg?.token) throw new Error('not linked yet: run the program without arguments, or: link <CODE>')
    const state = readJson(stateFile, { files: {}, sent: {} })
    const files = databases()
    if (!files.length) return { files: 0, scanned: 0, rows: 0, limits: false, missing: true }
    const unlock = lock('antigravity')
    if (!unlock) return { files: 0, scanned: 0, rows: 0, limits: false, busy: true }
    const stats = { files: 0, scanned: 0, rows: 0, limits: false }
    let failed = null
    try {
      const childrenOf = new Map()
      for (const [n, f] of files.entries()) {
        onFile?.(n + 1, files.length)
        stats.files++
        const sig = signature(f.path)
        if (!full && state.files[f.path] === sig) continue
        stats.scanned++
        try {
          if (!childrenOf.has(f.home)) childrenOf.set(f.home, await childConversations(f.home))
          const turns = await parseDatabase(f.path, childrenOf.get(f.home))
          const fresh = turns.filter(t => full || savedSignature(state.sent[t.turn_id]) !== rowSignature(t))
          for (let i = 0; i < fresh.length; i += BATCH) await post(cfg, { rows: fresh.slice(i, i + BATCH) })
          for (const t of fresh) state.sent[t.turn_id] = { sig: rowSignature(t), at: t.ts }
          stats.rows += fresh.length
          state.files[f.path] = sig // only after the rows of this file were accepted
          writeJson(stateFile, state)
        } catch (e) { failed ??= e } // one unreadable database (locked, being written) must not stop the others
      }
      compactState(state, new Set(files.map(f => f.path)))
      if (failed) throw failed
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
}
