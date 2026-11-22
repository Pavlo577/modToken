// Admin routes about devices: list, add (the token is shown once), a new token for a device, what the mod may send about projects, revoke,
// and delete (`?purge=1`: the device and all it sent).
import { PROJECT_MODES } from '../activity.ts'
import { PROVIDERS, autoConsolidateDevices, autoDeviceName, createDevice, deleteDevice, mergeDevices, newDeviceToken } from '../devices.ts'
import { pluginLogRead } from '../pluginlog.ts'
import { json, str, text } from '../util.ts'
import type { Routes } from './context.ts'

const isMode = (v: unknown): v is (typeof PROJECT_MODES)[number] => typeof v === 'string' && (PROJECT_MODES as readonly string[]).includes(v)
const isProvider = (v: unknown): v is (typeof PROVIDERS)[number] => typeof v === 'string' && (PROVIDERS as readonly string[]).includes(v)

/** Devices with no interactions yet (last_seen null) stay at the top (newest first), then the most recently used. */
export function sortDevices<T extends { last_seen?: unknown; created_at?: unknown }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const al = typeof a.last_seen === 'string' && a.last_seen ? a.last_seen : ''
    const bl = typeof b.last_seen === 'string' && b.last_seen ? b.last_seen : ''
    if (!al !== !bl) return al ? 1 : -1
    if (al !== bl) return bl.localeCompare(al)
    return String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))
  })
}

export const deviceRoutes: Routes = async ({ req, env, email, path }) => {
  if (path === '/devices' && req.method === 'GET') {
    const query = `SELECT id, name, revoked, created_at, last_seen, otlp_since, project_mode,
              ${PROVIDERS.map(p => `(SELECT MAX(t.ts) FROM token_events t WHERE t.device_id = devices.id AND t.provider = '${p}') AS seen_${p}`).join(', ')}
       FROM devices WHERE user_email = ? ORDER BY (last_seen IS NOT NULL) ASC, last_seen DESC, created_at DESC`
    let { results } = await env.DB.prepare(query).bind(email).all<Record<string, unknown>>()
    if (await autoConsolidateDevices(env, email, results.map(r => ({ id: String(r.id), name: String(r.name) })))) {
      results = (await env.DB.prepare(query).bind(email).all<Record<string, unknown>>()).results
    }
    // per agent: when it last sent from the device (one index entry each: device_id, provider, ts)
    return json(sortDevices(results.map(row => {
      const d: Record<string, unknown> = {}, seen: Record<string, string> = {}
      for (const [k, v] of Object.entries(row)) if (k.startsWith('seen_')) { if (v) seen[k.slice(5)] = String(v) } else d[k] = v
      return { ...d, providers: Object.keys(seen), seen } as Record<string, unknown>
    })))
  }

  if (path === '/devices/merge' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as { target_id?: unknown; source_id?: unknown } | null
    const targetId = str(body?.target_id, 40).trim(), sourceId = str(body?.source_id, 40).trim()
    if (!targetId || !sourceId || targetId === sourceId) return text('target_id and source_id required', 400)
    return (await mergeDevices(env, email, targetId, sourceId)) ? json({ merged: true }) : text('not found', 404)
  }

  if (path === '/plugin-log' && req.method === 'GET') return pluginLogRead(env, email)

  if (path === '/devices' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as { name?: unknown; project_mode?: unknown; agent?: unknown; place?: unknown } | null
    let name = str(body?.name, 60).trim()
    if (!name) {
      if (!isProvider(body?.agent)) return text('name required', 400)
      const { results } = await env.DB.prepare('SELECT name FROM devices WHERE user_email = ?').bind(email).all<{ name: string }>()
      name = autoDeviceName(body.agent, typeof body?.place === 'string' ? body.place : 'linux', results.map(r => r.name))
    }
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
    const body = (await req.json().catch(() => null)) as { name?: unknown; project_mode?: unknown; auto_name?: unknown; agent?: unknown; place?: unknown } | null
    const hasAuto = body !== null && typeof body === 'object' && body.auto_name === true
    const hasName = body !== null && typeof body === 'object' && body.name !== undefined
    const hasMode = body !== null && typeof body === 'object' && body.project_mode !== undefined
    if (!hasAuto && !hasName && !hasMode) return text('name or project_mode required', 400)
    let nextName = hasName ? str(body?.name, 60).trim() : null
    if (hasAuto) {
      const agent = isProvider(body?.agent) ? body.agent : 'claude'
      const place = typeof body?.place === 'string' ? body.place : 'linux'
      const { results } = await env.DB.prepare('SELECT name FROM devices WHERE user_email = ? AND id != ?').bind(email, dev[1]).all<{ name: string }>()
      nextName = autoDeviceName(agent, place, results.map(r => r.name))
    } else if (hasName && !nextName) {
      return text('name required', 400)
    }
    if (hasMode && !isMode(body?.project_mode)) return text('project_mode: off, name or hash', 400)
    const mode = hasMode ? (body!.project_mode as (typeof PROJECT_MODES)[number]) : null
    const r = nextName && mode
      ? await env.DB.prepare('UPDATE devices SET name = ?, project_mode = ? WHERE id = ? AND user_email = ?').bind(nextName, mode, dev[1], email).run()
      : nextName
        ? await env.DB.prepare('UPDATE devices SET name = ? WHERE id = ? AND user_email = ?').bind(nextName, dev[1], email).run()
        : await env.DB.prepare('UPDATE devices SET project_mode = ? WHERE id = ? AND user_email = ?').bind(mode, dev[1], email).run()
    if (!r.meta.changes) return text('not found', 404)
    // what is already stored follows the new setting: off forgets every project of the device, hash forgets the names
    if (mode && mode !== 'name') {
      await env.DB.prepare(`UPDATE mod_sessions SET project = NULL WHERE device_id = ? AND project IS NOT NULL ${mode === 'hash' ? "AND project NOT LIKE 'h:%'" : ''}`).bind(dev[1]).run()
    }
    return json({ ...(nextName ? { name: nextName } : {}), ...(mode ? { project_mode: mode } : {}) })
  }

  return null
}
