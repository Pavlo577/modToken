import { createRemoteJWKSet, jwtVerify } from 'jose'

export interface Env {
  DB: D1Database
  ASSETS: Fetcher
  TEAM_DOMAIN: string
  POLICY_AUD: string
  /** Local development only (.dev.vars): skips Access and acts as this user. Never set in production. */
  DEV_EMAIL?: string
}

const CODE_TTL_MS = 10 * 60 * 1000
const MAX_OPEN_CODES = 5
const MAX_ROWS = 500

const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('')
const sha256 = async (s: string) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))))
const randomHex = (bytes: number) => hex(crypto.getRandomValues(new Uint8Array(bytes)))

const json = (data: unknown, status = 200) => Response.json(data, { status })
const text = (msg: string, status: number) => new Response(msg, { status })

const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0)
const str = (v: unknown, n = 200) => String(v ?? '').slice(0, n)

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined

/** The signed-in user's email, verified against Cloudflare Access; null when not signed in. */
export async function accessEmail(req: Request, env: Env): Promise<string | null> {
  if (env.DEV_EMAIL) return env.DEV_EMAIL
  const token = req.headers.get('cf-access-jwt-assertion')
  if (!token) return null
  try {
    jwks ??= createRemoteJWKSet(new URL(`${env.TEAM_DOMAIN}/cdn-cgi/access/certs`))
    const { payload } = await jwtVerify(token, jwks, { issuer: env.TEAM_DOMAIN, audience: env.POLICY_AUD })
    return typeof payload.email === 'string' ? payload.email.toLowerCase() : null
  } catch {
    return null
  }
}

