import type { EngineInterface, Register } from 'claude-code'

// Probe: does a mod see the subscription's rate-limit windows (five_hour, seven_day) in this session? Numbers only (kind, percent, reset time)
// go to the status line, to ~/.claude/limits-probe.log and to <origin>/v1/statusline (the Worker keeps the shape). Origin and token: TRACKER_ORIGIN /
// TRACKER_TOKEN, else the device's OTLP settings (the logs endpoint's origin, the x-device-token header).
async function target($: EngineInterface): Promise<{ origin: string; token: string } | undefined> {
  let origin = await $.env.get('TRACKER_ORIGIN')
  if (!origin) {
    try { origin = new URL((await $.env.get('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT')) ?? '').origin } catch { origin = undefined }
  }
  const token = (await $.env.get('TRACKER_TOKEN')) ?? /(?:^|,)\s*x-device-token=([^,\s]+)/.exec((await $.env.get('OTEL_EXPORTER_OTLP_LOGS_HEADERS')) ?? '')?.[1]
  return origin && token ? { origin: origin.replace(/\/$/, ''), token } : undefined
}

const lines: string[] = []

async function record($: EngineInterface, from: string): Promise<void> {
  const { rateLimits } = await $.session.usage()
  const limits = rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt }))
  // Keyed by window (five_hour, seven_day, spend_limit): the Worker's log merges array items into one path.
  const byKind = Object.fromEntries(limits.map(r => [r.kind.replace(/[^\w]/g, '_').slice(0, 40), { percentUsed: r.percentUsed, resetsAt: r.resetsAt }]))
  const row = { probe: 'limits', from, at: new Date(await $.clock.now()).toISOString(), count: limits.length, limits: byKind }
  $.ui.status(limits.length ? limits.map(r => `${r.kind} ${r.percentUsed}%`).join(' · ') : 'limits: none yet')
  lines.push(JSON.stringify(row))
  const home = await $.env.get('HOME')
  if (home) await $.fs.write(`${home}/.claude/limits-probe.log`, lines.slice(-50).join('\n') + '\n').catch(() => {})
  const t = await target($)
  if (t) {
    await $.http.fetch(`${t.origin}/v1/statusline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-device-token': t.token },
      body: JSON.stringify(row),
    }).catch(() => undefined)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await record($, 'start').catch(() => {})
    return r
  })
  on('session.measure', async ($, e, next) => {
    await record($, 'measure:' + e.changed.join(',')).catch(() => {})
    return next(e)
  })
}
