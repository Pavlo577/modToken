// Insights tab: what the events database knows beyond the token counts: where the money goes, speed, tools, permissions, surfaces, hooks.
import { barChart } from '../charts/bar.ts'
import { lineChart } from '../charts/line.ts'
import { COLORS } from '../charts/base.ts'
import { PALETTE } from '../core/palette.ts'
import { currentRange } from '../core/range.ts'
import { get, q } from '../core/store.ts'
import { $, el } from '../lib/dom.ts'
import { dayLabel, dayLong, fmt, fmtPct, fmtUsd } from '../lib/format.ts'

type N = number | null
interface Source { source: string | null; calls: number; output: N; fresh_input: N; cache_read: N; cost_micros: N }
interface Surface { surface: string; calls: number; sessions: number; output: N; cost_micros: N }
interface ModelRow { model: string | null; speed: string | null; calls: number; output: N; cache_read: N; fresh_input: N; cost_micros: N }
interface DayRow { day: string; source: string | null; calls: number; cost_micros: N }
interface Latency { model: string; calls: number; ttft_p50: number; ttft_p95: number; dur_p50: number; dur_p95: number; tps_p50: number }
interface Tool { tool: string | null; runs: number; ok: N; avg_ms: N; max_ms: N; avg_in_bytes: N; avg_out_bytes: N }
interface Decision { tool: string | null; decision: string | null; source: string | null; n: number }
interface Safety { reason: string | null; class: string | null; decision: string | null; n: number }
interface Hook { hook_event: string | null; hook_name: string | null; runs: number; avg_ms: N; max_ms: N; failed: N }
interface Mcp { status: string | null; error: string | null; transport: string | null; is_plugin: N; n: number; avg_ms: N }
interface Refusal { model: string | null; hop: N; n: number }
interface Session { session_id: string; surface: string; calls: number; first_ts: string; last_ts: string; output: N; cost_micros: N }
interface Prompts { day: string; prompts: number; avg_len: N }
interface Command { command: string | null; n: number }
interface Mode { from_mode: string | null; to_mode: string | null; n: number }
interface Compaction { trigger: string | null; success: string | null; n: number; avg_ms: N; avg_pre: N; avg_post: N; saved: N }
interface Subagent { agent: string | null; runs: number; avg_ms: N; avg_tools: N; avg_tokens: N; async_runs: N; swapped: N }
interface ApiError { kind: string; status: N; model: string | null; n: number; avg_attempts: N; avg_retry_ms: N }
interface Skill { skill: string | null; trigger: string | null; source: string | null; n: number }
interface Insights {
  available: boolean
  totals: { events: number; kinds: number; sessions: number; first_ts: string | null; last_ts: string | null }
  bySource: Source[]; bySurface: Surface[]; byModel: ModelRow[]; byDay: DayRow[]; latency: Latency[]
  tools: Tool[]; decisions: Decision[]; safety: Safety[]; hooks: Hook[]; mcp: Mcp[]; refusals: Refusal[]
  sessions: Session[]; prompts: Prompts[]; commands: Command[]; modes: Mode[]
  compaction: Compaction[]; subagents: Subagent[]; errors: ApiError[]; skills: Skill[]
  unknownFields: { key: string; event: string }[]
}

const usd = (micros: N): number => (micros ?? 0) / 1e6
const ms = (v: N): string => (v == null ? '—' : v >= 10_000 ? (v / 1000).toFixed(0) + ' с' : v >= 1000 ? (v / 1000).toFixed(1) + ' с' : Math.round(v) + ' мс')
const bytes = (v: N): string => (v == null ? '—' : v >= 1_048_576 ? (v / 1_048_576).toFixed(1) + ' МБ' : v >= 1024 ? (v / 1024).toFixed(1) + ' КБ' : Math.round(v) + ' Б')

/** What the exporter calls a source of a request, in words. */
const SOURCE: Record<string, string> = {
  repl_main_thread: 'Твої запити (термінал, IDE)', sdk: 'Застосунок і хмара (SDK)', generate_session_title: 'Назви сесій',
  away_summary: 'Підсумки «поки тебе не було»', compact: 'Стиснення контексту',
}
const sourceLabel = (s: string | null): string => (s ? SOURCE[s] ?? s : 'невідомо')
/** What kind of work a source is: yours, or Claude working on its own. */
const isBackground = (s: string | null): boolean => !!s && !['repl_main_thread', 'sdk'].includes(s)

