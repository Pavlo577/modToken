// Turns out of one Claude Code session log (.jsonl), read line by line.
// Only token counts and timestamps are kept; no message text leaves the browser.

const num = v => (Number.isFinite(v) ? v : 0)
const SYNTHETIC = '<synthetic>'

function isPrompt(e) {
  if (e.type !== 'user' || e.isMeta) return false
  const c = e.message?.content
  if (typeof c === 'string') return c.length > 0 && !c.startsWith('<local-command')
  return Array.isArray(c) && c.some(b => b?.type === 'text' || b?.type === 'image')
}

/**
 * `fileKey` makes turn ids stable between imports of the same file.
 * `seen` is shared by all files of one run: a session copied into another file (after a `cd`,
 * a resume) repeats the same messages, which must be counted once, by the first file that has them.
 */
export function createParser(fileKey, seen = new Set()) {
  const own = new Set()
  const turns = []
  let cur = null
  let n = 0

  const start = startTs => { cur = { n: ++n, startTs, lastTs: null, sessionId: '', sidechain: false, msgs: new Map() } }

  const close = () => {
    if (!cur) return
    const t = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }
    let model = ''
    let best = -1
    for (const m of cur.msgs.values()) {
      t.input_tokens += m.input
      t.output_tokens += m.output
      t.cache_read_tokens += m.cache_read
      t.cache_creation_tokens += m.cache_creation
      if (m.output > best) { best = m.output; model = m.model }
    }
    const total = t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_creation_tokens
    if (total > 0 && cur.lastTs) {
      turns.push({
        turn_id: `imp:${fileKey}:${cur.n}`,
        session_id: cur.sessionId || fileKey,
        ts: new Date(cur.lastTs).toISOString(),
        model: model || 'unknown',
        ...t,
        duration_ms: cur.startTs ? Math.max(0, cur.lastTs - cur.startTs) : 0,
        is_subagent: cur.sidechain,
      })
    }
    cur = null
  }

  return {
    push(line) {
      let e
      try { e = JSON.parse(line) } catch { return }
      if (!e || typeof e !== 'object') return
      const ts = Date.parse(e.timestamp)
      if (isPrompt(e)) {
        close()
        start(Number.isNaN(ts) ? null : ts)
        return
      }
      const msg = e.type === 'assistant' ? e.message : null
      const u = msg?.usage
      if (!u || !msg.id || msg.model === SYNTHETIC || Number.isNaN(ts)) return
      if (seen.has(msg.id) && !own.has(msg.id)) return
      own.add(msg.id)
      if (!cur) start(null)
      cur.lastTs = Math.max(cur.lastTs ?? 0, ts)
      cur.sessionId ||= String(e.sessionId ?? '')
      cur.sidechain ||= e.isSidechain === true
      // The same API message is logged once per content block with the same usage: keep it once.
      const prev = cur.msgs.get(msg.id) ?? { input: 0, output: 0, cache_read: 0, cache_creation: 0, model: msg.model }
      cur.msgs.set(msg.id, {
        input: Math.max(prev.input, num(u.input_tokens)),
        output: Math.max(prev.output, num(u.output_tokens)),
        cache_read: Math.max(prev.cache_read, num(u.cache_read_input_tokens)),
        cache_creation: Math.max(prev.cache_creation, num(u.cache_creation_input_tokens)),
        model: msg.model,
      })
    },
    finish() {
      close()
      for (const id of own) seen.add(id)
      return turns
    },
  }
}
