// The OTLP/HTTP receiver: POST /v1/logs (JSON). A device authenticates with its own token, as for /api/ingest: header `x-device-token`,
// or `Authorization: Bearer <token>` (what most OTLP exporters are set up with). Calls become turn rows by ADDING to the row of the turn
// (unlike /api/ingest, where a resent turn keeps the maximum); a call that was counted before changes nothing.
import type { Env } from './env.ts'
import { MAX_RECORDS, parseOtlpLogs } from './otlp.ts'
import type { EventRow, ModelCall } from './otlp.ts'
import { sha256, text } from './util.ts'

const MAX_BODY_BYTES = 4_000_000
const CHUNK = 100 // calls per D1 batch (two statements each)
const KEEP_EVENTS_DAYS = 90 // how long the events database keeps an event
const EVENT_CHUNK = 50
const KEEP_CALLS_DAYS = 14 // how long a counted call is remembered (an exporter retries within minutes)

/** The device behind the token in `x-device-token` or `Authorization: Bearer`, if it is not revoked. */
export async function authDevice(req: Request, env: Env) {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]
  const token = req.headers.get('x-device-token') ?? bearer ?? ''
  if (!token) return null
  return env.DB.prepare('SELECT id, user_email FROM devices WHERE token_hash = ? AND revoked = 0').bind(await sha256(token)).first<{ id: string; user_email: string }>()
}

/** The request body as text, at most MAX_BODY_BYTES after unzipping (exporters may send `Content-Encoding: gzip`); null if it is larger. */
async function readBody(req: Request): Promise<string | null> {
  const encoding = (req.headers.get('content-encoding') ?? '').toLowerCase()
  if (!req.body) return ''
  const stream = encoding === 'gzip' ? req.body.pipeThrough(new DecompressionStream('gzip')) : req.body
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) { await reader.cancel(); return null }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const c of chunks) { all.set(c, at); at += c.byteLength }
  return new TextDecoder().decode(all)
}

const OK = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })

function callStatements(env: Env, email: string, deviceId: string, c: ModelCall, now: string) {
  return [
    env.DB.prepare('INSERT OR IGNORE INTO otlp_calls (device_id, call_id, seen_at) VALUES (?, ?, ?)').bind(deviceId, c.call_id, now),
    // Only when the line above really added the call (changes() = 1): the row of the turn grows by this call's numbers.
    env.DB.prepare(
      `INSERT INTO token_events
         (user_email, device_id, session_id, turn_id, ts, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, duration_ms, is_subagent, provider, cost_micros)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14 WHERE changes() = 1
       ON CONFLICT (device_id, turn_id) DO UPDATE SET
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
         cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
         duration_ms = duration_ms + excluded.duration_ms,
         cost_micros = cost_micros + excluded.cost_micros,
         ts = MAX(ts, excluded.ts),
         model = CASE WHEN excluded.output_tokens > 0 THEN excluded.model ELSE model END,
         is_subagent = MAX(is_subagent, excluded.is_subagent)`,
    ).bind(
      email, deviceId, c.session_id, `otlp:${c.provider}:${c.session_id}:${c.turn_key}`.slice(0, 200), c.ts, c.model,
      c.input_tokens, c.output_tokens, c.cache_read_tokens, c.cache_creation_tokens, c.duration_ms, c.is_subagent ? 1 : 0, c.provider, c.cost_micros,
    ),
  ]
}

/** Every record of the request into the events database (own database: it may fail or be absent without touching the counting). */
async function storeEvents(env: Env, dev: { id: string; user_email: string }, events: EventRow[]): Promise<void> {
  if (!env.EVENTS || !events.length) return
  try {
    const sql = 'INSERT OR IGNORE INTO events (device_id, user_email, dedupe, ts, name, service, session_id, prompt_id, surface, attrs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    for (let i = 0; i < events.length; i += EVENT_CHUNK) {
      await env.EVENTS.batch(events.slice(i, i + EVENT_CHUNK).map(e => env.EVENTS!.prepare(sql).bind(dev.id, dev.user_email, e.dedupe, e.ts, e.name, e.service, e.session_id, e.prompt_id, e.surface, e.attrs)))
    }
    const cutoff = new Date(Date.now() - KEEP_EVENTS_DAYS * 86_400_000).toISOString()
    await env.EVENTS.prepare('DELETE FROM events WHERE id IN (SELECT id FROM events WHERE ts < ? LIMIT 500)').bind(cutoff).run()
  } catch (e) {
    console.error('events database: ' + (e instanceof Error ? e.message : 'failed')) // never the data
  }
}

/** POST /v1/logs */
export async function otlpLogs(req: Request, env: Env): Promise<Response> {
  const dev = await authDevice(req, env)
  if (!dev) return text('unauthorized', 401)
  if (!(req.headers.get('content-type') ?? '').toLowerCase().includes('json')) return text('send OTLP as JSON: OTEL_EXPORTER_OTLP_PROTOCOL=http/json', 415)
  const body = await readBody(req)
  if (body === null) return text('payload too large', 413)
  let payload: unknown
  try { payload = JSON.parse(body) } catch { return text('bad request', 400) }
  const parsed = parseOtlpLogs(payload, env.DEBUG_OTLP === 'raw' ? 'raw' : env.DEBUG_OTLP === '1')
  if (!parsed) return text(`bad request (not OTLP logs, or more than ${MAX_RECORDS} records)`, 400)

  const now = new Date().toISOString()
  for (let i = 0; i < parsed.calls.length; i += CHUNK) {
    await env.DB.batch(parsed.calls.slice(i, i + CHUNK).flatMap(c => callStatements(env, dev.user_email, dev.id, c, now)))
  }
  for (const x of parsed.seen) {
    await env.DB.prepare(
      `INSERT INTO otlp_seen (device_id, service, event, keys, lens, sample, n, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (device_id, service, event) DO UPDATE SET n = n + excluded.n, keys = excluded.keys, lens = excluded.lens, sample = excluded.sample, last_seen = excluded.last_seen`,
    ).bind(dev.id, x.service, x.event, x.keys, x.lens, env.DEBUG_OTLP === '1' || env.DEBUG_OTLP === 'raw' ? x.sample : '', x.n, now).run()
  }
  await storeEvents(env, dev, parsed.events)
  const cutoff = new Date(Date.now() - KEEP_CALLS_DAYS * 86_400_000).toISOString()
  const since = parsed.calls.reduce<string | null>((m, c) => (m === null || c.ts < m ? c.ts : m), null) // earliest call of this request
  await env.DB.batch([
    env.DB.prepare('UPDATE devices SET otlp_since = MIN(COALESCE(otlp_since, ?1), ?1) WHERE id = ?2 AND ?1 IS NOT NULL').bind(since, dev.id),
    env.DB.prepare('DELETE FROM otlp_calls WHERE rowid IN (SELECT rowid FROM otlp_calls WHERE seen_at < ? LIMIT 200)').bind(cutoff),
    env.DB.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').bind(now, dev.id),
  ])
  return OK()
}

/** Metrics and traces are accepted and dropped (the logs carry everything we keep), so an exporter that sends them does not retry or complain. */
export async function otlpIgnored(req: Request, env: Env): Promise<Response> {
  return (await authDevice(req, env)) ? OK() : text('unauthorized', 401)
}
