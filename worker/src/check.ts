// POST /v1/check: diagnostics. The otlp-check mod sends each turn's token counts as the session sees them, so they can be compared with what
// OTLP counted. Stored in check_turns only, never in token_events: these numbers are compared, not counted.
import type { Env } from './env.ts'
import { authDevice } from './otlp-ingest.ts'
import { json, text } from './util.ts'

const MAX_BODY = 64_000
const ID = /^[\w-]{1,80}$/
const MODEL = /^[\w.:@\/-]{1,80}$/

export interface CheckTurn { id: string; session: string; ts: string; model: string; input: number; output: number; cache_read: number; cache_creation: number; duration_ms: number; sub: boolean }

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(1e9, Math.round(v)) : null)

export function parseCheck(body: unknown): CheckTurn[] | null {
  const list = body && typeof body === 'object' && !Array.isArray(body) ? (body as { turns?: unknown }).turns : undefined
  if (!Array.isArray(list)) return null
  const out: CheckTurn[] = []
  for (const t of list.slice(0, 50) as Record<string, unknown>[]) {
    if (!t || typeof t !== 'object') continue
    const ts = typeof t.ts === 'string' && t.ts.length <= 40 && !Number.isNaN(Date.parse(t.ts)) ? new Date(Date.parse(t.ts)).toISOString() : null
    const nums = [n(t.input), n(t.output), n(t.cache_read), n(t.cache_creation), n(t.duration_ms)]
    if (typeof t.id !== 'string' || !ID.test(t.id) || typeof t.session !== 'string' || !ID.test(t.session) || !ts || nums.some(x => x === null)) continue
    const [input, output, cache_read, cache_creation, duration_ms] = nums as number[]
    out.push({ id: t.id, session: t.session, ts, model: typeof t.model === 'string' && MODEL.test(t.model) ? t.model : 'unknown', input, output, cache_read, cache_creation, duration_ms, sub: t.sub === true })
  }
  return out
}

export async function checkIngest(req: Request, env: Env): Promise<Response> {
  const dev = await authDevice(req, env)
  if (!dev) return text('unauthorized', 401)
  const body = await req.text()
  if (body.length > MAX_BODY) return text('payload too large', 413)
  let raw: unknown
  try { raw = JSON.parse(body) } catch { return text('bad request', 400) }
  const turns = parseCheck(raw)
  if (!turns) return text('bad request: { turns: [...] }', 400)
  if (turns.length) {
    await env.DB.batch(turns.map(t => env.DB.prepare(
      `INSERT OR IGNORE INTO check_turns (device_id, user_email, session_id, turn_id, ts, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, duration_ms, is_subagent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(dev.id, dev.user_email, t.session, t.id, t.ts, t.model, t.input, t.output, t.cache_read, t.cache_creation, t.duration_ms, t.sub ? 1 : 0)))
  }
  return json({ turns: turns.length })
}
