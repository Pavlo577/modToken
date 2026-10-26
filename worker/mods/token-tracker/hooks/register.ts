import type { EngineInterface, Register } from 'claude-code'
import { addLogLine, MAX_HISTORY_TURNS } from './history.ts'
import type { HistoryTurn } from './history.ts'

// Token Tracker's mod: what OTLP does not carry. Numbers only, never text:
// - the subscription's rate-limit windows -> POST /v1/limits when they change;
// - the session (start, end, why it ended) and every main-loop turn (wall-clock length, the pause before the prompt, context fill,
//   permission prompts put to a person: how many, how many refused, how long until the tool finished) -> POST /v1/activity;
// - the session's repository only when the device allows it (GET /v1/config: off | name | hash): owner/name, or a hash of the remote;
//   when there is none, a word saying why (project_note: off, no_target, config_failed, no_repo).
// - /tracker-import: the token history from the local logs (~/.claude/projects/**/*.jsonl), parsed here by ./history.ts (a copy of the
//   Worker's src/history.ts) into numbers, a model name and ids, and POSTed to /v1/import; prompts and answers never leave the device.
//   A log over 4 MiB (what $.fs.read takes) is first shrunk on the device by node, python or PowerShell to those fields.
// The site and the device token are the device's own OTLP settings (the logs endpoint's origin, the x-device-token header);
// TRACKER_ORIGIN / TRACKER_TOKEN override them. Tokens are never sent: OTLP counts them.
type Limit = { kind: string; percentUsed: number; resetsAt?: string }
type Turn = {
  id: string; session: string; ts: string; wall_ms: number; think_ms: number | null; outcome: string
  context_pct: number | null; context_tokens: number | null; context_window: number | null
  perm_asks: number; perm_denied: number; perm_wait_ms: number
}
type Target = { origin: string; token: string }

async function target($: EngineInterface): Promise<Target | undefined> {
  let origin = await $.env.get('TRACKER_ORIGIN')
  if (!origin) {
    try { origin = new URL((await $.env.get('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT')) ?? '').origin } catch { origin = undefined }
  }
  const token = (await $.env.get('TRACKER_TOKEN')) ?? /(?:^|,)\s*x-device-token=([^,\s]+)/.exec((await $.env.get('OTEL_EXPORTER_OTLP_LOGS_HEADERS')) ?? '')?.[1]
  return origin && token ? { origin: origin.replace(/\/$/, ''), token } : undefined
}

