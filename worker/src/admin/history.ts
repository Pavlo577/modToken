// Admin route: POST /api/admin/import, the token history read from local logs in the browser (see ../history.ts, ../import.ts). Only numbers arrive.
import { MAX_IMPORT_BODY, importTurns } from '../import.ts'
import { MAX_HISTORY_TURNS } from '../history.ts'
import { json, text } from '../util.ts'
import type { Routes } from './context.ts'

export const historyRoutes: Routes = async ({ req, env, email, path }) => {
  if (path !== '/import' || req.method !== 'POST') return null
  const raw = await req.text()
  if (raw.length > MAX_IMPORT_BODY) return text('payload too large', 413)
  let body: { device_id?: unknown; turns?: unknown } | null
  try { body = JSON.parse(raw) } catch { body = null }
  if (!body || typeof body.device_id !== 'string' || !Array.isArray(body.turns)) return text('bad request', 400)
  if (body.turns.length > MAX_HISTORY_TURNS) return text(`at most ${MAX_HISTORY_TURNS} turns per request`, 400)

  const dev = await env.DB.prepare('SELECT id, otlp_since FROM devices WHERE id = ? AND user_email = ? AND revoked = 0').bind(body.device_id, email).first<{ id: string; otlp_since: string | null }>()
  if (!dev) return text('device not found', 404)
  return json(await importTurns(env, email, dev, body.turns))
}
