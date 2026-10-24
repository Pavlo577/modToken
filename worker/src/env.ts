export interface Env {
  DB: D1Database
  ASSETS: Fetcher
  TEAM_DOMAIN: string
  POLICY_AUD: string
  /** Preview settings only, never production: '1' keeps one masked sample of every event kind (otlp_seen.sample); 'raw' keeps it unmasked (temporary, for looking at what an agent sends). */
  DEBUG_OTLP?: string
  /** Local development only (.dev.vars): skips Access and acts as this user. Never set in production. */
  DEV_EMAIL?: string
}
