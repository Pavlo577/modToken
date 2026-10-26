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
const log = [line('msg_1', 3), line('msg_1', 40), line('msg_1', 12), JSON.stringify({ type: 'user', message: { content: 'SECRET PROMPT "usage"' } }), 'not json "usage"',
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
