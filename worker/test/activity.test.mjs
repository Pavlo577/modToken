// POST /v1/activity keeps numbers, times and short identifiers only; the project only as far as the device allows.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseActivity, projectFor } from '../src/activity.ts'

const turn = (extra = {}) => ({ id: 'turn-1', session: 'sess-1', ts: '2026-10-25T23:00:00.000Z', wall_ms: 12345.6, think_ms: 4000, outcome: 'answer',
  context_pct: 42.5, context_tokens: 85000, context_window: 200000, perm_asks: 2, perm_denied: 1, perm_wait_ms: 9000, ...extra })

test('activity: the numbers of a turn and a session are kept, nothing else survives', () => {
  const out = parseActivity({
    email: 'secret.person@example.com',
    session: { id: 'sess-1', started_at: '2026-10-25T22:00:00Z', end_reason: 'clear', project: 'owner/repo', cwd: '/home/SECRETUSER' },
    turns: [turn({ prompt: 'SECRET PROMPT', answer: 'SECRET' })],
  }, 'name')
  const text = JSON.stringify(out)
  for (const bad of ['SECRET', 'secret.person', 'cwd', 'prompt']) assert.equal(text.includes(bad), false, bad)
  assert.deepEqual(out.session, { id: 'sess-1', started_at: '2026-10-25T22:00:00.000Z', ended_at: null, end_reason: 'clear', project: 'owner/repo', project_note: null })
  assert.equal(parseActivity({ session: { id: 's', started_at: '2026-10-25T22:00:00Z', project_note: 'no_repo' } }, 'name').session.project_note, 'no_repo')
  assert.equal(parseActivity({ session: { id: 's', started_at: '2026-10-25T22:00:00Z', project_note: '/home/SECRET path' } }, 'name').session.project_note, null)
  assert.deepEqual(out.turns[0], { id: 'turn-1', session: 'sess-1', ts: '2026-10-25T23:00:00.000Z', wall_ms: 12346, think_ms: 4000, outcome: 'answer',
    context_pct: 42.5, context_tokens: 85000, context_window: 200000, perm_asks: 2, perm_denied: 1, perm_wait_ms: 9000 })
})

test('activity: the project follows the device setting', () => {
  assert.equal(projectFor('owner/repo', 'off'), null)
  assert.equal(projectFor('h:0123456789ab', 'off'), null)
  assert.equal(projectFor('owner/repo', 'hash'), null)
  assert.equal(projectFor('h:0123456789ab', 'hash'), 'h:0123456789ab')
  assert.equal(projectFor('owner/repo', 'name'), 'owner/repo')
  assert.equal(projectFor('h:0123456789ab', 'name'), 'h:0123456789ab')
  for (const bad of ['/home/user/repo', 'https://token@github.com/o/r', 'a b', 'x'.repeat(300)]) assert.equal(projectFor(bad, 'name'), null, bad)
})

test('activity: malformed turns are dropped, values are bounded', () => {
  const out = parseActivity({ turns: [
    turn({ id: 'bad id!' }), turn({ ts: 'not a time' }), turn({ wall_ms: -1 }), null,
    turn({ id: 't2', outcome: 'whatever', context_pct: 250, perm_asks: 99999, think_ms: 'x' }),
  ] }, 'off')
  assert.equal(out.session, null)
  assert.equal(out.turns.length, 1)
  assert.deepEqual([out.turns[0].outcome, out.turns[0].context_pct, out.turns[0].perm_asks, out.turns[0].think_ms], ['answer', 100, 1000, null])
  assert.equal(parseActivity([], 'off'), null)
  assert.equal(parseActivity({ turns: Array.from({ length: 80 }, (_, i) => turn({ id: 't' + i })) }, 'off').turns.length, 50)
})
