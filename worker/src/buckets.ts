// Incremental maintenance of the pre-aggregated `hourly_buckets` table (kept in sync on OTLP ingest and history import).
import type { Env } from './env.ts'

export interface BucketTarget {
  deviceId: string
  provider: string
  h: string
}

export const hourOf = (ts: string): string => ts.slice(0, 13)

export const nextHourIso = (h: string): string => new Date(Date.parse(h + ':00:00.000Z') + 3_600_000).toISOString()

const CHUNK = 25 // 2 statements per target = 50 statements per D1 batch

/**
 * Recomputes the affected `(device_id, provider, h)` rows in `hourly_buckets` from `token_events`.
 * Uses the `(device_id, provider, ts)` index and swallows missing-table errors so deploys remain safe before migration 0016 runs.
 */
export async function refreshHourlyBuckets(env: Env, targets: BucketTarget[]): Promise<void> {
  if (!targets.length) return
  const uniq = new Map<string, BucketTarget>()
  for (const t of targets) {
    if (!t.deviceId || !t.provider || t.h.length !== 13) continue
    uniq.set(`${t.deviceId}|${t.provider}|${t.h}`, t)
  }
  const items = [...uniq.values()]
  if (!items.length) return
  const delSql = 'DELETE FROM hourly_buckets WHERE device_id = ?1 AND provider = ?2 AND h = ?3'
  const insSql = `INSERT INTO hourly_buckets
    (user_email, device_id, h, model, provider, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, duration_ms, turns, bg_output, cost_micros, sub)
    SELECT user_email, device_id, ?3, model, provider,
           SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_creation_tokens), SUM(duration_ms),
           SUM(CASE WHEN kind = 'main' THEN 1 ELSE 0 END),
           SUM(CASE WHEN kind = 'bg' THEN output_tokens ELSE 0 END),
           CASE WHEN MIN(cost_micros) > 0 THEN SUM(cost_micros) ELSE 0 END,
           SUM(is_subagent)
    FROM token_events
    WHERE device_id = ?1 AND provider = ?2 AND ts >= ?4 AND ts < ?5
    GROUP BY user_email, device_id, model, provider`
  try {
    for (let i = 0; i < items.length; i += CHUNK) {
      const stmts = items.slice(i, i + CHUNK).flatMap(t => {
        const from = `${t.h}:00:00.000Z`
        const to = nextHourIso(t.h)
        return [
          env.DB.prepare(delSql).bind(t.deviceId, t.provider, t.h),
          env.DB.prepare(insSql).bind(t.deviceId, t.provider, t.h, from, to),
        ]
      })
      await env.DB.batch(stmts)
    }
  } catch (e) {
    console.error('hourly_buckets refresh: ' + (e instanceof Error ? e.message : 'failed'))
  }
}
