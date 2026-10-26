// The mod shrinks a log over 4 MiB on the device (node or python) before ./history.ts parses it: the result must be the same as parsing the log itself.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseClaudeLog } from '../src/history.ts'
import { SHRINK_JS, SHRINK_PY } from '../mods/token-tracker/hooks/register.ts'

const line = (id, out, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: `2026-10-20T10:00:0${out % 10}.000Z`, sessionId: 'sess-1', isSidechain: false, cwd: '/home/SECRET',
  message: { id, model: 'claude-sonnet-x', content: [{ type: 'text', text: 'SECRET ANSWER '.repeat(50) }], usage: { input_tokens: 2, output_tokens: out, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } }, ...extra })
const user = (ts, content, extra = {}) => JSON.stringify({ type: 'user', timestamp: ts, sessionId: 'sess-1', message: { content }, ...extra })
const log = [user('2026-10-20T09:59:00.000Z', 'SECRET PROMPT "usage"'), line('msg_1', 3), line('msg_1', 40), line('msg_1', 12),
  user('2026-10-20T10:00:05.000Z', [{ type: 'tool_result', content: 'SECRET' }]), user('2026-10-20T10:00:05.000Z', 'SECRET meta', { isMeta: true }), 'not json "usage"',
  user('2026-10-20T10:00:06.000Z', [{ type: 'text', text: 'SECRET PROMPT 2' }]),
  // copies of one answer, the last after a long pause: its first and last times both count for the turn's length
  line('msg_5', 5, { timestamp: '2026-10-20T10:00:07.000Z' }), line('msg_5', 5, { timestamp: '2026-10-20T10:00:08.500Z' }), line('msg_6', 6, { timestamp: '2026-10-20T12:00:09.000Z' }), line('msg_6', 6, { timestamp: '2026-10-20T12:00:09.400Z' }),
  line('msg_2', 7, { isSidechain: true }), line('msg_3', 0).replace('claude-sonnet-x', '<synthetic>')].join('\n') + '\n'

for (const [name, argv] of [['node', (f) => ['node', ['-e', SHRINK_JS, f]]], ['python', (f) => ['python3', ['-c', SHRINK_PY, f]]]]) {
  test(`mod: shrinking a log with ${name} parses to the same turns and drops the text`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'shrink-')), file = join(dir, 's.jsonl')
    try {
      writeFileSync(file, log)
      const [cmd, args] = argv(file)
      const out = execFileSync(cmd, args, { encoding: 'utf8' })
      assert.equal(out.includes('SECRET'), false)
      assert.deepEqual([...parseClaudeLog(out).values()], [...parseClaudeLog(log).values()])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}
