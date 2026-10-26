// Admin route behind the "Робота з агентом" cards: what the token-tracker mod measured (mod_sessions, mod_turns), joined with the OTLP turns
// (token_events, same session id) for the projects.
import { json } from '../util.ts'
import type { Routes } from './context.ts'

const IDLE_MS = 30 * 60_000 // a pause longer than this before a prompt counts as a break, not as thinking

const stat = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const p = (q: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0)
  return { n: s.length, avg: s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0, p50: p(0.5), p90: p(0.9), max: s.length ? s[s.length - 1] : 0 }
}

interface TurnRow { ts: string; session_id: string; wall_ms: number; think_ms: number | null; outcome: string; context_pct: number | null; perm_asks: number; perm_denied: number; perm_wait_ms: number }
interface SessionRow { session_id: string; started_at: string; ended_at: string | null; end_reason: string | null; last_turn: string | null; turns: number }

export const modStatsRoutes: Routes = async ({ req, env, url, email, path }) => {
  if (path !== '/mod-stats' || req.method !== 'GET') return null
  const to = Date.parse(url.searchParams.get('to') ?? '') || Date.now() + 86_400_000
  const from = Math.max(Date.parse(url.searchParams.get('from') ?? '') || to - 30 * 86_400_000, to - 400 * 86_400_000)
  const a = new Date(from).toISOString(), b = new Date(to).toISOString()
  const all = <T>(sql: string) => env.DB.prepare(sql).bind(email, a, b).all<T>().then(r => r.results)

  const [turns, sessions, projects, notes] = await Promise.all([
    all<TurnRow>(`SELECT ts, session_id, wall_ms, think_ms, outcome, context_pct, perm_asks, perm_denied, perm_wait_ms FROM mod_turns
      WHERE user_email = ?1 AND ts >= ?2 AND ts < ?3 ORDER BY ts LIMIT 50000`),
    all<SessionRow>(`SELECT s.session_id, s.started_at, s.ended_at, s.end_reason,
        (SELECT MAX(t.ts) FROM mod_turns t WHERE t.device_id = s.device_id AND t.session_id = s.session_id) AS last_turn,
        (SELECT COUNT(*) FROM mod_turns t WHERE t.device_id = s.device_id AND t.session_id = s.session_id) AS turns
      FROM mod_sessions s WHERE s.user_email = ?1 AND s.started_at >= ?2 AND s.started_at < ?3 ORDER BY s.started_at LIMIT 5000`),
    all<{ project: string | null; sessions: number; turns: number; output: number; input: number; cache_read: number; cost_micros: number }>(
      `SELECT s.project, COUNT(DISTINCT s.session_id) AS sessions, SUM(CASE WHEN e.kind = 'main' THEN 1 ELSE 0 END) AS turns, SUM(e.output_tokens) AS output,
        SUM(e.input_tokens + e.cache_creation_tokens) AS input, SUM(e.cache_read_tokens) AS cache_read, SUM(e.cost_micros) AS cost_micros
      FROM token_events e JOIN mod_sessions s ON s.device_id = e.device_id AND s.session_id = e.session_id
      WHERE e.user_email = ?1 AND e.ts >= ?2 AND e.ts < ?3 GROUP BY s.project ORDER BY output DESC LIMIT 100`),
    // why sessions came without a project (the mod's word: off, no_repo, config_failed ...)
    all<{ note: string | null; n: number }>(`SELECT project_note AS note, COUNT(*) AS n FROM mod_sessions WHERE user_email = ?1 AND started_at >= ?2 AND started_at < ?3 AND project IS NULL GROUP BY note ORDER BY n DESC`),
  ])

  // context: the fullest each session got, how full a turn usually is
  const peak = new Map<string, number>()
  for (const t of turns) if (t.context_pct != null) peak.set(t.session_id, Math.max(peak.get(t.session_id) ?? 0, t.context_pct))
  const EDGES = [25, 50, 75, 90, 101]
  const contextHist = EDGES.map((hi, i) => ({ lo: i ? EDGES[i - 1] : 0, hi: Math.min(hi, 100), n: 0 }))
  for (const v of peak.values()) contextHist.find(x => v < x.hi || x.hi === 100)!.n++
  const context = { turn: stat(turns.flatMap(t => (t.context_pct == null ? [] : [t.context_pct]))), sessions: peak.size, over90: [...peak.values()].filter(v => v >= 90).length, hist: contextHist }

  // time: how long a turn takes from the prompt to the answer, and the pause before a prompt (a break when longer than IDLE_MS)
  const thinks = turns.flatMap(t => (t.think_ms == null ? [] : [t.think_ms]))
  const wallSum = turns.reduce((s, t) => s + t.wall_ms, 0)
  const time = {
    wall: stat(turns.map(t => t.wall_ms)), think: stat(thinks.filter(x => x <= IDLE_MS)), breaks: thinks.filter(x => x > IDLE_MS).length,
    wallSum, thinkSum: thinks.filter(x => x <= IDLE_MS).reduce((s, x) => s + x, 0), idleMs: IDLE_MS,
    outcomes: Object.entries(turns.reduce<Record<string, number>>((m, t) => ((m[t.outcome] = (m[t.outcome] ?? 0) + 1), m), {})).map(([outcome, n]) => ({ outcome, n })),
  }

  // sessions: how long they last (to the end, else to the last turn), how they end, how many a day
  const lengths = sessions.flatMap(s => { const end = s.ended_at ?? s.last_turn; return end ? [Math.max(0, Date.parse(end) - Date.parse(s.started_at))] : [] })
  const reasons = Object.entries(sessions.reduce<Record<string, number>>((m, s) => { const k = s.end_reason ?? (s.ended_at ? 'other' : 'open'); m[k] = (m[k] ?? 0) + 1; return m }, {})).map(([reason, n]) => ({ reason, n })).sort((x, y) => y.n - x.n)
  const sessionStats = { count: sessions.length, length: stat(lengths), turns: stat(sessions.map(s => s.turns)), reasons }

  // permissions: how often the agent waited for an answer, how often it was told no, how long it waited (prompt to the tool's end)
  const asks = turns.reduce((s, t) => s + t.perm_asks, 0)
  const permissions = { asks, denied: turns.reduce((s, t) => s + t.perm_denied, 0), waitMs: turns.reduce((s, t) => s + t.perm_wait_ms, 0), turnsWithAsks: turns.filter(t => t.perm_asks > 0).length }

  // by day: turns, the median turn length, the median context fill, the permission prompts
  const days = new Map<string, TurnRow[]>()
  for (const t of turns) { const d = t.ts.slice(0, 10); days.set(d, [...(days.get(d) ?? []), t]) }
  const daily = [...days].map(([day, ts]) => ({
    day, turns: ts.length, wall_p50: stat(ts.map(t => t.wall_ms)).p50,
    context_p50: stat(ts.flatMap(t => (t.context_pct == null ? [] : [t.context_pct]))).p50, asks: ts.reduce((s, t) => s + t.perm_asks, 0),
  }))

  return json({ available: turns.length > 0 || sessions.length > 0, context, time, sessions: sessionStats, permissions, daily, projects, projectNotes: notes })
}
