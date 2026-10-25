import type { EngineInterface, Register } from 'claude-code'

// Token Tracker's mod: the one thing OTLP does not carry, the subscription's rate-limit windows (five_hour, seven_day). It reads them from the
// session and POSTs { limits: [{ kind, percentUsed, resetsAt }] } to <site>/v1/limits when they change. Numbers only: no text, no ids.
// The site and the device token are the device's own OTLP settings (the logs endpoint's origin, the x-device-token header);
// TRACKER_ORIGIN / TRACKER_TOKEN override them.
type Limit = { kind: string; percentUsed: number; resetsAt?: string }

async function target($: EngineInterface): Promise<{ origin: string; token: string } | undefined> {
  let origin = await $.env.get('TRACKER_ORIGIN')
  if (!origin) {
    try { origin = new URL((await $.env.get('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT')) ?? '').origin } catch { origin = undefined }
  }
  const token = (await $.env.get('TRACKER_TOKEN')) ?? /(?:^|,)\s*x-device-token=([^,\s]+)/.exec((await $.env.get('OTEL_EXPORTER_OTLP_LOGS_HEADERS')) ?? '')?.[1]
  return origin && token ? { origin: origin.replace(/\/$/, ''), token } : undefined
}

let lastSent = '' // the readings last accepted by the site, so an unchanged window is not sent again

async function send($: EngineInterface): Promise<void> {
  const { rateLimits } = await $.session.usage()
  const limits: Limit[] = rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt }))
  if (!limits.length) return
  $.ui.status(limits.map(r => `${r.kind === 'five_hour' ? '5h' : r.kind === 'seven_day' ? '7d' : r.kind} ${r.percentUsed}%`).join(' · '))
  const key = JSON.stringify(limits)
  if (key === lastSent) return
  const t = await target($)
  if (!t) return
  const r = await $.http.fetch(`${t.origin}/v1/limits`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-device-token': t.token },
    body: JSON.stringify({ limits }),
  }).catch(() => undefined)
  if (r?.ok) lastSent = key
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await send($).catch(() => {})
    return r
  })
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await send($).catch(() => {})
    return next(e)
  })
}
