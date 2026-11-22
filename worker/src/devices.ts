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

/**
 * If `dev.name` (or a sibling device on the same OS/place for `dev.user_email`) is still an auto-generated `<agent>-<place>`
 * placeholder and the request supplies a valid machine hostname (via `?host=` or `x-device-host`), upgrades `devices.name` in D1
 * to `<agent>-<hostname>` (and propagates the hostname to sibling `<other_agent>-<place>` placeholders on the same machine).
 */
export async function maybeAutoNameDevice(
  env: Env,
  dev: { id: string; user_email: string; name: string },
  agent: string | null | undefined,
  rawHost: string | null | undefined,
): Promise<void> {
  if (!rawHost) return
  const placeMatch = /^(?:claude|codex|antigravity)-(windows|linux)(?:-\d+)?$/i.exec(dev.name.trim())
  const inferredPlace = placeMatch
    ? (placeMatch[1].toLowerCase() as 'windows' | 'linux')
    : /[A-Z]{2,}/.test(rawHost.trim().split('.')[0] ?? '') ? 'windows' : 'linux'

  if (!isAutoDeviceName(dev.name)) {
    // Even if this device was already named (e.g. claude-KOTUS), check if sibling placeholders on the same OS still need the hostname
    const { results } = await env.DB.prepare('SELECT id, name FROM devices WHERE user_email = ?').bind(dev.user_email).all<{ id: string; name: string }>()
    const siblings = results.filter(r => new RegExp(`^(claude|codex|antigravity)-${inferredPlace}(-\\d+)?$`, 'i').test(r.name.trim()))
    if (!siblings.length) return
    const taken = results.map(r => r.name)
    for (const sib of siblings) {
      const sibAgent = sib.name.trim().split('-')[0].toLowerCase()
      const next = hostDeviceName(sib.name, sibAgent, rawHost, taken.filter(n => n !== sib.name))
      if (next && next !== sib.name) {
        await env.DB.prepare('UPDATE devices SET name = ? WHERE id = ?').bind(next, sib.id).run()
        const idx = taken.indexOf(sib.name)
        if (idx !== -1) taken[idx] = next
      }
    }
    return
  }

  const { results } = await env.DB.prepare('SELECT id, name FROM devices WHERE user_email = ?').bind(dev.user_email).all<{ id: string; name: string }>()
  const taken = results.map(r => r.name)
  const ownAgent = /^(claude|codex|antigravity)-/i.exec(dev.name.trim())?.[1]?.toLowerCase() ?? agent
  const next = hostDeviceName(dev.name, ownAgent, rawHost, taken.filter(n => n !== dev.name))
  if (next && next !== dev.name) {
    await env.DB.prepare('UPDATE devices SET name = ? WHERE id = ?').bind(next, dev.id).run()
    const idx = taken.indexOf(dev.name)
    if (idx !== -1) taken[idx] = next
    dev.name = next
  }
  for (const sib of results) {
    if (sib.id === dev.id) continue
    if (!new RegExp(`^(claude|codex|antigravity)-${inferredPlace}(-\\d+)?$`, 'i').test(sib.name.trim())) continue
    const sibAgent = sib.name.trim().split('-')[0].toLowerCase()
    const sibNext = hostDeviceName(sib.name, sibAgent, rawHost, taken.filter(n => n !== sib.name))
    if (sibNext && sibNext !== sib.name) {
      await env.DB.prepare('UPDATE devices SET name = ? WHERE id = ?').bind(sibNext, sib.id).run()
      const idx = taken.indexOf(sib.name)
      if (idx !== -1) taken[idx] = sibNext
    }
  }
}

