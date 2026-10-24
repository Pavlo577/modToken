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