async function post($: EngineInterface, t: Target, path: string, body: unknown): Promise<boolean> {
  const r = await $.http.fetch(`${t.origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-device-token': t.token },
    body: JSON.stringify(body),
  }).catch(() => undefined)
  return !!r?.ok
}

const iso = async ($: EngineInterface): Promise<string> => new Date(await $.clock.now()).toISOString()

/** owner/name of a remote URL (https or ssh), never its credentials; null when it does not look like one. */
function remoteName(remote: string | null): string | null {
  const m = /[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote ?? '')
  return m ? `${m[1]}/${m[2]}` : null
}

/** The project as the device allows it, or why there is none. */
async function project($: EngineInterface, mode: string): Promise<{ project: string | null; note: string | null }> {
  if (mode !== 'name' && mode !== 'hash') return { project: null, note: mode === 'off' ? 'off' : mode }
  const repo = await $.session.repo().catch(() => undefined)
  if (repo === undefined) return { project: null, note: 'repo_failed' }
  if (!repo) return { project: null, note: 'no_repo' }
  const name = repo.name ?? remoteName(repo.remote)
  if (mode === 'name' && name) return { project: name, note: null }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(repo.remote ?? repo.root))
  return { project: 'h:' + [...new Uint8Array(digest)].slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join(''), note: null }
}

// the session this process is in; reset by session.start (a /clear goes on under a new id)
let sessionId = ''
let startedAt = ''
let projectName: string | null = null
let projectNote: string | null = null
let target_: Target | undefined
let lastSentLimits = ''
let lastTurnEnd = 0
const turnStart = new Map<string, number>()
// permission checks that went to the decider (tool_use_id -> tool), and whether a person was then asked (classic PermissionRequest:
// a dialog is shown; an auto-mode classifier or a rule answering is not a person)
const asked = new Map<string, { tool: string; person: boolean }>()
let perm = { asks: 0, denied: 0, waitMs: 0 }
let queue: Turn[] = [] // turns not accepted yet; resent with the next one

async function sendLimits($: EngineInterface): Promise<void> {
  const { rateLimits } = await $.session.usage()
  const limits: Limit[] = rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt }))
  if (!limits.length) return
  $.ui.status(limits.map(r => `${r.kind === 'five_hour' ? '5h' : r.kind === 'seven_day' ? '7d' : r.kind} ${r.percentUsed}%`).join(' · '))
  const key = JSON.stringify(limits)
  if (key === lastSentLimits || !target_) return
  if (await post($, target_, '/v1/limits', { limits })) lastSentLimits = key
}

async function sendActivity($: EngineInterface, end?: { at: string; reason: string }): Promise<void> {
  if (!target_ || !sessionId) return
  const turns = queue.slice(-50)
  const session = { id: sessionId, started_at: startedAt, project: projectName, project_note: projectNote, ...(end ? { ended_at: end.at, end_reason: end.reason } : {}) }
  if (await post($, target_, '/v1/activity', { session, turns })) queue = queue.filter(t => !turns.includes(t))
}

// /tracker-import, one file per step on a timer, so a big history never holds one hook past its budget
let importing = false

// where the logs are: the folder of this session's own transcript (…/projects/<project>/<session>.jsonl, from a classic hook's transcript_path),
// else <CLAUDE_CONFIG_DIR or the home folder>/.claude/projects
let transcriptPath = ''

async function projectsDir($: EngineInterface): Promise<string> {
  const m = /^(.*)[\\/][^\\/]+[\\/][^\\/]+\.jsonl$/.exec(transcriptPath)
  if (m) return m[1]
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  return `${config ?? `${home}/.claude`}/projects`
}

/** The .jsonl logs under the projects folder (sessions, and sub-agents' logs in their folders), up to three levels down. */
async function logFiles($: EngineInterface): Promise<{ base: string; files: { path: string; size: number }[] }> {
  const base = await projectsDir($)
  const files: { path: string; size: number }[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const e of await $.fs.list(dir).catch(() => [])) {
      if (e.kind === 'dir' && depth < 3) await walk(`${dir}/${e.name}`, depth + 1)
      else if (e.kind === 'file' && e.name.endsWith('.jsonl')) files.push({ path: `${dir}/${e.name}`, size: e.size })
    }
  }
  await walk(base, 0)
  return { base, files }
}

// $.fs.read takes at most 4 MiB. A bigger log is shrunk on the device first: a small program keeps, of every assistant line with usage, only what
// the parser reads (type, timestamp, sessionId, isSidechain, message id, model, the four counts), one line per message, and ./history.ts parses that.
const FS_LIMIT = 4 * 1024 * 1024 - 64 * 1024
export const SHRINK_JS = `const fs=require("fs"),rl=require("readline").createInterface({input:fs.createReadStream(process.argv[1])}),m=new Map();rl.on("line",l=>{if(!l.includes('"usage"'))return;let o;try{o=JSON.parse(l)}catch{return}const g=o&&o.message,u=g&&g.usage;if(o.type!=="assistant"||!u||typeof g.id!=="string")return;const k=["input_tokens","output_tokens","cache_read_input_tokens","cache_creation_input_tokens"],x=m.get(g.id),n={type:"assistant",timestamp:o.timestamp,sessionId:o.sessionId,isSidechain:o.isSidechain===true,message:{id:g.id,model:g.model,usage:{}}};for(const q of k)n.message.usage[q]=Math.max(Number(u[q])||0,x?x.message.usage[q]:0);if(x&&x.timestamp>n.timestamp)n.timestamp=x.timestamp;if(x&&x.isSidechain)n.isSidechain=true;m.set(g.id,n)});rl.on("close",()=>{for(const n of m.values())process.stdout.write(JSON.stringify(n)+"\\n")})`
export const SHRINK_PY = `import json,sys\nm={}\nk=["input_tokens","output_tokens","cache_read_input_tokens","cache_creation_input_tokens"]\nfor l in open(sys.argv[1],encoding="utf-8",errors="replace"):\n if '"usage"' not in l: continue\n try: o=json.loads(l)\n except Exception: continue\n g=o.get("message") if isinstance(o,dict) else None\n u=g.get("usage") if isinstance(g,dict) else None\n if o.get("type")!="assistant" or not isinstance(u,dict) or not isinstance(g.get("id"),str): continue\n x=m.get(g["id"])\n n={"type":"assistant","timestamp":o.get("timestamp"),"sessionId":o.get("sessionId"),"isSidechain":o.get("isSidechain") is True,"message":{"id":g["id"],"model":g.get("model"),"usage":{}}}\n for q in k:\n  v=u.get(q); v=v if isinstance(v,(int,float)) else 0\n  n["message"]["usage"][q]=max(v,x["message"]["usage"][q] if x else 0)\n if x and str(x["timestamp"])>str(n["timestamp"]): n["timestamp"]=x["timestamp"]\n if x and x["isSidechain"]: n["isSidechain"]=True\n m[g["id"]]=n\nfor n in m.values(): sys.stdout.write(json.dumps(n)+"\\n")\n`
export const SHRINK_PS = `$m=[ordered]@{};$k='input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens';foreach($l in [IO.File]::ReadLines($args[0])){if(-not $l.Contains('"usage"')){continue};try{$o=$l|ConvertFrom-Json}catch{continue};if($o.type -ne 'assistant' -or -not $o.message.usage -or -not $o.message.id){continue};$x=$m[$o.message.id];$u=[ordered]@{};foreach($q in $k){$v=[double]($o.message.usage.$q);if($x -and $x.message.usage[$q] -gt $v){$v=$x.message.usage[$q]};$u[$q]=$v};$t=$o.timestamp;if($x -and "$($x.timestamp)" -gt "$t"){$t=$x.timestamp};$m[$o.message.id]=[ordered]@{type='assistant';timestamp=$t;sessionId=$o.sessionId;isSidechain=($o.isSidechain -eq $true -or ($x -and $x.isSidechain));message=[ordered]@{id=$o.message.id;model=$o.message.model;usage=$u}}};foreach($n in $m.Values){$n|ConvertTo-Json -Compress -Depth 5}`

/** A log's text, shrunk on the device when it is over $.fs.read's limit; null when it cannot be read. */
async function readLog($: EngineInterface, f: { path: string; size: number }): Promise<string | null> {
  if (f.size <= FS_LIMIT) return $.fs.read(f.path).catch(() => null)
  for (const argv of [['node', '-e', SHRINK_JS, f.path], ['python3', '-c', SHRINK_PY, f.path], ['python', '-c', SHRINK_PY, f.path],
    ['powershell', '-NoProfile', '-Command', `& { ${SHRINK_PS} }`, f.path]]) {
    const r = await $.process.run(argv, { timeoutMs: 120_000 }).catch(() => null)
    if (r && r.exitCode === 0 && !r.isStdoutTruncated) return r.stdout
  }
  return null
}

function startImport($: EngineInterface, t: Target, files: { path: string; size: number }[]): void {
  importing = true
  const acc = new Map<string, HistoryTurn>()
  const total = { files: 0, found: 0, added: 0, received: 0, skipped_live: 0, invalid: 0, failed: 0, unread: 0 }
  const send = async (): Promise<void> => {
    const turns = [...acc.values()]
    acc.clear()
    for (let i = 0; i < turns.length; i += MAX_HISTORY_TURNS) {
      const r = await $.http.fetch(`${t.origin}/v1/import`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-device-token': t.token }, body: JSON.stringify({ turns: turns.slice(i, i + MAX_HISTORY_TURNS) }),
      }).catch(() => undefined)
      if (!r?.ok) { total.failed += Math.min(MAX_HISTORY_TURNS, turns.length - i); continue }
      try {
        const x = JSON.parse(r.text) as { added?: number; received?: number; skipped_live?: number; invalid?: number }
        total.added += x.added ?? 0; total.received += x.received ?? 0; total.skipped_live += x.skipped_live ?? 0; total.invalid += x.invalid ?? 0
      } catch { /* counted as sent */ }
    }
  }
  const finish = (): void => {
    importing = false
    const msg = `Імпорт історії: файлів ${total.files}, повідомлень ${total.found}; додано ${total.added}, уже були ${total.received - total.added}, ` +
      `пропущено як уже пораховані OTLP ${total.skipped_live}` + (total.invalid ? `, некоректних ${total.invalid}` : '') + (total.failed ? `, НЕ надіслано ${total.failed}` : '') +
      (total.unread ? `; не вдалося прочитати файлів: ${total.unread} (великі логи потребують node, python або PowerShell)` : '')
    $.ui.toast(msg, { timeoutMs: 15_000 })
    $.ui.status(total.failed ? 'імпорт: не все надіслано' : `імпорт: +${total.added}`)
  }
  const step = async (): Promise<void> => {
    try {
      const file = files.shift()
      if (file) {
        const text = await readLog($, file)
        if (text === null) total.unread++
        const before = acc.size
        for (const line of (text ?? '').split('\n')) addLogLine(acc, line)
        total.files++
        total.found += acc.size - before
        $.ui.status(`імпорт: файл ${total.files}, повідомлень ${total.found}`)
        if (acc.size >= MAX_HISTORY_TURNS) await send()
        $.clock.after(0, () => void step())
        return
      }
      await send()
      finish()
    } catch { importing = false; $.ui.toast('Імпорт історії перервано через помилку') }
  }
  $.clock.after(0, () => void step())
}

export const register: Register = on => {
  on('command.run', { command: 'tracker-import' }, async ($) => {
    if (importing) return { text: 'Імпорт уже триває.' }
    const t = await target($)
    if (!t) return { text: 'Немає адреси сайту чи токена: налаштуй OTLP-змінні пристрою (Пристрої → Додати пристрій).' }
    const { base, files } = await logFiles($)
    if (!files.length) return { text: `Локальних логів не знайдено (${base}).` }
    startImport($, t, files)
    return { text: `Імпорт історії почався: ${files.length} файлів. Надсилаються лише числа, модель і id; підсумок з'явиться в сповіщенні.` }
  }).catch(() => ({ text: 'Імпорт історії не вдалося запустити.' }))

  // the session's own transcript tells where the logs are, whatever the OS and the config folder
  on('classic.SessionStart', async ($, e, next) => { transcriptPath = e.transcript_path ?? ''; return next(e) })
  on('classic.UserPromptSubmit', async ($, e, next) => { transcriptPath ||= e.transcript_path ?? ''; return next(e) })

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'tracker-import', description: 'Імпорт історії токенів із локальних логів (лише числа)' }).catch(() => {})
    try {
      sessionId = await $.session.id()
      startedAt = await iso($)
      target_ = await target($)
      lastTurnEnd = 0
      let mode = target_ ? 'config_failed' : 'no_target'
      if (target_) {
        const c = await $.http.fetch(`${target_.origin}/v1/config`, { headers: { 'x-device-token': target_.token } }).catch(() => undefined)
        if (c?.ok) try { mode = String((JSON.parse(c.text) as { project?: unknown }).project ?? 'off') } catch { /* config_failed */ }
      }
      const p = await project($, mode)
      projectName = p.project
      projectNote = p.note
      await sendActivity($)
      await sendLimits($)
    } catch { /* never in the way of the session */ }
    return r
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await sendLimits($).catch(() => {})
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) turnStart.set(e.turnId, await $.clock.now())
    return next(e)
  })

  // a permission prompt to a person: tool.check's verdict is "ask" and a dialog is then shown (classic PermissionRequest for that tool);
  // the wait runs from the call's start to its end, the answer and the run together (the API shows no moment of the answer)
  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && r.decision === 'ask' && e.tool_use_id) asked.set(e.tool_use_id, { tool: e.tool, person: false })
    return r
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    if (e.agent_id === undefined) {
      const pending = [...asked.values()].find(x => x.tool === e.tool_name && !x.person)
      if (pending) pending.person = true
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const t0 = await $.clock.now()
    const r = await next(e)
    const id = (e as { tool_use_id?: string }).tool_use_id
    const a = id ? asked.get(id) : undefined
    if (id) asked.delete(id)
    if (a?.person) {
      perm.asks++
      perm.waitMs += (await $.clock.now()) - t0
      if (r.deny !== undefined) perm.denied++
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    try {
      const now = await $.clock.now()
      const started = turnStart.get(e.turnId)
      turnStart.delete(e.turnId)
      const { context } = await $.session.usage()
      queue.push({
        id: e.turnId, session: sessionId, ts: new Date(now).toISOString(), wall_ms: Math.round(e.durationMs),
        think_ms: started !== undefined && lastTurnEnd ? Math.max(0, started - lastTurnEnd) : null, outcome: e.reason,
        context_pct: context.percent ?? null, context_tokens: context.tokens ?? null, context_window: context.window ?? null,
        perm_asks: perm.asks, perm_denied: perm.denied, perm_wait_ms: Math.round(perm.waitMs),
      })
      if (queue.length > 200) queue = queue.slice(-200)
      perm = { asks: 0, denied: 0, waitMs: 0 }
      lastTurnEnd = now
      await sendActivity($)
    } catch { /* never in the way of the session */ }
    return r
  })

  on('session.end', async ($, e, next) => {
    try { if (e.sessionId === sessionId) await sendActivity($, { at: await iso($), reason: e.reason }) } catch { /* best effort */ }
    return next(e)
  })
}
