import test from 'node:test'
import assert from 'node:assert/strict'
import { createCodexParser } from '../public/admin/parse-codex.mjs'

const meta = (ts, extra = {}) => JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { id: 'th1', timestamp: ts, cwd: '/p', ...extra } })
const ctx = (ts, turn, model = 'gpt-5-codex') => JSON.stringify({ timestamp: ts, type: 'turn_context', payload: { turn_id: turn, model, cwd: '/p' } })
const u = (input, cached, output, reasoning = 0, cw = 0) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: cw, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output })
const count = (ts, total, last, rate_limits = null) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last, model_context_window: 258400 }, rate_limits } })
const run = lines => { const p = createCodexParser('f'); for (const l of lines) p.push(l); return p.finish() }

test('one turn with two model calls: the totals grow, input excludes the cached part', () => {
  const { turns } = run([
    meta('2026-10-24T10:00:00Z'), ctx('2026-10-24T10:00:01Z', 't1'),
    count('2026-10-24T10:00:05Z', u(1000, 800, 50, 20), u(1000, 800, 50, 20)),
    count('2026-10-24T10:00:20Z', u(3000, 2500, 120, 60), u(2000, 1700, 70, 40)),
  ])
  assert.equal(turns.length, 1)
  const t = turns[0]
  assert.equal(t.provider, 'codex')
  assert.equal(t.turn_id, 'codex:th1:t1')
  assert.equal(t.session_id, 'th1')
  assert.equal(t.input_tokens, 500) // 3000 - 2500
  assert.equal(t.cache_read_tokens, 2500)
  assert.equal(t.output_tokens, 120) // reasoning is part of it, not added
  assert.equal(t.cache_creation_tokens, 0)
  assert.equal(t.model, 'gpt-5-codex')
  assert.equal(t.ts, '2026-10-24T10:00:20.000Z')
  assert.equal(t.duration_ms, 19000)
  assert.equal(t.is_subagent, false)
})

test('a token_count that only carries new rate limits is not counted twice', () => {
  const total = u(1000, 800, 50)
  const { turns } = run([
    meta('2026-10-24T10:00:00Z'), ctx('2026-10-24T10:00:01Z', 't1'),
    count('2026-10-24T10:00:05Z', total, total),
    count('2026-10-24T10:00:06Z', total, total, { primary: { used_percent: 10, window_minutes: 300, resets_at: 1792840000 } }),
    count('2026-10-24T10:00:07Z', total, total),
  ])
  assert.equal(turns[0].output_tokens, 50)
  assert.equal(turns[0].cache_read_tokens, 800)
})

test('cache writes are their own part of the input', () => {
  const { turns } = run([meta('2026-10-24T10:00:00Z'), ctx('2026-10-24T10:00:01Z', 't1'), count('2026-10-24T10:00:05Z', u(1000, 600, 10, 0, 300), u(1000, 600, 10, 0, 300))])
  assert.equal(turns[0].input_tokens, 100)
  assert.equal(turns[0].cache_read_tokens, 600)
  assert.equal(turns[0].cache_creation_tokens, 300)
})

test('a fork replays its parent history (older stamps): only new growth counts', () => {
  const { turns } = run([
    meta('2026-10-24T12:00:00Z', { forked_from_id: 'parent' }),
    ctx('2026-10-24T10:00:01Z', 'p1'),
    count('2026-10-24T10:00:05Z', u(1000, 800, 50), u(1000, 800, 50)), // replay
    count('2026-10-24T10:00:20Z', u(3000, 2500, 120), u(2000, 1700, 70)), // replay
    ctx('2026-10-24T12:00:30Z', 'c1'),
    count('2026-10-24T12:00:40Z', u(3500, 2900, 150), u(500, 400, 30)),
  ])
  assert.equal(turns.length, 1)
  assert.equal(turns[0].turn_id, 'codex:th1:c1')
  assert.equal(turns[0].output_tokens, 30)
  assert.equal(turns[0].cache_read_tokens, 400)
  assert.equal(turns[0].is_subagent, false)
})

test('a resumed file without replay: the first event counts only its last request', () => {
  const { turns } = run([meta('2026-10-24T12:00:00Z'), ctx('2026-10-24T12:00:01Z', 'r1'), count('2026-10-24T12:00:09Z', u(90000, 80000, 4000), u(2000, 1500, 100))])
  assert.equal(turns[0].output_tokens, 100)
  assert.equal(turns[0].cache_read_tokens, 1500)
  assert.equal(turns[0].input_tokens, 500)
})

test('totals that go down start over instead of subtracting', () => {
  const { turns } = run([
    meta('2026-10-24T10:00:00Z'), ctx('2026-10-24T10:00:01Z', 't1'),
    count('2026-10-24T10:00:05Z', u(5000, 4000, 200), u(5000, 4000, 200)),
    ctx('2026-10-24T10:01:00Z', 't2'),
    count('2026-10-24T10:01:05Z', u(300, 100, 40), u(300, 100, 40)),
  ])
  assert.deepEqual(turns.map(t => t.output_tokens), [200, 40])
})

test('several turns and a model change inside a session', () => {
  const { turns } = run([
    meta('2026-10-24T10:00:00Z'), ctx('2026-10-24T10:00:01Z', 't1', 'gpt-5'),
    count('2026-10-24T10:00:05Z', u(1000, 0, 100), u(1000, 0, 100)),
    ctx('2026-10-24T10:05:00Z', 't2', 'gpt-5-codex'),
    count('2026-10-24T10:05:09Z', u(2500, 500, 400), u(1500, 500, 300)),
  ])
  assert.deepEqual(turns.map(t => [t.model, t.output_tokens]), [['gpt-5', 100], ['gpt-5-codex', 300]])
})

