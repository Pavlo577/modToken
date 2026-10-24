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
const progress = (i, total) => stdout.write(`\r  перевіряю файли Codex: ${i} з ${total}   `)

/** Sends what is new and says in one line what happened; errors are shown, not thrown. */
async function runSync(agent, full = false) {
  try {
    const r = await agent.sync({ full, onFile: progress })
    stdout.write('\r' + ' '.repeat(50) + '\r')
    if (r.missing) out(`  ${agent.title}: теки ${agent.home} ще нема, нічого надсилати.`)
    else if (r.busy) out('  Уже йде інша синхронізація, спробуй за хвилину.')
    else out(`  Готово: нових ходів надіслано ${r.rows}${r.limits ? ', ліміти підписки оновлено' : ''} (переглянуто файлів: ${r.scanned} з ${r.files}).`)
    return true
  } catch (e) {
    stdout.write('\r' + ' '.repeat(50) + '\r')
    out(`  Не вдалося: ${e instanceof Error ? e.message : e}`)
    return false
  }
}

const hookText = {
  ours: 'підключено: після кожного ходу Codex повідомляє програму сам (Codex може один раз попросити підтвердити довіру до hook)',
  none: 'не підключено',
  unreadable: 'hooks.json у Codex не читається як JSON, тому я його не чіпаю',
}

const notifyText = {
  ours: 'підключено: після кожного ходу Codex дані йдуть самі',
  none: 'не підключено (у config.toml Codex немає рядка notify)',
  'no-config': 'не підключено (config.toml Codex ще нема)',
  other: 'не підключено: у config.toml уже є notify іншої програми (пункт 4 запропонує ланцюжок)',
}

function showStatus(agent) {
  const cfg = readJson(configFile, {}), st = agent.status()
  const row = (label, value) => out(`  ${(label + ':').padEnd(18)}${value}`)
  out()
  row('Сайт', cfg.url)
  row('Пристрій', cfg.device ?? '—')
  row(agent.title, `${agent.detect() ? 'знайдено' : 'не знайдено'} (${agent.home})`)
  row('Останній синк', when(st.lastSync))
  row('Надіслано', `${st.turns} ходів з ${st.files} файлів`)
  row('Stop-hook', hookText[agent.hookState()])
  row('Notify (запасний)', notifyText[agent.notifyState()])
  if (agent.hookState() === 'ours' || agent.notifyState() === 'ours') {
    const n = lastNotify()
    row('Останній виклик', n ? `${when(n.at)}: ${summarize(n) ?? 'викликано'}` : 'Codex ще жодного разу не викликав програму (зроби хід у Codex і відкрий знову)')
  }
  if (agent.notifyState() === 'ours') {
    for (const p of agent.notifyProblems()) row('Увага', p.kind === 'ours' ? `програму не знайдено за шляхом з config.toml (${p.program}); вимкни й підключи notify знову (пункт 4)` : `команду, що працює разом із нами, не знайдено (${p.program}): Codex, схоже, оновився; вимкни й підключи notify знову (пункт 4)`)
  }
  if (st.lastError) row('Остання помилка', `${st.lastError.message} (${when(st.lastError.at)})`)
}

/** Offers to connect the `notify` of config.toml; nothing is written without a "yes". */
async function offerNotify(rl, agent) {
  const info = agent.notifyInfo()
  if (info.state === 'ours') return out('  Автооновлення вже підключено.')
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
  out('  Спершу зроблю резервну копію config.toml і запам\'ятаю стару команду, щоб її можна було повернути (пункт 4 в меню: вимкнути notify).')
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
  out(`\n  Я прибираю свій notify з ${agent.configToml}${', а стару команду, якщо вона була, повертаю на місце'}. Спершу робиться копія файлу.`)
  if (!yes(await rl.question('  Вимкнути автооновлення? (так/ні): '))) return out('  Добре, лишаю як є.')
  try {
    const r = agent.restoreNotify()
    out(r.changed ? `  Готово.${r.restored ? ' Повернуто: ' + command(r.restored) : ''} Копія: ${r.backup}` : '  Нічого міняти не треба.')
  } catch (e) { out(`  Не вдалося: ${e instanceof Error ? e.message : e}`) }
}

