// The Antigravity agent of the collector (collectors/agents/antigravity.mjs): synthetic conversation databases, a fake site,
// no real ~/.gemini. The numbers in the first test are the ones seen in a real conversation (structure only, no text).
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dir } from './codex-home.mjs' // TOKEN_TRACKER_HOME points into a temporary directory

const agyHome = process.env.ANTIGRAVITY_HOME // set by codex-home.mjs: a temporary directory
const conversations = join(agyHome, 'conversations')
mkdirSync(conversations, { recursive: true })

const { default: agy, buildTurns, parseDatabase } = await import('../../collectors/agents/antigravity.mjs')
const { readFields, readGeneration, readStep } = await import('../../collectors/lib/antigravity-pb.mjs')
const { openSqlite } = await import('../../collectors/lib/antigravity-db.mjs')

const SECRET = 'TOP-SECRET-PROMPT-WORD'
after(() => rmSync(conversations, { recursive: true, force: true })) // other test files (bun runs them in one process) must not see these conversations

// A minimal protobuf encoder for the fixtures.
const vi = n => { const o = []; while (n >= 128) { o.push((n % 128) | 128); n = Math.floor(n / 128) } o.push(n); return o }
const tag = (f, w) => vi(f * 8 + w)
const V = (f, n) => [...tag(f, 0), ...vi(n)]
const B = (f, bytes) => [...tag(f, 2), ...vi(bytes.length), ...bytes]
const S = (f, s) => B(f, [...Buffer.from(s)])
const T = (f, ms) => B(f, [...V(1, Math.floor(ms / 1000)), ...V(2, (ms % 1000) * 1e6)])
const bytes = a => Uint8Array.from(a)

const T0 = Date.UTC(2026, 9, 20, 10, 0, 0)
const usage = ({ input, output, cache = 0, write = 0, think = 0, message }) => [
  ...V(1, 1318), ...V(2, input), ...V(3, output), ...(write ? V(4, write) : []), ...(cache ? V(5, cache) : []), ...V(6, 24),
  ...S(7, message), ...(think ? V(9, think) : []), ...V(10, output - think),
]
const ids = (conv = 'conv-1') => B(20, [...S(1, 'traj-1'), ...S(4, conv)])
const userStep = (turn, at) => bytes([...T(1, at), ...V(3, 4), ...S(12, turn), ...ids()])
const modelStep = (turn, at, endAt, u, extra = []) => bytes([...T(1, at), ...T(6, at + 1000), ...T(7, endAt), ...B(9, usage(u)), ...S(12, turn), ...ids(), ...extra])
const generation = (turn, message, model, u) => bytes([...B(1, [...B(4, usage({ ...u, message })), ...S(19, model)]), ...S(4, turn), ...B(8, S(1, SECRET))])

test('the numbers of a real conversation: two turns, the second one reads the first one from the cache', () => {
  const steps = [
    readStep(userStep('turn-a', T0)),
    readStep(modelStep('turn-a', T0 + 500, T0 + 22_000, { input: 33353, output: 6955, think: 2192, message: 'bot-a' })),
    readStep(userStep('turn-b', T0 + 109_000)),
    readStep(modelStep('turn-b', T0 + 109_500, T0 + 112_000, { input: 7784, output: 526, cache: 33063, think: 447, message: 'bot-b' })),
  ]
  const generations = [
    readGeneration(generation('turn-a', 'bot-a', 'gemini-3.8-flash', { input: 33353, output: 6955 })),
    readGeneration(generation('turn-b', 'bot-b', 'gemini-3.8-flash', { input: 7784, output: 526 })),
  ]
  const rows = buildTurns({ conversation: 'conv-1', steps, generations })
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], {
    provider: 'antigravity', turn_id: 'antigravity:conv-1:turn-a', session_id: 'conv-1', ts: new Date(T0 + 22_000).toISOString(), model: 'gemini-3.8-flash',
    input_tokens: 33353, output_tokens: 6955, cache_read_tokens: 0, cache_creation_tokens: 0, duration_ms: 22_000, is_subagent: false,
  })
  assert.equal(rows[1].input_tokens, 7784) // the 33063 read from the cache are NOT in the input
  assert.equal(rows[1].cache_read_tokens, 33063)
  assert.equal(rows[1].output_tokens, 526) // thinking is inside the output, not added on top
  assert.equal(rows[1].duration_ms, 3000) // from the user's input to the end of the last answer
})