/**
 * Ensures `targetAgent` (`claude`, `codex`, or `antigravity`) on `rawHost` has its own dedicated device and token for `dev.user_email`.
 * - If the authenticated `dev` already belongs to `targetAgent` (e.g. `claude-brolafkodev` for `claude`), keeps its existing token.
 * - If `dev` belongs to another agent (e.g. `claude-KOTUS` while syncing `antigravity` or `codex`), finds the user's existing
 *   `${targetAgent}-${host}` or `${targetAgent}-${place}` device (or creates `${targetAgent}-${host}` if none exists) and returns a
 *   synced token for it so `modtoken update` can configure every agent on the PC automatically.
 */
export async function syncAgentDevice(
  env: Env,
  dev: { id: string; user_email: string; name: string },
  targetAgent: string | null | undefined,
  rawHost: string | null | undefined,
  rawOs?: string | null,
): Promise<{ device: string; token?: string; project?: string }> {
  await maybeAutoNameDevice(env, dev, targetAgent, rawHost)
  if (!targetAgent || !(PROVIDERS as readonly string[]).includes(targetAgent)) {
    return { device: dev.name }
  }
  if (dev.name.trim().toLowerCase().startsWith(`${targetAgent}-`)) {
    return { device: dev.name }
  }

  const cleanHost = rawHost ? rawHost.trim().split('.')[0]?.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) ?? '' : ''
  const place: 'windows' | 'linux' =
    rawOs === 'windows'
      ? 'windows'
      : rawOs === 'linux'
        ? 'linux'
        : cleanHost && /[A-Z]{2,}/.test(cleanHost)
          ? 'windows'
          : 'linux'

  const { results } = await env.DB.prepare(
    'SELECT id, name, project_mode FROM devices WHERE user_email = ? AND revoked = 0 ORDER BY (last_seen IS NOT NULL) ASC, last_seen DESC, created_at DESC',
  ).bind(dev.user_email).all<{ id: string; name: string; project_mode: string }>()

  const taken = results.map(r => r.name)
  const exactPrefix = cleanHost ? `${targetAgent}-${cleanHost}`.toLowerCase() : ''
  const placeRe = new RegExp(`^${targetAgent}-${place}(-\\d+)?$`, 'i')
  const targetDev =
    (exactPrefix ? results.find(r => r.id !== dev.id && r.name.trim().toLowerCase() === exactPrefix) : undefined) ??
    results.find(r => r.id !== dev.id && placeRe.test(r.name.trim()))

  if (targetDev) {
    let finalName = targetDev.name
    if (cleanHost && isAutoDeviceName(targetDev.name)) {
      const renamed = hostDeviceName(targetDev.name, targetAgent, cleanHost, taken.filter(n => n !== targetDev.name))
      if (renamed && renamed !== targetDev.name) {
        await env.DB.prepare('UPDATE devices SET name = ? WHERE id = ?').bind(renamed, targetDev.id).run()
        finalName = renamed
      }
    }
    const issued = await newDeviceToken(env, dev.user_email, targetDev.id)
    return {
      device: issued?.name ?? finalName,
      ...(issued?.token ? { token: issued.token } : {}),
      project: targetDev.project_mode,
    }
  }

  const callerRow = results.find(r => r.id === dev.id)
  const mode = callerRow?.project_mode ?? 'name'
  const newName =
    (cleanHost && hostDeviceName(`${targetAgent}-${place}`, targetAgent, cleanHost, taken)) ||
    autoDeviceName(targetAgent as (typeof PROVIDERS)[number], place, taken)
  const token = await createDevice(env, dev.user_email, newName, mode)
  return { device: newName, token, project: mode }
}

/**
 * Merges `sourceId` into `targetId` for `email`: transfers all turns, calls, seen fields, limits, mod sessions/turns, and events
 * to `targetId` (ignoring duplicates), recomputes `hourly_buckets` and `last_seen`/`otlp_since`, and deletes `sourceId`.
 */
