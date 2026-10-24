import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_LIMITS, ROW_KEYS, sanitizeLimit, sanitizeRow } from '../../collectors/lib/contract.mjs'
import { createCodexParser } from '../public/admin/parse-codex.mjs'

const good = { provider: 'codex', turn_id: 'codex:t:1', session_id: 't', ts: '2026-10-24T10:00:00Z', model: 'gpt-5-codex', input_tokens: 10, output_tokens: 5, cache_read_tokens: 3, cache_creation_tokens: 0, duration_ms: 99, is_subagent: false }

test('contract: only the listed fields go out, typed like the Worker types them', () => {
  const r = sanitizeRow({ ...good, text: 'SECRET PROMPT', cwd: '/secret', 'input-messages': ['SECRET'], extra: { a: 1 }, input_tokens: -4, output_tokens: 'x', duration_ms: 12.9 })
  assert.deepEqual(Object.keys(r).sort(), [...ROW_KEYS].sort())
  assert.equal(JSON.stringify(r).includes('SECRET'), false)
  assert.deepEqual([r.input_tokens, r.output_tokens, r.duration_ms], [0, 0, 12])
  assert.equal(r.ts, '2026-10-24T10:00:00.000Z')
  assert.equal(sanitizeRow({ ...good, turn_id: 'x'.repeat(500) }).turn_id.length, 200)
})

test('contract: a row that cannot be a turn is dropped, a missing provider is claude', () => {
  assert.equal(sanitizeRow({ ...good, ts: 'not a date' }), null)
  assert.equal(sanitizeRow({ ...good, provider: 'skynet' }), null)
  assert.equal(sanitizeRow({ ...good, turn_id: '' }), null)
  assert.equal(sanitizeRow(null), null)
  const { provider, ...noProvider } = good
  assert.equal(sanitizeRow(noProvider).provider, 'claude')
})

test('contract: limits keep their four fields; unknown windows and junk are dropped', () => {
  assert.deepEqual(sanitizeLimit({ provider: 'codex', kind: 'five_hour', percentUsed: 12.5, resetsAt: '2026-10-24T15:00:00Z', plan: 'plus' }), { provider: 'codex', kind: 'five_hour', percentUsed: 12.5, resetsAt: '2026-10-24T15:00:00.000Z' })
  assert.equal(sanitizeLimit({ provider: 'codex', kind: 'monthly', percentUsed: 1 }), null)
  assert.equal(sanitizeLimit({ provider: 'codex', kind: 'seven_day', percentUsed: 'many' }), null)
  assert.equal(sanitizeLimit({ provider: 'codex', kind: 'seven_day', percentUsed: 5000, resetsAt: 'soon' }).percentUsed, 1000)
  assert.equal(sanitizeLimit({ provider: 'codex', kind: 'seven_day', percentUsed: 5, resetsAt: 'soon' }).resetsAt, '')
  assert.ok(MAX_LIMITS <= 8)
})

test('contract: what the Codex parser produces already is exactly a TurnRow (nothing is lost, nothing is added)', () => {
  const p = createCodexParser('f')
  const u = (i, c, o) => ({ input_tokens: i, cached_input_tokens: c, cache_write_input_tokens: 0, output_tokens: o, reasoning_output_tokens: 0, total_tokens: i + o })
  for (const l of [
    { timestamp: '2026-10-24T10:00:00Z', type: 'session_meta', payload: { id: 'th1', timestamp: '2026-10-24T10:00:00Z', cwd: '/secret' } },
    { timestamp: '2026-10-24T10:00:01Z', type: 'turn_context', payload: { turn_id: 'tA', model: 'gpt-5-codex' } },
    { timestamp: '2026-10-24T10:00:05Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: u(1000, 800, 50), last_token_usage: u(1000, 800, 50) } } },
  ]) p.push(JSON.stringify(l))
  const { turns } = p.finish()
  assert.equal(turns.length, 1)
  assert.deepEqual(sanitizeRow(turns[0]), { ...turns[0], ts: new Date(turns[0].ts).toISOString() })
  assert.deepEqual([turns[0].input_tokens, turns[0].cache_read_tokens, turns[0].output_tokens], [200, 800, 50])
})
