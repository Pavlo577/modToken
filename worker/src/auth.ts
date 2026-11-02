// Who is calling the admin API: the Cloudflare Access login (JWT checked against the team's keys).
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { Env } from './env.ts'

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined

/** The Access application tags a login may come from: POLICY_AUD is one tag or several separated by commas (a new application next to an old one). */
export const audiencesOf = (value: string | undefined): string[] => (value ?? '').split(',').map(s => s.trim()).filter(Boolean)

/** Why a login was refused, as one word the dashboard explains (never the token or the email). */
export type AuthReason = 'no-token' | 'expired' | 'clock' | 'audience' | 'issuer' | 'keys' | 'signature' | 'no-email' | 'invalid'

/**
 * Seconds of clock difference allowed between Cloudflare Access and the Worker. Without it a token Access has just issued could be
 * "not valid yet" (its nbf a moment ahead of the Worker's clock), and signing in again would only bring another such token.
 */
export const CLOCK_TOLERANCE = 60

/** The reason behind a jose verification error. */
export function authReason(e: unknown): AuthReason {
  const { code, claim } = (e ?? {}) as { code?: string; claim?: string }
  if (code === 'ERR_JWT_EXPIRED') return 'expired'
  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') return claim === 'aud' ? 'audience' : claim === 'iss' ? 'issuer' : claim === 'nbf' || claim === 'iat' ? 'clock' : 'invalid'
  if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') return 'signature'
  if (code?.startsWith('ERR_JWKS') || e instanceof TypeError) return 'keys' // no key with this id, or the team's keys could not be fetched
  return 'invalid'
}

/** The signed-in user's email, verified against Cloudflare Access, or why there is none. */
export async function accessCheck(req: Request, env: Env): Promise<{ email: string } | { reason: AuthReason }> {
  if (env.DEV_EMAIL) return { email: env.DEV_EMAIL }
  const token = req.headers.get('cf-access-jwt-assertion')
  if (!token) return { reason: 'no-token' }
  try {
    jwks ??= createRemoteJWKSet(new URL(`${env.TEAM_DOMAIN}/cdn-cgi/access/certs`))
    const { payload } = await jwtVerify(token, jwks, { issuer: env.TEAM_DOMAIN, audience: audiencesOf(env.POLICY_AUD), clockTolerance: CLOCK_TOLERANCE })
    return typeof payload.email === 'string' ? { email: payload.email.toLowerCase() } : { reason: 'no-email' } // a service token, not a person
  } catch (e) {
    const reason = authReason(e)
    if (reason === 'keys') jwks = undefined // fetch the team's keys afresh next time (they rotate)
    return { reason }
  }
}
