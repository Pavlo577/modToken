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
