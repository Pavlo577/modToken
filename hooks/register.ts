import type { Register } from 'claude-code'

const QUEUE = 'queue'
const MAX_QUEUE = 500

type Row = {
  device: string
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

async function flush($: any, url: string, key: string, extra?: Row) {
  if (!url || !key) {
    $.ui.status('tracker: set supabaseUrl and supabaseKey')
    return
  }
  const queued = ((await $.store.get(QUEUE)) as Row[] | undefined) ?? []
  const rows = extra ? [...queued, extra] : queued
  if (rows.length === 0) return
  try {
    const r = await $.http.fetch(`${url}/rest/v1/token_events?on_conflict=device,turn_id`, {
      method: 'POST',
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        prefer: 'resolution=ignore-duplicates,return=minimal',
      },
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
  const key = String(options.supabaseKey ?? '')
  const device = String(options.device ?? 'unnamed')
  let sessionId = 'unknown'

  on('classic.SessionStart', async ($, e, next) => {
    sessionId = e.session_id
    await flush($, url, key)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.usage) {
      await flush($, url, key, {
        device,
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
