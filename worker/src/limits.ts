// POST /v1/limits: the subscription's rate-limit windows, sent by the token-tracker mod (mods/token-tracker), which reads them from the session,
// and for Codex by the token-tracker Codex plugin (mods/codex-tracker), whose Stop hook reads them from Codex's own session files.
// Body: { provider?, limits: [{ kind, percentUsed, resetsAt? }] }. Only the agent, the window's name, a percent and a time are read; anything else is ignored.
// A reading equal to the device's last one for that window is not stored again.
import type { Env } from './env.ts'
import { recordDropped } from './dropped.ts'
import { authDevice } from './otlp-ingest.ts'
import { str, text } from './util.ts'

const MAX_BODY = 8_000
const MAX_LIMITS = 8

export type LimitReading = { kind: string; percent: number; resets_at: string }

/** Whose limits they are: `codex`, or `claude` (the mod, which does not say). */
export const limitsProvider = (body: unknown): 'claude' | 'codex' =>
  body && typeof body === 'object' && (body as { provider?: unknown }).provider === 'codex' ? 'codex' : 'claude'

/** The readings of a request body that are well formed (unknown fields and malformed readings are dropped). */
export function parseLimits(body: unknown): LimitReading[] | null {
  const list = body && typeof body === 'object' && !Array.isArray(body) ? (body as { limits?: unknown }).limits : undefined
  if (!Array.isArray(list)) return null
  const out: LimitReading[] = []
  for (const l of list.slice(0, MAX_LIMITS) as Record<string, unknown>[]) {
    if (!l || typeof l !== 'object') continue
    const kind = str(l.kind, 30)
    const pct = typeof l.percentUsed === 'number' ? l.percentUsed : NaN
    if (!/^[a-z_]+$/.test(kind) || !Number.isFinite(pct)) continue
    const resets = typeof l.resetsAt === 'string' ? new Date(l.resetsAt.slice(0, 40)) : null
    out.push({ kind, percent: Math.min(1000, Math.max(0, pct)), resets_at: resets && !Number.isNaN(resets.getTime()) ? resets.toISOString() : '' })
  }
  return out
}

export async function limitsIngest(req: Request, env: Env): Promise<Response> {
  const dev = await authDevice(req, env)
  if (!dev) return text('unauthorized', 401)
  const body = await req.text()
  if (body.length > MAX_BODY) return text('payload too large', 413)
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { return text('bad request', 400) }
  const limits = parseLimits(parsed)
  if (!limits) return text('bad request: { limits: [...] }', 400)
  await recordDropped(env, dev.id, 'limits', parsed)
  const provider = limitsProvider(parsed)
  const now = new Date().toISOString()
  if (limits.length) {
    await env.DB.batch(limits.map(l => env.DB.prepare(
      `INSERT INTO plan_limits (user_email, device_id, ts, kind, percent_used, resets_at, provider)
       SELECT ?1, ?2, ?3, ?4, ?5, NULLIF(?6, ''), ?7
       WHERE NOT EXISTS (
         SELECT 1 FROM plan_limits WHERE id = (SELECT MAX(id) FROM plan_limits WHERE device_id = ?2 AND kind = ?4 AND provider = ?7)
           AND percent_used = ?5 AND IFNULL(resets_at, '') = ?6)`,
    ).bind(dev.user_email, dev.id, now, l.kind, l.percent, l.resets_at, provider)))
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
}
