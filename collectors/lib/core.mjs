// Shared by every agent collector: where the device token and the state live, linking, posting, a lock, how to start itself again.
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const DEFAULT_URL = 'https://track.brolafkodev.pp.ua'
export const home = process.env.TOKEN_TRACKER_HOME || join(homedir(), '.token-tracker')
export const configFile = join(home, 'config.json')

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

/** Exchanges a one-time code made on the site (Devices tab) for a device token, saved with mode 600. */
export async function link(code, urlOption) {
  if (!code) throw new Error('usage: link <CODE> [--url https://your-site]')
  const url = (urlOption || readJson(configFile, {}).url || DEFAULT_URL).replace(/\/$/, '')
  const res = await fetch(`${url}/api/link`, { method: 'POST', body: JSON.stringify({ code }) })
  if (!res.ok) throw new Error(res.status === 403 ? 'the code is wrong, used or expired: make a new one on the site' : `site answered HTTP ${res.status}`)
  const { token, device } = await res.json()
  writeJson(configFile, { url, token, device }, 0o600)
  return { url, device }
}

export const linked = () => Boolean(readJson(configFile, null)?.token)

export async function post(cfg, body) {
  const res = await fetch(`${cfg.url}/api/ingest`, { method: 'POST', headers: { 'x-device-token': cfg.token, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (res.status === 401) throw new Error('the device token was rejected (revoked?): link again with a new code')
  if (!res.ok) throw new Error(`site answered HTTP ${res.status}`)
}

/** One sync at a time per agent: a lock file, taken over when it is older than 5 minutes. */
export function lock(name) {
  const file = join(home, `${name}-sync.lock`)
  try { if (Date.now() - statSync(file).mtimeMs > 5 * 60_000) unlinkSync(file) } catch { /* no lock */ }
  try { mkdirSync(home, { recursive: true }); closeSync(openSync(file, 'wx')) } catch { return null }
  return () => { try { unlinkSync(file) } catch { /* gone */ } }
}
