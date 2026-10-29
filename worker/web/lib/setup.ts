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
