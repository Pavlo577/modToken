#!/usr/bin/env node
// Sends the token usage found in local Claude Code logs to the tracker site.
// Reads ~/.claude/projects/**/*.jsonl line by line; only token counts, timestamps and
// model names leave the machine. Run by /tracker-import, or by hand:
//   TRACKER_URL=https://your-site TRACKER_TOKEN=... node import-logs.mjs
import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createParser } from './worker/public/admin/parse.mjs'

const url = (process.env.TRACKER_URL ?? '').replace(/\/$/, '')
const token = process.env.TRACKER_TOKEN ?? ''
const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
const BATCH = 300

if (!url || !token) {
  console.error('TRACKER_URL and TRACKER_TOKEN are required')
  process.exit(2)
}

async function* jsonlFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* jsonlFiles(path)
    else if (entry.name.endsWith('.jsonl')) yield path
  }
}

async function send(rows) {
  const res = await fetch(`${url}/api/import`, {
    method: 'POST',
    headers: { 'x-device-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ rows }),
  })
  if (res.status === 401) throw new Error('device token rejected (revoked or not linked): run /tracker-link')
  if (!res.ok) throw new Error(`site answered HTTP ${res.status}`)
  return res.json()
}

const total = { files: 0, turns: 0, inserted: 0, duplicates: 0, afterLink: 0 }

try {
  for await (const file of jsonlFiles(root)) {
    // Same key the website import builds, so both ways never count a turn twice.
    const key = relative(root, file).split(sep).join('/').replace(/\.jsonl$/, '')
    const parser = createParser(key)
    for await (const line of createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })) parser.push(line)
    const turns = parser.finish()
    total.files++
    total.turns += turns.length
    for (let i = 0; i < turns.length; i += BATCH) {
      const r = await send(turns.slice(i, i + BATCH))
      total.inserted += r.inserted
      total.duplicates += r.duplicates
      total.afterLink += r.afterLink
    }
  }
} catch (err) {
  if (err?.code === 'ENOENT') console.error(`no logs found in ${root}`)
  else console.error(String(err?.message ?? err))
  process.exit(1)
}
console.log(JSON.stringify(total))
