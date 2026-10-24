import type { Register } from 'claude-code'

// Mod 0.10: it reports ONE thing, the subscription's rate-limit windows. The turns themselves (tokens, models, durations) are read from
// Claude Code's session logs by the token-tracker program (collectors/), which is also what links the device: its config file
// (~/.token-tracker/config.json: the site, the device token) is what this mod uses, so a device is linked once.
// A device that was linked through an older version of this mod keeps its token in the mod's store: it is handed over to that file once,
// so the same device continues under the program (no second device, nothing counted twice).

const LEGACY_TOKEN = 'deviceToken'
// The site every device reports to (fixed: there is no setting for it). Hosting your own copy: change this line.
const BACKEND_URL = 'https://track.brolafkodev.pp.ua'

// What this module remembers while it runs (per registration): the last problem shown as a toast, so one failure is announced once,
// not on every turn; and the last limits that were delivered, so only a change is sent.
type Memory = { lastProblem: string; lastLimits: string }

function report($: any, memo: Memory, problem: string | null) {
  if (problem === null) {
    memo.lastProblem = ''
    $.ui.status('ok')
    return
  }
  $.ui.status(problem)
  if (problem !== memo.lastProblem) $.ui.toast(`token-tracker: ${problem}`)
  memo.lastProblem = problem
}

type Auth = { url: string; token: string; source: 'program' | 'legacy' }

/** Where the program keeps its config: $TOKEN_TRACKER_HOME, else <home>/.token-tracker (forward slashes work on Windows too). */
async function configPath($: any): Promise<string | undefined> {
  const custom = (await $.env.get('TOKEN_TRACKER_HOME')) as string | undefined
  if (custom) return `${custom.replace(/[\\/]$/, '')}/config.json`
  const home = ((await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))) as string | undefined
  return home ? `${home.replace(/[\\/]$/, '')}/.token-tracker/config.json` : undefined
}

async function programConfig($: any): Promise<{ url?: string; token?: string } | null> {
  try {
    const path = await configPath($)
    return path ? (JSON.parse(await $.fs.read(path)) as { url?: string; token?: string }) : null
  } catch {
    return null
  }
}

/** The program's link when there is one, else the token an older version of this mod stored. */
async function auth($: any): Promise<Auth | null> {
  const cfg = await programConfig($)
  if (cfg?.token) return { url: (cfg.url || BACKEND_URL).replace(/\/$/, ''), token: cfg.token, source: 'program' }
  const legacy = (await $.store.get(LEGACY_TOKEN)) as string | undefined
  return legacy ? { url: BACKEND_URL, token: legacy, source: 'legacy' } : null
}

/**
 * Hands a token this mod stored itself to the program's config file (once: only when that file is not there yet). `since` says from
 * which moment the program collects the turns: the mod stops sending them now, so nothing is missing and nothing is counted twice.
 */
async function handOver($: any) {
  try {
    const path = await configPath($)
    const legacy = (await $.store.get(LEGACY_TOKEN)) as string | undefined
    if (!path || !legacy || (await $.fs.exists(path))) return
    await $.fs.write(path, JSON.stringify({ url: BACKEND_URL, token: legacy, since: new Date().toISOString() }))
  } catch {
    /* the legacy token keeps working for the limits; the program can link again */
  }
}

// The subscription's rate-limit windows from the last API response (empty off a subscription). Sent only when changed.
async function readLimits($: any, memo: Memory): Promise<{ limits: unknown[]; key: string } | undefined> {
  try {
    const u = await $.session.usage()
    const limits = ((u.rateLimits ?? []) as { kind: string; percentUsed: number; resetsAt?: string }[])
      .filter(l => l.kind === 'five_hour' || l.kind === 'seven_day')
      .map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt }))
    const key = JSON.stringify(limits)
    return limits.length > 0 && key !== memo.lastLimits ? { limits, key } : undefined
  } catch {
    return undefined
  }
}

async function sendLimits($: any, memo: Memory) {
  const a = await auth($)
  if (!a) {
    report($, memo, 'not linked: run the token-tracker program (see the README)')
    return
  }
  const lim = await readLimits($, memo)
  if (!lim) return
  try {
    const r = await $.http.fetch(`${a.url}/api/ingest`, {
      method: 'POST',
      headers: { 'x-device-token': a.token, 'content-type': 'application/json' },
      body: JSON.stringify({ rows: [], limits: lim.limits }),
    })
    if (r.ok) memo.lastLimits = lim.key
    report(
      $,
      memo,
      r.ok
        ? a.source === 'legacy'
          ? 'limits only: turns now come from the token-tracker program'
          : null
        : r.status === 401
          ? 'device revoked or unknown: link it again in the token-tracker program'
          : `server answered HTTP ${r.status}`,
    )
  } catch {
    report($, memo, 'no connection (limits are sent again with the next turn)')
  }
}

export const register: Register = on => {
  const memo: Memory = { lastProblem: '', lastLimits: '' }

  on('classic.SessionStart', async ($, e, next) => {
    await handOver($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    // a sub-agent's turn ends under the same account: the main loop's turns are enough to follow the limits
    if (e.usage && e.agentId === undefined) await sendLimits($, memo)
    return ran
  })
}
