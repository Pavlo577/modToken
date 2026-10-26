// Token history from the local Claude Code logs (~/.claude/projects/**/*.jsonl). Pure, and shared by the dashboard: it reads the files in the
// browser and sends only what this module returns (numbers, a model name, ids); prompts and answers in the lines are never kept.

/** One assistant message of a log: the unit that is stored (a row, id `log:<message id>`). The first message after a prompt of yours is the turn
 * (`first`, counted as a turn, with the turn's length from the prompt to the last answer, long pauses left out); the others are its steps. */
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
  /** the first answer to a prompt: the row that counts as the turn */
  first: boolean
  /** on the first answer: from the prompt to the turn's last answer, in milliseconds; 0 on the others */
  duration_ms: number
}

/** What a log's earlier lines left for the next ones: the prompt being answered (its time, and its first answer once there is one). */
export interface LogState { prompt: { ms: number; first: HistoryTurn | null; lastMs: number; activeMs: number } | null }
export const newLogState = (): LogState => ({ prompt: null })

const MAX_TURN_MS = 7 * 86_400_000
/** A pause longer than this inside a turn (the session waited, or was away) is not counted in its length. */
const IDLE_MS = 30 * 60_000

/** A prompt of yours (not a tool's result, not a note Claude Code adds itself): it starts a turn. Only types and flags are read, never the text. */
function isPrompt(o: any): boolean {
  if (o?.type !== 'user' || o.isMeta === true || o.isCompactSummary === true) return false
  const c = o.message?.content
  return typeof c === 'string' || (Array.isArray(c) && !c.some((x: any) => x?.type === 'tool_result'))
}

export const MAX_HISTORY_TURNS = 1000 // per request
export const ID_SHAPE = /^[\w.:-]{1,100}$/
export const MODEL_SHAPE = /^[\w.:/+-]{1,64}$/

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.trunc(v), 1_000_000_000) : 0)

/** Adds one log line to `acc`; `state` carries the prompt being answered from line to line (one per file, the lines in order).
 * A message is written several times while it streams, so the largest numbers per message id win. */
export function addLogLine(acc: Map<string, HistoryTurn>, line: string, state: LogState = newLogState()): void {
  if (!line.includes('"usage"') && !line.includes('"type":"user"')) return // cheap filter: most lines are attachments and bookkeeping
  let o: any
  try { o = JSON.parse(line) } catch { return }
  if (o?.type === 'user') {
    const ms = Date.parse(o.timestamp)
    if (isPrompt(o) && Number.isFinite(ms)) state.prompt = { ms, first: null, lastMs: ms, activeMs: 0 }
    return
  }
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
    sub: o.isSidechain === true, first: false, duration_ms: 0,
  }
  if (t.input + t.output + t.cache_read + t.cache_creation === 0) return
  // the turn: the first answer after a prompt (an answer with no prompt before it in the file starts one of its own)
  if (!state.prompt) state.prompt = { ms, first: null, lastMs: ms, activeMs: 0 }
  const turn = state.prompt
  const prev = acc.get(t.id)
  if (!prev && !turn.first) { t.first = true; turn.first = t }
  // the turn's length: from the prompt to its last answer, without the pauses over IDLE_MS between them
  const step = ms - turn.lastMs
  if (step > 0) { if (step <= IDLE_MS) turn.activeMs += step; turn.lastMs = ms }
  if (turn.first) turn.first.duration_ms = Math.min(MAX_TURN_MS, turn.activeMs)
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
  const state = newLogState()
  for (const line of textOfLog.split('\n')) addLogLine(acc, line, state)
  return acc
}
