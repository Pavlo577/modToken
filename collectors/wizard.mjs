// The guide shown when the program is opened without arguments (a double click): the first time it sets everything up,
// every later time it shows the status and sends what is new. Nothing here reads or prints the text of a conversation.
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { AGENTS } from './agents/index.mjs'
import { arg, command, configFile, link, linked, readJson, shown } from './lib/core.mjs'

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

const notifyText = {
  ours: 'підключено: після кожного ходу Codex дані йдуть самі',
  none: 'не підключено (у config.toml Codex немає рядка notify)',
  'no-config': 'не підключено (config.toml Codex ще нема)',
  other: 'у config.toml вже є чужий notify, його не чіпаю',
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
  row('Автооновлення', notifyText[agent.notifyState()])
  if (st.lastError) row('Остання помилка', `${st.lastError.message} (${when(st.lastError.at)})`)
}

/** Offers to add the `notify` line to Codex's config.toml; nothing is written without a "yes". */
async function offerNotify(rl, agent) {
  const state = agent.notifyState()
  if (state === 'ours') return out('  Автооновлення вже підключено.')
  if (state === 'other') {
    out(`  У ${agent.configToml} вже є рядок notify від іншої програми, тому я його не міняю.`)
    out('  Якщо хочеш, щоб дані йшли самі, об\'єднай їх вручну або запускай цю програму раз на кілька днів.')
    return
  }
  out(`\n  Щоб дані йшли самі після кожного ходу Codex, треба додати в ${agent.configToml} один рядок:`)
  out(`    ${agent.notifyLine()}`)
  out(`  Він лише будить цю програму й не передає їй жодного тексту. ${state === 'none' ? 'Спершу я зроблю резервну копію файлу.' : 'Файлу ще нема, його буде створено.'}`)
  if (!yes(await rl.question('  Додати? (так/ні): '))) return out('  Добре, не чіпаю. Дані підтягуватимуться, коли відкриваєш цю програму.')
  try {
    const r = agent.installNotify()
    out(`  Додано.${r.backup ? ' Копія старого файлу: ' + r.backup : ''}`)
    out('  Codex читає конфіг при запуску: перезапусти Codex, а після першого ходу відкрий цю програму й перевір «Останній синк».')
  } catch (e) {
    out(`  Не вдалося змінити конфіг: ${e instanceof Error ? e.message : e}`)
    out(`  Додай вручну на самому верху ${agent.configToml}:\n    ${agent.notifyLine()}`)
  }
}

async function firstRun(rl, agent) {
  out(`
  Token Tracker: підключення ${agent.title}
  Програма надсилає на твій сайт лише числа: токени, час, назву моделі. Тексти розмов не читаються й не надсилаються.
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
  await offerNotify(rl, agent)
  out('\n  Усе налаштовано. Відкривай цю програму знову, щоб побачити статус і докачати нове. Вікно можна закрити.')
  return true
}

async function statusLoop(rl, agent) {
  out('\n  Token Tracker: докачую нове...')
  await runSync(agent)
  for (;;) {
    showStatus(agent)
    const more = agent.notifyState() === 'ours' ? '' : ', 3 — підключити автооновлення'
    const a = (await rl.question(`\n  1 — оновити зараз, 2 — переслати все заново${more}, Enter — закрити: `)).trim()
    if (a === '1') await runSync(agent)
    else if (a === '2') await runSync(agent, true)
    else if (a === '3' && more) await offerNotify(rl, agent)
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
