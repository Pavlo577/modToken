import type { EngineInterface, Register } from 'claude-code'

// Diagnostics for Token Tracker: each turn's token counts as the session sees them (turn.complete's usage), POSTed to <site>/v1/check, so the
// dashboard can compare them with what OTLP counted for the same session. The site keeps them apart and never adds them to the totals.
// Numbers, the model and ids only. The site and the token are the device's OTLP settings; TRACKER_ORIGIN / TRACKER_TOKEN override them.
type Turn = { id: string; session: string; ts: string; model: string; input: number; output: number; cache_read: number; cache_creation: number; duration_ms: number; sub: boolean }

async function target($: EngineInterface): Promise<{ origin: string; token: string } | undefined> {
  let origin = await $.env.get('TRACKER_ORIGIN')
  if (!origin) {
    try { origin = new URL((await $.env.get('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT')) ?? '').origin } catch { origin = undefined }
  }
  const token = (await $.env.get('TRACKER_TOKEN')) ?? /(?:^|,)\s*x-device-token=([^,\s]+)/.exec((await $.env.get('OTEL_EXPORTER_OTLP_LOGS_HEADERS')) ?? '')?.[1]
  return origin && token ? { origin: origin.replace(/\/$/, ''), token } : undefined
}

let queue: Turn[] = []

export const register: Register = on => {
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    try {
      const u = e.usage
      if (!u) return r
      queue.push({
        id: e.turnId, session: await $.session.id(), ts: new Date(await $.clock.now()).toISOString(), model: u.model,
        input: u.input_tokens, output: u.output_tokens, cache_read: u.cache_read_input_tokens, cache_creation: u.cache_creation_input_tokens,
        duration_ms: Math.round(e.durationMs), sub: e.agentId !== undefined,
      })
      if (queue.length > 200) queue = queue.slice(-200)
      const t = await target($)
      if (!t) return r
      const turns = queue.slice(-50)
      const res = await $.http.fetch(`${t.origin}/v1/check`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-device-token': t.token }, body: JSON.stringify({ turns }),
      }).catch(() => undefined)
      if (res?.ok) queue = queue.filter(x => !turns.includes(x))
      $.ui.status(`otlp-check: ${res?.ok ? 'sent' : 'not sent'} ${turns.length}`)
    } catch { /* diagnostics never get in the way */ }
    return r
  })
}