export async function mergeDevices(env: Env, email: string, targetId: string, sourceId: string): Promise<boolean> {
  if (!targetId || !sourceId || targetId === sourceId) return false
  const { results } = await env.DB.prepare('SELECT id, last_seen, otlp_since FROM devices WHERE user_email = ? AND id IN (?, ?)')
    .bind(email, targetId, sourceId).all<{ id: string; last_seen: string | null; otlp_since: string | null }>()
  const target = results.find(r => r.id === targetId)
  const source = results.find(r => r.id === sourceId)
  if (!target || !source) return false

  const lastSeen = [target.last_seen, source.last_seen].filter((x): x is string => Boolean(x)).sort().pop() ?? null
  const otlpSince = [target.otlp_since, source.otlp_since].filter((x): x is string => Boolean(x)).sort()[0] ?? null

  await env.DB.batch([
    env.DB.prepare('UPDATE OR IGNORE token_events SET device_id = ? WHERE device_id = ?').bind(targetId, sourceId),
    env.DB.prepare('DELETE FROM token_events WHERE device_id = ?').bind(sourceId),
    env.DB.prepare('UPDATE OR IGNORE otlp_calls SET device_id = ? WHERE device_id = ?').bind(targetId, sourceId),
    env.DB.prepare('DELETE FROM otlp_calls WHERE device_id = ?').bind(sourceId),
    env.DB.prepare('UPDATE OR IGNORE otlp_seen SET device_id = ? WHERE device_id = ?').bind(targetId, sourceId),
    env.DB.prepare('DELETE FROM otlp_seen WHERE device_id = ?').bind(sourceId),
    env.DB.prepare('UPDATE plan_limits SET device_id = ? WHERE user_email = ? AND device_id = ?').bind(targetId, email, sourceId),
    env.DB.prepare('UPDATE OR IGNORE mod_turns SET device_id = ? WHERE device_id = ?').bind(targetId, sourceId),
    env.DB.prepare('DELETE FROM mod_turns WHERE device_id = ?').bind(sourceId),
    env.DB.prepare('UPDATE OR IGNORE mod_sessions SET device_id = ? WHERE device_id = ?').bind(targetId, sourceId),
    env.DB.prepare('DELETE FROM mod_sessions WHERE device_id = ?').bind(sourceId),
    env.DB.prepare('UPDATE devices SET last_seen = ?, otlp_since = ? WHERE id = ? AND user_email = ?').bind(lastSeen, otlpSince, targetId, email),
    env.DB.prepare('DELETE FROM devices WHERE id = ? AND user_email = ?').bind(sourceId, email),
  ])

  await env.DB.batch([
    env.DB.prepare('DELETE FROM hourly_buckets WHERE device_id IN (?, ?)').bind(targetId, sourceId),
    env.DB.prepare(
      `INSERT OR REPLACE INTO hourly_buckets
         (user_email, device_id, h, model, provider, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, duration_ms, turns, bg_output, cost_micros, sub)
       SELECT user_email, device_id, substr(ts, 1, 13), model, provider,
              SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_creation_tokens), SUM(duration_ms),
              SUM(CASE WHEN kind = 'main' THEN 1 ELSE 0 END),
              SUM(CASE WHEN kind = 'bg' THEN output_tokens ELSE 0 END),
              CASE WHEN MIN(cost_micros) > 0 THEN SUM(cost_micros) ELSE 0 END,
              SUM(is_subagent)
       FROM token_events WHERE device_id = ?
       GROUP BY user_email, device_id, substr(ts, 1, 13), model, provider`,
    ).bind(targetId),
  ]).catch(() => undefined)

  if (env.EVENTS) {
    await env.EVENTS.batch([
      env.EVENTS.prepare('UPDATE OR IGNORE events SET device_id = ? WHERE user_email = ? AND device_id = ?').bind(targetId, email, sourceId),
      env.EVENTS.prepare('DELETE FROM events WHERE user_email = ? AND device_id = ?').bind(email, sourceId),
    ]).catch(() => undefined)
  }
  return true
}

