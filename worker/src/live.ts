// Live updates of the dashboard: one Durable Object per user holds the WebSockets of the user's open dashboards (GET /api/admin/live,
// behind Access) and passes on the numbers of every new model call the OTLP receiver counts. The page adds them to the hourly buckets it
// already has, so a live update reads nothing from D1. The object itself is in live-object.ts (only the Worker's entry imports it).
import type { Env } from './env.ts'
import type { ModelCall } from './otlp.ts'

/** One counted call as the page needs it for its buckets: numbers, the hour, the device's name, and whether it opened a turn. */
export interface LiveCall {
  h: string
  device: string
  model: string
  provider: string
  input: number
  output: number
  cache_read: number
  cache_creation: number
  duration_ms: number
  cost_micros: number
  sub: number
  /** this call started a turn (a new main row): the page counts one more turn */
  turn: boolean
  /** a background request: its output is the bucket's bg_output too */
  bg: boolean
}

export const liveCall = (c: ModelCall, device: string, newTurn: boolean): LiveCall => ({
  h: c.ts.slice(0, 13), device, model: c.model, provider: c.provider, input: c.input_tokens, output: c.output_tokens,
  cache_read: c.cache_read_tokens, cache_creation: c.cache_creation_tokens, duration_ms: c.duration_ms, cost_micros: c.cost_micros,
  sub: c.is_subagent ? 1 : 0, turn: newTurn, bg: c.kind === 'bg',
})

/** The user's live object (by email), when the binding is there. */
export const liveOf = (env: Env, email: string): DurableObjectStub | null => (env.LIVE ? env.LIVE.get(env.LIVE.idFromName(email)) : null)

/** Passes counted calls on to the user's open dashboards; never fails the request that counted them. */
export async function pushLive(env: Env, email: string, calls: LiveCall[]): Promise<void> {
  const stub = liveOf(env, email)
  if (!stub || !calls.length) return
  try {
    await stub.fetch('https://live/push', { method: 'POST', body: JSON.stringify(calls) })
  } catch (e) {
    console.error('live: ' + (e instanceof Error ? e.message : 'failed')) // never the data
  }
}
