// The guide shown when the program is opened without arguments (a double click): the first time it sets everything up,
// every later time it shows the status and sends what is new. Nothing here reads or prints the text of a conversation.
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { AGENTS } from './agents/index.mjs'
import { arg, command, configFile, link, linked, readJson, shown } from './lib/core.mjs'
import { lastNotify, summarize } from './lib/notify-log.mjs'

const out = (s = '') => console.log(s)
const when = iso => (iso ? new Date(iso).toLocaleString('uk-UA', { dateStyle: 'medium', timeStyle: 'short' }) : 'ще не було')
const yes = s => /^(т|так|y|yes)$/i.test(s.trim())
const progress = title => (i, total) => stdout.write(`\r  перевіряю файли ${title}: ${i} з ${total}   `)
const clear = () => stdout.write('\r' + ' '.repeat(60) + '\r')

/** Collected now: Codex when it is on the machine, Claude Code only after the user chose it. */
const enabledAgents = () => AGENTS.filter(a => (a.enabled ?? a.detect).call(a))
const hasNotify = agent => typeof agent.notifyInfo === 'function'

/** After the hook is added the agent has to be restarted to pick it up. */
const AFTER_HOOK = {
  claude: 'Перезапусти Claude Code (він читає settings.json при запуску). Після першого ходу відкрий цю програму й перевір «Останній виклик».',
  codex: 'Перезапусти Codex: він може один раз попросити підтвердити довіру до нового hook, підтверди. Після першого ходу відкрий цю програму й перевір «Останній виклик».',
}
const HOOK_WHY = {
  claude: 'Claude Code сам викликає програму після кожного ходу. Дані беруться з його журналу сесії, а підписочні ліміти й далі шле мод (у нього більше нічого не лишилось).',
  codex: 'Codex сам викликає програму після кожного ходу, і це не заважає іншим програмам Codex (на відміну від notify, який може бути лише один).',
}

/** Sends what is new and says in one line what happened; errors are shown, not thrown. */
async function runSync(agent, full = false) {
  try {
    const r = await agent.sync({ full, onFile: progress(agent.title) })
    clear()
    if (r.missing) out(`  ${agent.title}: теки ${agent.home} ще нема, нічого надсилати.`)
    else if (r.busy) out(`  ${agent.title}: уже йде інша синхронізація, спробуй за хвилину.`)
    else out(`  ${agent.title}: нових ходів надіслано ${r.rows}${r.limits ? ', ліміти підписки оновлено' : ''} (переглянуто файлів: ${r.scanned} з ${r.files}).`)
    return true
  } catch (e) {
    clear()
    out(`  ${agent.title}: не вдалося: ${e instanceof Error ? e.message : e}`)
    return false
  }
}

/** The old history of an agent that keeps one apart (Claude Code); safe to repeat. */
async function runImport(agent) {
  try {
    const r = await agent.importHistory({ onFile: progress(agent.title) })
    clear()
    if (r.missing) out(`  ${agent.title}: журналів ще нема.`)
    else if (r.busy) out(`  ${agent.title}: уже йде інша операція, спробуй за хвилину.`)
    else out(`  ${agent.title}: у журналах ${r.turns} ходів, додано ${r.inserted}, уже були ${r.duplicates}, новіші за прив'язку пристрою ${r.afterLink} (їх збирає хук).`)
  } catch (e) {
    clear()
    out(`  ${agent.title}: історія не надіслалась: ${e instanceof Error ? e.message : e}`)
  }
}

const hookText = {
  ours: 'підключено: після кожного ходу агент повідомляє програму сам',
  none: 'не підключено',
  unreadable: 'файл налаштувань агента не читається як JSON, тому я його не чіпаю',
}

const notifyText = {
  ours: 'підключено: після кожного ходу Codex дані йдуть самі',
  none: 'не підключено (у config.toml Codex немає рядка notify)',
  'no-config': 'не підключено (config.toml Codex ще нема)',
  other: 'не підключено: у config.toml уже є notify іншої програми (запропоную ланцюжок)',
}

