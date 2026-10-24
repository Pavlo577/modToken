// Creating devices and linking them with a one-time code.
import type { Env } from './env.ts'
import { json, randomHex, sha256, str, text } from './util.ts'

/** A new device for `email` with a fresh random token; the token is returned once and only its hash is stored. */
export async function createDevice(env: Env, email: string, name: string): Promise<string> {
  const token = randomHex(32)
  await env.DB.prepare('INSERT INTO devices (id, user_email, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), email, name, await sha256(token), new Date().toISOString())
    .run()
  return token
}

export async function createDeviceFromCode(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { code?: unknown } | null
  const code = str(body?.code, 40).toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (code.length < 8 || code.length > 20) return text('bad code', 400)

  const now = new Date().toISOString()
  // One statement: the code is spent atomically, so it can never link two devices.
  const spent = await env.DB.prepare(
    'UPDATE link_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING user_email, device_name',
  )
    .bind(now, await sha256(code), now)
    .first<{ user_email: string; device_name: string }>()
  if (!spent) return text('invalid or used code', 403)

  const token = await createDevice(env, spent.user_email, spent.device_name)
  return json({ token, device: spent.device_name })
}
