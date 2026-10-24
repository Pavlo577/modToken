// Token Tracker Worker: device endpoints (token in a header), the OTLP receiver (/v1/*), the Access-protected admin API and the static page.
import { admin } from './admin/index.ts'
import { createDeviceFromCode } from './devices.ts'
import type { Env } from './env.ts'
import { importFromDevice, ingest } from './ingest.ts'
import { otlpIgnored, otlpLogs } from './otlp-ingest.ts'
import { text } from './util.ts'

export type { Env }

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/api/ingest' && req.method === 'POST') return ingest(req, env)
    if (url.pathname === '/api/link' && req.method === 'POST') return createDeviceFromCode(req, env)
    if (url.pathname === '/api/import' && req.method === 'POST') return importFromDevice(req, env)
    // OpenTelemetry (OTLP/HTTP, JSON): collectors/DATA.md, section 5
    if (url.pathname === '/v1/logs' && req.method === 'POST') return otlpLogs(req, env)
    if ((url.pathname === '/v1/metrics' || url.pathname === '/v1/traces') && req.method === 'POST') return otlpIgnored(req, env)
    if (url.pathname.startsWith('/api/admin/')) return admin(req, env, url)
    if (url.pathname.startsWith('/api/')) return text('not found', 404)
    return env.ASSETS.fetch(req)
  },
} satisfies ExportedHandler<Env>