const SURFACE: Record<string, string> = { 'non-interactive': 'Застосунок Claude', pycharm: 'PyCharm', 'ssh-session': 'SSH-сесія', linux: 'Хмара (Linux)', vscode: 'VS Code', cursor: 'Cursor', tmux: 'Термінал (tmux)', 'iTerm.app': 'Термінал (iTerm)' }
const surfaceLabel = (s: string): string => SURFACE[s] ?? (s || 'невідомо')

const DECISION: Record<string, string> = { config: 'за налаштуваннями', user_reject: 'відхилив ти', user_temporary: 'дозволив ти один раз', user_permanent: 'дозволив ти назавжди', hook: 'за хуком', classifier: 'за класифікатором' }

const bars = (box: HTMLElement, rows: { name: string; value: number; label: string; title?: string; color?: string }[], empty = 'Немає даних'): void => {
  const max = Math.max(1e-9, ...rows.map(r => r.value))
  box.replaceChildren(...(rows.length ? rows.map((r, i) => el('div', { class: 'hrow', style: `--c:${r.color ?? PALETTE[i % PALETTE.length]};grid-template-columns:minmax(110px,230px) 1fr auto` },
    el('span', { class: 'name', title: r.title ?? r.name }, r.name),
    el('div', { class: 'track' }, el('b', { style: `width:${(r.value / max) * 100}%` }), el('span', { class: 'hatch' })),
    el('span', { class: 'val' }, r.label))) : [el('div', { class: 'empty' }, empty)]))
}

const table = (box: HTMLElement, head: string[], rows: (string | number)[][], empty = 'Немає даних'): void => {
  box.replaceChildren(rows.length
    ? el('table', {}, el('thead', {}, el('tr', {}, ...head.map((h, i) => el('th', { class: i === 0 ? 'l' : '' }, h)))),
      el('tbody', {}, ...rows.map(r => el('tr', {}, ...r.map((c, i) => el('td', { class: i === 0 ? 'l' : '' }, String(c)))))))
    : el('div', { class: 'empty' }, empty))
}

