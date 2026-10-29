// Creating devices: one device = one token that an agent's OTLP exporter sends in the `x-device-token` header.
import type { Env } from './env.ts'
import { randomHex, sha256 } from './util.ts'

/** A new device for `email` with a fresh random token; the token is returned once and only its hash is stored. */
export async function createDevice(env: Env, email: string, name: string, projectMode = 'off'): Promise<string> {
  const token = randomHex(32)
  await env.DB.prepare('INSERT INTO devices (id, user_email, name, token_hash, created_at, project_mode) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), email, name, await sha256(token), new Date().toISOString(), projectMode)
    .run()
  return token
}

/**
 * A new token for an existing device of `email` (its name, settings and data stay): the old token stops working at once. The way to
 * set a device up again, since a token is shown only when it is made. Null when there is no such device or it is revoked.
 */
export async function newDeviceToken(env: Env, email: string, id: string): Promise<{ token: string; name: string } | null> {
  const token = randomHex(32)
  const row = await env.DB.prepare('UPDATE devices SET token_hash = ? WHERE id = ? AND user_email = ? AND revoked = 0 RETURNING name')
    .bind(await sha256(token), id, email).first<{ name: string }>()
  return row ? { token, name: row.name } : null
}

/**
 * Deletes a device of `email` and everything it sent: its turns, limits, sessions, the counted-call and seen-field records, and its events
 * in the events database. Unlike revoking, its numbers leave the statistics. False when there is no such device.
 */
export async function deleteDevice(env: Env, email: string, id: string): Promise<boolean> {
  const dev = await env.DB.prepare('SELECT id FROM devices WHERE id = ? AND user_email = ?').bind(id, email).first<{ id: string }>()
  if (!dev) return false
  await env.DB.batch([
    env.DB.prepare('DELETE FROM token_events WHERE device_id = ?').bind(id),
    env.DB.prepare('DELETE FROM otlp_calls WHERE device_id = ?').bind(id),
    env.DB.prepare('DELETE FROM otlp_seen WHERE device_id = ?').bind(id),
    env.DB.prepare('DELETE FROM plan_limits WHERE user_email = ? AND device_id = ?').bind(email, id),
    env.DB.prepare('DELETE FROM mod_turns WHERE device_id = ?').bind(id),
    env.DB.prepare('DELETE FROM mod_sessions WHERE device_id = ?').bind(id),
    env.DB.prepare('DELETE FROM devices WHERE id = ? AND user_email = ?').bind(id, email),
  ])
  if (env.EVENTS) await env.EVENTS.prepare('DELETE FROM events WHERE user_email = ? AND device_id = ?').bind(email, id).run().catch(() => undefined)
  return true
}
