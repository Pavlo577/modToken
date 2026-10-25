// Admin route: POST /api/admin/import, the token history read from local logs in the browser (see ../history.ts). Only numbers arrive.
import { ID_SHAPE, MAX_HISTORY_TURNS, MODEL_SHAPE } from '../history.ts'
import type { HistoryTurn } from '../history.ts'
import { int, json, text } from '../util.ts'
import type { Routes } from './context.ts'

const CHUNK = 100 // rows per D1 batch
const MAX_BODY = 1_000_000

export const historyRoutes: Routes = async ({ req, env, email, path }) => {
  if (path !== '/import' || req.method !== 'POST') return null
  const raw = await req.text()
  if (raw.length > MAX_BODY) return text('payload too large', 413)
  let body: { device_id?: unknown; turns?: unknown } | null
  try { body = JSON.parse(raw) } catch { body = null }
  if (!body || typeof body.device_id !== 'string' || !Array.isArray(body.turns)) return text('bad request', 400)
  if (body.turns.length > MAX_HISTORY_TURNS) return text(`at most ${MAX_HISTORY_TURNS} turns per request`, 400)

  const dev = await env.DB.prepare('SELECT id, otlp_since FROM devices WHERE id = ? AND user_email = ? AND revoked = 0').bind(body.device_id, email).first<{ id: string; otlp_since: string | null }>()
  if (!dev) return text('device not found', 404)

  // Anything from the time this device already reports through OTLP is counted there; importing it again would count it twice.
  const limit = dev.otlp_since ?? '9999'
  const latest = new Date(Date.now() + 86_400_000).toISOString()

  const rows: HistoryTurn[] = []
  let skippedLive = 0
  let invalid = 0
  for (const x of body.turns as Record<string, unknown>[]) {
    const ts = typeof x?.ts === 'string' ? Date.parse(x.ts) : NaN
    const ok = typeof x?.id === 'string' && ID_SHAPE.test(x.id) && typeof x.session === 'string' && ID_SHAPE.test(x.session)
      && typeof x.model === 'string' && MODEL_SHAPE.test(x.model) && Number.isFinite(ts)
    if (!ok) { invalid++; continue }
    const iso = new Date(ts).toISOString()
    if (iso > latest) { invalid++; continue }
    if (iso >= limit) { skippedLive++; continue }
    rows.push({ id: x.id as string, session: x.session as string, ts: iso, model: x.model as string, input: int(x.input), output: int(x.output), cache_read: int(x.cache_read), cache_creation: int(x.cache_creation), sub: x.sub === true })
  }

  const count = () => env.DB.prepare(`SELECT COUNT(*) AS n FROM token_events WHERE device_id = ? AND turn_id LIKE 'log:%'`).bind(dev.id).first<{ n: number }>().then(r => r?.n ?? 0)
  const before = await count()
  const sql = env.DB.prepare(
    `INSERT INTO token_events
       (user_email, device_id, session_id, turn_id, ts, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, duration_ms, is_subagent, provider, cost_micros)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'claude', 0)
     ON CONFLICT (device_id, turn_id) DO UPDATE SET
       input_tokens = MAX(input_tokens, excluded.input_tokens), output_tokens = MAX(output_tokens, excluded.output_tokens),
       cache_read_tokens = MAX(cache_read_tokens, excluded.cache_read_tokens), cache_creation_tokens = MAX(cache_creation_tokens, excluded.cache_creation_tokens),
       is_subagent = MAX(is_subagent, excluded.is_subagent)`,
  )
  for (let i = 0; i < rows.length; i += CHUNK) {
    await env.DB.batch(rows.slice(i, i + CHUNK).map(r => sql.bind(email, dev.id, r.session, 'log:' + r.id, r.ts, r.model, r.input, r.output, r.cache_read, r.cache_creation, r.sub ? 1 : 0)))
  }
  return json({ added: (await count()) - before, received: rows.length, skipped_live: skippedLive, invalid })
}