test('several model calls of one turn are summed, a repeated call is counted once, a cache write is its own part', () => {
  const steps = [
    readStep(userStep('t', T0)),
    readStep(modelStep('t', T0 + 100, T0 + 1000, { input: 100, output: 10, write: 40, message: 'm1' })),
    readStep(modelStep('t', T0 + 1100, T0 + 2000, { input: 5, output: 20, cache: 140, message: 'm2' })),
    readStep(modelStep('t', T0 + 1100, T0 + 2000, { input: 5, output: 20, cache: 140, message: 'm2' })),
  ]
  const [row, ...rest] = buildTurns({ conversation: 'c', steps, generations: [] })
  assert.equal(rest.length, 0)
  assert.deepEqual([row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_creation_tokens, row.model], [105, 30, 140, 40, 'unknown'])
  assert.equal(row.ts, new Date(T0 + 2000).toISOString())
})

test('a turn without any model call gives no row, and a sub-agent conversation is marked', () => {
  assert.deepEqual(buildTurns({ conversation: 'c', steps: [readStep(userStep('t', T0))], generations: [] }), [])
  const steps = [readStep(modelStep('t', T0, T0 + 10, { input: 1, output: 1, message: 'm' }))]
  assert.equal(buildTurns({ conversation: 'c', steps, generations: [], subagent: true })[0].is_subagent, true)
})

test('garbage and truncated protobuf are rejected, not guessed', () => {
  assert.equal(readFields(bytes([0xff, 0xff, 0xff])), null)
  assert.equal(readFields(bytes([0x0a, 0x05, 0x01])), null) // length runs past the end
  assert.equal(readStep(bytes([1, 2, 3])), null)
  assert.equal(readStep(null), null)
  assert.equal(readGeneration(new Uint8Array(0)), null)
  assert.deepEqual(buildTurns({ conversation: 'c', steps: [null, null], generations: [null] }), [])
})

test('an id or model name that is not a plain identifier is dropped (so free text cannot slip through those fields)', () => {
  const evil = bytes([...T(1, T0), ...S(12, 'has spaces and ' + SECRET), ...B(9, [...V(2, 5), ...V(3, 5), ...S(7, 'bot with space')])])
  const s = readStep(evil)
  assert.equal(s.turn, '')
  assert.equal(s.usage.message, '')
  assert.equal(readGeneration(bytes([...B(1, S(19, 'a model with spaces ' + SECRET))])).model, '')
})

async function makeConversation(id, { steps, generations, payload = SECRET, parents = 0 }) {
  const db = await openSqlite(join(conversations, `${id}.db`), { readOnly: false })
  db.exec('CREATE TABLE trajectory_meta (trajectory_id text, cascade_id text, trajectory_type integer, source integer)')
  db.exec('CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, metadata blob, step_payload blob)')
  db.exec('CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob, size integer NOT NULL DEFAULT 0)')
  db.exec('CREATE TABLE parent_references (idx integer PRIMARY KEY, data blob)')
  steps.forEach((m, i) => db.run('INSERT INTO steps (idx, step_type, metadata, step_payload) VALUES (?, ?, ?, ?)', i, 15, m, Buffer.from(payload)))
  generations.forEach((g, i) => db.run('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)', i, g, g.length))
  for (let i = 0; i < parents; i++) db.run('INSERT INTO parent_references (idx, data) VALUES (?, ?)', i, bytes([1]))
  db.close()
}

