// Shared pure pricing logic for OpenAI, Gemini, and Anthropic models (used both by Worker cron/API and scripts/update-prices.mjs).
// Entries without "auto" in prices.json are maintained by hand and always win over generated entries.

export interface PriceEntry {
  match: string
  input: number
  output: number
  cache_read: number
  cache_write: number
  exact?: boolean
  auto?: boolean
}

export interface PricesFile {
  updated: string
  source: string
  note: string
  models: PriceEntry[]
}

export interface PriceSource {
  provider: string
  key: (id: string) => string | null
  want: (id: string) => boolean
  exact: boolean
}

export interface RawPriceSpec {
  litellm_provider?: string
  mode?: string
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_read_input_token_cost?: number
  cache_creation_input_token_cost?: number
}

export interface PriceChange {
  id: string
  kind: 'new' | 'changed' | 'removed'
  was?: PriceEntry
  now?: PriceEntry
}

const EXCLUDE = /(audio|realtime|image|transcribe|tts|search|embedding|moderation|computer|deep-research|live|chat-latest|instant|robotics|gemma|omni|latest|exp)/

/** Which models of which provider are taken from the community list. Prices are USD per token there; ours are per million. */
export const SOURCES: PriceSource[] = [
  {
    provider: 'openai',
    key: id => (id.includes('/') ? null : id),
    want: id => /^(gpt-[56]|codex-)/.test(id) && !EXCLUDE.test(id),
    exact: true,
  },
  {
    provider: 'gemini',
    key: id => id.replace(/^gemini\//, ''),
    want: id => /^gemini-(2\.5|3|4)/.test(id) && !EXCLUDE.test(id),
    exact: false,
  },
  {
    provider: 'anthropic',
    key: id => (id.includes('/') ? null : id),
    want: id => /^claude-(opus|sonnet|haiku|fable|mythos)-[3-9]/.test(id) && !EXCLUDE.test(id),
    exact: false,
  },
]

const perMillion = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e6 * 1e6) / 1e6 : null
const DATED = /(-\d{4}-\d{2}-\d{2}|-\d{8})$/

/** Converts LiteLLM raw entries into normalized Token Tracker price entries. */
export function convert(list: Record<string, RawPriceSpec>, sources: PriceSource[] = SOURCES): PriceEntry[] {
  const out = new Map<string, PriceEntry>()
  for (const [rawId, v] of Object.entries(list)) {
    if (!v || typeof v !== 'object') continue
    for (const s of sources) {
      if (v.litellm_provider !== s.provider) continue
      const id = s.key(rawId)
      if (!id || !s.want(id)) continue
      if (v.mode !== 'chat' && v.mode !== 'responses') continue
      const input = perMillion(v.input_cost_per_token)
      const output = perMillion(v.output_cost_per_token)
      if (!input || input <= 0 || !output || output <= 0) continue
      const cached = perMillion(v.cache_read_input_token_cost)
      const cacheWrite = perMillion(v.cache_creation_input_token_cost)
      const entry: PriceEntry = {
        match: id,
        input,
        output,
        cache_read: cached ?? input,
        cache_write: cacheWrite ?? input,
        auto: true,
      }
      if (s.exact) entry.exact = true
      out.set(id, entry)
    }
  }
  // A dated copy (gpt-5.5-2026-04-23 or claude-haiku-4-5-20251001) shares its base model price: keep the shorter id.
  for (const id of [...out.keys()]) {
    if (DATED.test(id) && out.has(id.replace(DATED, ''))) out.delete(id)
  }
  return [...out.values()].sort((a, b) => (a.match < b.match ? -1 : 1))
}

/** Merges generated entries into the current price file; hand-written entries (no `auto`) always win. */
export function merge(current: PricesFile, generated: PriceEntry[], { today, source }: { today: string; source: string }): { file: PricesFile; changes: PriceChange[] } {
  const manual = current.models.filter(m => !m.auto)
  const manualIds = new Set(manual.map(m => m.match))
  const before = new Map(current.models.filter(m => m.auto).map(m => [m.match, m]))
  const fresh = generated.filter(g => !manualIds.has(g.match))
  const changes: PriceChange[] = []
  for (const g of fresh) {
    const o = before.get(g.match)
    if (!o) changes.push({ id: g.match, kind: 'new', now: g })
    else if (o.input !== g.input || o.output !== g.output || o.cache_read !== g.cache_read || o.cache_write !== g.cache_write) {
      changes.push({ id: g.match, kind: 'changed', was: o, now: g })
    }
  }
  for (const [id, was] of before.entries()) {
    if (!fresh.some(g => g.match === id)) changes.push({ id, kind: 'removed', was })
  }
  const models = [...manual, ...fresh]
  const updatedSource = current.source.includes(source) ? current.source : `${current.source}; ${source}`
  return { file: { ...current, updated: today, source: updatedSource, models }, changes }
}

/** Refuses a result that looks broken: too few models, or a price that jumped by more than a factor of five. */
export function suspicious(changes: PriceChange[], generated: PriceEntry[], { minModels = 20 }: { minModels?: number } = {}): string[] {
  const problems: string[] = []
  if (generated.length < minModels) problems.push(`only ${generated.length} models found (expected at least ${minModels})`)
  for (const c of changes) {
    if (c.kind !== 'changed' || !c.was || !c.now) continue
    for (const k of ['input', 'output'] as const) {
      const r = c.now[k] / c.was[k]
      if (r > 5 || r < 0.2) problems.push(`${c.id}: ${k} ${c.was[k]} -> ${c.now[k]}`)
    }
  }
  return problems
}

/** Longest-prefix / exact lookup matching web/lib/stats.ts `priceFor`. */
export function priceFor(model: string, prices: PricesFile | null): PriceEntry | null {
  let best: PriceEntry | null = null
  const id = String(model)
  for (const p of prices?.models ?? []) {
    if (!id.startsWith(p.match) || (best && p.match.length <= best.match.length)) continue
    const rest = id.slice(p.match.length)
    const ok = p.exact ? rest === '' || /^-\d{4}-\d{2}-\d{2}$/.test(rest) : rest === '' || /^[-_]/.test(rest)
    if (ok) best = p
  }
  return best
}

/** Estimates cost in millionths of a dollar (cost_micros) from token counts and price table. */
export function estimateCostMicros(
  counts: { input?: number; output?: number; cache_read?: number; cache_creation?: number },
  model: string | null,
  prices: PricesFile | null,
): number {
  if (!model) return 0
  const p = priceFor(model, prices)
  if (!p) return 0
  return Math.round(
    (counts.input || 0) * p.input +
      (counts.output || 0) * p.output +
      (counts.cache_read || 0) * p.cache_read +
      (counts.cache_creation || 0) * p.cache_write,
  )
}
