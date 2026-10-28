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
  // This page runs about twenty queries over every event of the period, so a repeat within two minutes is answered from the edge cache (rows read are limited per day).
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default
  const key = new Request(`https://insights.cache.invalid/${encodeURIComponent(email)}/${a}/${b}`)
  const hit = url.searchParams.has('fresh') ? undefined : await cache?.match(key).catch(() => undefined) // ?fresh=1 skips the cache (the tests, a manual refresh)
  if (hit) return hit
  const q = <T = Row>(sql: string): Promise<T[]> => env.EVENTS!.prepare(sql).bind(email, a, b).all<T>().then(r => r.results)
  const W = "user_email = ?1 AND ts >= ?2 AND ts < ?3"
  const J = (k: string) => `json_extract(attrs, '$."${k}"')` // quoted: some names have dots
  const calls = `name = 'api_request'`

  const [bySource, bySurface, byModel, byDay, latencyRows, tools, decisions, safety, hooks, mcp, refusals, sessions, prompts, commands, modes, compaction, subagents, errors, skills, totals] = await Promise.all([
    q(`SELECT ${J('query_source')} AS source, COUNT(*) AS calls, SUM(${J('output_tokens')}) AS output, SUM(${J('input_tokens')} + ${J('cache_creation_tokens')}) AS fresh_input, SUM(${J('cache_read_tokens')}) AS cache_read, SUM(${J('cost_usd_micros')}) AS cost_micros FROM events WHERE ${W} AND ${calls} GROUP BY source ORDER BY cost_micros DESC`),
    q(`SELECT surface, COUNT(*) AS calls, COUNT(DISTINCT session_id) AS sessions, SUM(${J('output_tokens')}) AS output, SUM(${J('cost_usd_micros')}) AS cost_micros FROM events WHERE ${W} AND ${calls} GROUP BY surface ORDER BY cost_micros DESC`),
    q(`SELECT ${J('model')} AS model, ${J('speed')} AS speed, COUNT(*) AS calls, SUM(${J('output_tokens')}) AS output, SUM(${J('cache_read_tokens')}) AS cache_read, SUM(${J('input_tokens')} + ${J('cache_creation_tokens')}) AS fresh_input, SUM(${J('cost_usd_micros')}) AS cost_micros FROM events WHERE ${W} AND ${calls} GROUP BY model, speed ORDER BY cost_micros DESC`),
    q(`SELECT substr(ts, 1, 10) AS day, ${J('query_source')} AS source, COUNT(*) AS calls, SUM(${J('cost_usd_micros')}) AS cost_micros FROM events WHERE ${W} AND ${calls} GROUP BY day, source ORDER BY day`),
    q(`SELECT ts, surface, ${J('model')} AS model, ${J('ttft_ms')} AS ttft, ${J('duration_ms')} AS dur, ${J('output_tokens')} AS output, ${J('query_source')} AS source FROM events WHERE ${W} AND ${calls} AND (${J('query_source')} IS NULL OR ${J('query_source')} NOT IN ('generate_session_title', 'away_summary')) ORDER BY ts DESC LIMIT 20000`),
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
    q(`SELECT ${J('trigger')} AS trigger, ${J('success')} AS success, COUNT(*) AS n, AVG(${J('duration_ms')}) AS avg_ms, AVG(${J('pre_tokens')}) AS avg_pre, AVG(${J('post_tokens')}) AS avg_post, SUM(${J('pre_tokens')} - ${J('post_tokens')}) AS saved FROM events WHERE ${W} AND name = 'compaction' GROUP BY trigger, success ORDER BY n DESC LIMIT 10`),
    q(`SELECT ${J('agent_type')} AS agent, COUNT(*) AS runs, AVG(${J('duration_ms')}) AS avg_ms, AVG(${J('total_tool_uses')}) AS avg_tools, AVG(${J('total_tokens')}) AS avg_tokens, SUM(${J('is_async')}) AS async_runs, SUM(${J('model_swapped')}) AS swapped FROM events WHERE ${W} AND name = 'subagent_completed' GROUP BY agent ORDER BY runs DESC LIMIT 20`),
    q(`SELECT name AS kind, ${J('status_code')} AS status, ${J('model')} AS model, COUNT(*) AS n, AVG(${J('total_attempts')}) AS avg_attempts, AVG(${J('total_retry_duration_ms')}) AS avg_retry_ms FROM events WHERE ${W} AND name IN ('api_error', 'api_retries_exhausted') GROUP BY kind, status, model ORDER BY n DESC LIMIT 20`),
    q(`SELECT ${J('skill.name')} AS skill, ${J('invocation_trigger')} AS trigger, ${J('skill.source')} AS source, COUNT(*) AS n FROM events WHERE ${W} AND name = 'skill_activated' GROUP BY skill, trigger, source ORDER BY n DESC LIMIT 30`),
    q(`SELECT COUNT(*) AS events, COUNT(DISTINCT name) AS kinds, COUNT(DISTINCT session_id) AS sessions, MIN(ts) AS first_ts, MAX(ts) AS last_ts FROM events WHERE ${W}`),
  ])

  // fields that arrive but are not in the registry (src/otlp-fields.ts) yet: from the key names the diagnostics saw (otlp_seen lists every key, so no scan of the events)
  const unknown = new Map<string, string>()
  const seen = await env.DB.prepare('SELECT event, keys FROM otlp_seen WHERE device_id IN (SELECT id FROM devices WHERE user_email = ?)').bind(email).all<{ event: string; keys: string }>().then(r => r.results).catch(() => [])
  for (const x of seen) for (const k of x.keys.split(',')) if (k && !FIELD_KEYS.has(k) && !unknown.has(k)) unknown.set(k, x.event)
  const unknownFields = [...unknown].map(([key, event]) => ({ key, event })).sort((x, y) => x.key.localeCompare(y.key))

  // response time over time, its distribution and the slowest requests (from the same per-call rows)
  const BUCKETS = (edges: number[]) => edges.map((hi, i) => ({ hi, lo: i ? edges[i - 1] : 0, n: 0 }))
  const ttftHist = BUCKETS([500, 1000, 2000, 3000, 5000, Infinity]), durHist = BUCKETS([1000, 2000, 5000, 10_000, 30_000, 60_000, 120_000, Infinity])
  const put = (hist: { hi: number; lo: number; n: number }[], v: number) => { const b = hist.find(x => v < x.hi); if (b) b.n++ }
  const perDay = new Map<string, { ttft: number[]; dur: number[]; tps: number[] }>()
  for (const r of latencyRows) {
    const day = String(r.ts).slice(0, 10), e = perDay.get(day) ?? { ttft: [], dur: [], tps: [] }
    if (typeof r.ttft === 'number') { e.ttft.push(r.ttft); put(ttftHist, r.ttft) }
    if (typeof r.dur === 'number') {
      e.dur.push(r.dur); put(durHist, r.dur)
      if (typeof r.output === 'number' && r.dur >= 500 && r.output >= 20) e.tps.push((r.output * 1000) / r.dur)
    }
    perDay.set(day, e)
  }
  const sorted = (v: number[]) => [...v].sort((x, y) => x - y)
  const latencyDaily = [...perDay].sort(([x], [y]) => (x < y ? -1 : 1)).map(([day, e]) => {
    const t = sorted(e.ttft), d = sorted(e.dur), p = sorted(e.tps)
    return { day, calls: d.length, ttft_p50: pct(t, 50), ttft_p95: pct(t, 95), dur_p50: pct(d, 50), dur_p95: pct(d, 95), tps_p50: Math.round(pct(p, 50) * 10) / 10 }
  })
  const allDur = sorted(latencyRows.flatMap(r => (typeof r.dur === 'number' ? [r.dur] : [])))
  const allTtft = sorted(latencyRows.flatMap(r => (typeof r.ttft === 'number' ? [r.ttft] : [])))
  const stat = (v: number[]) => ({ n: v.length, avg: v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : 0, p50: pct(v, 50), p90: pct(v, 90), p95: pct(v, 95), p99: pct(v, 99), max: v.length ? v[v.length - 1] : 0 })
  const slowest = [...latencyRows].filter(r => typeof r.dur === 'number').sort((x, y) => (y.dur as number) - (x.dur as number)).slice(0, 10)
    .map(r => ({ ts: r.ts, surface: r.surface, model: r.model, source: r.source, ttft: r.ttft, dur: r.dur, output: r.output }))
  const latencyStats = { duration: stat(allDur), ttft: stat(allTtft) }
  const latencyHist = { ttft: ttftHist.map(b => ({ lo: b.lo, hi: Number.isFinite(b.hi) ? b.hi : null, n: b.n })), duration: durHist.map(b => ({ lo: b.lo, hi: Number.isFinite(b.hi) ? b.hi : null, n: b.n })) }

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

  const res = json({ available: true, totals: totals[0], bySource, bySurface, byModel, byDay, latency, tools, decisions, safety, hooks, mcp, refusals, sessions, prompts, commands, modes, compaction, subagents, errors, skills, latencyDaily, latencyHist, latencyStats, slowest, unknownFields })
  res.headers.set('cache-control', 'max-age=120')
  await cache?.put(key, res.clone()).catch(() => undefined)
  return res
}