/** The Stop hook: several hooks live side by side in hooks.json, so nobody has to give way (unlike the single notify). */
async function offerHook(rl, agent) {
  const state = agent.hookState()
  if (state === 'ours') return out('  Stop-hook уже підключено.')
  if (state === 'unreadable') return out(`  ${agent.hooksJson} не читається як JSON, тому я його не чіпаю. Виправ файл або додай hook вручну:\n    ${agent.hookCommand()}`)
  out(`\n  Рекомендований спосіб: Stop-hook. Codex сам викликає програму після кожного ходу, і це не заважає іншим програмам Codex (на відміну від notify, який може бути лише один).`)
  out(`  Я додам у ${agent.hooksJson} команду:\n    ${agent.hookCommand()}`)
  out('  Вона нічого не друкує й не змінює роботу Codex; з даних ходу використовує лише шлях до файлу сесії, а текст відповіді відкидає. Чужі hooks не чіпаю, перед записом роблю копію файлу.')
  if (!yes(await rl.question('  Додати? (так/ні): '))) return out('  Добре, не чіпаю.')
  try {
    const r = agent.installHook()
    out(`  Додано.${r.backup ? ' Копія старого файлу: ' + r.backup : ''}`)
    out('  Перезапусти Codex: він може один раз попросити підтвердити довіру до нового hook, підтверди. Після першого ходу відкрий цю програму й перевір «Останній виклик».')
  } catch (e) {
    out(`  Не вдалося змінити hooks.json: ${e instanceof Error ? e.message : e}`)
    out(`  Додай вручну в ${agent.hooksJson}:\n    ${agent.hookCommand()}`)
  }
}

async function offerHookRemove(rl, agent) {
  out(`\n  Я прибираю свій Stop-hook з ${agent.hooksJson}; інші hooks лишаються. Спершу робиться копія файлу.`)
  if (!yes(await rl.question('  Вимкнути Stop-hook? (так/ні): '))) return out('  Добре, лишаю як є.')
  try { const r = agent.removeHook(); out(r.changed ? `  Готово. Копія: ${r.backup}` : '  Нічого міняти не треба.') } catch (e) { out(`  Не вдалося: ${e instanceof Error ? e.message : e}`) }
}

async function firstRun(rl, agent) {
  out(`
  Token Tracker: підключення ${agent.title}
  Програма надсилає на твій сайт лише числа: токени, час, назву моделі. Тексти розмов не збираються, не зберігаються і не надсилаються.
`)
  if (!agent.detect()) {
    out(`  ${agent.title} не знайдено в ${agent.home}. Якщо він ще не запускався, запусти його один раз.`)
    out('  Якщо тека в іншому місці, задай змінну середовища CODEX_HOME і запусти програму знову.')
    if (!yes(await rl.question('  Прив\'язати пристрій усе одно? (так/ні): '))) return false
  }
  out('  1. На сайті відкрий вкладку «Пристрої», дай пристрою ім\'я (те саме, що й для Claude) і створи код.')
  for (let attempt = 1; ; attempt++) {
    const code = (await rl.question('  2. Встав код сюди: ')).replace(/[\s-]/g, '').toUpperCase()
    if (!code) { if (attempt >= 3) return false; continue }
    try {
      const { device } = await link(code, arg('--url'))
      out(`  Прив'язано як «${device}».\n`)
      break
    } catch (e) {
      out(`  Не вийшло: ${e instanceof Error ? e.message : e}`)
      if (attempt >= 3) return false
    }
  }
  out('  3. Надсилаю історію, що вже є (це безпечно повторювати, нічого не задвоїться)...')
  await runSync(agent)
  out('\n  4. Автооновлення.')
  await offerHook(rl, agent)
  if (agent.hookState() !== 'ours') await offerNotify(rl, agent) // the older way, when the hook was not wanted
  out('\n  Усе налаштовано. Відкривай цю програму знову, щоб побачити статус і докачати нове. Вікно можна закрити.')
  return true
}

async function statusLoop(rl, agent) {
  out('\n  Token Tracker: докачую нове...')
  await runSync(agent)
  for (;;) {
    showStatus(agent)
    const hookOn = agent.hookState() === 'ours', notifyOn = agent.notifyState() === 'ours'
    const a = (await rl.question(`\n  1 — оновити зараз, 2 — переслати все заново, 3 — ${hookOn ? 'вимкнути' : 'підключити'} Stop-hook, 4 — ${notifyOn ? 'вимкнути' : 'підключити'} notify, Enter — закрити: `)).trim()
    if (a === '1') await runSync(agent)
    else if (a === '2') await runSync(agent, true)
    else if (a === '3') await (hookOn ? offerHookRemove : offerHook)(rl, agent)
    else if (a === '4') await (notifyOn ? offerRestore : offerNotify)(rl, agent)
    else return
  }
}

export async function interactive() {
  const agent = AGENTS[0] // Codex is the only agent so far; later ones are listed by detect()
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    if (!linked()) {
      const done = await firstRun(rl, agent)
      if (done) await rl.question('\n  Натисни Enter, щоб закрити...')
      else out(`\n  Нічого не змінено. Спробуй ще раз, коли буде код. Підказка: ${command(shown)}`)
    } else await statusLoop(rl, agent)
  } finally { rl.close() }
}
