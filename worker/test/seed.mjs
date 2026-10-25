// Fills a local `wrangler dev` (DEV_EMAIL in .dev.vars) with realistic demo data, sent the way Claude Code sends it (OTLP logs), for working on the dashboard:
//   node test/seed.mjs [http://127.0.0.1:8787]
const B = process.argv[2] ?? 'http://127.0.0.1:8787'
let seed = 7
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
const pick = arr => arr[Math.floor(rnd() * arr.length)]
const post = async (path, body, headers = {}) => {
  headers = { 'content-type': 'application/json', ...headers }
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

const kv = (key, v) => ({ key, value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: v } })
const logs = records => ({ resourceLogs: [{ resource: { attributes: [kv('service.name', 'claude-code')] }, scopeLogs: [{ logRecords: records }] }] })

for (const dev of devices) {
  const { token } = await post('/api/admin/devices', { name: dev.name })
  const records = []
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
        const m = model(), out = Math.floor((big ? 9000 : 400) * (0.3 + rnd() * 2.2)), cr = Math.floor(60_000 + rnd() * 700_000), cw = Math.floor(rnd() * (big ? 120_000 : 15_000)), inp = 2 + Math.floor(rnd() * 14)
        const dur = Math.floor((big ? 120_000 : 9_000) * (0.4 + rnd() * 2))
        const price = m.includes('opus') ? [5, 25, 0.5, 10] : m.includes('haiku') ? [1, 5, 0.1, 2] : [2, 10, 0.2, 4]
        const micros = Math.round(inp * price[0] + out * price[1] + cr * price[2] + cw * price[3])
        const surface = dev.name === 'cloud' ? 'linux' : dev.name === 'win-work' ? 'non-interactive' : pick(['pycharm', 'ssh-session', 'non-interactive'])
        const base = [kv('session.id', sid), kv('prompt.id', `${sid}:${t}`), kv('terminal.type', surface), kv('user.email', 'seed@example.com'), kv('organization.id', 'org-seed')]
        const at = (extra, plus = 0) => ({ timeUnixNano: String(BigInt(ts.getTime() + plus) * 1_000_000n), attributes: [...base, ...extra] })
        const attrs = [
          kv('event.name', 'claude_code.api_request'), kv('session.id', sid), kv('prompt.id', `${sid}:${t}`), kv('request_id', `seed:${sid}:${t}`), kv('model', m),
          kv('input_tokens', inp), kv('output_tokens', out), kv('cache_read_tokens', cr), kv('cache_creation_tokens', cw), kv('duration_ms', dur),
          kv('ttft_ms', Math.floor(600 + rnd() * 2500)), kv('speed', rnd() < 0.05 ? 'fast' : 'normal'), kv('effort', 'medium'), kv('query_source', 'repl_main_thread'),
          kv('cost_usd_micros', micros), kv('cost_usd', micros / 1e6), kv('terminal.type', surface), kv('user.email', 'seed@example.com'), kv('organization.id', 'org-seed'),
        ]
        records.push(at([kv('event.name', 'claude_code.user_prompt'), kv('prompt', '<REDACTED>'), kv('prompt_length', 20 + Math.floor(rnd() * 400))], -4000))
        for (let k = 0, tools = Math.floor(rnd() * (big ? 8 : 4)); k < tools; k++) {
          const tool = pick(['Bash', 'Read', 'Edit', 'Grep', 'Write', 'Glob', 'WebFetch', 'PowerShell'])
          const rejected = rnd() < 0.06
          records.push(at([kv('event.name', 'claude_code.tool_decision'), kv('tool_name', tool), kv('decision', rejected ? 'reject' : 'accept'), kv('source', rejected ? 'user_reject' : 'config'), kv('permission_mode', 'auto')], -3000 + k * 100))
          if (!rejected) records.push(at([kv('event.name', 'claude_code.tool_result'), kv('tool_name', tool), kv('success', rnd() < 0.93 ? 'true' : 'false'), kv('duration_ms', String(Math.floor(20 + rnd() * (tool === 'Bash' ? 4000 : 400)))), kv('tool_input_size_bytes', String(40 + Math.floor(rnd() * 600))), kv('tool_result_size_bytes', String(Math.floor(rnd() * 20000)))], -2900 + k * 100))
        }
        if (rnd() < 0.5) records.push(at([kv('event.name', 'claude_code.hook_execution_complete'), kv('hook_event', 'Stop'), kv('hook_name', 'Stop'), kv('num_hooks', 2), kv('num_success', rnd() < 0.97 ? 2 : 1), kv('total_duration_ms', Math.floor(5 + rnd() * 40))], 500))
        if (rnd() < 0.12) records.push(at([kv('event.name', 'claude_code.api_request'), kv('request_id', `seed-title:${sid}:${t}`), kv('model', 'claude-haiku-4-5-20251001'), kv('input_tokens', 900), kv('output_tokens', 14), kv('duration_ms', 800), kv('ttft_ms', 650), kv('query_source', 'generate_session_title'), kv('cost_usd_micros', 979)], 800))
        records.push({ timeUnixNano: String(BigInt(ts.getTime()) * 1_000_000n), attributes: attrs })
      }
    }
  }
  for (let i = 0; i < records.length; i += 1000) await post('/v1/logs', logs(records.slice(i, i + 1000)), { 'x-device-token': token })
  console.log(`${dev.name}: ${records.length} calls`)
}
