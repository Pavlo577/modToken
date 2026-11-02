// Live updates: a WebSocket to /api/admin/live (the Worker's per-user Durable Object) brings the numbers of every model call the site
// counts, and they are added to the loaded hourly buckets, so the charts move without reading the database again. The day card and the
// session list follow on the next load. The socket comes back by itself after a drop.
import { $ } from '../lib/dom.ts'
import type { Bucket } from '../lib/types.ts'
import { actions } from './actions.ts'
import { load } from './load.ts'
import { store } from './store.ts'

/** One counted call, as src/live.ts sends it. */
interface LiveCall {
  h: string; device: string; model: string; provider: string
  input: number; output: number; cache_read: number; cache_creation: number; duration_ms: number; cost_micros: number
  sub: number; turn: boolean; bg: boolean
}

let retry = 1000
let renderTimer: ReturnType<typeof setTimeout> | undefined

const setDot = (on: boolean): void => {
  const dot = $('live')
  dot.classList.toggle('on', on)
  dot.title = on ? 'Наживо: нові виклики з’являються одразу' : 'Живі оновлення не з’єднані: дані оновляться при наступному завантаженні'
}

/** Adds the calls to the loaded buckets; a device or an agent the page does not know yet means loading anew. */
export function applyCalls(calls: LiveCall[]): void {
  const d = store.data
  if (!d) return
  let added = false
  for (const c of calls) {
    const t = Date.parse(c.h + ':00:00Z')
    if (!(t >= d.r.prevFrom && t < d.r.to)) continue // outside what is loaded
    if (!store.deviceNames.includes(c.device) || !store.providers.includes(c.provider)) { void load(); return }
    let b = d.buckets.find(x => x.h === c.h && x.device === c.device && x.model === c.model && (x.provider || 'claude') === c.provider)
    if (!b) {
      b = { h: c.h, device: c.device, model: c.model, provider: c.provider, input: 0, output: 0, cache_read: 0, cache_creation: 0, duration_ms: 0, turns: 0, sub: 0, bg_output: 0, cost_micros: c.cost_micros } as Bucket
      d.buckets.push(b)
    } else if (b.cost_micros) b.cost_micros = c.cost_micros ? b.cost_micros + c.cost_micros : 0 // a call without the agent's own price: the page prices the bucket
    b.input += c.input; b.output += c.output; b.cache_read += c.cache_read; b.cache_creation += c.cache_creation
    b.duration_ms += c.duration_ms; b.sub += c.sub; b.turns += c.turn ? 1 : 0
    if (c.bg) b.bg_output = (b.bg_output ?? 0) + c.output
    added = true
  }
  if (added && !renderTimer) renderTimer = setTimeout(() => { renderTimer = undefined; actions.render() }, 1000) // at most once a second
}

function connect(): void {
  let ws: WebSocket
  try { ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/admin/live`) } catch { return void setTimeout(connect, retry) }
  let ping: ReturnType<typeof setInterval> | undefined
  ws.onopen = () => { retry = 1000; setDot(true); ping = setInterval(() => ws.send('ping'), 30_000) }
  ws.onmessage = e => {
    try {
      const m = JSON.parse(String(e.data)) as { type?: string; calls?: LiveCall[] }
      if (m.type === 'calls' && Array.isArray(m.calls)) applyCalls(m.calls)
    } catch { /* 'pong' */ }
  }
  ws.onclose = () => {
    clearInterval(ping); setDot(false)
    retry = Math.min(retry * 2, 60_000) // back off up to a minute (signed out, or the site is redeploying)
    setTimeout(connect, retry)
  }
}

export const startLive = (): void => connect()
