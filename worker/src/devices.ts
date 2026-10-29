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
