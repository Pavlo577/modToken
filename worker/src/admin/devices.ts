// Admin routes about devices: list, revoke, cloud token, link codes and the old-history import.
import { createDevice } from '../devices.ts'
import { importRows } from '../ingest.ts'
import { json, randomHex, sha256, str, text } from '../util.ts'
import type { Routes } from './context.ts'

const CODE_TTL_MS = 10 * 60 * 1000
const MAX_OPEN_CODES = 5

export const deviceRoutes: Routes = async ({ req, env, email, path }) => {
  if (path === '/devices' && req.method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT id, name, revoked, created_at, last_seen, EXISTS(SELECT 1 FROM plan_limits p WHERE p.device_id = devices.id) AS has_limits, (SELECT GROUP_CONCAT(DISTINCT t.provider) FROM token_events t WHERE t.device_id = devices.id) AS providers FROM devices WHERE user_email = ? ORDER BY created_at DESC',
    ).bind(email).all()
    // Billing is told apart only by whether the device ever reported subscription limits.
    return json(results.map(({ has_limits, providers, ...d }) => ({ ...d, billing: has_limits ? 'subscription' : 'unknown', providers: providers ? String(providers).split(',') : [] })))
  }

  const dev = path.match(/^\/devices\/([0-9a-f-]{36})$/)
  if (dev && req.method === 'DELETE') {
    await env.DB.prepare('UPDATE devices SET revoked = 1 WHERE id = ? AND user_email = ?').bind(dev[1], email).run()
    return new Response(null, { status: 204 })
  }

  if (path === '/cloud-device' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as { name?: unknown } | null
    const name = str(body?.name, 60).trim()
    if (!name) return text('name required', 400)
    return json({ token: await createDevice(env, email, name), device: name })
  }

  if (path === '/codes' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as { name?: unknown } | null
    const name = str(body?.name, 60).trim()
    if (!name) return text('name required', 400)
    const now = new Date()
    const open = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM link_codes WHERE user_email = ? AND used_at IS NULL AND expires_at > ?',
    ).bind(email, now.toISOString()).first<{ n: number }>()
    if ((open?.n ?? 0) >= MAX_OPEN_CODES) return text('too many open codes', 429)
    const code = randomHex(5).toUpperCase()
    const expires = new Date(now.getTime() + CODE_TTL_MS).toISOString()
    await env.DB.prepare('INSERT INTO link_codes (code_hash, user_email, device_name, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256(code), email, name, expires).run()
    return json({ code, expires_at: expires })
  }

  // Cancels a code that was made but not used (the user changed their mind): it can no longer link anything.
  if (path === '/codes/cancel' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as { code?: unknown } | null
    const code = str(body?.code, 40).toUpperCase().replace(/[^A-Z0-9]/g, '')
    await env.DB.prepare('UPDATE link_codes SET used_at = ? WHERE code_hash = ? AND user_email = ? AND used_at IS NULL')
      .bind(new Date().toISOString(), await sha256(code), email).run()
    return new Response(null, { status: 204 })
  }

  if (path === '/import' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as { device_id?: unknown; rows?: unknown } | null
    const dev = await env.DB.prepare('SELECT id, created_at FROM devices WHERE id = ? AND user_email = ? AND revoked = 0')
      .bind(str(body?.device_id, 40), email).first<{ id: string; created_at: string }>()
    if (!dev) return text('device not found', 404)
    return importRows(env, email, dev, body?.rows)
  }

  return null
}