test('turns without ids are told apart by the start-of-turn events', () => {
  const start = ts => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'task_started' } })
  const { turns } = run([
    meta('2026-10-24T10:00:00Z'),
    start('2026-10-24T10:00:01Z'), count('2026-10-24T10:00:05Z', u(100, 0, 10), u(100, 0, 10)),
    start('2026-10-24T10:02:00Z'), count('2026-10-24T10:02:05Z', u(250, 0, 30), u(150, 0, 20)),
  ])
  assert.equal(turns.length, 2)
  assert.deepEqual(turns.map(t => t.output_tokens), [10, 20])
})

test('rate limits become five_hour and seven_day readings, the newest wins', () => {
  const { limits } = run([
    meta('2026-10-24T10:00:00Z'), ctx('2026-10-24T10:00:01Z', 't1'),
    count('2026-10-24T10:00:05Z', u(10, 0, 1), u(10, 0, 1), { primary: { used_percent: 5, window_minutes: 300, resets_at: 1792840000 }, secondary: { used_percent: 9, window_minutes: 10080, resets_at: 1793300000 }, plan_type: 'plus' }),
    count('2026-10-24T10:10:05Z', u(20, 0, 2), u(10, 0, 1), { primary: { used_percent: 57, window_minutes: 300, resets_at: 1792840000 }, secondary: { used_percent: 63, window_minutes: 10080, resets_at: 1793300000 } }),
    count('2026-10-24T10:11:05Z', u(30, 0, 3), u(10, 0, 1), null),
  ])
  assert.deepEqual(limits.map(l => [l.provider, l.kind, l.percentUsed]), [['codex', 'five_hour', 57], ['codex', 'seven_day', 63]])
  assert.equal(limits[0].resetsAt, new Date(1792840000 * 1000).toISOString())
})

test('sub-agent threads are marked', () => {
  const { turns } = run([meta('2026-10-24T10:00:00Z', { parent_thread_id: 'p' }), ctx('2026-10-24T10:00:01Z', 't1'), count('2026-10-24T10:00:05Z', u(10, 0, 1), u(10, 0, 1))])
  assert.equal(turns[0].is_subagent, true)
})

test('no text from the rollout reaches the result; garbage and token_usage_record are ignored', () => {
  const secret = 'TOP SECRET PROMPT'
  const { turns, limits } = run([
    'not json', '{}', '[]',
    JSON.stringify({ timestamp: '2026-10-24T10:00:00Z', type: 'session_meta', payload: { id: 'th1', cwd: '/home/me/' + secret, instructions: secret } }),
    JSON.stringify({ timestamp: '2026-10-24T10:00:01Z', type: 'response_item', payload: { type: 'message', content: [{ type: 'output_text', text: secret }] } }),
    ctx('2026-10-24T10:00:02Z', 't1'),
    JSON.stringify({ timestamp: '2026-10-24T10:00:03Z', type: 'token_usage_record', payload: { response_id: 'r1', usage: u(999999, 0, 999999) } }),
    count('2026-10-24T10:00:05Z', u(10, 0, 1), u(10, 0, 1)),
  ])
  assert.equal(turns.length, 1)
  assert.equal(turns[0].output_tokens, 1)
  assert.ok(!JSON.stringify({ turns, limits }).includes(secret))
})

test('a file without any usage gives nothing', () => {
  assert.deepEqual(run([meta('2026-10-24T10:00:00Z'), ctx('2026-10-24T10:00:01Z', 't1')]), { turns: [], limits: [] })
})

test('real layout: task_started with an id, then a bare user_message, turn_context, token counts, task_complete with the duration', () => {
  const ev = (ts, payload) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload })
  const { turns } = run([
    JSON.stringify({ timestamp: '2026-10-24T10:35:17.640Z', type: 'session_meta', payload: { session_id: 'th1', id: 'th1', timestamp: '2026-10-24T10:35:17.640Z', cwd: '/p', source: 'vscode', thread_source: 'user', model_provider: 'openai' } }),
    ev('2026-10-24T10:36:05.917Z', { type: 'task_started', turn_id: 'tX', started_at: 1792838165 }),
    ev('2026-10-24T10:36:06.264Z', { type: 'user_message', message: 'hello' }),
    ctx('2026-10-24T10:36:06.300Z', 'tX', 'gpt-5.6-sol'),
    count('2026-10-24T10:36:18.424Z', u(17632, 11520, 147), u(17632, 11520, 147)),
    count('2026-10-24T10:37:52.122Z', u(553341, 467328, 5189, 356), u(90001, 81536, 3681, 40)),
    ev('2026-10-24T10:37:52.158Z', { type: 'task_complete', turn_id: 'tX', duration_ms: 106243 }),
  ])
  assert.equal(turns.length, 1)
  assert.equal(turns[0].turn_id, 'codex:th1:tX')
  assert.equal(turns[0].input_tokens, 86013)
  assert.equal(turns[0].cache_read_tokens, 467328)
  assert.equal(turns[0].output_tokens, 5189)
  assert.equal(turns[0].duration_ms, 106243)
  assert.equal(turns[0].model, 'gpt-5.6-sol')
  assert.equal(turns[0].is_subagent, false) // source "vscode" is a plain string
})
