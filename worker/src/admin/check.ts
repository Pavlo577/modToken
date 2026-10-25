// Admin route behind the "Звірка: мод і OTLP" card: per session, the token counts the otlp-check mod saw against what OTLP counted (same device,
// same session id). A session found on one side only says the ids do not match, or one side was not running.
import { json } from '../util.ts'
import type { Routes } from './context.ts'

interface Side { input: number; output: number; cache_read: number; cache_creation: number; turns: number; first_ts: string; last_ts: string }

export const checkRoutes: Routes = async ({ req, env, url, email, path }) => {
  if (path !== '/check' || req.method !== 'GET') return null
  const to = Date.parse(url.searchParams.get('to') ?? '') || Date.now() + 86_400_000
  const from = Math.max(Date.parse(url.searchParams.get('from') ?? '') || to - 7 * 86_400_000, to - 60 * 86_400_000)
  const a = new Date(from).toISOString(), b = new Date(to).toISOString()
  const sums = (t: string, tok: [string, string, string, string]) => `SELECT d.name AS device, x.device_id, x.session_id, SUM(x.${tok[0]}) AS input, SUM(x.${tok[1]}) AS output,
      SUM(x.${tok[2]}) AS cache_read, SUM(x.${tok[3]}) AS cache_creation, COUNT(*) AS turns, MIN(x.ts) AS first_ts, MAX(x.ts) AS last_ts
    FROM ${t} x JOIN devices d ON d.id = x.device_id WHERE x.user_email = ?1 AND x.ts >= ?2 AND x.ts < ?3 GROUP BY x.device_id, x.session_id`
  const run = (sql: string) => env.DB.prepare(sql).bind(email, a, b).all<Side & { device: string; device_id: string; session_id: string }>().then(r => r.results).catch(() => [])
  const cols: [string, string, string, string] = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens']
  const [mod, otlp] = await Promise.all([run(sums('check_turns', cols)), run(sums('token_events', cols))])
  if (!mod.length) return json({ available: false, sessions: [] })
  // only the devices that run the check: the other devices' OTLP sessions say nothing about it
  const devices = new Set(mod.map(m => m.device_id))
  const key = (x: { device_id: string; session_id: string }) => `${x.device_id}|${x.session_id}`
  const o = new Map(otlp.filter(x => devices.has(x.device_id)).map(x => [key(x), x]))
  const m = new Map(mod.map(x => [key(x), x]))
  const pick = (x?: Side) => (x ? { input: x.input, output: x.output, cache_read: x.cache_read, cache_creation: x.cache_creation, turns: x.turns } : null)
  const sessions = [...new Set([...m.keys(), ...o.keys()])].map(k => {
    const x = m.get(k), y = o.get(k), any = (x ?? y)!
    return { device: any.device, session_id: any.session_id, first_ts: [x?.first_ts, y?.first_ts].filter(Boolean).sort()[0], mod: pick(x), otlp: pick(y) }
  }).sort((p, q) => String(q.first_ts).localeCompare(String(p.first_ts)))
  return json({ available: true, sessions })
}
