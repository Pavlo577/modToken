// The OTLP side of the Worker: how a payload becomes ModelCalls (src/otlp.ts, pure). The receiver itself is checked end to end in otlp.sh.
import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_RECORDS, parseOtlpLogs } from '../src/otlp.ts'

const s = (key, v) => ({ key, value: { stringValue: v } })
const i = (key, v) => ({ key, value: { intValue: String(v) } }) // OTLP/JSON: an int64 is a string
const record = (extra = [], ns = '1761300000123456789') => ({
  timeUnixNano: ns,
  attributes: [s('event.name', 'claude_code.api_request'), s('session.id', 'sess-1'), s('prompt.id', 'prompt-1'), s('request_id', 'req_1'), s('model', 'claude-sonnet-x'),
    i('input_tokens', 86013), i('output_tokens', 5189), i('cache_read_tokens', 467328), i('cache_creation_tokens', 0), i('duration_ms', 10243), ...extra],
})
const payload = (records, service = 'claude-code') => ({ resourceLogs: [{ resource: { attributes: [s('service.name', service)] }, scopeLogs: [{ logRecords: records }] }] })

test('otlp: a Claude Code api_request becomes one ModelCall with the numbers of the call', () => {
  const { calls, ignored } = parseOtlpLogs(payload([record()]))
  assert.equal(ignored, 0)
  assert.deepEqual(calls, [{
    provider: 'claude', call_id: 'req_1', session_id: 'sess-1', turn_key: 'prompt-1', ts: '2025-10-24T10:00:00.123Z', model: 'claude-sonnet-x',
    input_tokens: 86013, output_tokens: 5189, cache_read_tokens: 467328, cache_creation_tokens: 0, duration_ms: 10243, is_subagent: false,
  }])
})

test('otlp: nothing outside the structure survives (emails, account ids, prompts, tool details, cost)', () => {
  const noisy = record([s('user.email', 'me@example.com'), s('user.account_uuid', 'uuid-1'), s('organization.id', 'org-1'), s('prompt', 'SECRET PROMPT'), s('tool_parameters', 'SECRET'), { key: 'cost_usd', value: { doubleValue: 0.5 } }])
  const { calls } = parseOtlpLogs(payload([noisy]))
  const text = JSON.stringify(calls)
  for (const bad of ['me@example.com', 'uuid-1', 'org-1', 'SECRET', 'cost']) assert.equal(text.includes(bad), false, bad)
  assert.deepEqual(Object.keys(calls[0]).sort(), ['cache_creation_tokens', 'cache_read_tokens', 'call_id', 'duration_ms', 'input_tokens', 'is_subagent', 'model', 'output_tokens', 'provider', 'session_id', 'ts', 'turn_key'])
})

test('otlp: the event name is accepted with or without its prefix, in an attribute or in the body; other events are ignored', () => {
  const bare = { ...record(), attributes: record().attributes.map(a => (a.key === 'event.name' ? s('event.name', 'api_request') : a)) }
  const inBody = { timeUnixNano: '1761300000000000000', body: { stringValue: 'claude_code.api_request' }, attributes: record().attributes.filter(a => a.key !== 'event.name') }
  const prompt = { timeUnixNano: '1761300000000000000', attributes: [s('event.name', 'claude_code.user_prompt'), s('session.id', 'sess-1'), s('prompt', 'SECRET')] }
  const r = parseOtlpLogs(payload([bare, inBody, prompt]))
  assert.equal(r.calls.length, 2); assert.equal(r.ignored, 1)
})

test('otlp: ids and times fall back when the exporter leaves a field out', () => {
  const noRequest = { timeUnixNano: '1761300000000000000', attributes: record().attributes.filter(a => !['request_id', 'prompt.id'].includes(a.key)).concat(i('event.sequence', 7)) }
  const [c] = parseOtlpLogs(payload([noRequest])).calls
  assert.equal(c.call_id, 'sess-1:1761300000000000000:7')
  assert.equal(c.turn_key, c.call_id, 'without prompt.id every call is a turn of its own')
  const byAttr = { attributes: record().attributes.concat(s('event.timestamp', '2026-10-24T12:00:00.000Z')) } // no timeUnixNano
  assert.equal(parseOtlpLogs(payload([byAttr])).calls[0].ts, '2026-10-24T12:00:00.000Z')
  assert.equal(parseOtlpLogs(payload([{ attributes: record().attributes }])).calls.length, 0, 'no time at all: not a call')
})

