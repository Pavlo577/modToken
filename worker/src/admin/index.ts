// Admin API (/api/admin/*): only for a signed-in user, who sees only their own data.
import { accessCheck } from '../auth.ts'
import type { Env } from '../env.ts'
import { json, text } from '../util.ts'
import type { Ctx, Routes } from './context.ts'
import { dataRoutes } from './data.ts'
import { deviceRoutes } from './devices.ts'
import { historyRoutes } from './history.ts'
import { insightRoutes } from './insights.ts'
import { modStatsRoutes } from './modstats.ts'
import { statsRoutes } from './stats.ts'

const me: Routes = async ({ req, email, path }) => (path === '/me' && req.method === 'GET' ? json({ email }) : null)

const GROUPS: Routes[] = [me, deviceRoutes, historyRoutes, dataRoutes, statsRoutes, insightRoutes, modStatsRoutes]

export async function admin(req: Request, env: Env, url: URL): Promise<Response> {
  const who = await accessCheck(req, env)
  if (!('email' in who)) return text(`unauthorized: ${who.reason}`, 401) // the reason is one word the page explains
  const email = who.email
  const ctx: Ctx = { req, env, url, email, path: url.pathname.replace(/^\/api\/admin/, '') }
  for (const group of GROUPS) {
    const res = await group(ctx)
    if (res) return res
  }
  return text('not found', 404)
}
