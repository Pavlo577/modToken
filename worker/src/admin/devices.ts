// Admin routes about devices: list, add (the token is shown once) and revoke.
import { createDevice } from '../devices.ts'
import { json, str, text } from '../util.ts'
import type { Routes } from './context.ts'

export const deviceRoutes: Routes = async ({ req, env, email, path }) => {
  if (path === '/devices' && req.method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT id, name, revoked, created_at, last_seen, otlp_since,
              (SELECT GROUP_CONCAT(DISTINCT t.provider) FROM token_events t WHERE t.device_id = devices.id) AS providers
       FROM devices WHERE user_email = ? ORDER BY created_at DESC`,
    ).bind(email).all()
    return json(results.map(({ providers, ...d }) => ({ ...d, providers: providers ? String(providers).split(',') : [] })))
  }

  if (path === '/devices' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as { name?: unknown } | null
    const name = str(body?.name, 60).trim()
    if (!name) return text('name required', 400)
    return json({ token: await createDevice(env, email, name), device: name })
  }

  const dev = path.match(/^\/devices\/([0-9a-f-]{36})$/)
  if (dev && req.method === 'DELETE') {
    await env.DB.prepare('UPDATE devices SET revoked = 1 WHERE id = ? AND user_email = ?').bind(dev[1], email).run()
    return new Response(null, { status: 204 })
  }

  return null
}
