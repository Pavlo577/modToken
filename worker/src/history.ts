// Token history from the local Claude Code logs (~/.claude/projects/**/*.jsonl). Pure, and shared by the dashboard: it reads the files in the
// browser and sends only what this module returns (numbers, a model name, ids); prompts and answers in the lines are never kept.

/** One assistant message of a log: the unit that is stored (a turn row, id `log:<message id>`). */
export interface HistoryTurn {
  id: string
  session: string
  ts: string
  model: string
  input: number
  output: number
  cache_read: number
  cache_creation: number
  sub: boolean
}

export const MAX_HISTORY_TURNS = 1000 // per request
export const ID_SHAPE = /^[\w.:-]{1,100}$/
export const MODEL_SHAPE = /^[\w.:/+-]{1,64}$/

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.trunc(v), 1_000_000_000) : 0)

/** Adds one log line to `acc`. A message is written several times while it streams, so the largest numbers per message id win. */
export function addLogLine(acc: Map<string, HistoryTurn>, line: string): void {
  if (!line.includes('"usage"')) return // cheap filter: most lines are prompts, attachments and bookkeeping
  let o: any
  try { o = JSON.parse(line) } catch { return }
  if (o?.type !== 'assistant') return
  const m = o.message
  const u = m?.usage
  if (!m || !u || typeof m.id !== 'string' || typeof m.model !== 'string') return
  if (!ID_SHAPE.test(m.id) || !MODEL_SHAPE.test(m.model) || m.model.startsWith('<')) return // <synthetic> entries are not model calls
  const ms = Date.parse(o.timestamp)
  if (!Number.isFinite(ms) || typeof o.sessionId !== 'string' || !ID_SHAPE.test(o.sessionId)) return
  const t: HistoryTurn = {
    id: m.id, session: o.sessionId, ts: new Date(ms).toISOString(), model: m.model,
    input: num(u.input_tokens), output: num(u.output_tokens), cache_read: num(u.cache_read_input_tokens), cache_creation: num(u.cache_creation_input_tokens),
    sub: o.isSidechain === true,
  }
  if (t.input + t.output + t.cache_read + t.cache_creation === 0) return
  const prev = acc.get(t.id)
  if (!prev) { acc.set(t.id, t); return }
  prev.input = Math.max(prev.input, t.input)
  prev.output = Math.max(prev.output, t.output)
  prev.cache_read = Math.max(prev.cache_read, t.cache_read)
  prev.cache_creation = Math.max(prev.cache_creation, t.cache_creation)
  if (t.ts > prev.ts) prev.ts = t.ts
  prev.sub = prev.sub || t.sub
}

/** A whole log as text. */
export function parseClaudeLog(textOfLog: string, acc = new Map<string, HistoryTurn>()): Map<string, HistoryTurn> {
  for (const line of textOfLog.split('\n')) addLogLine(acc, line)
  return acc
}
