// POLICY_AUD may list several Access application tags.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose'
import { accessCheck, audiencesOf, authReason } from '../src/auth.ts'

test('auth: POLICY_AUD is one tag or a comma separated list', () => {
  assert.deepEqual(audiencesOf('abc'), ['abc'])
  assert.deepEqual(audiencesOf('abc, def ,ghi'), ['abc', 'def', 'ghi'])
  assert.deepEqual(audiencesOf(' ,abc,, '), ['abc'])
  assert.deepEqual(audiencesOf(''), [])
  assert.deepEqual(audiencesOf(undefined), [])
})

test('auth: a refused login says why, in one word (real jose errors)', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }
  const keys = createLocalJWKSet({ keys: [jwk] })
  const sign = (claims, exp = '1h') => new SignJWT({ email: 'me@example.com', ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuedAt().setExpirationTime(exp).sign(privateKey)
  const why = async (token, opts = {}) => { try { await jwtVerify(token, keys, { issuer: 'https://team', audience: ['app'], ...opts }); return 'ok' } catch (e) { return authReason(e) } }
  assert.equal(await why(await sign({ iss: 'https://team', aud: 'app' })), 'ok')
  assert.equal(await why(await sign({ iss: 'https://team', aud: 'app' }, Math.floor(Date.now() / 1000) - 60)), 'expired')
  assert.equal(await why(await sign({ iss: 'https://team', aud: 'other-app' })), 'audience')
  assert.equal(await why(await sign({ iss: 'https://other-team', aud: 'app' })), 'issuer')
  const other = (await generateKeyPair('RS256')).privateKey
  const forged = await new SignJWT({ iss: 'https://team', aud: 'app' }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setExpirationTime('1h').sign(other)
  assert.equal(await why(forged), 'signature')
  const unknownKid = await new SignJWT({ iss: 'https://team', aud: 'app' }).setProtectedHeader({ alg: 'RS256', kid: 'nope' }).setExpirationTime('1h').sign(privateKey)
  assert.equal(await why(unknownKid), 'keys')
  assert.equal(authReason(new TypeError('fetch failed')), 'keys')
  assert.equal(authReason(new Error('x')), 'invalid')
})

test('auth: no Access header is no-token; the reason never carries the token', async () => {
  const r = await accessCheck(new Request('https://x.test/api/admin/me'), { TEAM_DOMAIN: 'https://team', POLICY_AUD: 'app' })
  assert.deepEqual(r, { reason: 'no-token' })
})