function showStatus(agent) {
  const st = agent.status()
  const row = (label, value) => out(`  ${(label + ':').padEnd(20)}${value}`)
  out(`\n  ── ${agent.title}`)
  row('Знайдено', `${agent.detect() ? 'так' : 'ні'} (${agent.home})`)
  row('Останній синк', when(st.lastSync))
  row('Надіслано', `${st.turns} ходів з ${st.files} файлів`)
  row('Stop-hook', hookText[agent.hookState()])
  if (hasNotify(agent)) row('Notify (запасний)', notifyText[agent.notifyState()])
  if (agent.hookState() === 'ours' || (hasNotify(agent) && agent.notifyState() === 'ours')) {
    const n = lastNotify(agent.id)
    row('Останній виклик', n ? `${when(n.at)}: ${summarize(n) ?? 'викликано'}` : `${agent.title} ще жодного разу не викликав програму (зроби хід і відкрий знову)`)
  }
  if (hasNotify(agent) && agent.notifyState() === 'ours') {
    for (const p of agent.notifyProblems()) row('Увага', p.kind === 'ours' ? `програму не знайдено за шляхом з config.toml (${p.program}); вимкни й підключи notify знову` : `команду, що працює разом із нами, не знайдено (${p.program}): Codex, схоже, оновився; вимкни й підключи notify знову`)
  }
  if (st.lastError) row('Остання помилка', `${st.lastError.message} (${when(st.lastError.at)})`)
}

/** Offers to connect the `notify` of config.toml (Codex's older way); nothing is written without a "yes". */
async function offerNotify(rl, agent) {
  const info = agent.notifyInfo()
  if (info.state === 'ours') return out('  Автооновлення через notify уже підключено.')
  if (info.state === 'other') return offerChain(rl, agent, info.argv)
  out(`\n  Щоб дані йшли самі після кожного ходу Codex, треба додати в ${agent.configToml} один рядок:`)
  out(`    ${agent.notifyLine()}`)
  out(`  Він лише будить цю програму й не передає їй жодного тексту. ${info.state === 'none' ? 'Спершу я зроблю резервну копію файлу.' : 'Файлу ще нема, його буде створено.'}`)
  if (!yes(await rl.question('  Додати? (так/ні): '))) return out('  Добре, не чіпаю. Дані підтягуватимуться, коли відкриваєш цю програму.')
  apply(agent, () => agent.installNotify(), 'Додано.')
}

/** Codex runs one notify command only: ours goes first and starts the old one after itself, with the same arguments. */
async function offerChain(rl, agent, argv) {
  out(`\n  У ${agent.configToml} вже є notify іншої програми, а Codex дозволяє лише одну команду.`)
  if (!argv?.length) {
    out('  Я не можу безпечно прочитати цей рядок, тому нічого не змінюю.')
    out(`  Якщо хочеш автооновлення, об'єднай команди вручну: нехай твоя команда запускає «${command(shown)} sync», або запускай цю програму раз на кілька днів.`)
    return
  }
  out(`  Зараз там: ${command(argv)}`)
  out('  Я додамся поруч так, щоб стара команда працювала як раніше: після кожного ходу я надішлю числа, а вона отримає ті самі аргументи й той самий JSON від Codex.')
  out(`  Новий рядок:\n    ${agent.chainLine(argv)}`)
  out('  Спершу зроблю резервну копію config.toml і запам\'ятаю стару команду, щоб її можна було повернути (вимкнути notify можна в меню).')
  if (!yes(await rl.question('  Зробити так? (так/ні): '))) return out('  Добре, не чіпаю. Дані підтягуватимуться, коли відкриваєш цю програму.')
  apply(agent, () => agent.installNotify({ chain: true }), 'Готово: стара команда збережена й працюватиме як раніше.')
}

function apply(agent, action, doneText) {
  try {
    const r = action()
    out(`  ${doneText}${r.backup ? ' Копія старого файлу: ' + r.backup : ''}`)
    out('  Codex читає конфіг при запуску: перезапусти Codex, а після першого ходу відкрий цю програму й перевір «Останній синк».')
  } catch (e) {
    out(`  Не вдалося змінити конфіг: ${e instanceof Error ? e.message : e}`)
    out(`  Файл не зіпсовано (копія поруч, якщо вона встигла створитись). Додай вручну: ${agent.notifyLine()}`)
  }
}

