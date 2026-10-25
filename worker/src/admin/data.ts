// Admin routes that hand the page its raw numbers: hourly buckets, single turns and sessions.
import { json } from '../util.ts'
import type { Routes } from './context.ts'

export const dataRoutes: Routes = async ({ req, env, url, email, path }) => {
  if (['/buckets', '/turns', '/sessions'].includes(path) && req.method === 'GET') {
    // [from, to) in UTC; the page groups by the viewer's own time zone, so the server only slices by time.
    const to = Date.parse(url.searchParams.get('to') ?? '') || Date.now() + 86_400_000
    const from = Math.max(Date.parse(url.searchParams.get('from') ?? '') || to - 30 * 86_400_000, to - 400 * 86_400_000)
    const a = new Date(from).toISOString()
    const b = new Date(to).toISOString()
    const sums = `SUM(e.input_tokens) AS input, SUM(e.output_tokens) AS output, SUM(e.cache_read_tokens) AS cache_read,
                  SUM(e.cache_creation_tokens) AS cache_creation, SUM(e.duration_ms) AS duration_ms, COUNT(*) AS turns,
                  CASE WHEN MIN(e.cost_micros) > 0 THEN SUM(e.cost_micros) ELSE 0 END AS cost_micros`
    const all = <T>(sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).all<T>().then(r => r.results)
    if (path === '/buckets') {
      return json(await all(
        `SELECT substr(e.ts, 1, 13) AS h, d.name AS device, e.model AS model, ${sums}, SUM(e.is_subagent) AS sub, e.provider AS provider
         FROM token_events e JOIN devices d ON d.id = e.device_id
         WHERE e.user_email = ? AND e.ts >= ? AND e.ts < ? GROUP BY h, e.device_id, e.model, e.provider LIMIT 60000`, email, a, b))
    }
    if (path === '/turns') {
      return json(await all(
        `SELECT e.ts, d.name AS device, e.model, e.session_id, e.input_tokens AS input, e.output_tokens AS output,
                e.cache_read_tokens AS cache_read, e.cache_creation_tokens AS cache_creation, e.duration_ms, e.is_subagent AS sub, e.provider AS provider
         FROM token_events e JOIN devices d ON d.id = e.device_id
         WHERE e.user_email = ? AND e.ts >= ? AND e.ts < ? ORDER BY e.ts LIMIT 5000`, email, a, b))
    }
    if (path === '/sessions') {
      return json(await all(
        `SELECT e.session_id, d.name AS device, MIN(e.ts) AS first_ts, MAX(e.ts) AS last_ts, e.provider AS provider, ${sums},
                (SELECT x.model FROM token_events x WHERE x.device_id = e.device_id AND x.session_id = e.session_id
                 GROUP BY x.model ORDER BY SUM(x.output_tokens) DESC LIMIT 1) AS model
         FROM token_events e JOIN devices d ON d.id = e.device_id
         WHERE e.user_email = ? AND e.ts >= ? AND e.ts < ? GROUP BY e.device_id, e.session_id, e.provider
         ORDER BY output DESC LIMIT 300`, email, a, b))
    }
    return null
  }
  return null
}
