// Shapes of what the Worker's /api/admin/* endpoints return, and of the price file.

export interface Counts {
  input: number
  output: number
  cache_read: number
  cache_creation: number
  duration_ms: number
  turns: number
}

/** The agent's own price estimate in millionths of a dollar; 0 when any turn of the group lacks it (the page then prices the tokens itself). */
export interface OwnCost {
  cost_micros?: number
}

/** Hourly UTC bucket per device and model: GET /api/admin/buckets */
export interface Bucket extends Counts, OwnCost {
  h: string // 'YYYY-MM-DDTHH' (UTC)
  device: string
  model: string
  sub: number
  /** which agent: claude, codex, gemini ... */
  provider: string
}

/** One turn: GET /api/admin/turns */
export interface TurnRow {
  ts: string
  device: string
  model: string
  session_id: string
  input: number
  output: number
  cache_read: number
  cache_creation: number
  duration_ms: number
  sub: number
  provider: string
}

/** One session: GET /api/admin/sessions */
export interface SessionRow extends Counts, OwnCost {
  session_id: string
  device: string
  first_ts: string
  last_ts: string
  model: string | null
  provider: string
}

export interface PriceEntry {
  match: string
  input: number
  output: number
  cache_read: number
  cache_write: number
  /** only the model itself and its dated copies, not other ids that start with the same text */
  exact?: boolean
  /** written by scripts/update-prices.mjs */
  auto?: boolean
}
export interface Prices {
  updated: string
  source: string
  note: string
  models: PriceEntry[]
}

export interface DeviceRow {
  id: string
  name: string
  revoked: number
  created_at: string
  last_seen: string | null
  /** agents that sent turns from this device */
  providers: string[]
}

/** Sums plus the estimated cost, per day / hour / model / device. */
export interface Totals extends Counts {
  cost: number
}
