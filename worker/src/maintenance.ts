// Scheduled maintenance (hourly Cloudflare Cron Trigger):
// 1. Prunes expired `otlp_calls` (>45 days) and `events` (>90 days) off the hot ingest path.
// 2. Refreshes the dynamic LiteLLM model price list in `app_meta` once per ~23 hours.
import type { Env } from './env.ts'
import { refreshPrices } from './prices.ts'

const KEEP_CALLS_DAYS = 45
const KEEP_EVENTS_DAYS = 90
const PRUNE_LIMIT = 2000
const PRUNE_ROUNDS = 5
const PRICES_INTERVAL_MS = 23 * 3_600_000

/** Runs periodic retention cleanup and daily pricing sync without blocking user requests. */
export async function runMaintenance(env: Env, nowMs = Date.now()): Promise<void> {
  const callsCutoff = new Date(nowMs - KEEP_CALLS_DAYS * 86_400_000).toISOString()
  for (let i = 0; i < PRUNE_ROUNDS; i++) {
    try {
      const r = await env.DB.prepare('DELETE FROM otlp_calls WHERE rowid IN (SELECT rowid FROM otlp_calls WHERE seen_at < ? LIMIT ?)').bind(callsCutoff, PRUNE_LIMIT).run()
      if ((r.meta.changes ?? 0) < PRUNE_LIMIT) break
    } catch (e) {
      console.error('prune otlp_calls: ' + (e instanceof Error ? e.message : 'failed'))
      break
    }
  }

  if (env.EVENTS) {
    const eventsCutoff = new Date(nowMs - KEEP_EVENTS_DAYS * 86_400_000).toISOString()
    try {
      const { results } = await env.DB.prepare('SELECT DISTINCT user_email FROM devices').all<{ user_email: string }>()
      for (const { user_email } of results) {
        for (let i = 0; i < PRUNE_ROUNDS; i++) {
          // Uses events_user_ts_idx (user_email, ts)
          const r = await env.EVENTS.prepare('DELETE FROM events WHERE id IN (SELECT id FROM events WHERE user_email = ?1 AND ts < ?2 LIMIT ?3)')
            .bind(user_email, eventsCutoff, PRUNE_LIMIT).run()
          if ((r.meta.changes ?? 0) < PRUNE_LIMIT) break
        }
      }
    } catch (e) {
      console.error('prune events: ' + (e instanceof Error ? e.message : 'failed'))
    }
  }

  try {
    const meta = await env.DB.prepare(`SELECT updated_at FROM app_meta WHERE key = 'prices'`).first<{ updated_at: string }>()
    const lastMs = meta?.updated_at ? Date.parse(meta.updated_at) : 0
    if (!lastMs || nowMs - lastMs >= PRICES_INTERVAL_MS) await refreshPrices(env)
  } catch (e) {
    console.error('maintenance prices: ' + (e instanceof Error ? e.message : 'failed'))
  }
}
