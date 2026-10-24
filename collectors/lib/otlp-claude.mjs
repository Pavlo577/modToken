// Claude Code -> the Worker over OTLP, without a log reader: the settings that make Claude Code export its API-request events to
// <site>/v1/logs. The device token is NOT written into settings.json: `otelHeadersHelper` runs this program (`otlp-headers`) to get it.
// Pure functions on the parsed settings.json; the file work is in token-tracker.mjs.
export const OWN_KEYS = ['CLAUDE_CODE_ENABLE_TELEMETRY', 'OTEL_LOGS_EXPORTER', 'OTEL_METRICS_EXPORTER', 'OTEL_TRACES_EXPORTER', 'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL', 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT']

/** The env block we add. Metrics and traces stay off, prompt text is never asked for (OTEL_LOG_USER_PROMPTS is not set). */
export const otlpEnv = url => ({
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_METRICS_EXPORTER: 'none',
  OTEL_TRACES_EXPORTER: 'none',
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${url.replace(/\/$/, '')}/v1/logs`,
})

const isOurs = (doc, url, helper) => doc?.otelHeadersHelper === helper && OWN_KEYS.every(k => doc?.env?.[k] === otlpEnv(url)[k])

/** 'ours' | 'none' | 'other' (the user has their own OTEL settings: we do not touch them). */
export function otlpState(doc, url, helper) {
  if (isOurs(doc, url, helper)) return 'ours'
  const own = Object.keys(doc?.env ?? {}).some(k => k.startsWith('OTEL_') || k === 'CLAUDE_CODE_ENABLE_TELEMETRY') || doc?.otelHeadersHelper
  return own ? 'other' : 'none'
}

/** Settings with our OTLP block; throws if the user already has OTEL settings of their own (never overwritten). */
export function withOtlp(doc, url, helper) {
  const state = otlpState(doc ?? {}, url, helper)
  if (state === 'other') throw new Error('~/.claude/settings.json already has OpenTelemetry settings of its own: not changed. Remove them or add the exporter by hand (see README, OTLP).')
  return { ...doc, env: { ...doc?.env, ...otlpEnv(url) }, otelHeadersHelper: helper }
}

/** Settings without our block (only if it is exactly ours). */
export function withoutOtlp(doc, url, helper) {
  if (otlpState(doc ?? {}, url, helper) !== 'ours') return doc
  const env = { ...doc.env }
  for (const k of OWN_KEYS) delete env[k]
  const { otelHeadersHelper: _gone, env: _env, ...rest } = doc
  return Object.keys(env).length ? { ...rest, env } : rest
}
