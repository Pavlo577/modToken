import type { EngineInterface, Register } from 'claude-code'

// Token Tracker's mod: what OTLP does not carry. Numbers only, never text:
// - the subscription's rate-limit windows -> POST /v1/limits when they change;
// - the session (start, end, why it ended) and every main-loop turn (wall-clock length, the pause before the prompt, context fill,
//   permission prompts put to a person: how many, how many refused, how long until the tool finished) -> POST /v1/activity;
// - the session's repository only when the device allows it (GET /v1/config: off | name | hash): owner/name, or a hash of the remote;
//   when there is none, a word saying why (project_note: off, no_target, config_failed, no_repo).
// The site and the device token are the device's own OTLP settings (the logs endpoint's origin, the x-device-token header);
// TRACKER_ORIGIN / TRACKER_TOKEN override them. Tokens are never sent: OTLP counts them.
type Limit = { kind: string; percentUsed: number; resetsAt?: string }
type Turn = {
  id: string; session: string; ts: string; wall_ms: number; think_ms: number | null; outcome: string
  context_pct: number | null; context_tokens: number | null; context_window: number | null
  perm_asks: number; perm_denied: number; perm_wait_ms: number
}
type Target = { origin: string; token: string }

async function target($: EngineInterface): Promise<Target | undefined> {
  let origin = await $.env.get('TRACKER_ORIGIN')
  if (!origin) {
    try { origin = new URL((await $.env.get('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT')) ?? '').origin } catch { origin = undefined }
  }
  const token = (await $.env.get('TRACKER_TOKEN')) ?? /(?:^|,)\s*x-device-token=([^,\s]+)/.exec((await $.env.get('OTEL_EXPORTER_OTLP_LOGS_HEADERS')) ?? '')?.[1]
  return origin && token ? { origin: origin.replace(/\/$/, ''), token } : undefined
}

async function post($: EngineInterface, t: Target, path: string, body: unknown): Promise<boolean> {
  const r = await $.http.fetch(`${t.origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-device-token': t.token },
    body: JSON.stringify(body),
  }).catch(() => undefined)
  return !!r?.ok
}

const iso = async ($: EngineInterface): Promise<string> => new Date(await $.clock.now()).toISOString()

/** owner/name of a remote URL (https or ssh), never its credentials; null when it does not look like one. */
function remoteName(remote: string | null): string | null {
  const m = /[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote ?? '')
  return m ? `${m[1]}/${m[2]}` : null
}

/** The project as the device allows it, or why there is none. */
async function project($: EngineInterface, mode: string): Promise<{ project: string | null; note: string | null }> {
  if (mode !== 'name' && mode !== 'hash') return { project: null, note: mode === 'off' ? 'off' : mode }
  const repo = await $.session.repo().catch(() => undefined)
  if (repo === undefined) return { project: null, note: 'repo_failed' }
  if (!repo) return { project: null, note: 'no_repo' }
  const name = repo.name ?? remoteName(repo.remote)
  if (mode === 'name' && name) return { project: name, note: null }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(repo.remote ?? repo.root))
  return { project: 'h:' + [...new Uint8Array(digest)].slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join(''), note: null }
}

// the session this process is in; reset by session.start (a /clear goes on under a new id)
let sessionId = ''
let startedAt = ''
let projectName: string | null = null
let projectNote: string | null = null
let target_: Target | undefined
let lastSentLimits = ''
let lastTurnEnd = 0
const turnStart = new Map<string, number>()
// permission checks that went to the decider (tool_use_id -> tool), and whether a person was then asked (classic PermissionRequest:
// a dialog is shown; an auto-mode classifier or a rule answering is not a person)
const asked = new Map<string, { tool: string; person: boolean }>()
let perm = { asks: 0, denied: 0, waitMs: 0 }
let queue: Turn[] = [] // turns not accepted yet; resent with the next one

async function sendLimits($: EngineInterface): Promise<void> {
  const { rateLimits } = await $.session.usage()
  const limits: Limit[] = rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt }))
  if (!limits.length) return
  $.ui.status(limits.map(r => `${r.kind === 'five_hour' ? '5h' : r.kind === 'seven_day' ? '7d' : r.kind} ${r.percentUsed}%`).join(' · '))
  const key = JSON.stringify(limits)
  if (key === lastSentLimits || !target_) return
  if (await post($, target_, '/v1/limits', { limits })) lastSentLimits = key
}

async function sendActivity($: EngineInterface, end?: { at: string; reason: string }): Promise<void> {
  if (!target_ || !sessionId) return
  const turns = queue.slice(-50)
  const session = { id: sessionId, started_at: startedAt, project: projectName, project_note: projectNote, ...(end ? { ended_at: end.at, end_reason: end.reason } : {}) }
  if (await post($, target_, '/v1/activity', { session, turns })) queue = queue.filter(t => !turns.includes(t))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      sessionId = await $.session.id()
      startedAt = await iso($)
      target_ = await target($)
      lastTurnEnd = 0
      let mode = target_ ? 'config_failed' : 'no_target'
      if (target_) {
        const c = await $.http.fetch(`${target_.origin}/v1/config`, { headers: { 'x-device-token': target_.token } }).catch(() => undefined)
        if (c?.ok) try { mode = String((JSON.parse(c.text) as { project?: unknown }).project ?? 'off') } catch { /* config_failed */ }
      }
      const p = await project($, mode)
      projectName = p.project
      projectNote = p.note
      await sendActivity($)
      await sendLimits($)
    } catch { /* never in the way of the session */ }
    return r
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await sendLimits($).catch(() => {})
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) turnStart.set(e.turnId, await $.clock.now())
    return next(e)
  })

  // a permission prompt to a person: tool.check's verdict is "ask" and a dialog is then shown (classic PermissionRequest for that tool);
  // the wait runs from the call's start to its end, the answer and the run together (the API shows no moment of the answer)
  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && r.decision === 'ask' && e.tool_use_id) asked.set(e.tool_use_id, { tool: e.tool, person: false })
    return r
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    if (e.agent_id === undefined) {
      const pending = [...asked.values()].find(x => x.tool === e.tool_name && !x.person)
      if (pending) pending.person = true
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const t0 = await $.clock.now()
    const r = await next(e)
    const id = (e as { tool_use_id?: string }).tool_use_id
    const a = id ? asked.get(id) : undefined
    if (id) asked.delete(id)
    if (a?.person) {
      perm.asks++
      perm.waitMs += (await $.clock.now()) - t0
      if (r.deny !== undefined) perm.denied++
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    try {
      const now = await $.clock.now()
      const started = turnStart.get(e.turnId)
      turnStart.delete(e.turnId)
      const { context } = await $.session.usage()
      queue.push({
        id: e.turnId, session: sessionId, ts: new Date(now).toISOString(), wall_ms: Math.round(e.durationMs),
        think_ms: started !== undefined && lastTurnEnd ? Math.max(0, started - lastTurnEnd) : null, outcome: e.reason,
        context_pct: context.percent ?? null, context_tokens: context.tokens ?? null, context_window: context.window ?? null,
        perm_asks: perm.asks, perm_denied: perm.denied, perm_wait_ms: Math.round(perm.waitMs),
      })
      if (queue.length > 200) queue = queue.slice(-200)
      perm = { asks: 0, denied: 0, waitMs: 0 }
      lastTurnEnd = now
      await sendActivity($)
    } catch { /* never in the way of the session */ }
    return r
  })

  on('session.end', async ($, e, next) => {
    try { if (e.sessionId === sessionId) await sendActivity($, { at: await iso($), reason: e.reason }) } catch { /* best effort */ }
    return next(e)
  })
}
