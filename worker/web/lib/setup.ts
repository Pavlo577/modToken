// What a device needs to export its Claude Code telemetry to this site (OTLP/HTTP JSON): the settings.json block and the same as shell variables.
export function setupEnv(origin: string, token: string): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_TRACES_EXPORTER: 'none',
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${origin.replace(/\/$/, '')}/v1/logs`,
    OTEL_EXPORTER_OTLP_LOGS_HEADERS: `x-device-token=${token}`,
  }
}

export const settingsJson = (origin: string, token: string): string => JSON.stringify({ env: setupEnv(origin, token) }, null, 2)

export const shellEnv = (origin: string, token: string): string =>
  Object.entries(setupEnv(origin, token)).map(([k, v]) => `export ${k}=${/^[\w./:=-]+$/.test(v) ? v : JSON.stringify(v)}`).join('\n')

// A cloud session (claude.ai/code) is a fresh container each time. Its "Setup script" cannot read the environment's saved variables, so it only
// installs the mod (scripts/cloud-setup.sh); the OTLP settings, the token and CLAUDE_CODE_PLUGIN_DIRS go into "Environment variables" as KEY=value lines.
// The minimum: metrics and traces are off unless an exporter is named, and the mod reads the site and the token from the OTLP variables.
export const CLOUD_SCRIPT_URL = 'https://raw.githubusercontent.com/Pavlo577/modToken/main/worker/scripts/cloud-setup.sh'
export const CLOUD_MOD_DIR = '/root/.claude/mods/token-tracker'
export const cloudScript = (): string => `curl -fsSL ${CLOUD_SCRIPT_URL} | bash`
export function cloudEnv(origin: string, token: string): string {
  const { CLAUDE_CODE_ENABLE_TELEMETRY, OTEL_LOGS_EXPORTER, OTEL_EXPORTER_OTLP_LOGS_PROTOCOL, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, OTEL_EXPORTER_OTLP_LOGS_HEADERS } = setupEnv(origin, token)
  return Object.entries({ CLAUDE_CODE_ENABLE_TELEMETRY, OTEL_LOGS_EXPORTER, OTEL_EXPORTER_OTLP_LOGS_PROTOCOL, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, OTEL_EXPORTER_OTLP_LOGS_HEADERS, CLAUDE_CODE_PLUGIN_DIRS: CLOUD_MOD_DIR })
    .map(([k, v]) => `${k}=${v}`).join('\n')
}

// A computer: one command does all of it (scripts/install.sh, scripts/install.ps1): the OTLP settings with the token, and the mod as a plugin.
const RAW_SCRIPTS = 'https://raw.githubusercontent.com/Pavlo577/modToken/main/worker/scripts'
export const pcInstallSh = (origin: string, token: string): string => `curl -fsSL ${RAW_SCRIPTS}/install.sh | bash -s -- ${origin.replace(/\/$/, '')} ${token}`
export const pcInstallPs = (origin: string, token: string): string => `& ([scriptblock]::Create((irm ${RAW_SCRIPTS}/install.ps1))) ${origin.replace(/\/$/, '')} ${token}`

// Codex CLI: the [otel] table of ~/.codex/config.toml (the HTTP protocol has no default there and must be json for this site), written by
// scripts/install-codex.sh / install-codex.ps1, or added by hand.
export const codexToml = (origin: string, token: string): string =>
  `[otel]\nlog_user_prompt = false\nexporter = { otlp-http = { endpoint = "${origin.replace(/\/$/, '')}/v1/logs", protocol = "json", headers = { "x-device-token" = "${token}" } } }`
export const codexInstallSh = (origin: string, token: string): string => `curl -fsSL ${RAW_SCRIPTS}/install-codex.sh | bash -s -- ${origin.replace(/\/$/, '')} ${token}`
export const codexInstallPs = (origin: string, token: string): string => `& ([scriptblock]::Create((irm ${RAW_SCRIPTS}/install-codex.ps1))) ${origin.replace(/\/$/, '')} ${token}`

// ---- The "Add device" box: the agent and the place it runs pick the one best way to set it up; the manual settings come last.
export type Agent = 'claude' | 'codex'
export type Place = 'windows' | 'linux' | 'cloud'
/** One step: text (`code` in backticks) and, when there is something to paste, the snippet. */
export interface Step { text: string; code?: string }
export interface Plan { steps: Step[]; manual: Step[] }

const keyLines = (env: Record<string, string>): string => Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')

export function setupPlan(agent: Agent, place: Place, origin: string, token: string): Plan {
  const host = origin.replace(/^https?:\/\//, '').replace(/[/:].*$/, '') // the network allow list takes the host name, no port
  if (agent === 'claude' && place === 'cloud') return {
    steps: [
      { text: 'claude.ai/code → середовище → «Оновити середовище». У «Скрипт налаштування» встав (він ставить мод; токена в ньому немає):', code: cloudScript() },
      { text: 'У «Змінні середовища» додай ці рядки (скрипт налаштування їх не бачить, тому токен лише тут):', code: cloudEnv(origin, token) },
      { text: `У «Доступі до мережі» дозволь \`${host}\` і \`raw.githubusercontent.com\`. Нові сесії почнуть надсилати дані.` },
    ],
    manual: [{ text: 'Без мода (лише токени, без лімітів і сесій): тільки ці змінні середовища, скрипт налаштування не потрібен:', code: keyLines(setupEnv(origin, token)) }],
  }
  if (agent === 'claude') {
    const win = place === 'windows'
    return {
      steps: [
        { text: win ? 'Відкрий PowerShell і виконай (налаштує OpenTelemetry і поставить мод: ліміти, сесії, `/tracker-import`):' : 'У терміналі виконай (налаштує OpenTelemetry і поставить мод: ліміти, сесії, `/tracker-import`):', code: win ? pcInstallPs(origin, token) : pcInstallSh(origin, token) },
        { text: 'Перезапусти Claude Code. Стару історію додасть команда `/tracker-import`.' },
      ],
      manual: [
        { text: `Додай у \`${win ? '%USERPROFILE%\\.claude\\settings.json' : '~/.claude/settings.json'}\`; якщо там уже є блок \`env\`, додай у нього ці ключі:`, code: settingsJson(origin, token) },
        ...(win ? [] : [{ text: 'Або як змінні середовища (shell):', code: shellEnv(origin, token) }]),
        { text: 'Так приходять лише токени. Ліміти й сесії надсилає мод `token-tracker`, його ставить команда вище.' },
      ],
    }
  }
  const toml = codexToml(origin, token)
  if (place === 'cloud') return {
    steps: [
      { text: 'Codex CLI у хмарному контейнері: встав у скрипт налаштування середовища (токен тоді буде в скрипті, бо Codex читає його лише з config.toml):', code: codexInstallSh(origin, token) },
      { text: `Дозволь у мережі \`${host}\` і \`raw.githubusercontent.com\`.` },
    ],
    manual: [{ text: 'Або допиши в кінець `~/.codex/config.toml` у контейнері:', code: toml }],
  }
  const win = place === 'windows'
  return {
    steps: [
      { text: win ? 'Відкрий PowerShell і виконай (допише в config.toml Codex експорт OpenTelemetry і поставить плагін лімітів):' : 'У терміналі виконай (допише в config.toml Codex експорт OpenTelemetry і поставить плагін лімітів; йому потрібен `python3`):', code: win ? codexInstallPs(origin, token) : codexInstallSh(origin, token) },
      { text: "Перезапусти Codex. Коли Codex спитає про хук плагіна token-tracker, дозволь його: він надсилає ліміти. Дані з'являться після першого запиту." },
    ],
    manual: [
      { text: `Допиши в кінець \`${win ? '%USERPROFILE%\\.codex\\config.toml' : '~/.codex/config.toml'}\`; якщо там уже є секція \`[otel]\`, додай ці ключі в неї:`, code: toml },
      { text: "`protocol = \"json\"` обов'язковий: іншого формату сайт не приймає. Текст запитів лишається вимкненим (`log_user_prompt = false`). Так приходять лише токени: ліміти надсилає плагін token-tracker для Codex, його ставить команда вище (`codex plugin add token-tracker@token-tracker-local`)." },
    ],
  }
}
