// Admin route that hands the statistics page its aggregates, computed from the events database (every event with its harmless attributes).
import { FIELD_KEYS } from '../otlp-fields.ts'
import { json } from '../util.ts'
import type { Routes } from './context.ts'

interface Row { [k: string]: string | number | null }

const pct = (sorted: number[], p: number): number => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0)

export const insightRoutes: Routes = async ({ req, env, url, email, path }) => {
  if (path !== '/insights' || req.method !== 'GET') return null
  if (!env.EVENTS) return json({ available: false })
  const to = Date.parse(url.searchParams.get('to') ?? '') || Date.now() + 86_400_000
  const from = Math.max(Date.parse(url.searchParams.get('from') ?? '') || to - 30 * 86_400_000, to - 400 * 86_400_000)
  const a = new Date(from).toISOString(), b = new Date(to).toISOString()
  const q = <T = Row>(sql: string): Promise<T[]> => env.EVENTS!.prepare(sql).bind(email, a, b).all<T>().then(r => r.results)
  const W = "user_email = ?1 AND ts >= ?2 AND ts < ?3"
  const J = (k: string) => `json_extract(attrs, '$.${k}')`
  const calls = `name = 'api_request'`

  const [bySource, bySurface, byModel, byDay, latencyRows, tools, decisions, safety, hooks, mcp, refusals, sessions, prompts, commands, modes, totals] = await Promise.all([
    q(`SELECT ${J('query_source')} AS source, COUNT(*) AS calls, SUM(${J('output_tokens')}) AS output, SUM(${J('input_tokens')} + ${J('cache_creation_tokens')}) AS fresh_input, SUM(${J('cache_read_tokens')}) AS cache_read, SUM(${J('cost_usd_micros')}) AS cost_micros FROM events WHERE ${W} AND ${calls} GROUP BY source ORDER BY cost_micros DESC`),
    q(`SELECT surface, COUNT(*) AS calls, COUNT(DISTINCT session_id) AS sessions, SUM(${J('output_tokens')}) AS output, SUM(${J('cost_usd_micros')}) AS cost_micros FROM events WHERE ${W} AND ${calls} GROUP BY surface ORDER BY cost_micros DESC`),
    q(`SELECT ${J('model')} AS model, ${J('speed')} AS speed, COUNT(*) AS calls, SUM(${J('output_tokens')}) AS output, SUM(${J('cache_read_tokens')}) AS cache_read, SUM(${J('input_tokens')} + ${J('cache_creation_tokens')}) AS fresh_input, SUM(${J('cost_usd_micros')}) AS cost_micros FROM events WHERE ${W} AND ${calls} GROUP BY model, speed ORDER BY cost_micros DESC`),
    q(`SELECT substr(ts, 1, 10) AS day, ${J('query_source')} AS source, COUNT(*) AS calls, SUM(${J('cost_usd_micros')}) AS cost_micros FROM events WHERE ${W} AND ${calls} GROUP BY day, source ORDER BY day`),
    q(`SELECT ${J('model')} AS model, ${J('ttft_ms')} AS ttft, ${J('duration_ms')} AS dur, ${J('output_tokens')} AS output FROM events WHERE ${W} AND ${calls} ORDER BY ts DESC LIMIT 20000`),
    q(`SELECT ${J('tool_name')} AS tool, COUNT(*) AS runs, SUM(CASE WHEN ${J('success')} = 'true' OR ${J('success')} = 1 THEN 1 ELSE 0 END) AS ok, AVG(${J('duration_ms')}) AS avg_ms, MAX(${J('duration_ms')}) AS max_ms, AVG(${J('tool_input_size_bytes')}) AS avg_in_bytes, AVG(${J('tool_result_size_bytes')}) AS avg_out_bytes FROM events WHERE ${W} AND name = 'tool_result' GROUP BY tool ORDER BY runs DESC LIMIT 40`),
    q(`SELECT ${J('tool_name')} AS tool, ${J('decision')} AS decision, ${J('source')} AS source, COUNT(*) AS n FROM events WHERE ${W} AND name = 'tool_decision' GROUP BY tool, decision, source ORDER BY n DESC LIMIT 80`),
    q(`SELECT ${J('reason_code')} AS reason, ${J('tool_class')} AS class, ${J('decision')} AS decision, COUNT(*) AS n FROM events WHERE ${W} AND name = 'safety_event' GROUP BY reason, class, decision ORDER BY n DESC LIMIT 30`),
    q(`SELECT ${J('hook_event')} AS hook_event, ${J('hook_name')} AS hook_name, COUNT(*) AS runs, AVG(${J('total_duration_ms')}) AS avg_ms, MAX(${J('total_duration_ms')}) AS max_ms, SUM(CASE WHEN ${J('num_success')} < ${J('num_hooks')} THEN 1 ELSE 0 END) AS failed FROM events WHERE ${W} AND name = 'hook_execution_complete' GROUP BY hook_event, hook_name ORDER BY runs DESC LIMIT 30`),
    q(`SELECT ${J('status')} AS status, ${J('error_code')} AS error, ${J('transport_type')} AS transport, ${J('is_plugin')} AS is_plugin, COUNT(*) AS n, AVG(${J('duration_ms')}) AS avg_ms FROM events WHERE ${W} AND name = 'mcp_server_connection' GROUP BY status, error, transport, is_plugin ORDER BY n DESC LIMIT 30`),
    q(`SELECT ${J('model')} AS model, ${J('server_fallback_hop')} AS hop, COUNT(*) AS n FROM events WHERE ${W} AND name = 'api_refusal' GROUP BY model, hop ORDER BY n DESC LIMIT 20`),
    q(`SELECT session_id, MIN(surface) AS surface, COUNT(*) AS calls, MIN(ts) AS first_ts, MAX(ts) AS last_ts, SUM(${J('output_tokens')}) AS output, SUM(${J('cost_usd_micros')}) AS cost_micros FROM events WHERE ${W} AND ${calls} GROUP BY session_id ORDER BY cost_micros DESC LIMIT 15`),
    q(`SELECT substr(ts, 1, 10) AS day, COUNT(*) AS prompts, AVG(${J('prompt_length')}) AS avg_len FROM events WHERE ${W} AND name = 'user_prompt' GROUP BY day ORDER BY day`),
    q(`SELECT ${J('command_name')} AS command, COUNT(*) AS n FROM events WHERE ${W} AND name = 'user_prompt' AND ${J('command_name')} IS NOT NULL GROUP BY command ORDER BY n DESC LIMIT 20`),
    q(`SELECT ${J('from_mode')} AS from_mode, ${J('to_mode')} AS to_mode, COUNT(*) AS n FROM events WHERE ${W} AND name = 'permission_mode_changed' GROUP BY from_mode, to_mode ORDER BY n DESC LIMIT 20`),
    q(`SELECT COUNT(*) AS events, COUNT(DISTINCT name) AS kinds, COUNT(DISTINCT session_id) AS sessions, MIN(ts) AS first_ts, MAX(ts) AS last_ts FROM events WHERE ${W}`),
  ])

  // fields that arrive but are not in the registry (src/otlp-fields.ts) yet: from the stored attributes and from the names the diagnostics saw
  const unknown = new Map<string, string>()
  const stored = await env.EVENTS.prepare(`SELECT DISTINCT e.name AS event, j.key AS key FROM events e, json_each(e.attrs) j WHERE e.user_email = ?1 AND e.ts >= ?2 AND e.ts < ?3`).bind(email, a, b).all<{ event: string; key: string }>().then(r => r.results).catch(() => [])
  for (const x of stored) if (!FIELD_KEYS.has(x.key)) unknown.set(x.key, x.event)
  const seen = await env.DB.prepare('SELECT event, keys FROM otlp_seen WHERE device_id IN (SELECT id FROM devices WHERE user_email = ?)').bind(email).all<{ event: string; keys: string }>().then(r => r.results).catch(() => [])
  for (const x of seen) for (const k of x.keys.split(',')) if (k && !FIELD_KEYS.has(k) && !unknown.has(k)) unknown.set(k, x.event)
  const unknownFields = [...unknown].map(([key, event]) => ({ key, event })).sort((x, y) => x.key.localeCompare(y.key))

  const byModelLatency = new Map<string, { ttft: number[]; dur: number[]; tps: number[] }>()
  for (const r of latencyRows) {
    const m = String(r.model ?? 'unknown'), e = byModelLatency.get(m) ?? { ttft: [], dur: [], tps: [] }
    if (typeof r.ttft === 'number') e.ttft.push(r.ttft)
    if (typeof r.dur === 'number') {
      e.dur.push(r.dur)
      // tokens per second of the whole call, for calls long enough to mean something
      if (typeof r.output === 'number' && r.dur >= 500 && r.output >= 20) e.tps.push((r.output * 1000) / r.dur)
    }
    byModelLatency.set(m, e)
  }
  const latency = [...byModelLatency].map(([model, e]) => {
    const t = [...e.ttft].sort((x, y) => x - y), d = [...e.dur].sort((x, y) => x - y), s = [...e.tps].sort((x, y) => x - y)
    return { model, calls: d.length, ttft_p50: pct(t, 50), ttft_p95: pct(t, 95), dur_p50: pct(d, 50), dur_p95: pct(d, 95), tps_p50: Math.round(pct(s, 50) * 10) / 10 }
  }).sort((x, y) => y.calls - x.calls)

  return json({ available: true, totals: totals[0], bySource, bySurface, byModel, byDay, latency, tools, decisions, safety, hooks, mcp, refusals, sessions, prompts, commands, modes, unknownFields })
}
