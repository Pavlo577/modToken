// Turns the community price list (LiteLLM's model_prices_and_context_window.json) into entries of public/admin/prices.json.
// Only entries marked "auto" are managed here: anything written by hand (no "auto") is kept as it is and wins over a generated one.

/** Which models of which provider are taken from the list. Prices are USD per token there; ours are per million. */
export const SOURCES = [
  {
    // OpenAI's own ids (no "provider/" prefix in the list); chat / responses models of the GPT-5, GPT-6 and Codex families
    provider: 'openai',
    key: id => (id.includes('/') ? null : id),
    want: id => /^(gpt-[56]|codex-)/.test(id) && !/(audio|realtime|image|transcribe|tts|search|embedding|moderation|computer|deep-research|live|chat-latest|instant)/.test(id),
  },
]

const perMillion = v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e6 * 1e6) / 1e6 : null)
const DATED = /-\d{4}-\d{2}-\d{2}$/

/** The generated entries: { match, input, output, cache_read, cache_write, auto: true, exact: true }. */
export function convert(list, sources = SOURCES) {
  const out = new Map()
  for (const [rawId, v] of Object.entries(list)) {
    if (!v || typeof v !== 'object') continue
    for (const s of sources) {
      if (v.litellm_provider !== s.provider) continue
      const id = s.key(rawId)
      if (!id || !s.want(id)) continue
      if (v.mode !== 'chat' && v.mode !== 'responses') continue
      const input = perMillion(v.input_cost_per_token), output = perMillion(v.output_cost_per_token)
      if (!(input > 0) || !(output > 0)) continue
      const cached = perMillion(v.cache_read_input_token_cost)
      out.set(id, { match: id, input, output, cache_read: cached ?? input, cache_write: input, auto: true, exact: true })
    }
  }
  // a dated copy (gpt-5.5-2026-04-23) is the same model as its undated name: keep the shorter, the lookup accepts dates
  for (const id of [...out.keys()]) if (DATED.test(id) && out.has(id.replace(DATED, ''))) out.delete(id)
  return [...out.values()].sort((a, b) => (a.match < b.match ? -1 : 1))
}

/** Merges generated entries into the current price file; returns the new file and a list of changes (for the log). */
export function merge(current, generated, { today, source }) {
  const manual = current.models.filter(m => !m.auto)
  const manualIds = new Set(manual.map(m => m.match))
  const before = new Map(current.models.filter(m => m.auto).map(m => [m.match, m]))
  const fresh = generated.filter(g => !manualIds.has(g.match))
  const changes = []
  for (const g of fresh) {
    const o = before.get(g.match)
    if (!o) changes.push({ id: g.match, kind: 'new', now: g })
    else if (['input', 'output', 'cache_read'].some(k => o[k] !== g[k])) changes.push({ id: g.match, kind: 'changed', was: o, now: g })
  }
  for (const id of before.keys()) if (!fresh.some(g => g.match === id)) changes.push({ id, kind: 'removed', was: before.get(id) })
  const models = [...manual, ...fresh]
  return { file: { ...current, updated: today, source: current.source.includes(source) ? current.source : `${current.source}; ${source}`, models }, changes }
}

/** Refuses a result that looks broken: too few models, or a price that jumped by more than a factor of five. */
export function suspicious(changes, generated, { minModels = 20 } = {}) {
  const problems = []
  if (generated.length < minModels) problems.push(`only ${generated.length} models found (expected at least ${minModels})`)
  for (const c of changes) {
    if (c.kind !== 'changed') continue
    for (const k of ['input', 'output']) {
      const r = c.now[k] / c.was[k]
      if (r > 5 || r < 0.2) problems.push(`${c.id}: ${k} ${c.was[k]} -> ${c.now[k]}`)
    }
  }
  return problems
}
