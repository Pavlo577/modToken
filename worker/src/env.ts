export interface Env {
  DB: D1Database
  ASSETS: Fetcher
  TEAM_DOMAIN: string
  POLICY_AUD: string
  /** Local development only (.dev.vars): skips Access and acts as this user. Never set in production. */
  DEV_EMAIL?: string
}
