// Token Tracker Worker: the OTLP receiver (/v1/*, device token in a header), the Access-protected admin API and the static dashboard.
import { admin } from './admin/index.ts'
import type { Env } from './env.ts'
import { otlpIgnored, otlpLogs } from './otlp-ingest.ts'
import { activityIngest, modConfig } from './activity.ts'
import { deviceImport } from './import.ts'
import { limitsIngest } from './limits.ts'
import { text } from './util.ts'

export type { Env }

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    // OpenTelemetry (OTLP/HTTP, JSON): docs/OTLP.md
    if (url.pathname === '/v1/logs' && req.method === 'POST') return otlpLogs(req, env)
    if ((url.pathname === '/v1/metrics' || url.pathname === '/v1/traces') && req.method === 'POST') return otlpIgnored(req, env)
    if (url.pathname === '/v1/limits' && req.method === 'POST') return limitsIngest(req, env) // the mod's rate-limit readings
    if (url.pathname === '/v1/activity' && req.method === 'POST') return activityIngest(req, env) // the mod's sessions and turns
    if (url.pathname === '/v1/import' && req.method === 'POST') return deviceImport(req, env) // the mod's /tracker-import: history from local logs
    if (url.pathname === '/v1/config' && req.method === 'GET') return modConfig(req, env) // what the device lets the mod send
    if (url.pathname.startsWith('/api/admin/')) return admin(req, env, url)
    if (url.pathname.startsWith('/api/')) return text('not found', 404)
    return env.ASSETS.fetch(req)
  },
} satisfies ExportedHandler<Env>
