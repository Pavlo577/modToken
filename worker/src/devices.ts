// Creating devices: one device = one token that an agent's OTLP exporter sends in the `x-device-token` header.
import type { Env } from './env.ts'
import { randomHex, sha256 } from './util.ts'

export const PROVIDERS = ['claude', 'codex', 'antigravity'] as const
export const PLACES = ['windows', 'linux', 'cloud'] as const

const AUTO_NAME_RE = /^(claude|codex|antigravity)-(windows|linux|cloud)(-\d+)?$/i

/** Returns true when `name` is still an auto-generated `<agent>-<place>(-N)` placeholder. */
export const isAutoDeviceName = (name: string): boolean => AUTO_NAME_RE.test(name.trim())

function uniqueName(base: string, existingNames: string[]): string {
  const taken = new Set(existingNames.map(n => n.trim().toLowerCase()))
  const cleanBase = base.slice(0, 56)
  if (!taken.has(cleanBase.toLowerCase())) return cleanBase
  for (let i = 2; i < 1000; i++) {
    const candidate = `${cleanBase}-${i}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return `${cleanBase}-${Date.now() % 10000}`
}

/** Builds a unique default device name (`<agent>-<place>` or `<agent>-<place>-2`) when the user leaves the name blank. */
export function autoDeviceName(agent: string, place: string, existingNames: string[] = []): string {
  const a = (PROVIDERS as readonly string[]).includes(agent) ? agent : 'claude'
  const p = (PLACES as readonly string[]).includes(place) ? place : 'linux'
  return uniqueName(`${a}-${p}`, existingNames)
}

/**
 * Computes `<agent>-<hostname>` when an install script reports the machine's hostname (`GET /v1/config?agent=...&host=...`),
 * but ONLY if the device still has its auto-generated `<agent>-<place>` placeholder name (never overwrites a custom name).
 */
export function hostDeviceName(
  currentName: string,
  agent: string | null | undefined,
  rawHost: string | null | undefined,
  existingNames: string[] = [],
): string | null {
  if (!isAutoDeviceName(currentName) || typeof rawHost !== 'string') return null
  const firstLabel = rawHost.trim().split('.')[0] ?? ''
  const host = firstLabel.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  if (host.length < 2 || /^localhost$/i.test(host)) return null
  const prefix = typeof agent === 'string' && (PROVIDERS as readonly string[]).includes(agent)
    ? agent
    : currentName.trim().split('-')[0].toLowerCase()
  return uniqueName(`${prefix}-${host}`, existingNames)
}

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
  await env.DB.prepare('DELETE FROM hourly_buckets WHERE device_id = ?').bind(id).run().catch(() => undefined)
  if (env.EVENTS) await env.EVENTS.prepare('DELETE FROM events WHERE user_email = ? AND device_id = ?').bind(email, id).run().catch(() => undefined)
  return true
}
