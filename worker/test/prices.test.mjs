import test from 'node:test'
import assert from 'node:assert/strict'
import { convert, merge, suspicious } from '../scripts/prices-lib.mjs'
import { priceFor } from '../web/lib/stats.ts'

const m = (input, output, cache, extra = {}) => ({ litellm_provider: 'openai', mode: 'chat', input_cost_per_token: input / 1e6, output_cost_per_token: output / 1e6, cache_read_input_token_cost: cache == null ? undefined : cache / 1e6, ...extra })
const list = {
  'gpt-6.1-sol': m(2, 10, 0.1),
  'gpt-6-astra': m(10, 50, 1),
  'gpt-5.5': m(5, 30, 0.5),
  'gpt-5.5-2026-04-23': m(5, 30, 0.5), // a dated copy of gpt-5.5
  'gpt-5.5-pro': m(30, 180, undefined, { mode: 'responses' }),
  'azure/gpt-6-astra': m(11, 55, 1.1, { litellm_provider: 'azure' }),
  'us.openai.gpt-6-astra': m(11, 55, 1.1, { litellm_provider: 'bedrock_converse' }),
  'gpt-5-realtime': m(4, 16, 0.4),
  'gpt-5-embedding-x': m(1, 1, 1, { mode: 'embedding' }),
  'gpt-5-free': { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: 0, output_cost_per_token: 0 },
  'claude-x': m(1, 2, 0.1, { litellm_provider: 'anthropic' }),
}

test('convert keeps OpenAI chat models in USD per million, without prefixed copies, dated copies and odd kinds', () => {
  const g = convert(list)
  assert.deepEqual(g.map(x => x.match), ['gpt-5.5', 'gpt-5.5-pro', 'gpt-6-astra', 'gpt-6.1-sol'])
  const sol = g.find(x => x.match === 'gpt-6.1-sol')
  assert.deepEqual([sol.input, sol.cache_read, sol.output, sol.auto, sol.exact], [2, 0.1, 10, true, true])
  assert.equal(g.find(x => x.match === 'gpt-5.5-pro').cache_read, 30) // no cache price: the plain input price
})

test('merge never touches hand-written entries and reports what changed', () => {
  const current = { updated: 'x', source: 'claude page', note: '', models: [
    { match: 'claude-sonnet-5', input: 2, output: 10, cache_read: 0.2, cache_write: 4 },
    { match: 'gpt-6-astra', input: 1, output: 1, cache_read: 1, cache_write: 1 }, // fixed by hand
    { match: 'gpt-5.5', input: 4, output: 30, cache_read: 0.5, cache_write: 4, auto: true, exact: true },
    { match: 'gpt-old', input: 1, output: 1, cache_read: 1, cache_write: 1, auto: true, exact: true },
  ] }
  const { file, changes } = merge(current, convert(list), { today: '2026-10-24', source: 'litellm' })
  assert.equal(file.models.find(x => x.match === 'gpt-6-astra').input, 1) // the hand-written one wins
  assert.equal(file.models.find(x => x.match === 'claude-sonnet-5').input, 2)
  assert.ok(!file.models.some(x => x.match === 'gpt-old'))
  assert.deepEqual(changes.map(c => [c.kind, c.id]).sort(), [['changed', 'gpt-5.5'], ['new', 'gpt-5.5-pro'], ['new', 'gpt-6.1-sol'], ['removed', 'gpt-old']])
  assert.equal(file.updated, '2026-10-24')
  assert.ok(file.source.includes('litellm'))
})

test('a result that looks broken is refused', () => {
  const g = convert(list)
  assert.match(suspicious([], g).join(), /only 4 models/)
  const wild = [{ kind: 'changed', id: 'gpt-5.5', was: { input: 5, output: 30 }, now: { input: 50, output: 30 } }]
  assert.match(suspicious(wild, g, { minModels: 1 }).join(), /gpt-5\.5: input 5 -> 50/)
  assert.equal(suspicious([], g, { minModels: 1 }).length, 0)
})

test('exact prices cover the model and its dated copies only; other entries are prefixes up to a dash', () => {
  const p = { updated: '', source: '', note: '', models: [
    { match: 'gpt-5.6', input: 4, output: 20, cache_read: 0.4, cache_write: 4, exact: true },
    { match: 'gpt-5.6-sol', input: 4, output: 20, cache_read: 0.4, cache_write: 4, exact: true },
    { match: 'claude-sonnet-5', input: 2, output: 10, cache_read: 0.2, cache_write: 4 },
  ] }
  assert.equal(priceFor('gpt-5.6', p).match, 'gpt-5.6')
  assert.equal(priceFor('gpt-5.6-sol-2026-07-09', p).match, 'gpt-5.6-sol')
  assert.equal(priceFor('gpt-5.6-pro', p), null)
  assert.equal(priceFor('gpt-5.60', p), null)
  assert.equal(priceFor('claude-sonnet-5-5-20260101', p).match, 'claude-sonnet-5')
})