async function offerRestore(rl, agent) {
  out(`\n  Я прибираю свій notify з ${agent.configToml}, а стару команду, якщо вона була, повертаю на місце. Спершу робиться копія файлу.`)
  if (!yes(await rl.question('  Вимкнути notify? (так/ні): '))) return out('  Добре, лишаю як є.')
  try {
    const r = agent.restoreNotify()
    out(r.changed ? `  Готово.${r.restored ? ' Повернуто: ' + command(r.restored) : ''} Копія: ${r.backup}` : '  Нічого міняти не треба.')
  } catch (e) { out(`  Не вдалося: ${e instanceof Error ? e.message : e}`) }
}

/** The Stop hook: several hooks live side by side in the agent's settings, so nobody has to give way (unlike Codex's single notify). */
async function offerHook(rl, agent) {
  const state = agent.hookState()
  if (state === 'ours') return out(`  ${agent.title}: Stop-hook уже підключено.`)
  if (state === 'unreadable') return out(`  ${agent.hooksJson} не читається як JSON, тому я його не чіпаю. Виправ файл або додай hook вручну:\n    ${agent.hookCommand()}`)
  out(`\n  ${agent.title}: рекомендований спосіб автооновлення: Stop-hook. ${HOOK_WHY[agent.id] ?? ''}`)
  out(`  Я додам у ${agent.hooksJson} команду:\n    ${agent.hookCommand()}`)
  out('  Вона нічого не друкує й не змінює роботу агента; з даних ходу використовує лише шлях до журналу сесії, а текст відповіді відкидає. Чужі hooks не чіпаю, перед записом роблю копію файлу.')
  if (!yes(await rl.question('  Додати? (так/ні): '))) return out('  Добре, не чіпаю.')
  try {
    const r = agent.installHook()
    out(`  Додано.${r.backup ? ' Копія старого файлу: ' + r.backup : ''}`)
    out(`  ${AFTER_HOOK[agent.id] ?? 'Перезапусти агента.'}`)
  } catch (e) {
    out(`  Не вдалося змінити ${agent.hooksJson}: ${e instanceof Error ? e.message : e}`)
    out(`  Додай вручну:\n    ${agent.hookCommand()}`)
  }
}

async function offerHookRemove(rl, agent) {
  out(`\n  Я прибираю свій Stop-hook з ${agent.hooksJson}; інші hooks лишаються. Спершу робиться копія файлу.`)
  if (!yes(await rl.question('  Вимкнути Stop-hook? (так/ні): '))) return out('  Добре, лишаю як є.')
  try { const r = agent.removeHook(); out(r.changed ? `  Готово. Копія: ${r.backup}` : '  Нічого міняти не треба.') } catch (e) { out(`  Не вдалося: ${e instanceof Error ? e.message : e}`) }
}

/** Everything for one agent after the device is linked: its history, what is new, the Stop hook (Codex: the older notify as a fallback). */
async function setupAgent(rl, agent) {
  out(`\n  ── ${agent.title}`)
  agent.enable?.()
  if (agent.importHistory) { out('  Надсилаю історію, що була до прив\'язки пристрою (це безпечно повторювати, нічого не задвоїться)...'); await runImport(agent) }
  out('  Надсилаю нове...')
  await runSync(agent)
  await offerHook(rl, agent)
  if (hasNotify(agent) && agent.hookState() !== 'ours') await offerNotify(rl, agent) // the older way, when the hook was not wanted
}

