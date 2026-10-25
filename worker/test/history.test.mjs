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
  assert.deepEqual([...t.values()], [{ id: 'msg_1', session: 'sess-1', ts: '2026-10-20T10:00:00.000Z', model: 'claude-sonnet-x', input: 2, output: 10, cache_read: 100, cache_creation: 5, sub: false }])
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
