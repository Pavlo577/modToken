// One temporary Codex home for the collector tests. The collector reads CODEX_HOME / TOKEN_TRACKER_HOME when it is loaded, and
// `bun test` loads all test files into one process, so every file must share this one home (a module is evaluated only once).
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const dir = mkdtempSync(join(tmpdir(), 'cx-'))
mkdirSync(join(dir, 'codex'), { recursive: true })
process.env.CODEX_HOME = join(dir, 'codex')
process.env.TOKEN_TRACKER_HOME = join(dir, 'tt')
export const codex = (await import('../../collectors/agents/codex.mjs')).default
