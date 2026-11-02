// Calls to the admin API of the Worker.

/** What a refused login means, by the one word the Worker gives (src/auth.ts). */
const AUTH_TEXT: Record<string, string> = {
  'no-token': 'Cloudflare Access не передав вхід: сеанс скинуто або сторінку відкрито не через захищену адресу.',
  expired: 'Сеанс входу закінчився.',
  clock: 'Годинник Cloudflare Access і сайту розійшлися: вхід ще «не дійсний». Спробуй за хвилину.',
  'no-email': 'Вхід без пошти (сервісний токен Cloudflare Access), а дашборд показує дані людини.',
  audience: 'Вхід виданий іншим застосунком Cloudflare Access, ніж очікує сайт (POLICY_AUD).',
  issuer: 'Вхід виданий іншою командою Cloudflare Access (TEAM_DOMAIN).',
  keys: 'Не вдалося перевірити вхід: ключі Cloudflare Access тимчасово недоступні.',
  signature: 'Підпис входу не пройшов перевірку.',
  invalid: 'Вхід не пройшов перевірку.',
}

/** A bar at the top: why the login was refused, and a way to sign in again (Access's own logout clears the session, the reload signs in). */
function authBar(reason: string): void {
  if (document.getElementById('auth-bar')) return
  const bar = document.createElement('div')
  bar.id = 'auth-bar'
  bar.className = 'auth-bar'
  const msg = document.createElement('span')
  msg.textContent = `Не авторизовано. ${AUTH_TEXT[reason] ?? AUTH_TEXT.invalid}`
  const again = document.createElement('button')
  again.textContent = 'Увійти знову'
  again.onclick = () => { again.disabled = true; void fetch('/cdn-cgi/access/logout', { credentials: 'include' }).catch(() => undefined).finally(() => location.reload()) }
  bar.append(msg, again)
  document.body.prepend(bar)
}

export const api = async <T = unknown>(path: string, opts?: RequestInit): Promise<T> => {
  const r = await fetch('/api/admin' + path, opts)
  if (!r.ok) {
    const body = await r.text()
    if (r.status === 401) authBar(/^unauthorized: ([a-z-]+)$/.exec(body)?.[1] ?? 'invalid')
    throw new Error(r.status === 401 ? 'не авторизовано' : body || String(r.status))
  }
  return (r.status === 204 ? null : await r.json()) as T
}
