// Admin route that hands the Insights tab its aggregates, computed from the events database (every event with its harmless attributes).
// Supports all agents (?provider=claude|codex|antigravity) using 1 call-event query and skipped Claude-only queries for other providers.
import { FIELD_KEYS } from '../otlp-fields.ts'
import { getPrices } from '../prices.ts'
import { estimateCostMicros } from '../prices-lib.ts'
import type { PricesFile } from '../prices-lib.ts'
import { json } from '../util.ts'
import type { Routes } from './context.ts'

export type InsightsProvider = 'claude' | 'codex' | 'antigravity'

export interface RawCallEventRow {
  ts: string
  name: string
  service: string
  session_id: string
  surface: string
  attrs: string
}

interface Stat { n: number; avg: number; p50: number; p90: number; p95: number; p99: number; max: number }
interface Bucket { lo: number; hi: number | null; n: number }

const pct = (sorted: number[], p: number): number =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0

const safeParse = (raw: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const num = (a: Record<string, unknown>, k: string): number | null =>
  typeof a[k] === 'number' && Number.isFinite(a[k]) ? (a[k] as number) : null

const txt = (a: Record<string, unknown>, k: string): string | null =>
  typeof a[k] === 'string' && a[k] ? (a[k] as string) : null

/** Aggregates model call event rows across Claude, Codex, and Antigravity in one pass. */
export function aggregateCallEvents(rows: RawCallEventRow[], prices: PricesFile | null) {
  const bySourceMap = new Map<string, { source: string | null; calls: number; output: number; fresh_input: number; cache_read: number; cost_micros: number }>()
  const bySurfaceMap = new Map<string, { surface: string; calls: number; sessions: Set<string>; output: number; cost_micros: number }>()
  const byDayMap = new Map<string, { day: string; source: string | null; calls: number; cost_micros: number }>()

  const ttftHist = [500, 1000, 2000, 3000, 5000, Infinity].map((hi, i, arr) => ({ hi, lo: i ? arr[i - 1] : 0, n: 0 }))
  const durHist = [1000, 2000, 5000, 10_000, 30_000, 60_000, 120_000, Infinity].map((hi, i, arr) => ({ hi, lo: i ? arr[i - 1] : 0, n: 0 }))
  const put = (hist: { hi: number; lo: number; n: number }[], v: number) => {
    const b = hist.find(x => v < x.hi)
    if (b) b.n++
  }

  const perDay = new Map<string, { ttft: number[]; dur: number[]; tps: number[] }>()
  const byModelLat = new Map<string, { ttft: number[]; dur: number[]; tps: number[] }>()
  const allDur: number[] = []
  const allTtft: number[] = []
  const latencyCandidates: { ts: string; surface: string; model: string | null; source: string | null; ttft: number | null; dur: number; output: number }[] = []

  for (const r of rows) {
    const a = safeParse(r.attrs)
    const isCodex = r.name === 'codex.sse_event'
    if (isCodex && txt(a, 'event.kind') !== 'response.completed') continue

    const isAgy = r.name === 'antigravity.api_request'
    const model = txt(a, 'model') || 'unknown'

    let plainInput = 0, output = 0, cacheRead = 0, cacheWrite = 0
    let source: string | null
    let surface: string
    if (isCodex) {
      output = num(a, 'output_token_count') ?? 0
      cacheRead = num(a, 'cached_token_count') ?? 0
      cacheWrite = num(a, 'cache_write_token_count') ?? 0
      plainInput = Math.max(0, (num(a, 'input_token_count') ?? 0) - cacheRead - cacheWrite)
      source = txt(a, 'originator') || 'codex'
      surface = r.surface || source
    } else {
      plainInput = num(a, 'input_tokens') ?? 0
      output = num(a, 'output_tokens') ?? 0
      cacheRead = num(a, 'cache_read_tokens') ?? 0
      cacheWrite = num(a, 'cache_creation_tokens') ?? 0
      source = txt(a, 'query_source') || (isAgy ? 'antigravity-cli' : null)
      surface = r.surface || (isAgy ? 'antigravity-cli' : '')
    }
    const freshInput = plainInput + cacheWrite
    const rawMicros = num(a, 'cost_usd_micros')
    const costMicros = rawMicros && rawMicros > 0
      ? rawMicros
      : estimateCostMicros({ input: plainInput, output, cache_read: cacheRead, cache_creation: cacheWrite }, model, prices)

    const srcKey = source ?? '__null__'
    const srcSlot = bySourceMap.get(srcKey) ?? { source, calls: 0, output: 0, fresh_input: 0, cache_read: 0, cost_micros: 0 }
    srcSlot.calls++
    srcSlot.output += output
    srcSlot.fresh_input += freshInput
    srcSlot.cache_read += cacheRead
    srcSlot.cost_micros += costMicros
    bySourceMap.set(srcKey, srcSlot)

    const surfSlot = bySurfaceMap.get(surface) ?? { surface, calls: 0, sessions: new Set<string>(), output: 0, cost_micros: 0 }
    surfSlot.calls++
    if (r.session_id) surfSlot.sessions.add(r.session_id)
    surfSlot.output += output
    surfSlot.cost_micros += costMicros
    bySurfaceMap.set(surface, surfSlot)

    const day = r.ts.slice(0, 10)
    const dayKey = `${day}|${srcKey}`
    const daySlot = byDayMap.get(dayKey) ?? { day, source, calls: 0, cost_micros: 0 }
    daySlot.calls++
    daySlot.cost_micros += costMicros
    byDayMap.set(dayKey, daySlot)

    if (source === 'generate_session_title' || source === 'away_summary') continue

    const ttft = num(a, 'ttft_ms')
    const dur = num(a, 'duration_ms')
    const dayLat = perDay.get(day) ?? { ttft: [], dur: [], tps: [] }
    const modLat = byModelLat.get(model) ?? { ttft: [], dur: [], tps: [] }

    if (ttft !== null) {
      allTtft.push(ttft)
      dayLat.ttft.push(ttft)
      modLat.ttft.push(ttft)
      put(ttftHist, ttft)
    }
    if (dur !== null) {
      allDur.push(dur)
      dayLat.dur.push(dur)
      modLat.dur.push(dur)
      put(durHist, dur)
      if (dur >= 500 && output >= 20) {
        const tps = (output * 1000) / dur
        dayLat.tps.push(tps)
        modLat.tps.push(tps)
      }
      latencyCandidates.push({ ts: r.ts, surface, model, source, ttft, dur, output })
    }
    if (ttft !== null || dur !== null) {
      perDay.set(day, dayLat)
      byModelLat.set(model, modLat)
    }
  }

  const sorted = (v: number[]) => [...v].sort((x, y) => x - y)
  const stat = (v: number[]): Stat => {
    const s = sorted(v)
    return { n: s.length, avg: s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : 0, p50: pct(s, 50), p90: pct(s, 90), p95: pct(s, 95), p99: pct(s, 99), max: s.length ? s[s.length - 1] : 0 }
  }

  const bySource = [...bySourceMap.values()].sort((a, b) => b.cost_micros - a.cost_micros || b.calls - a.calls)
  const bySurface = [...bySurfaceMap.values()]
    .map(s => ({ surface: s.surface, calls: s.calls, sessions: s.sessions.size, output: s.output, cost_micros: s.cost_micros }))
    .sort((a, b) => b.cost_micros - a.cost_micros || b.calls - a.calls)
  const byDay = [...byDayMap.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))

  const latencyDaily = [...perDay]
    .sort(([x], [y]) => (x < y ? -1 : 1))
    .map(([day, e]) => {
      const t = sorted(e.ttft), d = sorted(e.dur), p = sorted(e.tps)
      return { day, calls: d.length, ttft_p50: pct(t, 50), ttft_p95: pct(t, 95), dur_p50: pct(d, 50), dur_p95: pct(d, 95), tps_p50: Math.round(pct(p, 50) * 10) / 10 }
    })

  const latency = [...byModelLat]
    .map(([model, e]) => {
      const t = sorted(e.ttft), d = sorted(e.dur), s = sorted(e.tps)
      return { model, calls: d.length, ttft_p50: pct(t, 50), ttft_p95: pct(t, 95), dur_p50: pct(d, 50), dur_p95: pct(d, 95), tps_p50: Math.round(pct(s, 50) * 10) / 10 }
    })
    .filter(l => l.calls > 0 || l.ttft_p50 > 0)
    .sort((x, y) => y.calls - x.calls)

  const slowest = latencyCandidates.sort((x, y) => y.dur - x.dur).slice(0, 10)
  const latencyStats = { duration: stat(allDur), ttft: stat(allTtft) }
  const latencyHist = {
    ttft: ttftHist.map((b): Bucket => ({ lo: b.lo, hi: Number.isFinite(b.hi) ? b.hi : null, n: b.n })),
    duration: durHist.map((b): Bucket => ({ lo: b.lo, hi: Number.isFinite(b.hi) ? b.hi : null, n: b.n })),
  }

  return { bySource, bySurface, byDay, latency, latencyDaily, latencyHist, latencyStats, slowest }
}

