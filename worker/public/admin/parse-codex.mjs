// Turns and subscription limits out of one OpenAI Codex CLI rollout (~/.codex/sessions/**/rollout-*.jsonl), line by line.
// Only token counts, timestamps, model names and ids are kept: prompts, answers and tool output are never read into the result.
//
// The rollout format is internal to Codex and not documented, so this reads only what it needs and ignores the rest:
//   session_meta  -> thread id, when the file began, whether it is a forked / sub-agent thread
//   turn_context  -> the model in use, the turn id
//   event_msg     -> task_started / task_complete (turn id, Codex's own duration), user_message, and payload.type "token_count": cumulative `total_token_usage` (+ `last_token_usage`, `rate_limits`)
// `input_tokens` includes the cached part and `output_tokens` includes the reasoning part (OpenAI usage semantics).
//
// Counting rules (why a plain sum of `last_token_usage` would be wrong):
//   * `token_count` is also written when only the rate limits change, with unchanged totals: count only growth of the totals.
//   * A forked / resumed rollout replays the history of its parent first, stamped with the original times, i.e. earlier than
//     the file's own start: such events only set the baseline.
//   * If the first counted event of a file already carries a larger total than its last request (a resumed thread without
//     replay), only the last request is new.
//   * If a total goes down, the thread restarted: count the last request, not a negative amount.
//   * `token_usage_record` (newer files) is another projection of the same usage and is ignored.

const num = v => (Number.isFinite(v) && v > 0 ? v : 0)
const FIELDS = ['input', 'cached', 'cacheWrite', 'output', 'reasoning']

/** The five counters of a `total_token_usage` / `last_token_usage` object. */
function usageOf(u) {
  if (!u || typeof u !== 'object') return null
  return {
    input: num(u.input_tokens),
    cached: num(u.cached_input_tokens),
    cacheWrite: num(u.cache_write_input_tokens),
    output: num(u.output_tokens),
    reasoning: num(u.reasoning_output_tokens),
  }
}

/** five_hour / seven_day from the length of a rate-limit window; null for anything else. */
function kindOf(minutes) {
  if (!(minutes > 0)) return null
  if (minutes >= 240 && minutes <= 480) return 'five_hour'
  if (minutes >= 7200 && minutes <= 14400) return 'seven_day'
  return null
}

function limitsOf(rl) {
  if (!rl || typeof rl !== 'object') return []
  const out = []
  for (const w of [rl.primary, rl.secondary]) {
    const kind = kindOf(Number(w?.window_minutes))
    const pct = Number(w?.used_percent)
    if (!kind || !Number.isFinite(pct)) continue
    const at = Number(w.resets_at)
    out.push({ provider: 'codex', kind, percentUsed: pct, resetsAt: at > 0 ? new Date(at * 1000).toISOString() : '' })
  }
  return out
}

/**
 * `fileKey`: a name for the file, used for the ids when the rollout has no thread id.
 * finish() returns { turns, limits, limitsAt }: `turns` are rows for /api/ingest (provider "codex"), `limits` the newest
 * subscription reading in the file (empty if there was none), and `limitsAt` its event timestamp in milliseconds.
 */
export function createCodexParser(fileKey) {
  let thread = ''
  let startedAt = null // when this file began (ms)
  let sub = false
  let model = ''
  let key = '' // the current turn
  let seq = 0
  let explicit = false // the rollout names its turns (turn_id): then a bare "user_message" does not start another one
  let prev = null // totals at the previous token_count
  let limits = []
  let limitsAt = 0
  const turns = new Map() // key -> { startTs, lastTs, sums, best, model, took }

  const turnOf = k => {
    let t = turns.get(k)
    if (!t) turns.set(k, (t = { startTs: null, lastTs: null, sums: { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 }, best: -1, model: '', took: null }))
    return t
  }
  /** A turn begins (explicit id when the record has one, else a counter). */
  const begin = (id, ts) => {
    if (typeof id === 'string' && id) explicit = true
    else if (explicit) return // an id-less boundary inside a rollout that has ids
    const k = typeof id === 'string' && id ? id : `n${++seq}`
    if (k !== key) key = k
    const t = turnOf(key)
    if (t.startTs === null && ts !== null) t.startTs = ts
  }

  const count = (p, ts) => {
    const rl = limitsOf(p.rate_limits)
    if (rl.length && ts >= limitsAt) { limits = rl; limitsAt = ts }
    const total = usageOf(p.info?.total_token_usage)
    if (!total) return
    const last = usageOf(p.info?.last_token_usage)
    const replay = startedAt !== null && ts < startedAt - 1000
    let d = null
    if (replay) d = null // history of the parent: only moves the baseline
    else if (prev === null) d = last ?? total
    else if (FIELDS.some(f => total[f] < prev[f])) d = last ?? total
    else d = Object.fromEntries(FIELDS.map(f => [f, total[f] - prev[f]]))
    prev = total
    if (!d || FIELDS.every(f => d[f] === 0)) return
    if (!key) begin(null, ts)
    const t = turnOf(key)
    for (const f of FIELDS) t.sums[f] += d[f]
    t.lastTs = Math.max(t.lastTs ?? 0, ts)
    if (t.startTs === null) t.startTs = ts
    if (d.output > t.best) { t.best = d.output; t.model = model }
  }

  return {
    push(line) {
      let e
      try { e = JSON.parse(line) } catch { return }
      if (!e || typeof e !== 'object') return
      const p = e.payload && typeof e.payload === 'object' ? e.payload : {}
      const ts = Date.parse(e.timestamp)
      const at = Number.isNaN(ts) ? null : ts
      if (e.type === 'session_meta') {
        thread = typeof p.id === 'string' ? p.id : thread
        const began = Date.parse(p.timestamp ?? e.timestamp)
        if (!Number.isNaN(began)) startedAt = began
        sub = Boolean(p.parent_thread_id || p.agent_path || (p.source && typeof p.source === 'object' && 'subagent' in p.source))
      } else if (e.type === 'turn_context') {
        if (typeof p.model === 'string' && p.model) model = p.model
        if (typeof p.turn_id === 'string') begin(p.turn_id, at)
      } else if (e.type === 'event_msg') {
        if (p.type === 'token_count') { if (at !== null) count(p, at) }
        else if (p.type === 'task_started' || p.type === 'turn_started' || p.type === 'user_message') begin(typeof p.turn_id === 'string' ? p.turn_id : null, at)
        else if (p.type === 'task_complete' && typeof p.turn_id === 'string' && Number(p.duration_ms) >= 0) turnOf(p.turn_id).took = Number(p.duration_ms) // Codex's own timing of the turn
      }
    },
    finish() {
      const session = thread || fileKey
      const rows = []
      for (const [k, t] of turns) {
        const s = t.sums
        const input = Math.max(0, s.input - s.cached - s.cacheWrite)
        if (input + s.cached + s.cacheWrite + s.output === 0 || t.lastTs === null) continue
        rows.push({
          provider: 'codex',
          turn_id: `codex:${session}:${k}`,
          session_id: session,
          ts: new Date(t.lastTs).toISOString(),
          model: t.model || model || 'unknown',
          input_tokens: input,
          output_tokens: s.output,
          cache_read_tokens: s.cached,
          cache_creation_tokens: s.cacheWrite,
          duration_ms: t.took ?? (t.startTs !== null ? Math.max(0, t.lastTs - t.startTs) : 0),
          is_subagent: sub,
        })
      }
      return { turns: rows, limits, limitsAt: limitsAt || null }
    },
  }
}
