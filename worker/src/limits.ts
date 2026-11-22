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

export type LimitReading = { kind: string; percent: number; resets_at: string; observed_at?: string }
export type StoredLimitRow = { ts: string; percent_used: number; resets_at: string | null; device_id: string }

/** Whose limits they are: `codex`, `antigravity`, or `claude` (the mod, which does not say). */
export const limitsProvider = (body: unknown): 'claude' | 'codex' | 'antigravity' => {
  const p = body && typeof body === 'object' ? (body as { provider?: unknown }).provider : undefined
  return p === 'codex' || p === 'antigravity' ? p : 'claude'
}

/** The readings of a request body that are well formed (unknown fields and malformed readings are dropped). */
export function parseLimits(body: unknown, nowMs = Date.now()): LimitReading[] | null {
  const list = body && typeof body === 'object' && !Array.isArray(body) ? (body as { limits?: unknown }).limits : undefined
  if (!Array.isArray(list)) return null
  const out: LimitReading[] = []
  const minObs = nowMs - 30 * 86_400_000, maxObs = nowMs + 5 * 60_000
  for (const l of list.slice(0, MAX_LIMITS) as Record<string, unknown>[]) {
    if (!l || typeof l !== 'object') continue
    const kind = str(l.kind, 30)
    const pct = typeof l.percentUsed === 'number' ? l.percentUsed : NaN
    if (!/^[a-z][a-z0-9_]*$/.test(kind) || !Number.isFinite(pct)) continue
    const resets = typeof l.resetsAt === 'string' ? new Date(l.resetsAt.slice(0, 40)) : null
    const obs = typeof l.observedAt === 'string' ? Date.parse(l.observedAt.slice(0, 40)) : NaN
    const row: LimitReading = { kind, percent: Math.min(1000, Math.max(0, pct)), resets_at: resets && !Number.isNaN(resets.getTime()) ? resets.toISOString() : '' }
    if (Number.isFinite(obs) && obs >= minObs && obs <= maxObs) row.observed_at = new Date(obs).toISOString()
    out.push(row)
  }
  return out
}

/** Account-wide limit deduplication and out-of-order / false-reset protection across multiple devices. */
export function shouldStoreLimit(
  last: StoredLimitRow | null | undefined,
  next: { ts: string; percent: number; resets_at: string; device_id: string },
): boolean {
  if (!last) return true
  const lastMs = Date.parse(last.ts), nextMs = Date.parse(next.ts)
  if (Number.isFinite(lastMs) && Number.isFinite(nextMs) && nextMs < lastMs) return false
  const lastRes = last.resets_at ? Date.parse(last.resets_at) : 0
  const nextRes = next.resets_at ? Date.parse(next.resets_at) : 0
  if (lastRes > 0 && nextRes > 0 && nextRes < lastRes - 60_000) return false
  const sameWindow = (!lastRes && !nextRes) || (lastRes > 0 && nextRes > 0 && Math.abs(nextRes - lastRes) <= 60_000)
  if (sameWindow) {
    if (Math.abs(next.percent - last.percent_used) < 0.05) return false
    if (next.device_id !== last.device_id && next.percent < last.percent_used - 3 && Number.isFinite(lastMs) && Number.isFinite(nextMs) && nextMs - lastMs < 5 * 60_000) {
      return false
    }
  }
  return true
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
  const stmts = []
  const seen = new Map<string, StoredLimitRow>()
  for (const l of limits) {
    const obsTs = l.observed_at ?? now
    let last = seen.get(l.kind)
    if (last === undefined) {
      last = (await env.DB.prepare(
        `SELECT ts, percent_used, resets_at, device_id FROM plan_limits
         WHERE user_email = ?1 AND provider = ?2 AND kind = ?3
         ORDER BY ts DESC, id DESC LIMIT 1`,
      ).bind(dev.user_email, provider, l.kind).first<StoredLimitRow>()) ?? undefined
    }
    if (!shouldStoreLimit(last, { ts: obsTs, percent: l.percent, resets_at: l.resets_at, device_id: dev.id })) continue
    stmts.push(env.DB.prepare(
      `INSERT INTO plan_limits (user_email, device_id, ts, kind, percent_used, resets_at, provider)
       VALUES (?1, ?2, ?3, ?4, ?5, NULLIF(?6, ''), ?7)`,
    ).bind(dev.user_email, dev.id, obsTs, l.kind, l.percent, l.resets_at, provider))
    seen.set(l.kind, { ts: obsTs, percent_used: l.percent, resets_at: l.resets_at || null, device_id: dev.id })
  }
  stmts.push(env.DB.prepare('UPDATE devices SET last_seen = MAX(COALESCE(last_seen, ?1), ?1) WHERE id = ?2').bind(now, dev.id))
  await env.DB.batch(stmts)
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
}