const LEGACY_MERGES: readonly { target: string; fallbackTargets: readonly string[]; sources: readonly string[] }[] = [
  { target: 'linux-le-h', fallbackTargets: ['claude-linux'], sources: ['linux-lekh-h', 'home-le'] },
  { target: 'win-pk-h-codex', fallbackTargets: ['codex-windows'], sources: ['win-pk-h codex'] },
]

const LEGACY_AUTO_RESET: Readonly<Record<string, { agent: (typeof PROVIDERS)[number]; place: (typeof PLACES)[number] }>> = {
  'linux-le-h': { agent: 'claude', place: 'linux' },
  'win-pk-h': { agent: 'claude', place: 'windows' },
  'cloud-cc': { agent: 'claude', place: 'cloud' },
  'win-pk-h-codex': { agent: 'codex', place: 'windows' },
  'win-agy': { agent: 'antigravity', place: 'windows' },
  'agy-lekh': { agent: 'antigravity', place: 'linux' },
}

/**
 * Idempotent one-time consolidation of the legacy duplicate devices and reset of manual legacy names to auto-placeholders
 * (`<agent>-<place>`) so each sits in its right agent group and auto-updates to `<agent>-<hostname>` on next connection.
 */
export async function autoConsolidateDevices(env: Env, email: string, rows: { id: string; name: string }[]): Promise<boolean> {
  const byName = new Map(rows.map(r => [r.name, r]))
  let changed = false

  for (const m of LEGACY_MERGES) {
    const target = byName.get(m.target) ?? m.fallbackTargets.map(t => byName.get(t)).find(Boolean)
    if (!target) continue
    for (const sName of m.sources) {
      const src = byName.get(sName)
      if (src && src.id !== target.id) {
        if (await mergeDevices(env, email, target.id, src.id)) {
          byName.delete(sName)
          changed = true
        }
      }
    }
  }

  const currentNames = [...byName.values()].map(r => r.name)
  for (const [oldName, spec] of Object.entries(LEGACY_AUTO_RESET)) {
    const dev = byName.get(oldName)
    if (!dev) continue
    const others = currentNames.filter(n => n !== oldName)
    const nextName = autoDeviceName(spec.agent, spec.place, others)
    await env.DB.prepare('UPDATE devices SET name = ? WHERE id = ? AND user_email = ?').bind(nextName, dev.id, email).run()
    dev.name = nextName
    const idx = currentNames.indexOf(oldName)
    if (idx !== -1) currentNames[idx] = nextName
    changed = true
  }

  // Propagate any already-discovered Windows or Linux hostname (e.g. claude-KOTUS -> KOTUS) to remaining *-windows / *-linux placeholders
  let winHost: string | null = null
  let linHost: string | null = null
  for (const r of byName.values()) {
    const m = /^(?:claude|codex|antigravity)-([A-Za-z0-9_-]{2,32})$/.exec(r.name.trim())
    if (!m) continue
    const h = m[1]
    if (/^(windows|linux|cloud)$/i.test(h)) continue
    if (/[A-Z]{2,}/.test(h) && !winHost) winHost = h
    else if (!/[A-Z]{2,}/.test(h) && !linHost) linHost = h
  }
  for (const r of byName.values()) {
    const pm = /^(claude|codex|antigravity)-(windows|linux)(?:-\d+)?$/i.exec(r.name.trim())
    if (!pm) continue
    const ag = pm[1].toLowerCase(), pl = pm[2].toLowerCase()
    const host = pl === 'windows' ? winHost : linHost
    if (!host) continue
    const nextName = hostDeviceName(r.name, ag, host, currentNames.filter(n => n !== r.name))
    if (nextName && nextName !== r.name) {
      await env.DB.prepare('UPDATE devices SET name = ? WHERE id = ? AND user_email = ?').bind(nextName, r.id, email).run()
      const idx = currentNames.indexOf(r.name)
      if (idx !== -1) currentNames[idx] = nextName
      r.name = nextName
      changed = true
    }
  }
  return changed
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
