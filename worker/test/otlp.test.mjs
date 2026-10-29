// The OTLP side of the Worker: how a payload becomes ModelCalls (src/otlp.ts, pure). The receiver itself is checked end to end in otlp.sh.
import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_RECORDS, parseOtlpLogs, safeAttrs, sampleOf } from '../src/otlp.ts'

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
    input_tokens: 86013, output_tokens: 5189, cache_read_tokens: 467328, cache_creation_tokens: 0, duration_ms: 10243, cost_micros: 0, is_subagent: false, kind: 'main',
  }])
})

test('otlp: nothing outside the structure survives (emails, account ids, prompts, tool details, cost)', () => {
  const noisy = record([s('user.email', 'me@example.com'), s('user.account_uuid', 'uuid-1'), s('organization.id', 'org-1'), s('prompt', 'SECRET PROMPT'), s('tool_parameters', 'SECRET'), { key: 'cost_usd', value: { doubleValue: 0.5 } }])
  const { calls } = parseOtlpLogs(payload([noisy]))
  const text = JSON.stringify(calls)
  for (const bad of ['me@example.com', 'uuid-1', 'org-1', 'SECRET', 'cost_usd']) assert.equal(text.includes(bad), false, bad)
  assert.deepEqual(Object.keys(calls[0]).sort(), ['cache_creation_tokens', 'cache_read_tokens', 'call_id', 'cost_micros', 'duration_ms', 'input_tokens', 'is_subagent', 'kind', 'model', 'output_tokens', 'provider', 'session_id', 'ts', 'turn_key'])
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
  assert.deepEqual(parseOtlpLogs(payload([record()], 'some-other-agent')), { calls: [], ignored: 1, events: [], seen: [{ service: 'some-other-agent', event: 'claude_code.api_request', lens: '', sample: parseOtlpLogs(payload([record()], 'some-other-agent')).seen[0].sample, keys: 'cache_creation_tokens,cache_read_tokens,duration_ms,event.name,input_tokens,model,output_tokens,prompt.id,request_id,session.id', n: 1 }] })
  assert.deepEqual(parseOtlpLogs({ resourceLogs: [] }), { calls: [], ignored: 0, events: [], seen: [] })
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

test('otlp: a sample shows harmless values and only the length of identity, conversation and prose values', () => {
  const rec = { timeUnixNano: '1761300000000000000', attributes: [s('event.name', 'claude_code.user_prompt'), s('model', 'claude-sonnet-5-5'), s('user.email', 'me@example.com'), s('organization.id', 'org-secret'),
    s('prompt', 'SECRET PROMPT'), s('summary', 'some secret sentence with spaces'), s('tool_name', 'Bash'), i('prompt_length', 5)] }
  const sample = JSON.parse(parseOtlpLogs(payload([rec])).seen[0].sample)
  assert.equal(sample.model, 'claude-sonnet-5-5'); assert.equal(sample.tool_name, 'Bash'); assert.equal(sample.prompt_length, 5)
  assert.equal(sample['user.email'], '<masked:14>'); assert.equal(sample.prompt, '<masked:13>'); assert.equal(sample.summary, '<text:32>')
  const raw = JSON.stringify(sample)
  for (const bad of ['me@example.com', 'org-secret', 'SECRET', 'secret sentence']) assert.equal(raw.includes(bad), false, bad)
})

test('otlp: recognised calls are sampled too, but only when asked (the preview debug mode)', () => {
  assert.equal(parseOtlpLogs(payload([record()])).seen.length, 0)
  const { seen, calls } = parseOtlpLogs(payload([record()]), true)
  assert.equal(calls.length, 1); assert.equal(seen.length, 1); assert.equal(seen[0].event, 'claude_code.api_request')
})

test('otlp: the raw debug mode keeps the values (temporary, preview only); the default never does', () => {
  const rec = { timeUnixNano: '1761300000000000000', attributes: [s('event.name', 'x_event'), s('user.email', 'me@example.com')] }
  assert.ok(parseOtlpLogs(payload([rec]), 'raw').seen[0].sample.includes('me@example.com'))
  assert.equal(parseOtlpLogs(payload([rec]), true).seen[0].sample.includes('me@example.com'), false)
  assert.equal(parseOtlpLogs(payload([rec])).seen[0].sample.includes('me@example.com'), false)
})

test('otlp: the cost the agent states is kept per call (micros, or dollars converted)', () => {
  assert.equal(parseOtlpLogs(payload([record([i('cost_usd_micros', 168820)])])).calls[0].cost_micros, 168820)
  assert.equal(parseOtlpLogs(payload([record([{ key: 'cost_usd', value: { doubleValue: 0.5 } }])])).calls[0].cost_micros, 500000)
  assert.equal(parseOtlpLogs(payload([record()])).calls[0].cost_micros, 0)
})

test('events: every record of a known service is kept, with time, name, session, prompt and surface as columns', () => {
  const tool = { timeUnixNano: '1761300000000000000', attributes: [s('event.name', 'claude_code.tool_result'), s('session.id', 'sess-1'), s('prompt.id', 'p-1'), s('terminal.type', 'pycharm'), i('event.sequence', 7), s('tool_name', 'Bash'), s('duration_ms', '1227'), s('success', 'true')] }
  const { events } = parseOtlpLogs(payload([record(), tool]))
  assert.equal(events.length, 2)
  const e = events.find(x => x.name === 'tool_result')
  assert.deepEqual({ ts: e.ts, session_id: e.session_id, prompt_id: e.prompt_id, surface: e.surface, service: e.service }, { ts: '2025-10-24T10:00:00.000Z', session_id: 'sess-1', prompt_id: 'p-1', surface: 'pycharm', service: 'claude-code' })
  assert.deepEqual(JSON.parse(e.attrs), { 'event.sequence': 7, duration_ms: 1227, success: 'true', tool_name: 'Bash' }, 'numbers that arrive as strings become numbers')
  assert.equal(events.find(x => x.name === 'api_request').dedupe.startsWith('sess-1|api_request|'), true)
  assert.equal(parseOtlpLogs(payload([tool], 'some-other-agent')).events.length, 0, 'an unknown service is not stored')
})

test('events: identity, conversation text, prose and addresses never reach the stored attributes', () => {
  const a = new Map(Object.entries({
    'user.email': 'me@example.com', 'user.id': 'abc', 'user.account_uuid': 'u', organization_id: 'x', 'organization.id': 'org-1', 'process.owner': 'IOOOI',
    prompt: 'SECRET PROMPT', response: 'SECRET ANSWER', prompt_text: 'SECRET', tool_input: 'SECRET', error: 'SECRET failure',
    summary: 'some secret sentence with spaces', contact: 'someone@example.com', path: 'C:\\Users\\me\\file.txt', note: 'x'.repeat(100),
    tool_name: 'Bash', duration_ms: 12, ok: true, ttft: '1500', model: 'claude-sonnet-5',
  }))
  const out = safeAttrs(a)
  assert.deepEqual(out, { duration_ms: 12, model: 'claude-sonnet-5', ok: true, organization_id: 'x', tool_name: 'Bash', ttft: 1500 })
  assert.equal(JSON.stringify(out).includes('SECRET'), false)
})

test('otlp: a sub-agent and a background request get turn rows of their own, by model; the prompt stays one turn', () => {
  const src = (v) => s('query_source', v)
  const { calls } = parseOtlpLogs(payload([
    record([src('sdk')]), record([src('agent:builtin:general-purpose'), s('model', 'claude-haiku-x'), s('request_id', 'req_2')]),
    record([src('prompt_suggestion'), s('request_id', 'req_3')]), record([src('repl_main_thread'), s('request_id', 'req_4')]),
    record([src('subagent'), s('request_id', 'req_5')]), record([s('agent_id', 'a1'), s('request_id', 'req_6')]),
  ]))
  assert.deepEqual(calls.map(c => [c.kind, c.is_subagent, c.turn_key]), [
    ['main', false, 'prompt-1'], ['sub', true, 'prompt-1:sub:claude-haiku-x'], ['bg', false, 'prompt-1:bg:claude-sonnet-x'],
    ['main', false, 'prompt-1'], ['sub', true, 'prompt-1:sub:claude-sonnet-x'], ['sub', true, 'prompt-1:sub:claude-sonnet-x'],
  ])
})

// ---- Codex (openai/codex, codex-rs/otel): a synthetic payload, built from its source, until a real one is captured
const codexRec = (name, extra = [], ns = '1761300000123456789') => ({
  timeUnixNano: ns,
  attributes: [s('event.name', name), s('conversation.id', 'conv-1'), s('model', 'gpt-5.1-codex'), s('app.version', '0.50.0'), s('originator', 'codex_cli_rs'),
    s('user.email', 'me@example.com'), s('user.account_id', 'acct-SECRET'), ...extra],
})
const completed = (extra = [], ns) => codexRec('codex.sse_event', [s('event.kind', 'response.completed'), i('input_token_count', 12000), i('cached_token_count', 9000),
  i('cache_write_token_count', 0), i('output_token_count', 700), i('reasoning_token_count', 300), i('tool_token_count', 12700), i('ttft_ms', 800), ...extra], ns)

test('otlp: a Codex response.completed becomes one step row, the cached input taken out of the input', () => {
  const { calls, ignored } = parseOtlpLogs(payload([completed()], 'codex_cli_rs'))
  assert.equal(ignored, 0)
  assert.deepEqual(calls, [{
    provider: 'codex', call_id: 'conv-1:call:1761300000123456789', session_id: 'conv-1', turn_key: 'conv-1:call:1761300000123456789', ts: '2025-10-24T10:00:00.123Z',
    model: 'gpt-5.1-codex', input_tokens: 3000, output_tokens: 700, cache_read_tokens: 9000, cache_creation_tokens: 0, duration_ms: 0, cost_micros: 0, is_subagent: false, kind: 'step',
  }])
})

test('otlp: a Codex user prompt is the turn: a main row with no tokens and none of its text', () => {
  const { calls } = parseOtlpLogs(payload([codexRec('codex.user_prompt', [s('prompt', 'SECRET PROMPT'), i('prompt_length', 13)])], 'codex_exec'))
  assert.equal(calls.length, 1)
  assert.deepEqual([calls[0].provider, calls[0].kind, calls[0].session_id, calls[0].input_tokens + calls[0].output_tokens], ['codex', 'main', 'conv-1', 0])
})

test('otlp: Codex events without tokens, other SSE kinds and records without a conversation are not calls; nothing secret survives', () => {
  const r = parseOtlpLogs(payload([
    codexRec('codex.sse_event', [s('event.kind', 'response.output_text.delta')]),
    codexRec('codex.tool_result', [s('tool_name', 'shell'), s('arguments', 'cat SECRET-FILE'), s('output', 'SECRET OUTPUT'), s('call_id', 'call_1'), s('mcp_server', 'SECRET-SRV'), s('mcp_server_origin', 'https://SECRET.example/mcp'), { key: 'success', value: { boolValue: true } }]),
    codexRec('codex.api_request', [s('error.message', 'SECRET ERROR'), i('attempt', 1)]),
    { timeUnixNano: '1761300000000000000', attributes: [s('event.name', 'codex.sse_event'), s('event.kind', 'response.completed'), i('input_token_count', 5)] },
    completed([], '1761300000999999999'),
  ], 'codex_cli_rs'))
  assert.equal(r.calls.length, 1)
  assert.equal(r.ignored, 4)
  const text = JSON.stringify(r)
  for (const bad of ['me@example.com', 'acct-SECRET', 'SECRET-FILE', 'SECRET OUTPUT', 'SECRET ERROR', 'SECRET-SRV', 'SECRET.example']) assert.equal(text.includes(bad), false, bad)
  const tool = r.events.find(e => e.name === 'codex.tool_result')
  assert.equal(tool.session_id, 'conv-1')
  assert.deepEqual(Object.keys(JSON.parse(tool.attrs)).sort(), ['app.version', 'call_id', 'model', 'originator', 'success', 'tool_name'])
})

test('otlp: a Codex call whose cached count exceeds its input never goes negative', () => {
  const [c] = parseOtlpLogs(payload([completed([i('input_token_count', 100), i('cached_token_count', 150)])], 'codex_cli_rs')).calls
  assert.equal(c.input_tokens, 0)
})

test('otlp: Codex writes input and output counts as strings of digits (a real Codex Desktop payload): they are counted', () => {
  // codex-app-server / Codex_Desktop 0.146: input_token_count and output_token_count arrive as stringValue, the cached count as intValue
  const rec = codexRec('codex.sse_event', [s('event.kind', 'response.completed'), s('input_token_count', '25940'), i('cached_token_count', 25728), i('cache_write_token_count', 0),
    s('output_token_count', '115'), i('reasoning_token_count', 7), s('tool_token_count', '26055')])
  const [c] = parseOtlpLogs(payload([rec], 'codex-app-server')).calls
  assert.deepEqual([c.input_tokens, c.output_tokens, c.cache_read_tokens], [212, 115, 25728])
  // no cache at all: still a call (it was dropped as empty while the strings were not read)
  const cold = codexRec('codex.sse_event', [s('event.kind', 'response.completed'), s('input_token_count', '7245'), i('cached_token_count', 0), s('output_token_count', '0')], '1761300000999000000')
  assert.equal(parseOtlpLogs(payload([cold], 'codex-app-server')).calls[0].input_tokens, 7245)
  // a word is not a number
  assert.equal(parseOtlpLogs(payload([codexRec('codex.sse_event', [s('event.kind', 'response.completed'), s('input_token_count', '12 tokens'), i('cached_token_count', 1)])], 'codex-app-server')).calls[0].input_tokens, 0)
})
