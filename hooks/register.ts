import type { Register } from 'claude-code'

const QUEUE = 'queue'
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

async function flush($: any, url: string, token: string, extra?: Row) {
  if (!url || !token) {
    $.ui.status('tracker: set supabaseUrl and deviceToken')
    return
  }
  const queued = ((await $.store.get(QUEUE)) as Row[] | undefined) ?? []
  const rows = extra ? [...queued, extra] : queued
  if (rows.length === 0) return
  try {
    const r = await $.http.fetch(`${url}/functions/v1/ingest`, {
      method: 'POST',
      headers: { 'x-device-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(rows),
    })
    await $.store.set(QUEUE, r.ok ? [] : rows.slice(-MAX_QUEUE))
    $.ui.status(r.ok ? 'tracker: ok' : `tracker: HTTP ${r.status}, ${rows.length} queued`)
  } catch {
    await $.store.set(QUEUE, rows.slice(-MAX_QUEUE))
    $.ui.status(`tracker: offline, ${rows.length} queued`)
  }
}

export const register: Register = (on, options) => {
  const url = String(options.supabaseUrl ?? '').replace(/\/$/, '')
  const token = String(options.deviceToken ?? '')
  let sessionId = 'unknown'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tracker-setup',
      description: 'Set token-tracker: /tracker-setup <supabaseUrl>',
    })
    return next(e)
  })

  on('command.run', { command: 'tracker-setup' }, async ($, e) => {
    const [u] = e.args.trim().split(/\s+/)
    if (!u || !/^https:\/\/.+\.supabase\.co\/?$/.test(u)) {
      return { text: 'Usage: /tracker-setup https://<ref>.supabase.co ' }
    }
    const done: string[] = []
    for (const [field, value] of [['supabaseUrl', u]] as const) {
      if (!value) continue
      try {
        const r = await $.config.set({ key: `token-tracker.${field}`, value })
        if ('deny' in r && r.deny) return { text: `token-tracker: ${field} not saved (${r.deny})` }
        done.push(field)
      } catch (err) {
        return { text: `token-tracker: ${field} failed (${String((err as Error)?.message ?? err).slice(0, 200)}); saved so far: ${done.join(', ') || 'nothing'}` }
      }
    }
    return { text: `token-tracker: saved ${done.join(', ')}. Put your device token in deviceToken (settings.json or the install screen); the status line shows "tracker: ok" after the next turn.` }
  }).catch(() => ({ text: 'token-tracker: setup failed unexpectedly' }))

  on('classic.SessionStart', async ($, e, next) => {
    sessionId = e.session_id
    await flush($, url, token)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.usage) {
      await flush($, url, token, {
        session_id: sessionId,
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
