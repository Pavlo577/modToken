// Small helpers shared by the Worker modules.
const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('')
export const sha256 = async (s: string) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))))
export const randomHex = (bytes: number) => hex(crypto.getRandomValues(new Uint8Array(bytes)))

export const json = (data: unknown, status = 200) => Response.json(data, { status })
export const text = (msg: string, status: number) => new Response(msg, { status })

/** A non-negative integer from untrusted input (0 for anything else). */
export const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0)
/** A string from untrusted input, cut to `n` characters. */
export const str = (v: unknown, n = 200) => String(v ?? '').slice(0, n)
