// Who is calling the admin API: the Cloudflare Access login (JWT checked against the team's keys).
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { Env } from './env.ts'

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined

/** The Access application tags a login may come from: POLICY_AUD is one tag or several separated by commas (a new application next to an old one). */
export const audiencesOf = (value: string | undefined): string[] => (value ?? '').split(',').map(s => s.trim()).filter(Boolean)

/** The signed-in user's email, verified against Cloudflare Access; null when not signed in. */
export async function accessEmail(req: Request, env: Env): Promise<string | null> {
  if (env.DEV_EMAIL) return env.DEV_EMAIL
  const token = req.headers.get('cf-access-jwt-assertion')
  if (!token) return null
  try {
    jwks ??= createRemoteJWKSet(new URL(`${env.TEAM_DOMAIN}/cdn-cgi/access/certs`))
    const { payload } = await jwtVerify(token, jwks, { issuer: env.TEAM_DOMAIN, audience: audiencesOf(env.POLICY_AUD) })
    return typeof payload.email === 'string' ? payload.email.toLowerCase() : null
  } catch {
    return null
  }
}
