// The token-tracker mod's endpoints read named fields and drop the rest. This records the NAMES of what was dropped (never a value), so a field the
// mod starts to send does not vanish unnoticed: it shows in the Insights "new fields" card like an unknown OTLP field (the table is otlp_seen,
// service 'token-tracker', the event is the endpoint).
import type { Env } from './env.ts'

/** The names each endpoint reads: the top level, then each nested object (the path is the key in `droppedNames`). */
export const MOD_FIELDS = {
  limits: { '': ['limits'], 'limits': ['kind', 'percentUsed', 'resetsAt'] },
  activity: {
    '': ['session', 'turns'],
    'session': ['id', 'started_at', 'ended_at', 'end_reason', 'project', 'project_note'],
    'turns': ['id', 'session', 'ts', 'wall_ms', 'think_ms', 'outcome', 'context_pct', 'context_tokens', 'context_window', 'perm_asks', 'perm_denied', 'perm_wait_ms'],
  },
  import: { '': ['turns'], 'turns': ['id', 'session', 'ts', 'model', 'input', 'output', 'cache_read', 'cache_creation', 'sub', 'first', 'duration_ms'] },
} as const satisfies Record<string, Record<string, readonly string[]>>

export type ModEndpoint = keyof typeof MOD_FIELDS

const MAX_NAMES = 40
const clean = (k: string): string => k.replace(/[^\w.:-]/g, '').slice(0, 60)
const objects = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v : [v]).slice(0, 20).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))

/** Names in `body` that the endpoint does not read, as `path.name` (`turns.extra`, `extra` at the top). Only names, never values. */
export function droppedNames(endpoint: ModEndpoint, body: unknown): string[] {
  const spec = MOD_FIELDS[endpoint] as Record<string, readonly string[]>
  const out = new Set<string>()
  for (const [path, allowed] of Object.entries(spec)) {
    const nodes = path === '' ? objects(body) : objects(body).flatMap(b => objects(b[path]))
    for (const o of nodes) for (const k of Object.keys(o)) if (!allowed.includes(k)) out.add(path ? `${path}.${clean(k)}` : clean(k))
  }
  return [...out].filter(Boolean).sort().slice(0, MAX_NAMES)
}

/** Remembers the dropped names of a request (merged with the earlier ones). Nothing is read or written when nothing was dropped. */
export async function recordDropped(env: Env, deviceId: string, endpoint: ModEndpoint, body: unknown): Promise<void> {
  const names = droppedNames(endpoint, body)
  if (!names.length) return
  try {
    const before = await env.DB.prepare(`SELECT keys FROM otlp_seen WHERE device_id = ? AND service = 'token-tracker' AND event = ?`).bind(deviceId, endpoint).first<{ keys: string }>()
    const keys = [...new Set([...(before?.keys ?? '').split(','), ...names])].filter(Boolean).sort().join(',').slice(0, 2000)
    await env.DB.prepare(
      `INSERT INTO otlp_seen (device_id, service, event, keys, lens, sample, n, last_seen) VALUES (?1, 'token-tracker', ?2, ?3, '', '', 1, ?4)
       ON CONFLICT (device_id, service, event) DO UPDATE SET n = n + 1, keys = excluded.keys, last_seen = excluded.last_seen`,
    ).bind(deviceId, endpoint, keys, new Date().toISOString()).run()
  } catch (e) {
    console.error('dropped names: ' + (e instanceof Error ? e.message : 'failed')) // never the data
  }
}
