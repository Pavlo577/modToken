// POLICY_AUD may list several Access application tags.
import test from 'node:test'
import assert from 'node:assert/strict'
import { audiencesOf } from '../src/auth.ts'

test('auth: POLICY_AUD is one tag or a comma separated list', () => {
  assert.deepEqual(audiencesOf('abc'), ['abc'])
  assert.deepEqual(audiencesOf('abc, def ,ghi'), ['abc', 'def', 'ghi'])
  assert.deepEqual(audiencesOf(' ,abc,, '), ['abc'])
  assert.deepEqual(audiencesOf(''), [])
  assert.deepEqual(audiencesOf(undefined), [])
})