const EVENT_SQL = `INSERT OR IGNORE INTO token_events
  (user_email, device_id, session_id, turn_id, ts, model, input_tokens, output_tokens,
   cache_read_tokens, cache_creation_tokens, duration_ms, is_subagent)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

/** One validated row as an INSERT, or null when its timestamp is not a date. */
function eventStmt(env: Env, email: string, deviceId: string, r: Record<string, unknown>, turnId = str(r.turn_id), sql = EVENT_SQL) {
  const ts = new Date(str(r.ts))
  if (Number.isNaN(ts.getTime())) return null
  return env.DB.prepare(sql).bind(
    email, deviceId, str(r.session_id), turnId, ts.toISOString(), str(r.model),
    int(r.input_tokens), int(r.output_tokens), int(r.cache_read_tokens), int(r.cache_creation_tokens),
    int(r.duration_ms), r.is_subagent === true ? 1 : 0,
  )
}

/** Old history for a device: only turns from before it was linked (later ones are collected live). */
async function importRows(env: Env, email: string, dev: { id: string; created_at: string }, rows: unknown): Promise<Response> {
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

async function importFromDevice(req: Request, env: Env): Promise<Response> {
  const token = req.headers.get('x-device-token') ?? ''
  const dev = await env.DB.prepare('SELECT id, user_email, created_at FROM devices WHERE token_hash = ? AND revoked = 0')
    .bind(await sha256(token))
    .first<{ id: string; user_email: string; created_at: string }>()
  if (!dev) return text('unauthorized', 401)
  const body = (await req.json().catch(() => null)) as { rows?: unknown } | null
  return importRows(env, dev.user_email, dev, body?.rows)
}

const INGEST_SQL = `${EVENT_SQL.replace('INSERT OR IGNORE', 'INSERT')}
  ON CONFLICT (device_id, turn_id) DO UPDATE SET
    input_tokens = MAX(input_tokens, excluded.input_tokens),
    output_tokens = MAX(output_tokens, excluded.output_tokens),
    cache_read_tokens = MAX(cache_read_tokens, excluded.cache_read_tokens),
    cache_creation_tokens = MAX(cache_creation_tokens, excluded.cache_creation_tokens),
    duration_ms = MAX(duration_ms, excluded.duration_ms)`

async function ingest(req: Request, env: Env): Promise<Response> {
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
    if (!/^[a-z_]+$/.test(kind) || !Number.isFinite(pct)) continue
    const resets = l.resetsAt ? new Date(str(l.resetsAt)) : null
    const resetsAt = resets && !Number.isNaN(resets.getTime()) ? resets.toISOString() : ''
    stmts.push(
      env.DB.prepare(
        `INSERT INTO plan_limits (user_email, device_id, ts, kind, percent_used, resets_at)
         SELECT ?1, ?2, ?3, ?4, ?5, NULLIF(?6, '')
         WHERE NOT EXISTS (
           SELECT 1 FROM plan_limits WHERE id = (SELECT MAX(id) FROM plan_limits WHERE device_id = ?2 AND kind = ?4)
             AND percent_used = ?5 AND IFNULL(resets_at, '') = ?6)`,
      ).bind(dev.user_email, dev.id, now, kind, Math.min(1000, Math.max(0, pct)), resetsAt),
    )
  }
  stmts.push(env.DB.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').bind(now, dev.id))
  await env.DB.batch(stmts)
  return new Response(null, { status: 204 })
}

/** A new device for `email` with a fresh random token; the token is returned once and only its hash is stored. */
async function createDevice(env: Env, email: string, name: string): Promise<string> {
  const token = randomHex(32)
  await env.DB.prepare('INSERT INTO devices (id, user_email, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), email, name, await sha256(token), new Date().toISOString())
    .run()
  return token
}

async function link(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { code?: unknown } | null
  const code = str(body?.code, 40).toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (code.length < 8 || code.length > 20) return text('bad code', 400)

  const now = new Date().toISOString()
  // One statement: the code is spent atomically, so it can never link two devices.
  const spent = await env.DB.prepare(
    'UPDATE link_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING user_email, device_name',
  )
    .bind(now, await sha256(code), now)
    .first<{ user_email: string; device_name: string }>()
  if (!spent) return text('invalid or used code', 403)

  const token = await createDevice(env, spent.user_email, spent.device_name)
  return json({ token, device: spent.device_name })
}

async function admin(req: Request, env: Env, url: URL): Promise<Response> {
  const email = await accessEmail(req, env)
  if (!email) return text('unauthorized', 401)
  const path = url.pathname.replace(/^\/api\/admin/, '')

  if (path === '/me' && req.method === 'GET') return json({ email })

  if (path === '/devices' && req.method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT id, name, revoked, created_at, last_seen FROM devices WHERE user_email = ? ORDER BY created_at DESC',
    ).bind(email).all()
    return json(results)
  }

  const dev = path.match(/^\/devices\/([0-9a-f-]{36})$/)
  if (dev && req.method === 'DELETE') {
    await env.DB.prepare('UPDATE devices SET revoked = 1 WHERE id = ? AND user_email = ?').bind(dev[1], email).run()
    return new Response(null, { status: 204 })
  }

  if (path === '/cloud-device' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as { name?: unknown } | null
    const name = str(body?.name, 60).trim()
    if (!name) return text('name required', 400)
    return json({ token: await createDevice(env, email, name), device: name })
  }

  if (path === '/codes' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as { name?: unknown } | null
    const name = str(body?.name, 60).trim()
    if (!name) return text('name required', 400)
    const now = new Date()
    const open = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM link_codes WHERE user_email = ? AND used_at IS NULL AND expires_at > ?',
    ).bind(email, now.toISOString()).first<{ n: number }>()
    if ((open?.n ?? 0) >= MAX_OPEN_CODES) return text('too many open codes', 429)
    const code = randomHex(5).toUpperCase()
    const expires = new Date(now.getTime() + CODE_TTL_MS).toISOString()
    await env.DB.prepare('INSERT INTO link_codes (code_hash, user_email, device_name, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256(code), email, name, expires).run()
    return json({ code, expires_at: expires })
  }

  if (path === '/import' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as { device_id?: unknown; rows?: unknown } | null
    const dev = await env.DB.prepare('SELECT id, created_at FROM devices WHERE id = ? AND user_email = ? AND revoked = 0')
      .bind(str(body?.device_id, 40), email).first<{ id: string; created_at: string }>()
    if (!dev) return text('device not found', 404)
    return importRows(env, email, dev, body?.rows)
  }

  if (['/buckets', '/turns', '/sessions', '/limits'].includes(path) && req.method === 'GET') {
    // [from, to) in UTC; the page groups by the viewer's own time zone, so the server only slices by time.
    const to = Date.parse(url.searchParams.get('to') ?? '') || Date.now() + 86_400_000
    const from = Math.max(Date.parse(url.searchParams.get('from') ?? '') || to - 30 * 86_400_000, to - 400 * 86_400_000)
    const a = new Date(from).toISOString()
    const b = new Date(to).toISOString()
    const sums = `SUM(e.input_tokens) AS input, SUM(e.output_tokens) AS output, SUM(e.cache_read_tokens) AS cache_read,
                  SUM(e.cache_creation_tokens) AS cache_creation, SUM(e.duration_ms) AS duration_ms, COUNT(*) AS turns`
    const all = <T>(sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).all<T>().then(r => r.results)
    if (path === '/buckets') {
      return json(await all(
        `SELECT substr(e.ts, 1, 13) AS h, d.name AS device, e.model AS model, ${sums}, SUM(e.is_subagent) AS sub
         FROM token_events e JOIN devices d ON d.id = e.device_id
         WHERE e.user_email = ? AND e.ts >= ? AND e.ts < ? GROUP BY h, e.device_id, e.model LIMIT 60000`, email, a, b))
    }
    if (path === '/turns') {
      return json(await all(
        `SELECT e.ts, d.name AS device, e.model, e.session_id, e.input_tokens AS input, e.output_tokens AS output,
                e.cache_read_tokens AS cache_read, e.cache_creation_tokens AS cache_creation, e.duration_ms, e.is_subagent AS sub
         FROM token_events e JOIN devices d ON d.id = e.device_id
         WHERE e.user_email = ? AND e.ts >= ? AND e.ts < ? ORDER BY e.ts LIMIT 5000`, email, a, b))
    }
    if (path === '/sessions') {
      return json(await all(
        `SELECT e.session_id, d.name AS device, MIN(e.ts) AS first_ts, MAX(e.ts) AS last_ts, ${sums},
                (SELECT x.model FROM token_events x WHERE x.device_id = e.device_id AND x.session_id = e.session_id
                 GROUP BY x.model ORDER BY SUM(x.output_tokens) DESC LIMIT 1) AS model
         FROM token_events e JOIN devices d ON d.id = e.device_id
         WHERE e.user_email = ? AND e.ts >= ? AND e.ts < ? GROUP BY e.device_id, e.session_id
         ORDER BY output DESC LIMIT 300`, email, a, b))
    }
    return json(await all(
      `SELECT l.ts, d.name AS device, l.kind, l.percent_used AS percent, l.resets_at
       FROM plan_limits l JOIN devices d ON d.id = l.device_id
       WHERE l.user_email = ? AND l.ts >= ? AND l.ts < ? ORDER BY l.ts LIMIT 20000`, email, a, b))
  }

  if (path === '/stats' && req.method === 'GET') {
    const days = Math.min(365, Math.max(1, int(Number(url.searchParams.get('days'))) || 30))
    // ?day=YYYY-MM-DD narrows everything to that one UTC day
    const dayParam = url.searchParams.get('day') ?? ''
    const day = /^\d{4}-\d{2}-\d{2}$/.test(dayParam) && !Number.isNaN(Date.parse(dayParam)) ? dayParam : null
    const since = day ? `${day}T00:00:00.000Z` : new Date(Date.now() - days * 86_400_000).toISOString()
    const until = day ? new Date(Date.parse(since) + 86_400_000).toISOString() : '9999-12-31'
    const q = (sql: string) => env.DB.prepare(sql).bind(email, since, until).all().then(r => r.results)
    const sums = `SUM(input_tokens) AS input, SUM(output_tokens) AS output,
                  SUM(cache_read_tokens) AS cache_read, SUM(cache_creation_tokens) AS cache_creation,
                  SUM(duration_ms) AS duration_ms, COUNT(*) AS turns`
    const where = 'FROM token_events e WHERE e.user_email = ? AND e.ts >= ? AND e.ts < ?'
    const [byDay, byModel, byHour, byDevice] = await Promise.all([
      q(`SELECT substr(e.ts, 1, 10) AS day, ${sums} ${where} GROUP BY day ORDER BY day`),
      q(`SELECT e.model AS model, ${sums} ${where} GROUP BY e.model ORDER BY output DESC`),
      q(`SELECT CAST(substr(e.ts, 12, 2) AS INTEGER) AS hour, ${sums} ${where} GROUP BY hour ORDER BY hour`),
      env.DB.prepare(
        `SELECT d.name AS device, ${sums} FROM token_events e JOIN devices d ON d.id = e.device_id
         WHERE e.user_email = ? AND e.ts >= ? AND e.ts < ? GROUP BY d.id ORDER BY output DESC`,
      ).bind(email, since, until).all().then(r => r.results),
    ])
    return json({ days, day, byDay, byModel, byHour, byDevice })
  }

  return text('not found', 404)
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/api/ingest' && req.method === 'POST') return ingest(req, env)
    if (url.pathname === '/api/link' && req.method === 'POST') return link(req, env)
    if (url.pathname === '/api/import' && req.method === 'POST') return importFromDevice(req, env)
    if (url.pathname.startsWith('/api/admin/')) return admin(req, env, url)
    if (url.pathname.startsWith('/api/')) return text('not found', 404)
    return env.ASSETS.fetch(req)
  },
} satisfies ExportedHandler<Env>