test('no secret from the content or from unknown fields reaches the rows', async () => {
  const unknown = [...S(30, SECRET), ...B(31, S(1, SECRET))] // fields the collector does not know
  await makeConversation('secret-conv', {
    steps: [userStep('t', T0), modelStep('t', T0 + 10, T0 + 50, { input: 7, output: 3, message: 'bot-s' }, unknown)],
    generations: [generation('t', 'bot-s', 'gemini-3.8-flash', { input: 7, output: 3 })],
  })
  const rows = await parseDatabase(join(conversations, 'secret-conv.db'))
  assert.equal(rows.length, 1)
  assert.ok(!JSON.stringify(rows).includes(SECRET))
  rmSync(join(conversations, 'secret-conv.db'))
})

test('sync end to end: rows go out once, a grown conversation sends only what changed, secrets stay out of the body, the state and the log', async () => {
  mkdirSync(join(dir, 'tt'), { recursive: true })
  writeFileSync(join(dir, 'tt', 'config.json'), JSON.stringify({ url: 'https://unit.invalid', token: 't' }))
  const stepsOf = n => [userStep('t1', T0), modelStep('t1', T0 + 10, T0 + 50, { input: 7, output: 3, message: 'bot-1' }),
    ...(n > 1 ? [userStep('t2', T0 + 100), modelStep('t2', T0 + 110, T0 + 150, { input: 9, output: 4, message: 'bot-2' })] : [])]
  const gens = n => [generation('t1', 'bot-1', 'gemini-3.8-flash', { input: 7, output: 3 }), ...(n > 1 ? [generation('t2', 'bot-2', 'gemini-3.8-flash', { input: 9, output: 4 })] : [])]
  await makeConversation('sync-conv', { steps: stepsOf(1), generations: gens(1) })
  await makeConversation('helper-conv', { steps: stepsOf(1), generations: gens(1), parents: 1 })

  const bodies = []
  const oldFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => { bodies.push(init.body); return new Response(null, { status: 204 }) }
  try {
    assert.equal(agy.detect(), true)
    const first = await agy.sync({})
    assert.deepEqual([first.files, first.scanned, first.rows], [2, 2, 2])
    const sent = bodies.flatMap(b => JSON.parse(b).rows)
    assert.deepEqual(sent.map(r => r.provider), ['antigravity', 'antigravity'])
    assert.equal(sent.find(r => r.session_id === 'helper-conv').is_subagent, true)
    assert.equal(sent.find(r => r.session_id === 'sync-conv').is_subagent, false)

    bodies.length = 0
    const again = await agy.sync({})
    assert.deepEqual([again.scanned, again.rows], [0, 0]) // nothing changed
    assert.equal(bodies.length, 0)

    const db = await openSqlite(join(conversations, 'sync-conv.db'), { readOnly: false })
    stepsOf(2).slice(2).forEach((m, i) => db.run('INSERT INTO steps (idx, step_type, metadata, step_payload) VALUES (?, ?, ?, ?)', 2 + i, 15, m, Buffer.from(SECRET)))
    db.run('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)', 1, gens(2)[1], 1)
    db.close()
    const grown = await agy.sync({})
    assert.deepEqual([grown.scanned, grown.rows], [1, 1]) // only the new turn
    assert.equal(JSON.parse(bodies[0]).rows[0].turn_id, 'antigravity:sync-conv:t2')

    const all = bodies.join('') + readFileSync(join(dir, 'tt', 'antigravity-state.json'), 'utf8')
    const log = readdirSync(join(dir, 'tt')).map(n => (/log|\.txt$/.test(n) ? readFileSync(join(dir, 'tt', n), 'utf8') : '')).join('')
    assert.ok(!(all + log).includes(SECRET))
    assert.equal(agy.status().turns, 3)
  } finally { globalThis.fetch = oldFetch }
})

test('an unreadable database is reported but does not stop the others', async () => {
  writeFileSync(join(conversations, 'broken.db'), 'this is not a database')
  const oldFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(null, { status: 204 })
  try {
    await assert.rejects(agy.sync({ full: true }))
    assert.match(agy.status().lastError.message, /./)
    assert.ok(agy.status().turns >= 3) // the readable conversations were still sent
  } finally { globalThis.fetch = oldFetch; rmSync(join(conversations, 'broken.db')) }
})
