// Storing a token history read from local Claude Code logs (src/history.ts parses them on the device: in the browser, or in the token-tracker
// mod) or from Codex's session files (the Codex plugin's hooks/history.py / .ps1). Shared by POST /api/admin/import (the dashboard, signed in)
// and POST /v1/import (the mod or the plugin, with the device token). Only numbers arrive.
import type { Env } from './env.ts'
import { hourOf, refreshHourlyBuckets } from './buckets.ts'
import { ID_SHAPE, MAX_HISTORY_TURNS, MODEL_SHAPE } from './history.ts'
import type { HistoryTurn } from './history.ts'
import { recordDropped } from './dropped.ts'
import { authDevice } from './otlp-ingest.ts'
import { int, json, text } from './util.ts'

const CHUNK = 100 // rows per D1 batch
const SESSION_BATCH = 80
export const MAX_IMPORT_BODY = 1_000_000

export interface ImportResult { added: number; received: number; skipped_live: number; invalid: number }

export type ImportProvider = 'claude' | 'codex' | 'antigravity'
export type ImportMode = 'backfill' | 'reconcile'
/** Whose history it is: `codex`, `antigravity`, or `claude` (the mod and the dashboard, which do not say). */
export const importProvider = (body: unknown): ImportProvider => {
  const p = body && typeof body === 'object' ? (body as { provider?: unknown }).provider : undefined
  return p === 'codex' || p === 'antigravity' ? p : 'claude'
}

/**
 * Adds the well-formed turns from local logs; a turn imported twice counts once.
 * - `backfill` (legacy default): skips turns from `otlp_since` onward for backward compatibility.
 * - `reconcile`: checks per `(device_id, provider, session_id)` against OTLP rows and across other user devices so
 *   sessions missed during OTLP outages are backfilled without duplicating OTLP sessions or synced logs.
 */
