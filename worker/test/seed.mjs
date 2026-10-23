// Fills a local `wrangler dev` (DEV_EMAIL in .dev.vars) with realistic demo data for working on the dashboard:
//   node test/seed.mjs [http://127.0.0.1:8787]
const B = process.argv[2] ?? 'http://127.0.0.1:8787'
let seed = 7
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
const pick = arr => arr[Math.floor(rnd() * arr.length)]
const post = async (path, body, headers = {}) => {
  const r = await fetch(B + path, { method: 'POST', body: JSON.stringify(body), headers })
  if (!r.ok && r.status !== 204) throw new Error(`${path}: ${r.status} ${await r.text()}`)
  return r.status === 204 ? null : r.json()
}

const devices = [
  { name: 'linux-home', weight: 1, workHours: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17], weekend: 0.25 },
  { name: 'win-work', weight: 0.8, workHours: [9, 10, 11, 12, 14, 15, 16, 17, 18], weekend: 0.05 },
  { name: 'cloud', weight: 0.5, workHours: [6, 7, 12, 19, 20, 21, 22], weekend: 0.7 },
]
const MODELS = [['claude-sonnet-5-5', 0.7], ['claude-opus-5-5', 0.2], ['claude-haiku-5-5', 0.1]]
const model = () => { let r = rnd(); for (const [m, w] of MODELS) if ((r -= w) < 0) return m; return MODELS[0][0] }

const tokens = []
for (const dev of devices) {
  const code = (await post('/api/admin/codes', { name: dev.name })).code
  const { token } = await post('/api/link', { code })
  const rows = []
  const now = Date.now()
  for (let d = 150; d >= 0; d--) {
    const day = new Date(now - d * 86_400_000)
    const dow = day.getUTCDay()
    const weekend = dow === 0 || dow === 6
    if (rnd() > (weekend ? dev.weekend : 0.85) * dev.weight + 0.1) continue
    const sessions = 1 + Math.floor(rnd() * 3)
    for (let s = 0; s < sessions; s++) {
      const sid = `${dev.name}-${d}-${s}`
      let hour = pick(dev.workHours), minute = Math.floor(rnd() * 50)
      const n = 3 + Math.floor(rnd() * 22 * dev.weight)
      for (let t = 0; t < n; t++) {
        minute += 1 + Math.floor(rnd() * 9)
        if (minute >= 60) { minute -= 60; hour = Math.min(23, hour + 1) }
        const ts = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute, Math.floor(rnd() * 60)))
        if (ts.getTime() > now - 600_000) continue
        const big = rnd() < 0.08
        rows.push({
          turn_id: `seed:${sid}:${t}`, session_id: sid, ts: ts.toISOString(), model: model(),
          input_tokens: 2 + Math.floor(rnd() * 14), output_tokens: Math.floor((big ? 9000 : 400) * (0.3 + rnd() * 2.2)),
          cache_read_tokens: Math.floor(60_000 + rnd() * 700_000), cache_creation_tokens: Math.floor(rnd() * (big ? 120_000 : 15_000)),
          duration_ms: Math.floor((big ? 120_000 : 9_000) * (0.4 + rnd() * 2)), is_subagent: rnd() < 0.07,
        })
      }
    }
  }
  for (let i = 0; i < rows.length; i += 400) await post('/api/ingest', rows.slice(i, i + 400), { 'x-device-token': token })
  tokens.push({ dev, token })
  console.log(`${dev.name}: ${rows.length} turns`)
}

// A current reading of both subscription windows, as the mod sends after a turn (the history of past weeks
// cannot be back-dated through the API; test/seed-limits.sql does that directly in the local database).
const { token } = tokens[0]
const now = Date.now()
const nextWed = new Date(now); nextWed.setUTCHours(6, 0, 0, 0)
while (nextWed.getUTCDay() !== 3 || nextWed.getTime() <= now) nextWed.setUTCDate(nextWed.getUTCDate() + 1)
await post('/api/ingest', { limits: [
  { kind: 'seven_day', percentUsed: 41.5, resetsAt: nextWed.toISOString() },
  { kind: 'five_hour', percentUsed: 62.5, resetsAt: new Date(now + 2 * 3_600_000).toISOString() },
] }, { 'x-device-token': token })
console.log('limits sent')
