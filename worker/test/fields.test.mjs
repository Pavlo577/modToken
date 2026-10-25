// The registry of OTLP fields (src/otlp-fields.ts) is not a wish list: what it says the Worker does with a field is checked against the code.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EVENT_NAMES, FIELDS, FIELD_KEYS, fieldsMarkdown } from '../src/otlp-fields.ts'
import { parseOtlpLogs, safeAttrs } from '../src/otlp.ts'

const s = (key, v) => ({ key, value: { stringValue: v } })
const i = (key, v) => ({ key, value: { intValue: String(v) } })

test('fields: no field is listed twice and each has events, a meaning and a known handling', () => {
  assert.equal(FIELD_KEYS.size, FIELDS.length)
  for (const x of FIELDS) {
    assert.ok(x.events.length > 0 && x.what.length > 3, x.key)
    assert.ok(['counted', 'column', 'stored', 'identity', 'content'].includes(x.handling), x.key)
  }
  assert.ok(EVENT_NAMES.includes('api_request') && EVENT_NAMES.includes('tool_result'))
})

test('fields: what the registry says is kept or dropped is what safeAttrs does', () => {
  for (const x of FIELDS) {
    const kept = Object.keys(safeAttrs(new Map([[x.key, 5]])))
    if (x.handling === 'stored' || x.handling === 'counted') assert.ok(kept.some(k => k.replace(/[^\w.:-]/g, '') === x.key), `${x.key} should be kept`)
    else assert.deepEqual(kept, [], `${x.key} (${x.handling}) must not be kept as an attribute`)
  }
})

test('fields: identity and content fields never survive, even with a harmless value', () => {
  for (const x of FIELDS.filter(f => f.handling === 'identity' || f.handling === 'content')) {
    assert.deepEqual(safeAttrs(new Map([[x.key, 'abc']])), {}, x.key)
    assert.deepEqual(safeAttrs(new Map([[x.key, 12]])), {}, x.key)
  }
})

test('fields: the counted fields of api_request are the ones the counting really reads', () => {
  const rec = {
    timeUnixNano: '1761300000000000000',
    attributes: [s('event.name', 'api_request'), s('session.id', 'S'), s('prompt.id', 'P'), s('request_id', 'REQ'), s('model', 'M'), i('input_tokens', 11), i('output_tokens', 22),
      i('cache_read_tokens', 33), i('cache_creation_tokens', 44), i('duration_ms', 55), i('cost_usd_micros', 66), s('agent_id', 'A')],
  }
  const [c] = parseOtlpLogs({ resourceLogs: [{ resource: { attributes: [s('service.name', 'claude-code')] }, scopeLogs: [{ logRecords: [rec] }] }] }).calls
  assert.deepEqual([c.input_tokens, c.output_tokens, c.cache_read_tokens, c.cache_creation_tokens, c.duration_ms, c.cost_micros, c.model, c.call_id, c.is_subagent], [11, 22, 33, 44, 55, 66, 'M', 'REQ', true])
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'duration_ms', 'cost_usd_micros', 'cost_usd', 'model', 'request_id', 'agent_id', 'query_source']) {
    assert.equal(FIELDS.find(x => x.key === key)?.handling, 'counted', key)
  }
})

test('fields: a request whose query_source is subagent is a sub-agent call, a main-thread one is not', () => {
  const call = qs => parseOtlpLogs({ resourceLogs: [{ resource: { attributes: [s('service.name', 'claude-code')] }, scopeLogs: [{ logRecords: [{ timeUnixNano: '1761300000000000000', attributes: [s('event.name', 'api_request'), s('request_id', 'R' + qs), i('input_tokens', 1), i('output_tokens', 1), s('query_source', qs)] }] }] }] }).calls[0]
  assert.equal(call('subagent').is_subagent, true)
  assert.equal(call('repl_main_thread').is_subagent, false)
})

test('fields: the keys that only appear with tool details on are never stored, even with a harmless value', () => {
  for (const key of ['server_name', 'hook_matcher', 'hook_definitions', 'managed_settings.helper.path', 'tool_parameters', 'tool_input', 'error']) assert.deepEqual(safeAttrs(new Map([[key, 'abc']])), {}, key)
})

test('fields: docs/OTLP-fields.md is the generated one (run: bun run fields)', () => {
  assert.equal(readFileSync(new URL('../../docs/OTLP-fields.md', import.meta.url), 'utf8'), fieldsMarkdown())
})
