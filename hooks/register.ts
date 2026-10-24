import type { Register } from 'claude-code'

const QUEUE = 'queue'
const TOKEN = 'deviceToken'
// The site every device reports to (fixed: there is no setting for it). Linking still needs a one-time code from the site.
// Hosting your own copy: change this line.
const BACKEND_URL = 'https://track.brolafkodev.pp.ua'
const MAX_QUEUE = 500

type Row = {
  session_id: string
  turn_id: string
  ts: string
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  duration_ms: number
  is_subagent: boolean
}

// The last problem shown as a toast, so one failure is announced once, not on every turn.
let lastProblem = ''

function report($: any, problem: string | null) {
  if (problem === null) {
    lastProblem = ''
    $.ui.status('ok')
    return
  }
  $.ui.status(problem)
  if (problem !== lastProblem) $.ui.toast(`token-tracker: ${problem}`)
  lastProblem = problem
}

// The subscription's rate-limit windows from the last API response (empty off a subscription). Sent only when changed.
let lastLimits = ''

async function readLimits($: any): Promise<{ limits: unknown[]; key: string } | undefined> {
  try {
    const u = await $.session.usage()
    const limits = ((u.rateLimits ?? []) as { kind: string; percentUsed: number; resetsAt?: string }[])
      .filter(l => l.kind === 'five_hour' || l.kind === 'seven_day')
      .map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt }))
    const key = JSON.stringify(limits)
    return limits.length > 0 && key !== lastLimits ? { limits, key } : undefined
  } catch {
    return undefined
  }
}

const backend = (): string => BACKEND_URL.replace(/\/$/, '')

async function flush($: any, extra?: Row) {
  const url = backend()
  const token = (await $.store.get(TOKEN)) as string | undefined
  if (!token) {
    report($, 'not linked: run /tracker-link <code>')
    return
  }
  const queued = ((await $.store.get(QUEUE)) as Row[] | undefined) ?? []
  const rows = extra ? [...queued, extra] : queued
  const lim = extra ? await readLimits($) : undefined
  if (rows.length === 0 && !lim) return
  try {
    const r = await send($, url, token, rows, lim?.limits)
    if (r.status === 400) return await sendOneByOne($, url, token, rows, lim)
    await $.store.set(QUEUE, r.ok ? [] : rows.slice(-MAX_QUEUE))
    if (r.ok && lim) lastLimits = lim.key
    report(
      $,
      r.ok
        ? null
        : r.status === 401
          ? 'device revoked or unknown: run /tracker-link <code>'
          : `server answered HTTP ${r.status}, ${rows.length} turn(s) queued`,
    )
  } catch {
    await $.store.set(QUEUE, rows.slice(-MAX_QUEUE))
    report($, `no connection, ${rows.length} turn(s) queued`)
  }
}

const send = ($: any, url: string, token: string, rows: Row[], limits?: unknown[]) =>
  $.http.fetch(`${url}/api/ingest`, {
    method: 'POST',
    headers: { 'x-device-token': token, 'content-type': 'application/json' },
    body: JSON.stringify(limits ? { rows, limits } : rows),
  })

/**
 * The server refuses a whole request with HTTP 400 when one row is bad. Kept in the queue that row would block every later turn
 * for good, so the rows go one by one: the good ones arrive, the refused ones are dropped (and said so), the rest stays queued.
 */
async function sendOneByOne($: any, url: string, token: string, rows: Row[], lim?: { limits: unknown[]; key: string }) {
  const left: Row[] = []
  let dropped = 0
  let failed: number | undefined
  for (const [i, row] of rows.entries()) {
    try {
      const one = await send($, url, token, [row], i === 0 ? lim?.limits : undefined)
      if (one.ok) { if (i === 0 && lim) lastLimits = lim.key }
      else if (one.status === 400) dropped++
      else { left.push(row); failed = one.status }
    } catch {
      left.push(row)
    }
  }
  await $.store.set(QUEUE, left.slice(-MAX_QUEUE))
  if (left.length) report($, failed === 401 ? 'device revoked or unknown: run /tracker-link <code>' : `${left.length} turn(s) queued`)
  else report($, null)
  if (dropped) $.ui.toast(`token-tracker: ${dropped} turn(s) refused by the server and skipped`)
}

