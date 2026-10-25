// POST /v1/statusline: a log of what Claude Code's `statusLine` command is given, to find out which fields it carries (subscription limits among them).
// Only the SHAPE is kept: every key path, numbers and flags as they are, an ISO timestamp as it is, any other string by its length only
// (the input holds cwd, paths and the model's name; none of it is stored). One row per device: the last shape and a counter.
import type { Env } from './env.ts'
import { authDevice } from './otlp-ingest.ts'
import { text } from './util.ts'

const MAX_BODY = 64_000
const MAX_PATHS = 300
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})?$/

/** Key path → harmless value (see above); arrays are walked as `path[]` (their items merge into one path). */
export function statuslineShape(input: unknown): Record<string, number | boolean | string | null> {
  const out: Record<string, number | boolean | string | null> = {}
  const walk = (v: unknown, path: string, depth: number): void => {
    if (Object.keys(out).length >= MAX_PATHS || depth > 8) return
    if (Array.isArray(v)) { for (const x of v.slice(0, 5)) walk(x, path + '[]', depth + 1); return }
    if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k.slice(0, 60)}` : k.slice(0, 60), depth + 1); return }
    if (typeof v === 'number' || typeof v === 'boolean') out[path] = v
    else if (typeof v === 'string') out[path] = ISO.test(v) ? v : `str:${v.length}`
    else out[path] = null
  }
  walk(input, '', 0)
  return out
}

export async function statuslineLog(req: Request, env: Env): Promise<Response> {
  const dev = await authDevice(req, env)
  if (!dev) return text('unauthorized', 401)
  const body = await req.text()
  if (body.length > MAX_BODY) return text('payload too large', 413)
  let input: unknown
  try { input = JSON.parse(body) } catch { return text('bad request', 400) }
  const shape = statuslineShape(input)
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO statusline_seen (device_id, n, keys, sample, last_seen) VALUES (?, 1, ?, ?, ?)
     ON CONFLICT (device_id) DO UPDATE SET n = n + 1, keys = excluded.keys, sample = excluded.sample, last_seen = excluded.last_seen`,
  ).bind(dev.id, Object.keys(shape).sort().join(' '), JSON.stringify(shape), now).run()
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
}