async function firstRun(rl) {
  out(`
  Token Tracker: надсилання токенів Claude Code і Codex на твій сайт
  Програма надсилає лише числа: токени, час, назву моделі. Тексти розмов не збираються, не зберігаються і не надсилаються.
`)
  const found = AGENTS.filter(a => a.detect())
  if (!found.length) {
    out('  Не знайдено ні Claude Code, ні Codex (їхніх тек у домашній теці). Якщо вони ще не запускались, запусти їх один раз.')
    out('  Якщо теки в іншому місці, задай змінні середовища CLAUDE_CONFIG_DIR / CODEX_HOME і запусти програму знову.')
    if (!yes(await rl.question('  Прив\'язати пристрій усе одно? (так/ні): '))) return false
  } else out(`  Знайдено: ${found.map(a => a.title).join(', ')}.\n`)
  if (found.some(a => a.id === 'claude')) {
    out('  Увага: якщо на цьому комп\'ютері мод Claude Code вже був підключений (/tracker-link), НЕ прив\'язуй пристрій тут вдруге: інакше історія порахується двічі.')
    out('  Онови мод (/plugin update), запусти Claude Code один раз: нова версія мода передасть прив\'язку цій програмі, і код не потрібен.')
    if (yes(await rl.question('  Мод уже був підключений на цьому комп\'ютері? (так/ні): '))) { out('\n  Тоді спершу онови мод, запусти Claude Code і відкрий цю програму знову.'); return false }
  }
  out('  1. На сайті відкрий вкладку «Пристрої», дай пристрою ім\'я і створи код.')
  for (let attempt = 1; ; attempt++) {
    const code = (await rl.question('  2. Встав код сюди: ')).replace(/[\s-]/g, '').toUpperCase()
    if (!code) { if (attempt >= 3) return false; continue }
    try {
      const { device } = await link(code, arg('--url'))
      out(`  Прив'язано як «${device}».`)
      break
    } catch (e) {
      out(`  Не вийшло: ${e instanceof Error ? e.message : e}`)
      if (attempt >= 3) return false
    }
  }
  for (const agent of found) {
    // Claude Code is collected only when the user says so; Codex has always been the reason people run the program
    if (agent.enable && !yes(await rl.question(`\n  Надсилати й ходи ${agent.title}? (так/ні): `))) continue
    await setupAgent(rl, agent)
  }
  out('\n  Усе налаштовано. Відкривай цю програму знову, щоб побачити статус і докачати нове. Вікно можна закрити.')
  return true
}

/** The automatic-update switches of every agent, numbered; picking one turns it on or off. */
async function updateMenu(rl) {
  const items = []
  for (const agent of AGENTS.filter(a => a.detect())) {
    items.push({ label: `${agent.title}: Stop-hook`, on: agent.hookState() === 'ours', toggle: () => (agent.hookState() === 'ours' ? offerHookRemove : offerHook)(rl, agent) })
    if (hasNotify(agent)) items.push({ label: `${agent.title}: notify (запасний)`, on: agent.notifyState() === 'ours', toggle: () => (agent.notifyState() === 'ours' ? offerRestore : offerNotify)(rl, agent) })
  }
  if (!items.length) return out('  Нічого налаштовувати: агентів не знайдено.')
  out()
  items.forEach((it, i) => out(`  ${i + 1} — ${it.label}: ${it.on ? 'підключено' : 'не підключено'}`))
  const n = Number((await rl.question('  Який перемкнути? (номер, Enter — нічого): ')).trim())
  if (items[n - 1]) await items[n - 1].toggle()
}

async function statusLoop(rl) {
  out('\n  Token Tracker: докачую нове...')
  for (const agent of enabledAgents()) await runSync(agent)
  for (;;) {
    const cfg = readJson(configFile, {})
    out(`\n  Сайт: ${cfg.url}   Пристрій: ${cfg.device ?? '—'}`)
    for (const agent of enabledAgents()) showStatus(agent)
    const off = AGENTS.filter(a => a.detect() && !enabledAgents().includes(a))
    for (const a of off) out(`\n  ${a.title} знайдено, але не підключено (пункт 4).`)
    const a = (await rl.question(`\n  1 — оновити зараз, 2 — переслати все заново, 3 — автооновлення (hook, notify)${off.length ? ', 4 — підключити ' + off.map(x => x.title).join(', ') : ''}, Enter — закрити: `)).trim()
    if (a === '1') for (const agent of enabledAgents()) await runSync(agent)
    else if (a === '2') for (const agent of enabledAgents()) await runSync(agent, true)
    else if (a === '3') await updateMenu(rl)
    else if (a === '4' && off.length) for (const agent of off) { if (yes(await rl.question(`\n  Надсилати ходи ${agent.title}? (так/ні): `))) await setupAgent(rl, agent) }
    else return
  }
}

export async function interactive() {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    if (!linked()) {
      const done = await firstRun(rl)
      if (done) await rl.question('\n  Натисни Enter, щоб закрити...')
      else out(`\n  Нічого не змінено. Спробуй ще раз, коли буде код. Підказка: ${command(shown)}`)
    } else await statusLoop(rl)
  } finally { rl.close() }
}
