#!/usr/bin/env node
// Stop hook for Claude Code cloud sessions (claude.ai/code): after each turn it sends the session's
// token usage to the tracker site. Only token counts, timestamps and model names are sent.
//
// The site is read from ~/.claude/token-tracker/url (written by setup.sh). The device token is not
// here at all: Anthropic's network proxy adds the `x-device-token` header (a "network secret" on the
// environment) to requests to the site's host. Locally TRACKER_EXTRA_HEADER can stand in for it (tests).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createParser } from './parse.mjs'

const BATCH = 300
const RESEND = 3 // the newest turns are re-sent: the log can lag a moment behind the turn that just ended

async function work(transcript, session) {
  // The transcript is written asynchronously, so wait a moment for the end of the turn to reach it.
  await new Promise(r => setTimeout(r, 1500))
  const url = readFileSync(join(homedir(), '.claude', 'token-tracker', 'url'), 'utf8').trim().replace(/\/$/, '')
  const parser = createParser(session)
  for (const line of readFileSync(transcript, 'utf8').split('\n')) if (line) parser.push(line)
  // Same turn ids for the same session whichever log file holds it (a `cd` makes a copy), so repeats are harmless.
  const turns = parser.finish().map(t => ({ ...t, turn_id: t.turn_id.replace(/^imp:/, 'cc:'), session_id: session }))

  const stateFile = join(tmpdir(), `token-tracker-${session}.json`)
  let sent = 0
  try { sent = JSON.parse(readFileSync(stateFile, 'utf8')).sent ?? 0 } catch {}
  const todo = turns.slice(Math.max(0, sent - RESEND))
  const extra = process.env.TRACKER_EXTRA_HEADER ? ['-H', process.env.TRACKER_EXTRA_HEADER] : []

  for (let i = 0; i < todo.length; i += BATCH) {
    const r = spawnSync('curl', ['-sS', '-f', '--max-time', '30', '-X', 'POST', `${url}/api/ingest`,
      '-H', 'content-type: application/json', ...extra, '--data-binary', '@-'],
      { input: JSON.stringify(todo.slice(i, i + BATCH)), encoding: 'utf8' })
    if (r.status !== 0) return // try again at the next Stop; nothing is marked as sent
  }
  writeFileSync(stateFile, JSON.stringify({ sent: turns.length }))
}

if (process.argv[2] === '--work') {
  work(process.argv[3], process.argv[4]).catch(() => {}).finally(() => process.exit(0))
} else {
  if (process.env.CLAUDE_CODE_REMOTE !== 'true') process.exit(0)
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', c => (input += c))
  process.stdin.on('end', () => {
    try {
      const { session_id, transcript_path } = JSON.parse(input)
      if (session_id && transcript_path && existsSync(transcript_path)) {
        // Detached, so the next turn never waits for the upload.
        spawn(process.execPath, [fileURLToPath(import.meta.url), '--work', transcript_path, session_id], { detached: true, stdio: 'ignore' }).unref()
      }
    } catch {}
    process.exit(0)
  })
}
