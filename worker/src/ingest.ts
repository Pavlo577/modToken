// Endpoints that a device calls with its own token: live turns (and limits), and the old-history import.
import type { Env } from './env.ts'
import { INGEST_SQL, MAX_ROWS, eventStmt, providerOf } from './events.ts'
import { json, sha256, str, text } from './util.ts'

/** Old history for a device: only turns from before it was linked (later ones are collected live). */
export async function importRows(env: Env, email: string, dev: { id: string; created_at: string }, rows: unknown): Promise<Response> {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ROWS) return text('bad request', 400)
  const cutoff = new Date(dev.created_at).getTime()
  const stmts: D1PreparedStatement[] = []
  let afterLink = 0
  for (const r of rows as Record<string, unknown>[]) {
    const turnId = str(r.turn_id)
    if (!turnId.startsWith('imp:')) return text('bad request', 400)
    const stmt = eventStmt(env, email, dev.id, r, turnId)
    if (!stmt) return text('bad request', 400)
    if (new Date(str(r.ts)).getTime() >= cutoff) { afterLink++; continue }
    stmts.push(stmt)
  }
  const results = stmts.length ? await env.DB.batch(stmts) : []
  const inserted = results.reduce((n, r) => n + (r.meta.changes ?? 0), 0)
  return json({ inserted, duplicates: stmts.length - inserted, afterLink })
}

export async function importFromDevice(req: Request, env: Env): Promise<Response> {
  const token = req.headers.get('x-device-token') ?? ''
  const dev = await env.DB.prepare('SELECT id, user_email, created_at FROM devices WHERE token_hash = ? AND revoked = 0')
    .bind(await sha256(token))
    .first<{ id: string; user_email: string; created_at: string }>()
  if (!dev) return text('unauthorized', 401)
  const body = (await req.json().catch(() => null)) as { rows?: unknown } | null
  return importRows(env, dev.user_email, dev, body?.rows)
}

export async function ingest(req: Request, env: Env): Promise<Response> {
  const token = req.headers.get('x-device-token') ?? ''
  const dev = await env.DB.prepare('SELECT id, user_email FROM devices WHERE token_hash = ? AND revoked = 0')
    .bind(await sha256(token))
    .first<{ id: string; user_email: string }>()
  if (!dev) return text('unauthorized', 401)

  const raw = await req.json().catch(() => null)
  // An array of turns (the cloud hook, older mods) or { rows, limits } (mod 0.9+).
  const rows = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (raw as { rows?: unknown }).rows ?? [] : null
  const limits = raw && !Array.isArray(raw) && typeof raw === 'object' ? (raw as { limits?: unknown }).limits : undefined
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) return text('bad request', 400)
  if (rows.length === 0 && !Array.isArray(limits)) return text('bad request', 400)

  const stmts: D1PreparedStatement[] = []
  for (const r of rows as Record<string, unknown>[]) {
    const stmt = eventStmt(env, dev.user_email, dev.id, r, str(r.turn_id), INGEST_SQL)
    if (!stmt) return text('bad request', 400)
    stmts.push(stmt)
  }
  const now = new Date().toISOString()
  for (const l of (Array.isArray(limits) ? limits : []).slice(0, 8) as Record<string, unknown>[]) {
    const kind = str(l.kind, 30)
    const pct = Number(l.percentUsed)
    const provider = providerOf(l.provider)
    if (!/^[a-z_]+$/.test(kind) || !Number.isFinite(pct) || !provider) continue
    const resets = l.resetsAt ? new Date(str(l.resetsAt)) : null
    const resetsAt = resets && !Number.isNaN(resets.getTime()) ? resets.toISOString() : ''
    stmts.push(
      env.DB.prepare(
        `INSERT INTO plan_limits (user_email, device_id, ts, kind, percent_used, resets_at, provider)
         SELECT ?1, ?2, ?3, ?4, ?5, NULLIF(?6, ''), ?7
         WHERE NOT EXISTS (
           SELECT 1 FROM plan_limits WHERE id = (SELECT MAX(id) FROM plan_limits WHERE device_id = ?2 AND kind = ?4 AND provider = ?7)
             AND percent_used = ?5 AND IFNULL(resets_at, '') = ?6)`,
      ).bind(dev.user_email, dev.id, now, kind, Math.min(1000, Math.max(0, pct)), resetsAt, provider),
    )
  }
  stmts.push(env.DB.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').bind(now, dev.id))
  await env.DB.batch(stmts)
  return new Response(null, { status: 204 })
}
