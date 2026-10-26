// POST /v1/activity: what the token-tracker mod measures beyond the limits, numbers only. GET /v1/config: what the device lets the mod send.
// A session: { id, started_at, ended_at?, end_reason?, project?, project_note? (why there is none: a word) }; turns: [{ id, session, ts, wall_ms, think_ms?, outcome, context_pct?, context_tokens?,
// context_window?, perm_asks, perm_denied, perm_wait_ms }]. The project (a repository's owner/name, or `h:` and 12 hex characters) is kept only as
// far as the device's project_mode allows: off keeps none, hash keeps a hash only, name keeps either. Anything else in the body is ignored.
import type { Env } from './env.ts'
import { authDevice } from './otlp-ingest.ts'
import { json, text } from './util.ts'

const MAX_BODY = 64_000
const MAX_TURNS = 50
export const PROJECT_MODES = ['off', 'name', 'hash'] as const
export type ProjectMode = (typeof PROJECT_MODES)[number]

const ID = /^[\w-]{1,80}$/
const WORD = /^[a-z_]{1,30}$/
const HASH = /^h:[0-9a-f]{12}$/
const NAME = /^[\w.-]{1,100}(\/[\w.-]{1,100})?$/
const OUTCOMES = new Set(['answer', 'aborted', 'refusal', 'error'])

export interface ModSession { id: string; started_at: string; ended_at: string | null; end_reason: string | null; project: string | null; project_note: string | null }
export interface ModTurn {
  id: string; session: string; ts: string; wall_ms: number; think_ms: number | null; outcome: string
  context_pct: number | null; context_tokens: number | null; context_window: number | null
  perm_asks: number; perm_denied: number; perm_wait_ms: number
}

const iso = (v: unknown): string | null => {
  if (typeof v !== 'string' || v.length > 40) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}
const int = (v: unknown, max: number): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(max, Math.round(v)) : null)

/** The project as far as the device allows it, else null. */
export function projectFor(v: unknown, mode: ProjectMode): string | null {
  if (typeof v !== 'string' || mode === 'off') return null
  if (HASH.test(v)) return v
  return mode === 'name' && NAME.test(v) ? v : null
}

export function parseActivity(body: unknown, mode: ProjectMode): { session: ModSession | null; turns: ModTurn[] } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const b = body as { session?: unknown; turns?: unknown }
  let session: ModSession | null = null
  if (b.session && typeof b.session === 'object') {
    const s = b.session as Record<string, unknown>
    const started = iso(s.started_at)
    if (typeof s.id === 'string' && ID.test(s.id) && started) {
      session = { id: s.id, started_at: started, ended_at: iso(s.ended_at), end_reason: typeof s.end_reason === 'string' && WORD.test(s.end_reason) ? s.end_reason : null, project: projectFor(s.project, mode),
        project_note: typeof s.project_note === 'string' && WORD.test(s.project_note) ? s.project_note : null }
    }
  }
  const turns: ModTurn[] = []
  for (const t of (Array.isArray(b.turns) ? b.turns : []).slice(0, MAX_TURNS) as Record<string, unknown>[]) {
    if (!t || typeof t !== 'object') continue
    const ts = iso(t.ts), wall = int(t.wall_ms, 86_400_000)
    if (typeof t.id !== 'string' || !ID.test(t.id) || typeof t.session !== 'string' || !ID.test(t.session) || !ts || wall === null) continue
    const pct = typeof t.context_pct === 'number' && Number.isFinite(t.context_pct) ? Math.min(100, Math.max(0, t.context_pct)) : null
    turns.push({
      id: t.id, session: t.session, ts, wall_ms: wall, think_ms: int(t.think_ms, 7 * 86_400_000),
      outcome: typeof t.outcome === 'string' && OUTCOMES.has(t.outcome) ? t.outcome : 'answer',
      context_pct: pct, context_tokens: int(t.context_tokens, 10_000_000), context_window: int(t.context_window, 10_000_000),
      perm_asks: int(t.perm_asks, 1000) ?? 0, perm_denied: int(t.perm_denied, 1000) ?? 0, perm_wait_ms: int(t.perm_wait_ms, 86_400_000) ?? 0,
    })
  }
  return { session, turns }
}

async function deviceMode(env: Env, id: string): Promise<ProjectMode> {
  const r = await env.DB.prepare('SELECT project_mode FROM devices WHERE id = ?').bind(id).first<{ project_mode: string }>()
  return (PROJECT_MODES as readonly string[]).includes(r?.project_mode ?? '') ? (r!.project_mode as ProjectMode) : 'off'
}

/** GET /v1/config */
export async function modConfig(req: Request, env: Env): Promise<Response> {
  const dev = await authDevice(req, env)
  if (!dev) return text('unauthorized', 401)
  return json({ project: await deviceMode(env, dev.id) })
}

/** POST /v1/activity */
export async function activityIngest(req: Request, env: Env): Promise<Response> {
  const dev = await authDevice(req, env)
  if (!dev) return text('unauthorized', 401)
  const body = await req.text()
  if (body.length > MAX_BODY) return text('payload too large', 413)
  let raw: unknown
  try { raw = JSON.parse(body) } catch { return text('bad request', 400) }
  const mode = await deviceMode(env, dev.id)
  const parsed = parseActivity(raw, mode)
  if (!parsed) return text('bad request', 400)
  const stmts: D1PreparedStatement[] = []
  const s = parsed.session
  if (s) {
    stmts.push(env.DB.prepare(
      `INSERT INTO mod_sessions (device_id, user_email, session_id, started_at, ended_at, end_reason, project, project_note) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (device_id, session_id) DO UPDATE SET started_at = MIN(started_at, excluded.started_at),
         ended_at = COALESCE(excluded.ended_at, ended_at), end_reason = COALESCE(excluded.end_reason, end_reason),
         project = COALESCE(excluded.project, project), project_note = COALESCE(excluded.project_note, project_note)`,
    ).bind(dev.id, dev.user_email, s.id, s.started_at, s.ended_at, s.end_reason, s.project, s.project_note))
  }
  for (const t of parsed.turns) {
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO mod_turns (device_id, user_email, session_id, turn_id, ts, wall_ms, think_ms, outcome, context_pct, context_tokens, context_window, perm_asks, perm_denied, perm_wait_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(dev.id, dev.user_email, t.session, t.id, t.ts, t.wall_ms, t.think_ms, t.outcome, t.context_pct, t.context_tokens, t.context_window, t.perm_asks, t.perm_denied, t.perm_wait_ms))
  }
  if (stmts.length) await env.DB.batch(stmts)
  return json({ turns: parsed.turns.length, session: !!s })
}
