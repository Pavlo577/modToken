// Token history from local logs: only numbers and ids survive, a streamed message counts once.
import test from 'node:test'
import assert from 'node:assert/strict'
import { addLogLine, parseClaudeLog } from '../src/history.ts'

const line = (o) => JSON.stringify(o)
const msg = (id, usage, extra = {}) => line({
  type: 'assistant', timestamp: '2026-10-20T10:00:00.000Z', sessionId: 'sess-1', isSidechain: false, cwd: '/home/SECRET_DIR', requestId: 'req_x',
  message: { id, model: 'claude-sonnet-x', role: 'assistant', content: [{ type: 'text', text: 'SECRET ANSWER' }], usage: { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, ...usage } },
  ...extra,
})

test('history: a message becomes one turn with its numbers and nothing else', () => {
  const t = parseClaudeLog(msg('msg_1', {}) + '\n' + line({ type: 'user', message: { content: 'SECRET PROMPT' } }) + '\n')
  assert.deepEqual([...t.values()], [{ id: 'msg_1', session: 'sess-1', ts: '2026-10-20T10:00:00.000Z', model: 'claude-sonnet-x', input: 2, output: 10, cache_read: 100, cache_creation: 5, sub: false, first: true, duration_ms: 0 }])
  const out = JSON.stringify([...t.values()])
  for (const bad of ['SECRET', 'req_x']) assert.equal(out.includes(bad), false, bad)
})

test('history: a message written several times while streaming counts once, with the largest numbers', () => {
  const t = parseClaudeLog([msg('msg_1', { output_tokens: 3 }), msg('msg_1', { output_tokens: 40 }, { timestamp: '2026-10-20T10:00:05.000Z' }), msg('msg_1', { output_tokens: 12 })].join('\n'))
  assert.equal(t.size, 1)
  const x = t.get('msg_1')
  assert.equal(x.output, 40); assert.equal(x.ts, '2026-10-20T10:00:05.000Z')
})

test('history: synthetic, empty, malformed and foreign lines are skipped; sidechain marks a sub-agent', () => {
  const acc = new Map()
  for (const l of ['not json "usage"', msg('msg_2', {}).replace('claude-sonnet-x', '<synthetic>'), msg('msg_3', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    msg('../bad id', {}), line({ type: 'user', usage: 1 }), msg('msg_4', {}, { isSidechain: true })]) addLogLine(acc, l)
  assert.deepEqual([...acc.keys()], ['msg_4'])
  assert.equal(acc.get('msg_4').sub, true)
})

test('history: the mod parses the logs with the same code as the dashboard (a copy of src/history.ts)', async () => {
  const { readFileSync } = await import('node:fs')
  const a = readFileSync(new URL('../src/history.ts', import.meta.url), 'utf8')
  const b = readFileSync(new URL('../mods/token-tracker/hooks/history.ts', import.meta.url), 'utf8')
  assert.equal(b, a, 'copy src/history.ts to mods/token-tracker/hooks/history.ts')
})

test('history: a prompt and the answers after it are one turn; its length runs from the prompt to the last answer; no text is read', () => {
  const user = (ts, content, extra = {}) => line({ type: 'user', timestamp: ts, sessionId: 'sess-1', message: { role: 'user', content }, ...extra })
  const at = (id, ts) => msg(id, {}, { timestamp: ts })
  const t = parseClaudeLog([
    user('2026-10-20T10:00:00.000Z', 'SECRET PROMPT 1'),
    at('m1', '2026-10-20T10:00:03.000Z'), user('2026-10-20T10:00:04.000Z', [{ type: 'tool_result', content: 'SECRET OUTPUT' }]),
    at('m2', '2026-10-20T10:00:09.000Z'), at('m2', '2026-10-20T10:00:10.000Z'),
    user('2026-10-20T10:00:11.000Z', 'note', { isMeta: true }),
    user('2026-10-20T10:01:00.000Z', [{ type: 'text', text: 'SECRET PROMPT 2' }]), at('m3', '2026-10-20T10:01:02.000Z'),
    at('m4', '2026-10-20T12:01:02.000Z'), at('m5', '2026-10-20T12:01:05.000Z'), // the session was away two hours: that pause is left out
  ].join('\n'))
  assert.deepEqual([...t.values()].map(x => [x.id, x.first, x.duration_ms]), [['m1', true, 10_000], ['m2', false, 0], ['m3', true, 5000], ['m4', false, 0], ['m5', false, 0]])
  assert.equal(JSON.stringify([...t.values()]).includes('SECRET'), false)
})
