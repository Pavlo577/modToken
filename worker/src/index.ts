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

async function ingest(req: Request, env: Env): Promise<Response> {
  const token = req.headers.get('x-device-token') ?? ''
  const dev = await env.DB.prepare('SELECT id, user_email FROM devices WHERE token_hash = ? AND revoked = 0')
    .bind(await sha256(token))
    .first<{ id: string; user_email: string }>()
  if (!dev) return text('unauthorized', 401)

  const body = await req.json().catch(() => null)
  if (!Array.isArray(body) || body.length === 0 || body.length > MAX_ROWS) return text('bad request', 400)

  const insert = env.DB.prepare(
    `INSERT OR IGNORE INTO token_events
     (user_email, device_id, session_id, turn_id, ts, model, input_tokens, output_tokens,
      cache_read_tokens, cache_creation_tokens, duration_ms, is_subagent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const stmts: D1PreparedStatement[] = []
  for (const r of body as Record<string, unknown>[]) {
    const ts = new Date(str(r.ts))
    if (Number.isNaN(ts.getTime())) return text('bad request', 400)
    stmts.push(
      insert.bind(
        dev.user_email, dev.id, str(r.session_id), str(r.turn_id), ts.toISOString(), str(r.model),
        int(r.input_tokens), int(r.output_tokens), int(r.cache_read_tokens), int(r.cache_creation_tokens),
        int(r.duration_ms), r.is_subagent === true ? 1 : 0,
      ),
    )
  }
  stmts.push(env.DB.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').bind(new Date().toISOString(), dev.id))
  await env.DB.batch(stmts)
  return new Response(null, { status: 204 })
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

  const token = randomHex(32)
  await env.DB.prepare('INSERT INTO devices (id, user_email, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), spent.user_email, spent.device_name, await sha256(token), now)
    .run()
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

  if (path === '/stats' && req.method === 'GET') {
    const days = Math.min(365, Math.max(1, int(Number(url.searchParams.get('days'))) || 30))
    const since = new Date(Date.now() - days * 86_400_000).toISOString()
    const q = (sql: string) => env.DB.prepare(sql).bind(email, since).all().then(r => r.results)
    const sums = `SUM(input_tokens) AS input, SUM(output_tokens) AS output,
                  SUM(cache_read_tokens) AS cache_read, SUM(cache_creation_tokens) AS cache_creation,
                  SUM(duration_ms) AS duration_ms, COUNT(*) AS turns`
    const where = 'FROM token_events e WHERE e.user_email = ? AND e.ts >= ?'
    const [byDay, byModel, byHour, byDevice] = await Promise.all([
      q(`SELECT substr(e.ts, 1, 10) AS day, ${sums} ${where} GROUP BY day ORDER BY day`),
      q(`SELECT e.model AS model, ${sums} ${where} GROUP BY e.model ORDER BY output DESC`),
      q(`SELECT CAST(substr(e.ts, 12, 2) AS INTEGER) AS hour, ${sums} ${where} GROUP BY hour ORDER BY hour`),
      env.DB.prepare(
        `SELECT d.name AS device, ${sums} FROM token_events e JOIN devices d ON d.id = e.device_id
         WHERE e.user_email = ? AND e.ts >= ? GROUP BY d.id ORDER BY output DESC`,
      ).bind(email, since).all().then(r => r.results),
    ])
    return json({ days, byDay, byModel, byHour, byDevice })
  }

  return text('not found', 404)
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/api/ingest' && req.method === 'POST') return ingest(req, env)
    if (url.pathname === '/api/link' && req.method === 'POST') return link(req, env)
    if (url.pathname.startsWith('/api/admin/')) return admin(req, env, url)
    if (url.pathname.startsWith('/api/')) return text('not found', 404)
    return env.ASSETS.fetch(req)
  },
} satisfies ExportedHandler<Env>
