import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { createParser } from '../public/admin/parse.mjs'

const asst = (id, ts, out, extra = {}) => JSON.stringify({
  type: 'assistant', timestamp: ts, sessionId: 's1',
  message: { id, model: 'm1', usage: { input_tokens: 2, output_tokens: out, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 } }, ...extra,
})
const user = (ts, content = 'hi') => JSON.stringify({ type: 'user', timestamp: ts, message: { content } })

test('one message logged per content block counts once', () => {
  const p = createParser('f')
  for (const l of [user('2026-01-01T10:00:00Z'), asst('a', '2026-01-01T10:00:05Z', 50), asst('a', '2026-01-01T10:00:06Z', 50), asst('a', '2026-01-01T10:00:07Z', 50)]) p.push(l)
  const [t] = p.finish()
  assert.equal(t.output_tokens, 50)
  assert.equal(t.input_tokens, 2)
  assert.equal(t.cache_read_tokens, 100)
})

test('tool results do not start a turn, a new prompt does', () => {
  const p = createParser('f')
  const toolResult = JSON.stringify({ type: 'user', timestamp: '2026-01-01T10:00:08Z', message: { content: [{ type: 'tool_result', content: 'x' }] } })
  for (const l of [user('2026-01-01T10:00:00Z'), asst('a', '2026-01-01T10:00:05Z', 10), toolResult, asst('b', '2026-01-01T10:00:09Z', 20), user('2026-01-01T10:05:00Z'), asst('c', '2026-01-01T10:05:30Z', 5)]) p.push(l)
  const turns = p.finish()
  assert.equal(turns.length, 2)
  assert.equal(turns[0].output_tokens, 30)
  assert.equal(turns[0].duration_ms, 9000)
  assert.equal(turns[1].turn_id, 'imp:f:2')
})

test('garbage lines, synthetic messages and empty turns are ignored', () => {
  const p = createParser('f')
  for (const l of ['not json', '{}', user('2026-01-01T10:00:00Z'), JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T10:00:01Z', message: { id: 'z', model: '<synthetic>', usage: { output_tokens: 9 } } })]) p.push(l)
  assert.equal(p.finish().length, 0)
})

// Compare with an independent count (unique message ids) on real logs when present.
const dir = process.env.CLAUDE_LOGS || `${process.env.HOME}/.claude/projects`
test('totals match an independent count on real logs', { skip: !existsSync(dir) }, () => {
  let want = 0, got = 0, files = 0
  for (const proj of readdirSync(dir)) {
    let names = []
    try { names = readdirSync(`${dir}/${proj}`).filter(f => f.endsWith('.jsonl')) } catch { continue }
    for (const f of names) {
      const text = readFileSync(`${dir}/${proj}/${f}`, 'utf8')
      const best = new Map()
      const p = createParser(f)
      for (const line of text.split('\n')) {
        if (!line) continue
        p.push(line)
        let e; try { e = JSON.parse(line) } catch { continue }
        const m = e.type === 'assistant' ? e.message : null
        if (m?.usage && m.id && m.model !== '<synthetic>') best.set(m.id, Math.max(best.get(m.id) ?? 0, m.usage.output_tokens ?? 0))
      }
      for (const v of best.values()) want += v
      for (const t of p.finish()) got += t.output_tokens
      files++
    }
  }
  console.log(`files ${files}, output tokens ${got}`)
  assert.equal(got, want)
})