const CALL_NAMES: Record<InsightsProvider, string[]> = {
  claude: ['api_request'],
  codex: ['codex.sse_event'],
  antigravity: ['antigravity.api_request'],
}

export const insightRoutes: Routes = async ({ req, env, url, email, path }) => {
  if (path !== '/insights' || req.method !== 'GET') return null
  if (!env.EVENTS) return json({ available: false })

  const to = Date.parse(url.searchParams.get('to') ?? '') || Date.now() + 86_400_000
  const from = Math.max(Date.parse(url.searchParams.get('from') ?? '') || to - 30 * 86_400_000, to - 400 * 86_400_000)
  const a = new Date(from).toISOString(), b = new Date(to).toISOString()
  const rawProv = url.searchParams.get('provider') ?? ''
  const provider = ['claude', 'codex', 'antigravity'].includes(rawProv) ? (rawProv as InsightsProvider) : null

  // This page runs several indexed queries over the period, so a repeat within two minutes is answered from the edge cache (rows read are limited per day).
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default
  const key = new Request(`https://insights.cache.invalid/${encodeURIComponent(email)}/${provider ?? 'all'}/${a}/${b}`)
  const hit = url.searchParams.has('fresh') ? undefined : await cache?.match(key).catch(() => undefined) // ?fresh=1 skips the cache (the tests, a manual refresh)
  if (hit) return hit

  const q = <T = Record<string, string | number | null>>(sql: string): Promise<T[]> =>
    env.EVENTS!.prepare(sql).bind(email, a, b).all<T>().then(r => r.results)
  const svcFilter = provider === 'claude' ? ` AND service LIKE 'claude%'`
    : provider === 'codex' ? ` AND service LIKE 'codex%'`
    : provider === 'antigravity' ? ` AND service LIKE 'antigravity%'`
    : ''
  const W = `user_email = ?1 AND ts >= ?2 AND ts < ?3${svcFilter}`
  const J = (k: string) => `json_extract(attrs, '$."${k}"')`
  const callNames = provider ? CALL_NAMES[provider] : [...CALL_NAMES.claude, ...CALL_NAMES.antigravity, ...CALL_NAMES.codex]
  const wantClaudeOnly = !provider || provider === 'claude'
  const empty = <T>() => Promise.resolve([] as T[])

  const [prices, callRows, tools, decisions, promptRows, errors, totals, safety, hooks, mcp, refusals, modes, compaction, subagents, skills] = await Promise.all([
    getPrices(env),
    q<RawCallEventRow>(
      `SELECT ts, name, service, session_id, surface, attrs FROM events
       WHERE ${W} AND name IN (${callNames.map(n => `'${n}'`).join(', ')})
         AND (name != 'codex.sse_event' OR ${J('event.kind')} = 'response.completed')
       ORDER BY ts DESC LIMIT 20000`,
    ),
    q(`SELECT ${J('tool_name')} AS tool, COUNT(*) AS runs, SUM(CASE WHEN ${J('success')} = 'true' OR ${J('success')} = 1 THEN 1 ELSE 0 END) AS ok, AVG(${J('duration_ms')}) AS avg_ms, MAX(${J('duration_ms')}) AS max_ms, AVG(${J('tool_input_size_bytes')}) AS avg_in_bytes, AVG(${J('tool_result_size_bytes')}) AS avg_out_bytes FROM events WHERE ${W} AND name IN ('tool_result', 'codex.tool_result') GROUP BY tool ORDER BY runs DESC LIMIT 40`),
    q(`SELECT ${J('tool_name')} AS tool, ${J('decision')} AS decision, ${J('source')} AS source, COUNT(*) AS n FROM events WHERE ${W} AND name IN ('tool_decision', 'codex.tool_decision') GROUP BY tool, decision, source ORDER BY n DESC LIMIT 80`),
    q<{ day: string; command: string | null; n: number; len_sum: number | null; len_n: number }>(`SELECT substr(ts, 1, 10) AS day, ${J('command_name')} AS command, COUNT(*) AS n, SUM(${J('prompt_length')}) AS len_sum, COUNT(${J('prompt_length')}) AS len_n FROM events WHERE ${W} AND name IN ('user_prompt', 'codex.user_prompt') GROUP BY day, command ORDER BY day`),
    q(`SELECT name AS kind, COALESCE(${J('status_code')}, ${J('http.response.status_code')}) AS status, ${J('model')} AS model, COUNT(*) AS n, AVG(${J('total_attempts')}) AS avg_attempts, AVG(${J('total_retry_duration_ms')}) AS avg_retry_ms FROM events WHERE ${W} AND (name IN ('api_error', 'api_retries_exhausted') OR (name = 'codex.api_request' AND ${J('http.response.status_code')} >= 400)) GROUP BY kind, status, model ORDER BY n DESC LIMIT 20`),
    q(`SELECT COUNT(*) AS events, COUNT(DISTINCT name) AS kinds, COUNT(DISTINCT session_id) AS sessions, MIN(ts) AS first_ts, MAX(ts) AS last_ts FROM events WHERE ${W}`),
    wantClaudeOnly ? q(`SELECT ${J('reason_code')} AS reason, ${J('tool_class')} AS class, ${J('decision')} AS decision, COUNT(*) AS n FROM events WHERE ${W} AND name = 'safety_event' GROUP BY reason, class, decision ORDER BY n DESC LIMIT 30`) : empty(),
    wantClaudeOnly ? q(`SELECT ${J('hook_event')} AS hook_event, ${J('hook_name')} AS hook_name, COUNT(*) AS runs, AVG(${J('total_duration_ms')}) AS avg_ms, MAX(${J('total_duration_ms')}) AS max_ms, SUM(CASE WHEN ${J('num_success')} < ${J('num_hooks')} THEN 1 ELSE 0 END) AS failed FROM events WHERE ${W} AND name = 'hook_execution_complete' GROUP BY hook_event, hook_name ORDER BY runs DESC LIMIT 30`) : empty(),
    wantClaudeOnly ? q(`SELECT ${J('status')} AS status, ${J('error_code')} AS error, ${J('transport_type')} AS transport, ${J('is_plugin')} AS is_plugin, COUNT(*) AS n, AVG(${J('duration_ms')}) AS avg_ms FROM events WHERE ${W} AND name = 'mcp_server_connection' GROUP BY status, error, transport, is_plugin ORDER BY n DESC LIMIT 30`) : empty(),
    wantClaudeOnly ? q(`SELECT ${J('model')} AS model, ${J('server_fallback_hop')} AS hop, COUNT(*) AS n FROM events WHERE ${W} AND name = 'api_refusal' GROUP BY model, hop ORDER BY n DESC LIMIT 20`) : empty(),
    wantClaudeOnly ? q(`SELECT ${J('from_mode')} AS from_mode, ${J('to_mode')} AS to_mode, COUNT(*) AS n FROM events WHERE ${W} AND name = 'permission_mode_changed' GROUP BY from_mode, to_mode ORDER BY n DESC LIMIT 20`) : empty(),
    wantClaudeOnly ? q(`SELECT ${J('trigger')} AS trigger, ${J('success')} AS success, COUNT(*) AS n, AVG(${J('duration_ms')}) AS avg_ms, AVG(${J('pre_tokens')}) AS avg_pre, AVG(${J('post_tokens')}) AS avg_post, SUM(${J('pre_tokens')} - ${J('post_tokens')}) AS saved FROM events WHERE ${W} AND name = 'compaction' GROUP BY trigger, success ORDER BY n DESC LIMIT 10`) : empty(),
    wantClaudeOnly ? q(`SELECT ${J('agent_type')} AS agent, COUNT(*) AS runs, AVG(${J('duration_ms')}) AS avg_ms, AVG(${J('total_tool_uses')}) AS avg_tools, AVG(${J('total_tokens')}) AS avg_tokens, SUM(${J('is_async')}) AS async_runs, SUM(${J('model_swapped')}) AS swapped FROM events WHERE ${W} AND name = 'subagent_completed' GROUP BY agent ORDER BY runs DESC LIMIT 20`) : empty(),
    wantClaudeOnly ? q(`SELECT ${J('skill.name')} AS skill, ${J('invocation_trigger')} AS trigger, ${J('skill.source')} AS source, COUNT(*) AS n FROM events WHERE ${W} AND name = 'skill_activated' GROUP BY skill, trigger, source ORDER BY n DESC LIMIT 30`) : empty(),
  ])

  const callAgg = aggregateCallEvents(callRows, prices)

  // Prompts per day + top commands derived from the single prompt query
  const promptMap = new Map<string, { prompts: number; lenSum: number; lenN: number }>()
  const cmdMap = new Map<string, number>()
  for (const r of promptRows) {
    const p = promptMap.get(r.day) ?? { prompts: 0, lenSum: 0, lenN: 0 }
    p.prompts += r.n
    if (r.len_sum != null && r.len_n > 0) { p.lenSum += r.len_sum; p.lenN += r.len_n }
    promptMap.set(r.day, p)
    if (r.command) cmdMap.set(r.command, (cmdMap.get(r.command) ?? 0) + r.n)
  }
  const prompts = [...promptMap].sort(([x], [y]) => (x < y ? -1 : 1)).map(([day, p]) => ({
    day,
    prompts: p.prompts,
    avg_len: p.lenN ? p.lenSum / p.lenN : null,
  }))
  const commands = [...cmdMap].map(([command, n]) => ({ command, n })).sort((x, y) => y.n - x.n).slice(0, 20)

  // Fields that arrive but are not in the registry (src/otlp-fields.ts) yet
  const unknown = new Map<string, string>()
  const seen = await env.DB.prepare('SELECT event, keys FROM otlp_seen WHERE device_id IN (SELECT id FROM devices WHERE user_email = ?)')
    .bind(email).all<{ event: string; keys: string }>().then(r => r.results).catch(() => [])
  for (const x of seen) for (const k of x.keys.split(',')) if (k && !FIELD_KEYS.has(k) && !unknown.has(k)) unknown.set(k, x.event)
  const unknownFields = [...unknown].map(([key, event]) => ({ key, event })).sort((x, y) => x.key.localeCompare(y.key))

  const res = json({
    available: true,
    totals: totals[0],
    ...callAgg,
    tools,
    decisions,
    safety,
    hooks,
    mcp,
    refusals,
    prompts,
    commands,
    modes,
    compaction,
    subagents,
    errors,
    skills,
    unknownFields,
  })
  res.headers.set('cache-control', 'max-age=120')
  await cache?.put(key, res.clone()).catch(() => undefined)
  return res
}
