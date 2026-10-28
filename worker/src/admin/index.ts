// Admin API (/api/admin/*): only for a signed-in user, who sees only their own data.
import { accessEmail } from '../auth.ts'
import type { Env } from '../env.ts'
import { json, text } from '../util.ts'
import type { Ctx, Routes } from './context.ts'
import { dataRoutes } from './data.ts'
import { deviceRoutes } from './devices.ts'
import { historyRoutes } from './history.ts'
import { insightRoutes } from './insights.ts'
import { modStatsRoutes } from './modstats.ts'
import { seriesRoutes } from './series.ts'
import { statsRoutes } from './stats.ts'

const me: Routes = async ({ req, email, path }) => (path === '/me' && req.method === 'GET' ? json({ email }) : null)

const GROUPS: Routes[] = [me, deviceRoutes, historyRoutes, dataRoutes, statsRoutes, insightRoutes, modStatsRoutes, seriesRoutes]

export async function admin(req: Request, env: Env, url: URL): Promise<Response> {
  const email = await accessEmail(req, env)
  if (!email) return text('unauthorized', 401)
  const ctx: Ctx = { req, env, url, email, path: url.pathname.replace(/^\/api\/admin/, '') }
  for (const group of GROUPS) {
    const res = await group(ctx)
    if (res) return res
  }
  return text('not found', 404)
}
