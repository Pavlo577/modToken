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

// A cloud session (claude.ai/code) is a fresh container each time: its "Setup script" fetches scripts/cloud-setup.sh, and the token goes in as the environment variable TRACKER_TOKEN.
export const CLOUD_SCRIPT_URL = 'https://raw.githubusercontent.com/Pavlo577/modToken/claudesolo/worker/scripts/cloud-setup.sh'
export const cloudScript = (origin: string): string => `curl -fsSL ${CLOUD_SCRIPT_URL} | bash -s -- ${origin.replace(/\/$/, '')}`
export const cloudTokenVar = (token: string): string => `TRACKER_TOKEN=${token}`
