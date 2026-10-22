import { createClient } from 'jsr:@supabase/supabase-js@2'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('')
const sha256 = async (s: string) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))))

Deno.serve(async req => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })

  const body = await req.json().catch(() => null)
  const code = String(body?.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (code.length < 8 || code.length > 20) return new Response('bad code', { status: 400 })

  const token = hex(crypto.getRandomValues(new Uint8Array(32)))
  const { data: name, error } = await db.rpc('redeem_link_code', {
    p_code_hash: await sha256(code),
    p_token_hash: await sha256(token),
  })
  if (error) return new Response('server error', { status: 500 })
  if (!name) return new Response('invalid or used code', { status: 403 })

  return Response.json({ token, device: name })
})
