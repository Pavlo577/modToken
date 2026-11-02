// POST /v1/plugin-log: what the agents' plugins report about themselves (the Codex plugin, the Claude mod), so the dashboard can show
// whether a device's plugin works: limits sent, the history import started or done (how many calls), and failures. Only a kind, counts,
// an error's TYPE (URLError, PermissionError ... never its message, which may hold a path) and a stage word; anything else is dropped.
// Kept in the events database as plugin.<kind> events (90 days), so no table of its own; GET /api/admin/plugin-log reads them back.
import type { Env } from './env.ts'
import { recordDropped } from './dropped.ts'
import { authDevice } from './otlp-ingest.ts'
import { json, text } from './util.ts'

export const PLUGIN_KINDS = ['limits', 'history_hook', 'history_imported', 'import', 'error'] as const
const MAX_BODY = 8_000
const MAX_EVENTS = 20

export interface PluginEvent { kind: string; n?: number; total?: number; error?: string; stage?: string }
export interface PluginLog { provider: 'claude' | 'codex'; version: string; events: PluginEvent[] }

const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1e9 ? v : undefined)
const word = (v: unknown, re: RegExp): string | undefined => (typeof v === 'string' && re.test(v) ? v : undefined)

/** The well-formed part of a report: known kinds, counts, an error type and a stage word; null when it is not a report at all. */
export function parsePluginLog(body: unknown): PluginLog | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  if (!Array.isArray(b.events)) return null
  const events: PluginEvent[] = []
  for (const e of b.events.slice(0, MAX_EVENTS) as Record<string, unknown>[]) {
    if (!e || typeof e !== 'object' || !(PLUGIN_KINDS as readonly string[]).includes(e.kind as string)) continue
    const x: PluginEvent = { kind: e.kind as string }
    const n = count(e.n), total = count(e.total), error = word(e.error, /^[A-Za-z][\w.]{0,59}$/), stage = word(e.stage, /^[a-z_]{1,20}$/)
    if (n !== undefined) x.n = n
    if (total !== undefined) x.total = total
    if (error) x.error = error
    if (stage) x.stage = stage
    events.push(x)
  }
  return { provider: b.provider === 'codex' ? 'codex' : 'claude', version: word(b.version, /^[\w.-]{1,20}$/) ?? '', events }
}

/** POST /v1/plugin-log, with the device token. */
export async function pluginLogIngest(req: Request, env: Env): Promise<Response> {
  const dev = await authDevice(req, env)
  if (!dev) return text('unauthorized', 401)
  const raw = await req.text()
  if (raw.length > MAX_BODY) return text('payload too large', 413)
  let body: unknown
  try { body = JSON.parse(raw) } catch { return text('bad request', 400) }
  const log = parsePluginLog(body)
  if (!log) return text('bad request: { provider, version, events: [...] }', 400)
  await recordDropped(env, dev.id, 'plugin_log', body)
  if (env.EVENTS && log.events.length) {
    const now = new Date().toISOString()
    const service = log.provider === 'codex' ? 'codex-plugin' : 'claude-mod'
    const sql = 'INSERT INTO events (device_id, user_email, dedupe, ts, name, service, session_id, prompt_id, surface, attrs) VALUES (?, ?, ?, ?, ?, ?, \'\', \'\', \'\', ?)'
    await env.EVENTS.batch(log.events.map(({ kind, ...rest }) => env.EVENTS!.prepare(sql)
      .bind(dev.id, dev.user_email, crypto.randomUUID(), now, 'plugin.' + kind, service, JSON.stringify({ ...rest, version: log.version }))))
      .catch(e => console.error('plugin log: ' + (e instanceof Error ? e.message : 'failed')))
  }
  return new Response(null, { status: 204 })
}

/** GET /api/admin/plugin-log: the user's plugin reports of the last 30 days, newest first (one indexed range per kind). */
export async function pluginLogRead(env: Env, email: string): Promise<Response> {
  if (!env.EVENTS) return json([])
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const names = PLUGIN_KINDS.map(k => 'plugin.' + k)
  const { results } = await env.EVENTS.prepare(
    `SELECT device_id, ts, name, service, attrs FROM events WHERE user_email = ? AND name IN (${names.map(() => '?').join(', ')}) AND ts >= ? ORDER BY ts DESC LIMIT 300`,
  ).bind(email, ...names, since).all<{ device_id: string; ts: string; name: string; service: string; attrs: string }>()
  return json(results.map(r => ({ device_id: r.device_id, ts: r.ts, kind: r.name.slice('plugin.'.length), service: r.service, ...(JSON.parse(r.attrs) as object) })))
}