export const register: Register = on => {
  let sessionId = 'unknown'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tracker-link',
      description: 'Link this device to your account: /tracker-link <code from the site>',
    })
    await $.command.register({
      name: 'tracker-import',
      description: 'Send the usage history from before linking (needs Node.js on this device)',
    })
    return next(e)
  })

  on('command.run', { command: 'tracker-link' }, async ($, e) => {
    const code = e.args.trim()
    const url = backend()
    if (!code) return { text: 'Usage: /tracker-link <code>. Create a code on the site (Add device).' }
    try {
      const r = await $.http.fetch(`${url}/api/link`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      if (r.status === 403) return { text: 'token-tracker: the code is wrong, expired or already used. Create a new one on the site.' }
      if (!r.ok) return { text: `token-tracker: linking failed (HTTP ${r.status}).` }
      const out = JSON.parse(r.text) as { token?: string; device?: string }
      if (!out.token) return { text: 'token-tracker: linking failed (unexpected answer).' }
      await $.store.set(TOKEN, out.token)
      $.ui.status('linked')
      return { text: `token-tracker: linked as "${out.device}". Usage will be sent after each turn. Run /tracker-import to add the history from before linking.` }
    } catch {
      return { text: 'token-tracker: could not reach the backend. Check the URL and your connection.' }
    }
  }).catch(() => ({ text: 'token-tracker: linking failed unexpectedly' }))

  on('command.run', { command: 'tracker-import' }, async ($, e) => {
    const token = (await $.store.get(TOKEN)) as string | undefined
    if (!token) return { text: 'token-tracker: not linked yet. Run /tracker-link <code> first.' }
    const noNode = 'token-tracker: could not run Node.js here. Install Node.js, or import on the site: Devices, Import old data.'
    try {
      const r = await $.process.run(['node', `${$.plugin.root}/import-logs.mjs`], {
        env: { TRACKER_URL: backend(), TRACKER_TOKEN: token },
        timeoutMs: 600_000,
      })
      if (r.exitCode !== 0) return { text: `token-tracker: import failed. ${r.stderr.trim().slice(0, 300) || `exit code ${r.exitCode}`}` }
      const t = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as { turns?: number; inserted?: number; duplicates?: number; afterLink?: number }
      return {
        text: `token-tracker: found ${t.turns ?? 0} turns in the logs, added ${t.inserted ?? 0}, already there ${t.duplicates ?? 0}, newer than linking ${t.afterLink ?? 0} (collected live).`,
      }
    } catch {
      return { text: noNode }
    }
  }).catch(() => ({ text: 'token-tracker: import failed unexpectedly' }))

  on('classic.SessionStart', async ($, e, next) => {
    sessionId = e.session_id
    await flush($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.usage) {
      // The session's own id (the transcript file's name), so a mod switched on in the middle of a session still names it;
      // the id remembered at session start is the fallback, 'unknown' the last resort.
      const session = (await $.session.id().catch(() => '')) || sessionId
      await flush($, {
        session_id: session,
        turn_id: e.turnId,
        ts: new Date(await $.clock.now()).toISOString(),
        model: e.usage.model,
        input_tokens: e.usage.input_tokens,
        output_tokens: e.usage.output_tokens,
        cache_read_tokens: e.usage.cache_read_input_tokens,
        cache_creation_tokens: e.usage.cache_creation_input_tokens,
        duration_ms: e.durationMs,
        is_subagent: e.agentId !== undefined,
      })
    }
    return ran
  })
}