test('otlp: a request that cost nothing, negative or fractional numbers, other services and empty payloads', () => {
  const zero = record().attributes.map(a => (/_tokens$/.test(a.key) ? i(a.key, 0) : a))
  assert.equal(parseOtlpLogs(payload([{ timeUnixNano: '1761300000000000000', attributes: zero }])).calls.length, 0)
  const odd = record([]); odd.attributes = odd.attributes.map(a => (a.key === 'output_tokens' ? { key: 'output_tokens', value: { intValue: '-5' } } : a.key === 'duration_ms' ? { key: 'duration_ms', value: { doubleValue: 12.9 } } : a))
  const [c] = parseOtlpLogs(payload([odd])).calls
  assert.deepEqual([c.output_tokens, c.duration_ms], [0, 12])
  assert.deepEqual(parseOtlpLogs(payload([record()], 'some-other-agent')), { calls: [], ignored: 1, seen: [{ service: 'some-other-agent', event: 'claude_code.api_request', lens: '', keys: 'cache_creation_tokens,cache_read_tokens,duration_ms,event.name,input_tokens,model,output_tokens,prompt.id,request_id,session.id', n: 1 }] })
  assert.deepEqual(parseOtlpLogs({ resourceLogs: [] }), { calls: [], ignored: 0, seen: [] })
  for (const bad of [null, 5, 'x', {}, { resourceLogs: 'no' }]) assert.equal(parseOtlpLogs(bad), null)
})

test('otlp: a payload with more records than the limit is refused as a whole', () => {
  assert.equal(parseOtlpLogs(payload(Array.from({ length: MAX_RECORDS + 1 }, () => record()))), null)
  assert.notEqual(parseOtlpLogs(payload(Array.from({ length: MAX_RECORDS }, () => record()))), null)
})

test('otlp: a call with agent_id is a sub-agent call, one without is the main session', () => {
  const [main] = parseOtlpLogs(payload([record()])).calls
  const [sub] = parseOtlpLogs(payload([record([s('agent_id', 'agent-1'), s('parent_agent_id', 'main')])])).calls
  assert.equal(main.is_subagent, false); assert.equal(sub.is_subagent, true)
})

test('otlp: what was not recognised is reported by NAMES only, never by value', () => {
  const rec = { timeUnixNano: '1761300000000000000', attributes: [s('event.name', 'claude_code.user_prompt'), s('prompt', 'SECRET PROMPT'), s('user.email', 'me@example.com'), i('prompt_length', 5)] }
  const { seen } = parseOtlpLogs(payload([rec, rec]))
  assert.equal(seen.length, 1); assert.equal(seen[0].n, 2); assert.equal(seen[0].event, 'claude_code.user_prompt')
  for (const bad of ['SECRET', 'me@example.com']) assert.equal(JSON.stringify(seen).includes(bad), false, bad)
  assert.ok(seen[0].keys.includes('prompt_length') && seen[0].keys.includes('user.email'), 'attribute names are listed')
})

test('otlp: the Claude app (service claude-code-desktop) is Claude Code too; the extra attributes it sends are not kept', () => {
  const extra = [s('claude.deployment_mode', 'desktop'), i('cache_creation_1h_tokens', 5), i('cache_creation_5m_tokens', 7), s('response', 'SECRET ANSWER'), s('prompt_text', 'SECRET PROMPT'), s('terminal.type', 'x')]
  const { calls } = parseOtlpLogs(payload([record(extra)], 'claude-code-desktop'))
  assert.equal(calls.length, 1); assert.equal(calls[0].provider, 'claude'); assert.equal(calls[0].input_tokens, 86013)
  assert.equal(JSON.stringify(calls).includes('SECRET'), false)
  assert.equal(parseOtlpLogs(payload([record()], 'claude-codex-fake')).calls.length, 1, 'any claude-code* name')
  assert.equal(parseOtlpLogs(payload([record()], 'codex')).calls.length, 0)
})

test('otlp: for conversation text only the length is reported, and whether it looks redacted', () => {
  const rec = { timeUnixNano: '1761300000000000000', attributes: [s('event.name', 'claude_code.user_prompt'), s('prompt', 'SECRET PROMPT'), s('prompt_text', '[REDACTED]'), s('response', '')] }
  const { seen } = parseOtlpLogs(payload([rec]))
  assert.equal(seen[0].lens, 'prompt=13,prompt_text=10R,response=0')
  assert.equal(JSON.stringify(seen).includes('SECRET'), false)
})
