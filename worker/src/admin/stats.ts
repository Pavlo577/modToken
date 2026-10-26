// The older summary endpoint (grouped on the server, UTC days); the page itself uses /buckets.
import { int, json } from '../util.ts'
import type { Routes } from './context.ts'

export const statsRoutes: Routes = async ({ req, env, url, email, path }) => {
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
                  SUM(duration_ms) AS duration_ms, SUM(CASE WHEN kind = 'main' THEN 1 ELSE 0 END) AS turns`
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
  return null
}
