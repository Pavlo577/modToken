// Admin routes about devices: list, add (the token is shown once), a new token for a device, what the mod may send about projects, revoke,
// and delete (`?purge=1`: the device and all it sent).
import { PROJECT_MODES } from '../activity.ts'
import { createDevice, deleteDevice, newDeviceToken } from '../devices.ts'
import { pluginLogRead } from '../pluginlog.ts'
import { json, str, text } from '../util.ts'
import type { Routes } from './context.ts'

const PROVIDERS = ['claude', 'codex'] as const // the agents a device can send from (token_events.provider)
const isMode = (v: unknown): v is (typeof PROJECT_MODES)[number] => typeof v === 'string' && (PROJECT_MODES as readonly string[]).includes(v)

export const deviceRoutes: Routes = async ({ req, env, email, path }) => {
  if (path === '/devices' && req.method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT id, name, revoked, created_at, last_seen, otlp_since, project_mode,
              ${PROVIDERS.map(p => `(SELECT MAX(t.ts) FROM token_events t WHERE t.device_id = devices.id AND t.provider = '${p}') AS seen_${p}`).join(', ')}
       FROM devices WHERE user_email = ? ORDER BY created_at DESC`,
    ).bind(email).all<Record<string, unknown>>()
    // per agent: when it last sent from the device (one index entry each: device_id, provider, ts)
    return json(results.map(row => {
      const d: Record<string, unknown> = {}, seen: Record<string, string> = {}
      for (const [k, v] of Object.entries(row)) if (k.startsWith('seen_')) { if (v) seen[k.slice(5)] = String(v) } else d[k] = v
      return { ...d, providers: Object.keys(seen), seen }
    }))
  }

  if (path === '/plugin-log' && req.method === 'GET') return pluginLogRead(env, email)

  if (path === '/devices' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as { name?: unknown; project_mode?: unknown } | null
    const name = str(body?.name, 60).trim()
    if (!name) return text('name required', 400)
    const mode = body?.project_mode ?? 'off'
    if (!isMode(mode)) return text('project_mode: off, name or hash', 400)
    return json({ token: await createDevice(env, email, name, mode), device: name })
  }

  const renew = path.match(/^\/devices\/([0-9a-f-]{36})\/token$/)
  if (renew && req.method === 'POST') {
    const r = await newDeviceToken(env, email, renew[1])
    return r ? json({ token: r.token, device: r.name }) : text('not found', 404)
  }

  const dev = path.match(/^\/devices\/([0-9a-f-]{36})$/)
  if (dev && req.method === 'DELETE' && new URL(req.url).searchParams.get('purge') === '1') {
    return (await deleteDevice(env, email, dev[1])) ? new Response(null, { status: 204 }) : text('not found', 404)
  }
  if (dev && req.method === 'DELETE') {
    await env.DB.prepare('UPDATE devices SET revoked = 1 WHERE id = ? AND user_email = ?').bind(dev[1], email).run()
    return new Response(null, { status: 204 })
  }
  if (dev && req.method === 'PATCH') {
    const body = (await req.json().catch(() => null)) as { project_mode?: unknown } | null
    if (!isMode(body?.project_mode)) return text('project_mode: off, name or hash', 400)
    const mode = body.project_mode
    const r = await env.DB.prepare('UPDATE devices SET project_mode = ? WHERE id = ? AND user_email = ?').bind(mode, dev[1], email).run()
    if (!r.meta.changes) return text('not found', 404)
    // what is already stored follows the new setting: off forgets every project of the device, hash forgets the names
    if (mode !== 'name') {
      await env.DB.prepare(`UPDATE mod_sessions SET project = NULL WHERE device_id = ? AND project IS NOT NULL ${mode === 'hash' ? "AND project NOT LIKE 'h:%'" : ''}`).bind(dev[1]).run()
    }
    return json({ project_mode: mode })
  }

  return null
}
