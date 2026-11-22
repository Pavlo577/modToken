// Dynamic model pricing backed by D1 (app_meta key 'prices') with fallback to the bundled static public/admin/prices.json.
import type { Env } from './env.ts'
import { convert, merge, suspicious } from './prices-lib.ts'
import type { PricesFile, RawPriceSpec } from './prices-lib.ts'

export const LITELLM_PRICES_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
export const LITELLM_SOURCE = 'https://github.com/BerriAI/litellm (OpenAI, Gemini, Anthropic)'

/** Reads the bundled static prices.json asset (returns an empty table if ASSETS is absent in unit tests). */
export async function loadStaticPrices(env: Env): Promise<PricesFile> {
  if (!env.ASSETS) return { updated: '', source: '', note: '', models: [] }
  const res = await env.ASSETS.fetch(new Request('https://assets.invalid/admin/prices.json'))
  if (!res.ok) return { updated: '', source: '', note: '', models: [] }
  return (await res.json()) as PricesFile
}

/** Fetches the latest LiteLLM price list, merges with static manual entries, sanity-checks it, and stores it in app_meta. */
export async function refreshPrices(env: Env): Promise<{ updated: boolean; models: number; changes: number; problems: string[] }> {
  const res = await fetch(LITELLM_PRICES_URL, { headers: { 'user-agent': 'token-tracker-prices/1.0' } })
  if (!res.ok) throw new Error(`LiteLLM price list returned HTTP ${res.status}`)
  const list = (await res.json()) as Record<string, RawPriceSpec>
  const current = await loadStaticPrices(env)
  const today = new Date().toISOString().slice(0, 10)
  const generated = convert(list)
  const { file, changes } = merge(current, generated, { today, source: LITELLM_SOURCE })
  const problems = suspicious(changes, generated)
  if (problems.length) return { updated: false, models: generated.length, changes: changes.length, problems }
  const now = new Date().toISOString()
  try {
    await env.DB.prepare(
      `INSERT INTO app_meta (key, value, updated_at) VALUES ('prices', ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(JSON.stringify(file), now).run()
  } catch (e) {
    console.error('prices store: ' + (e instanceof Error ? e.message : 'failed'))
  }
  return { updated: true, models: file.models.length, changes: changes.length, problems: [] }
}

/** Returns the active price table from D1 app_meta, optionally refreshing first, falling back to static prices.json. */
export async function getPrices(env: Env, opts: { refresh?: boolean } = {}): Promise<PricesFile> {
  if (opts.refresh) {
    try { await refreshPrices(env) } catch (e) { console.error('prices refresh: ' + (e instanceof Error ? e.message : 'failed')) }
  }
  try {
    const row = await env.DB.prepare(`SELECT value FROM app_meta WHERE key = 'prices'`).first<{ value: string }>()
    if (row?.value) {
      const parsed = JSON.parse(row.value) as PricesFile
      if (parsed && Array.isArray(parsed.models) && parsed.models.length) return parsed
    }
  } catch { /* app_meta may not exist before migration 0016 */ }
  return loadStaticPrices(env)
}
