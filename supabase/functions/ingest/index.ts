import { createClient } from 'jsr:@supabase/supabase-js@2'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const sha256 = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

const int = (v: unknown) => (Number.isFinite(v) ? Math.max(0, Math.trunc(v as number)) : 0)
const str = (v: unknown, n = 200) => String(v ?? '').slice(0, n)

Deno.serve(async req => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })

  const token = req.headers.get('x-device-token') ?? ''
  const { data: dev } = await db
    .from('devices')
    .select('id, user_id')
    .eq('token_hash', await sha256(token))
    .eq('revoked', false)
    .maybeSingle()
  if (!dev) return new Response('unauthorized', { status: 401 })

  const body = await req.json().catch(() => null)
  if (!Array.isArray(body) || body.length === 0 || body.length > 500) {
    return new Response('bad request', { status: 400 })
  }

  // Owner and device come from the token, never from the client.
  const rows = body.map((r: Record<string, unknown>) => ({
    user_id: dev.user_id,
    device_id: dev.id,
    session_id: str(r.session_id),
    turn_id: str(r.turn_id),
    ts: new Date(str(r.ts)).toISOString(),
    model: str(r.model),
    input_tokens: int(r.input_tokens),
    output_tokens: int(r.output_tokens),
    cache_read_tokens: int(r.cache_read_tokens),
    cache_creation_tokens: int(r.cache_creation_tokens),
    duration_ms: int(r.duration_ms),
    is_subagent: r.is_subagent === true,
  }))

  const { error } = await db.from('token_events').upsert(rows, { onConflict: 'device_id,turn_id', ignoreDuplicates: true })
  return error ? new Response('db error', { status: 500 }) : new Response(null, { status: 204 })
})