export async function importTurns(
  env: Env,
  email: string,
  dev: { id: string; otlp_since: string | null },
  turns: unknown[],
  provider: ImportProvider = 'claude',
  mode: ImportMode = 'backfill',
): Promise<ImportResult> {
  const latest = new Date(Date.now() + 86_400_000).toISOString()

  const cand: (HistoryTurn & { bg: boolean })[] = []
  let skippedLive = 0
  let invalid = 0
  for (const x of turns as Record<string, unknown>[]) {
    const ts = typeof x?.ts === 'string' ? Date.parse(x.ts) : NaN
    const ok = typeof x?.id === 'string' && ID_SHAPE.test(x.id) && typeof x.session === 'string' && ID_SHAPE.test(x.session)
      && typeof x.model === 'string' && MODEL_SHAPE.test(x.model) && Number.isFinite(ts)
    if (!ok) { invalid++; continue }
    const iso = new Date(ts).toISOString()
    if (iso > latest) { invalid++; continue }
    // first and duration_ms came later: a client that sends neither counts every message as a turn, as before
    cand.push({ id: x.id as string, session: x.session as string, ts: iso, model: x.model as string, input: int(x.input), output: int(x.output), cache_read: int(x.cache_read), cache_creation: int(x.cache_creation), sub: x.sub === true, first: x.first !== false, duration_ms: Math.min(7 * 86_400_000, int(x.duration_ms)), bg: x.bg === true })
  }

  let rows: (HistoryTurn & { bg: boolean })[] = []
  if (mode === 'reconcile') {
    const sessions = [...new Set(cand.map(r => r.session))]
    const skipSessions = new Set<string>()
    for (let i = 0; i < sessions.length; i += SESSION_BATCH) {
      const batch = sessions.slice(i, i + SESSION_BATCH)
      const ph = batch.map(() => '?').join(',')
      const [ownOtlp, otherDev] = await env.DB.batch([
        env.DB.prepare(
          `SELECT DISTINCT session_id FROM token_events
           WHERE device_id = ? AND provider = ? AND turn_id >= 'otlp:' AND turn_id < 'otlp;' AND session_id IN (${ph})`,
        ).bind(dev.id, provider, ...batch),
        env.DB.prepare(
          `SELECT DISTINCT session_id FROM token_events
           WHERE user_email = ? AND provider = ? AND device_id != ? AND session_id IN (${ph})`,
        ).bind(email, provider, dev.id, ...batch),
      ])
      for (const r of (ownOtlp?.results ?? []) as { session_id: string }[]) skipSessions.add(r.session_id)
      for (const r of (otherDev?.results ?? []) as { session_id: string }[]) skipSessions.add(r.session_id)
    }
    for (const r of cand) {
      if (skipSessions.has(r.session)) skippedLive++
      else rows.push(r)
    }
  } else {
    // Legacy cutoff: skip anything from the device's first OTLP call for this provider onward.
    const limit = provider !== 'claude'
      ? (await env.DB.prepare(`SELECT ts FROM token_events WHERE user_email = ? AND provider = ? AND device_id = ? AND turn_id >= 'otlp:' AND turn_id < 'otlp;' ORDER BY ts LIMIT 1`)
          .bind(email, provider, dev.id).first<{ ts: string }>())?.ts ?? '9999'
      : dev.otlp_since ?? '9999'
    for (const r of cand) {
      if (r.ts >= limit) skippedLive++
      else rows.push(r)
    }
  }

  const count = () => env.DB.prepare(`SELECT COUNT(*) AS n FROM token_events WHERE device_id = ? AND turn_id >= 'log:' AND turn_id < 'log;'`).bind(dev.id).first<{ n: number }>().then(r => r?.n ?? 0)
  const before = await count()
  const sql = env.DB.prepare(
    `INSERT INTO token_events
       (user_email, device_id, session_id, turn_id, ts, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, duration_ms, is_subagent, provider, cost_micros, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT (device_id, turn_id) DO UPDATE SET
       input_tokens = MAX(input_tokens, excluded.input_tokens), output_tokens = MAX(output_tokens, excluded.output_tokens),
       cache_read_tokens = MAX(cache_read_tokens, excluded.cache_read_tokens), cache_creation_tokens = MAX(cache_creation_tokens, excluded.cache_creation_tokens),
       is_subagent = MAX(is_subagent, excluded.is_subagent), duration_ms = MAX(duration_ms, excluded.duration_ms), kind = excluded.kind`,
  )
  for (let i = 0; i < rows.length; i += CHUNK) {
    await env.DB.batch(rows.slice(i, i + CHUNK).map(r => sql.bind(email, dev.id, r.session, 'log:' + r.id, r.ts, r.model, r.input, r.output, r.cache_read, r.cache_creation, r.duration_ms, r.sub ? 1 : 0, provider, r.sub ? 'sub' : r.bg ? 'bg' : r.first ? 'main' : 'step')))
  }
  await refreshHourlyBuckets(env, rows.map(r => ({ deviceId: dev.id, provider, h: hourOf(r.ts) })))
  return { added: (await count()) - before, received: rows.length, skipped_live: skippedLive, invalid }
}

/** POST /v1/import: { provider?, mode?, turns: [...] } from the token-tracker mod's /tracker-import, or from the Codex plugin (provider codex). */
export async function deviceImport(req: Request, env: Env): Promise<Response> {
  const dev = await authDevice(req, env)
  if (!dev) return text('unauthorized', 401)
  const raw = await req.text()
  if (raw.length > MAX_IMPORT_BODY) return text('payload too large', 413)
  let body: { mode?: unknown; turns?: unknown } | null
  try { body = JSON.parse(raw) } catch { body = null }
  if (!body || !Array.isArray(body.turns)) return text('bad request', 400)
  if (body.turns.length > MAX_HISTORY_TURNS) return text(`at most ${MAX_HISTORY_TURNS} turns per request`, 400)
  await recordDropped(env, dev.id, 'import', body)
  const d = await env.DB.prepare('SELECT otlp_since FROM devices WHERE id = ?').bind(dev.id).first<{ otlp_since: string | null }>()
  const mode: ImportMode = body.mode === 'reconcile' ? 'reconcile' : 'backfill'
  return json(await importTurns(env, dev.user_email, { id: dev.id, otlp_since: d?.otlp_since ?? null }, body.turns, importProvider(body), mode))
}
