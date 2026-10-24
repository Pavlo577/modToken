// Calls to the admin API of the Worker.

export const api = async <T = unknown>(path: string, opts?: RequestInit): Promise<T> => {
  const r = await fetch('/api/admin' + path, opts)
  if (!r.ok) throw new Error((await r.text()) || String(r.status))
  return (r.status === 204 ? null : await r.json()) as T
}
