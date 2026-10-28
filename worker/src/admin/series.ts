// Admin route: GET /api/admin/series?from&to&step&off, the tokens in buckets of 5, 15 or 30 minutes (the hourly /buckets is too coarse for the main chart's finer steps).
// `off` is the viewer's UTC offset in minutes, so a bucket starts on the viewer's own clock (a half-hour zone still gets whole 30 minute buckets).
// Reads the turns of the period once, through the (user_email, ts) index; the answer is cached for a minute (`?fresh=1` skips the cache).
import { json, text } from '../util.ts'
import type { Routes } from './context.ts'

export const SERIES_STEPS = [5, 15, 30]
const MAX_DAYS = 40

export const seriesRoutes: Routes = async ({ req, env, url, email, path }) => {
  if (path !== '/series' || req.method !== 'GET') return null
  const step = Number(url.searchParams.get('step'))
  if (!SERIES_STEPS.includes(step)) return text('step must be 5, 15 or 30', 400)
  const off = Math.max(-720, Math.min(840, Math.trunc(Number(url.searchParams.get('off'))) || 0))
  const to = Date.parse(url.searchParams.get('to') ?? '') || Date.now() + 86_400_000
  const from = Math.max(Date.parse(url.searchParams.get('from') ?? '') || to - 86_400_000, to - MAX_DAYS * 86_400_000)
  const a = new Date(from).toISOString(), b = new Date(to).toISOString()

  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default
  const key = new Request(`https://series.cache.invalid/${encodeURIComponent(email)}/${a}/${b}/${step}/${off}`)
  const hit = url.searchParams.has('fresh') ? undefined : await cache?.match(key).catch(() => undefined)
  if (hit) return hit

  const secs = step * 60
  const { results } = await env.DB.prepare(
    `SELECT ((CAST(strftime('%s', e.ts) AS INTEGER) + ?4) / ?5) * ?5 - ?4 AS t, d.name AS device, e.provider AS provider,
            SUM(e.input_tokens) AS input, SUM(e.output_tokens) AS output, SUM(e.cache_read_tokens) AS cache_read, SUM(e.cache_creation_tokens) AS cache_creation,
            SUM(CASE WHEN e.kind = 'main' THEN 1 ELSE 0 END) AS turns, SUM(e.duration_ms) AS duration_ms -- turns = the main loop's, as in /buckets
     FROM token_events e JOIN devices d ON d.id = e.device_id
     WHERE e.user_email = ?1 AND e.ts >= ?2 AND e.ts < ?3
     GROUP BY t, e.device_id, e.provider LIMIT 20000`,
  ).bind(email, a, b, off * 60, secs).all<{ t: number }>()
  const res = json(results.map(r => ({ ...r, t: r.t * 1000 }))) // the start of the bucket, UTC milliseconds
  res.headers.set('cache-control', 'max-age=60')
  await cache?.put(key, res.clone()).catch(() => undefined)
  return res
}
