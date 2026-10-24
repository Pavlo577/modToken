// Turn rows: the INSERT statements and the validation of one row, shared by live ingest and old-history import.
import type { Env } from './env.ts'
import { int, str } from './util.ts'

export const MAX_ROWS = 500

/** The agents whose turns can be stored; a row without `provider` is Claude's (older mods and the cloud hook). */
export const PROVIDERS = ['claude', 'codex', 'gemini', 'mistral', 'opencode'] as const
export type Provider = (typeof PROVIDERS)[number]

/** The provider of a row, or null when it names an unknown one. */
export const providerOf = (v: unknown): Provider | null => (v === undefined || v === null || v === '' ? 'claude' : (PROVIDERS as readonly string[]).includes(String(v)) ? (String(v) as Provider) : null)

export const EVENT_SQL = `INSERT OR IGNORE INTO token_events
  (user_email, device_id, session_id, turn_id, ts, model, input_tokens, output_tokens,
   cache_read_tokens, cache_creation_tokens, duration_ms, is_subagent, provider)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

/** Live ingest: a turn that is sent again (it grew since) raises the counts instead of being ignored. */
export const INGEST_SQL = `${EVENT_SQL.replace('INSERT OR IGNORE', 'INSERT')}
  ON CONFLICT (device_id, turn_id) DO UPDATE SET
    input_tokens = MAX(input_tokens, excluded.input_tokens),
    output_tokens = MAX(output_tokens, excluded.output_tokens),
    cache_read_tokens = MAX(cache_read_tokens, excluded.cache_read_tokens),
    cache_creation_tokens = MAX(cache_creation_tokens, excluded.cache_creation_tokens),
    duration_ms = MAX(duration_ms, excluded.duration_ms)`

/** One validated row as an INSERT, or null when its timestamp is not a date or its provider is unknown. */
export function eventStmt(env: Env, email: string, deviceId: string, r: Record<string, unknown>, turnId = str(r.turn_id), sql = EVENT_SQL) {
  const ts = new Date(str(r.ts))
  const provider = providerOf(r.provider)
  if (Number.isNaN(ts.getTime()) || !provider) return null
  return env.DB.prepare(sql).bind(
    email, deviceId, str(r.session_id), turnId, ts.toISOString(), str(r.model),
    int(r.input_tokens), int(r.output_tokens), int(r.cache_read_tokens), int(r.cache_creation_tokens),
    int(r.duration_ms), r.is_subagent === true ? 1 : 0, provider,
  )
}
