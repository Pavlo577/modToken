// Shared by every agent collector: where the device token and the state live, linking, posting, a lock, how to start itself again.
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { MAX_LIMITS, sanitizeLimit, sanitizeRow } from './contract.mjs'

export const DEFAULT_URL = 'https://track.brolafkodev.pp.ua'
export const home = process.env.TOKEN_TRACKER_HOME || join(homedir(), '.token-tracker')
export const configFile = join(home, 'config.json')
const HTTP_TIMEOUT_MS = Number(process.env.TOKEN_TRACKER_HTTP_TIMEOUT_MS) || 30_000

export const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback } }
export const writeJson = (file, data, mode) => { mkdirSync(home, { recursive: true }); writeFileSync(file, JSON.stringify(data), { mode }) }
export const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }

// Run as a script ("node token-tracker.mjs") or as the single file made by "bun build --compile" (the release program).
/**
 * Is this the single-file program? Its code lives in a virtual folder ("/$bunfs/root/..." on Linux and macOS, "B:/~BUN/root/..."
 * on Windows, where the url shows the "~" as %7E), and the "script" it was started from is that program, not a .mjs file.
 */
export const isCompiled = (url, script) => /\$bunfs|~BUN|%7EBUN/i.test(url) || /\$bunfs|~BUN/i.test(script ?? '') || (Boolean(script) && !/\.[cm]?js$/i.test(script))
export const compiled = isCompiled(import.meta.url, process.argv[1])
/** The command that starts this program again, and how to show it to the user. */
const script = process.argv[1] ? resolve(process.argv[1]) : ''
export const self = compiled ? [process.execPath] : [process.execPath, script]
export const shown = compiled ? [process.execPath] : ['node', script]
export const quoted = list => list.map(a => `"${a.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(', ')
export const command = list => list.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')

/** fetch with a time limit and path-free errors ("did not answer in time" / "could not reach the site"). */
async function request(url, init) {
  try { return await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) }) } catch (e) {
    throw new Error(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'the site did not answer in time: try again later' : 'could not reach the site: check the internet connection')
  }
}

/** Exchanges a one-time code made on the site (Devices tab) for a device token, saved with mode 600. */
export async function link(code, urlOption) {
  if (!code) throw new Error('usage: link <CODE> [--url https://your-site]')
  const url = (urlOption || readJson(configFile, {}).url || DEFAULT_URL).replace(/\/$/, '')
  const res = await request(`${url}/api/link`, { method: 'POST', body: JSON.stringify({ code }) })
  if (!res.ok) throw new Error(res.status === 403 ? 'the code is wrong, used or expired: make a new one on the site' : `site answered HTTP ${res.status}`)
  const { token, device } = await res.json()
  // `since`: from this moment on the turns of Claude Code are collected by this program (older ones are history)
  writeJson(configFile, { url, token, device, since: new Date().toISOString() }, 0o600)
  return { url, device }
}

export const linked = () => Boolean(readJson(configFile, null)?.token)

/** The only way data leaves: rows and limits are cut to the fields of lib/contract.mjs first. */
export async function post(cfg, body) {
  body = { rows: (body.rows ?? []).map(sanitizeRow).filter(Boolean), ...(body.limits ? { limits: body.limits.map(sanitizeLimit).filter(Boolean).slice(0, MAX_LIMITS) } : {}) }
  if (!body.rows.length && !body.limits?.length) return // nothing valid is left: the Worker refuses an empty call
  const res = await request(`${cfg.url}/api/ingest`, { method: 'POST', headers: { 'x-device-token': cfg.token, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (res.status === 401) throw new Error('the device token was rejected (revoked?): link again with a new code')
  if (!res.ok) throw new Error(`site answered HTTP ${res.status}`)
}

/** Old history for the device (turn ids imp:..): the Worker keeps what is older than the device and ignores repeats. */
export async function postImport(cfg, rows) {
  rows = rows.map(sanitizeRow).filter(Boolean)
  if (!rows.length) return { inserted: 0, duplicates: 0, afterLink: 0 }
  const res = await request(`${cfg.url}/api/import`, { method: 'POST', headers: { 'x-device-token': cfg.token, 'content-type': 'application/json' }, body: JSON.stringify({ rows }) })
  if (res.status === 401) throw new Error('the device token was rejected (revoked?): link again with a new code')
  if (!res.ok) throw new Error(`site answered HTTP ${res.status}`)
  return res.json()
}

const LOCK_MAX_AGE_MS = 30 * 60_000
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e?.code === 'EPERM' } }

/**
 * One sync at a time per agent. The lock file holds the process id and the start time; a lock is taken over only when that process is gone
 * (or the lock is older than 30 minutes, in case the id was reused), so a slow but live sync is never overtaken. Returns a release function, or null if busy.
 */
export function lock(name) {
  const file = join(home, `${name}-sync.lock`)
  mkdirSync(home, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try { writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' }); return () => { try { unlinkSync(file) } catch { /* gone */ } } } catch (e) {
      if (e?.code !== 'EEXIST') return null
      let held = null
      try { held = JSON.parse(readFileSync(file, 'utf8')) } catch { /* unreadable: stale */ }
      if (held && Number.isInteger(held.pid) && Date.now() - held.at < LOCK_MAX_AGE_MS && alive(held.pid)) return null
      try { unlinkSync(file) } catch { return null }
    }
  }
  return null
}