export async function renderInsights(): Promise<void> {
  const r = currentRange()
  let d: Insights
  try { d = await get<Insights>('/insights?' + q(r.from, r.to)) } catch (e) {
    $('ins-kpis').replaceChildren(el('div', { class: 'empty', style: 'grid-column:1/-1' }, 'Не вдалося завантажити: ' + (e as Error).message)); return
  }
  $('ins-off').classList.toggle('hide', d.available)
  $('ins-body').classList.toggle('hide', !d.available)
  if (!d.available) { $('ins-kpis').replaceChildren(); return }

  const calls = d.bySource.reduce((a, s) => a + s.calls, 0)
  const cost = d.bySource.reduce((a, s) => a + usd(s.cost_micros), 0)
  const bg = d.bySource.filter(s => isBackground(s.source)).reduce((a, s) => a + usd(s.cost_micros), 0)
  const runs = d.tools.reduce((a, t) => a + t.runs, 0), okRuns = d.tools.reduce((a, t) => a + (t.ok ?? 0), 0)
  const rejected = d.decisions.filter(x => x.decision === 'reject').reduce((a, x) => a + x.n, 0)
  const decided = d.decisions.reduce((a, x) => a + x.n, 0)
  const lat = d.latency.reduce((a, l) => a + l.calls, 0)
  const ttft = lat ? d.latency.reduce((a, l) => a + l.ttft_p50 * l.calls, 0) / lat : null
  const tiles: [string, string, string, string][] = [
    ['Запитів до моделі', fmt(calls), 'var(--in)', `у ${d.totals.sessions} сесіях`],
    ['Вартість запитів', fmtUsd(cost), 'var(--out)', 'за оцінкою Claude (cost_usd)'],
    ['Фонова робота', fmtPct(cost ? bg / cost : null, 1), 'var(--cache)', 'вартості: назви, підсумки, стиснення'],
    ['Інструментів запущено', fmt(runs), 'var(--ok)', runs ? `успішно ${fmtPct(okRuns / runs)}` : 'немає даних'],
    ['Відхилено дозволів', fmt(rejected), 'var(--warn)', decided ? `з ${fmt(decided)} рішень` : 'немає даних'],
    ['Типовий TTFT', ms(ttft), 'var(--in)', 'до першого токена'],
  ]
  $('ins-kpis').replaceChildren(...tiles.map(([l, v, c, s]) => el('div', { class: 'kpi', style: `--c:${c}` }, el('div', { class: 'l' }, l), el('div', { class: 'v' }, v), el('div', { class: 's' }, s))))

  // where the money goes
  bars($('ins-source'), d.bySource.map((s, i) => ({ name: sourceLabel(s.source), value: usd(s.cost_micros), label: `${fmtUsd(usd(s.cost_micros))} · ${fmt(s.calls)}`, title: `${s.source ?? ''}: вихідні ${fmt(s.output)}, нові вхідні ${fmt(s.fresh_input)}`, color: isBackground(s.source) ? COLORS.cache : PALETTE[i % PALETTE.length] })))
  $('ins-source-note').textContent = d.bySource.some(s => isBackground(s.source)) ? 'Фіолетовим показано роботу, яку Claude робить сам, без твого повідомлення: придумує назви сесій, підсумовує, стискає контекст.' : ''
  bars($('ins-model'), d.byModel.map((m, i) => ({ name: (m.model ?? 'невідомо') + (m.speed && m.speed !== 'normal' ? ` · ${m.speed}` : ''), value: usd(m.cost_micros), label: `${fmtUsd(usd(m.cost_micros))} · ${fmt(m.calls)}`, title: `вихідні ${fmt(m.output)}, з кешу ${fmt(m.cache_read)}`, color: PALETTE[i % PALETTE.length] })))

  // money by day, by source
  const days = [...new Set(d.byDay.map(x => x.day))].sort()
  const sources = [...new Set(d.byDay.map(x => x.source ?? 'невідомо'))]
  const bySrcDay = new Map(d.byDay.map(x => [`${x.day}|${x.source ?? 'невідомо'}`, usd(x.cost_micros)]))
  const series = sources.map((s, i) => ({ label: sourceLabel(s), color: PALETTE[i % PALETTE.length], values: days.map(day => bySrcDay.get(`${day}|${s}`) ?? 0), fmt: fmtUsd }))
  $('ins-day-legend').replaceChildren(...series.map(s => el('span', {}, el('i', { style: `background:${s.color}` }), s.label)))
  barChart($('ins-day-chart'), { labels: days.map(dayLabel), series, height: 220, yFmt: v => '$' + (v >= 1 ? v.toFixed(0) : v.toFixed(2)), tipTitle: i => dayLong(days[i]) })

  table($('ins-latency'), ['Модель', 'Запитів', 'TTFT p50', 'TTFT p95', 'Відповідь p50', 'Відповідь p95', 'Токенів/с'],
    d.latency.map(l => [l.model, fmt(l.calls), ms(l.ttft_p50), ms(l.ttft_p95), ms(l.dur_p50), ms(l.dur_p95), l.tps_p50 ? String(l.tps_p50) : '—']))

  table($('ins-tools'), ['Інструмент', 'Запусків', 'Успішно', 'Сер. час', 'Сер. вхід', 'Сер. результат'],
    d.tools.map(t => [t.tool ?? 'невідомо', fmt(t.runs), fmtPct(t.runs ? (t.ok ?? 0) / t.runs : null), ms(t.avg_ms), bytes(t.avg_in_bytes), bytes(t.avg_out_bytes)]))

  const perTool = new Map<string, { accept: number; reject: number }>()
  for (const x of d.decisions) {
    const e = perTool.get(x.tool ?? 'невідомо') ?? { accept: 0, reject: 0 }
    if (x.decision === 'reject') e.reject += x.n; else e.accept += x.n
    perTool.set(x.tool ?? 'невідомо', e)
  }
  const bySource = new Map<string, number>()
  for (const x of d.decisions) bySource.set(x.source ?? 'невідомо', (bySource.get(x.source ?? 'невідомо') ?? 0) + x.n)
  table($('ins-decisions'), ['Інструмент', 'Прийнято', 'Відхилено', 'Відхилень'],
    [...perTool].sort((a, b) => b[1].accept + b[1].reject - a[1].accept - a[1].reject).map(([t, e]) => [t, fmt(e.accept), fmt(e.reject), fmtPct((e.accept + e.reject) ? e.reject / (e.accept + e.reject) : null)]))
  const extra = [...bySource].map(([s, n]) => `${DECISION[s] ?? s}: ${fmt(n)}`).join(' · ')
  table($('ins-safety'), ['Перевірки безпеки', 'Клас', 'Рішення', 'Разів'], d.safety.map(s => [s.reason ?? 'невідомо', s.class ?? '—', s.decision ?? '—', fmt(s.n)]), 'Перевірки безпеки нічого не зупиняли')
  if (extra) $('ins-safety').append(el('p', { class: 'note' }, 'Хто вирішував: ' + extra + (d.modes.length ? '. Режими дозволів: ' + d.modes.map(m => `${m.from_mode} → ${m.to_mode} ×${m.n}`).join(', ') : '')))

  table($('ins-subagents'), ['Тип', 'Запусків', 'Час', 'Інстр.', 'Контекст', 'У фоні'],
    d.subagents.map(x => [x.agent ?? 'невідомо', fmt(x.runs), ms(x.avg_ms), x.avg_tools == null ? '—' : x.avg_tools.toFixed(1), fmt(x.avg_tokens == null ? null : Math.round(x.avg_tokens)), fmt(x.async_runs ?? 0)]), 'Субагенти не запускались')
  const TRIGGER: Record<string, string> = { auto: 'автоматично', manual: 'вручну' }
  table($('ins-compaction'), ['Запуск', 'Вдало', 'Разів', 'Час', 'До', 'Після', 'Зекономл.'],
    d.compaction.map(c => [TRIGGER[c.trigger ?? ''] ?? c.trigger ?? '—', c.success === 'true' ? 'так' : c.success === 'false' ? 'ні' : '—', fmt(c.n), ms(c.avg_ms), fmt(c.avg_pre == null ? null : Math.round(c.avg_pre)), fmt(c.avg_post == null ? null : Math.round(c.avg_post)), fmt(c.saved)]), 'Стиснень не було')
  table($('ins-errors'), ['Подія', 'Код', 'Модель', 'Разів', 'Спроб', 'Ретраї'],
    d.errors.map(e => [e.kind === 'api_retries_exhausted' ? 'ретраї вичерпано' : 'помилка API', e.status ?? '—', e.model ?? '—', fmt(e.n), e.avg_attempts == null ? '—' : e.avg_attempts.toFixed(1), ms(e.avg_retry_ms)]), 'Помилок API не було')
  table($('ins-skills'), ['Скіл', 'Як запущено', 'Звідки', 'Разів'], d.skills.map(k => [k.skill ?? '—', k.trigger ?? '—', k.source ?? '—', fmt(k.n)]), 'Скілів не запускалось')

  bars($('ins-surface'), d.bySurface.map((s, i) => ({ name: surfaceLabel(s.surface), value: usd(s.cost_micros), label: `${fmtUsd(usd(s.cost_micros))} · ${s.sessions} сес.`, title: `${fmt(s.calls)} запитів, вихідні ${fmt(s.output)}`, color: PALETTE[i % PALETTE.length] })))

  const pd = d.prompts
  lineChart($('ins-prompts'), { labels: pd.map(p => dayLabel(p.day)), height: 150, series: [{ label: 'Повідомлень', color: COLORS.in, values: pd.map(p => p.prompts), fmt: v => String(v) }], yFmt: v => String(Math.round(v)), tipTitle: i => dayLong(pd[i].day) })
  table($('ins-commands'), ['Команда', 'Разів'], d.commands.map(c => ['/' + (c.command ?? ''), fmt(c.n)]), 'Команд не було')

  table($('ins-sessions'), ['Сесія', 'Де', 'Запитів', 'Вихідні', 'Тривалість', 'Вартість'],
    d.sessions.map(s => [s.session_id.slice(0, 8), surfaceLabel(s.surface), fmt(s.calls), fmt(s.output), ms(Date.parse(s.last_ts) - Date.parse(s.first_ts)), fmtUsd(usd(s.cost_micros))]))

  table($('ins-hooks'), ['Хук', 'Подія', 'Спрацювань', 'Сер. час', 'Макс.', 'З помилкою'],
    d.hooks.map(h => [h.hook_name ?? '—', h.hook_event ?? '—', fmt(h.runs), ms(h.avg_ms), ms(h.max_ms), fmt(h.failed ?? 0)]), 'Хуків не було')
  table($('ins-mcp'), ['Статус', 'Помилка', 'Транспорт', 'Разів', 'Сер. час'],
    d.mcp.map(m => [m.status ?? '—', m.error ?? '—', m.transport ?? '—', fmt(m.n), ms(m.avg_ms)]), 'MCP-серверів не було')
  table($('ins-refusals'), ['Відмови моделі', 'Крок запасного', 'Разів'], d.refusals.map(x => [x.model ?? '—', x.hop == null ? '—' : String(x.hop), fmt(x.n)]), 'Модель не відмовляла')
  $('ins-unknown').classList.toggle('hide', !d.unknownFields.length)
  $('ins-unknown-list').replaceChildren(...d.unknownFields.map(x => el('span', { class: 'tag', title: `подія ${x.event}` }, x.key)))
  $('ins-note').textContent = `У базі подій за цей період: ${fmt(d.totals.events)} подій ${d.totals.kinds} видів. Дані зберігаються 90 днів. Тексту повідомлень, пошти й ідентифікаторів тут немає.`
}
