// How our `notify` sits next to other programs' in Codex's config.toml. Codex runs one notify command only, so programs chain:
//   ours:         [our.exe, "notify", "--then", <the old command ...>]                 (we start the old command after ourselves)
//   Codex Desktop's computer-use helper keeps the previous notify itself, in its own form:
//                 [codex-computer-use.exe, "turn-ended", "--previous-notify", "<JSON array of the previous command>"]
// and it rewrites a notify it finds into that form (our line then ends up inside --previous-notify), so we read and write that form too.

export const PREVIOUS = '--previous-notify'
const norm = p => String(p).replace(/\\/g, '/').toLowerCase()
const base = p => norm(p).split('/').pop().replace(/\.exe$/, '')
const same = (a, b) => a.length === b.length && a.every((x, i) => norm(x) === norm(b[i]))

/** { at, argv }: where `--previous-notify` is in `argv` and the command inside its JSON value; null if there is none. */
export function previousOf(argv) {
  const at = argv.indexOf(PREVIOUS)
  if (at < 0 || at + 1 >= argv.length) return null
  try {
    const p = JSON.parse(argv[at + 1])
    return Array.isArray(p) && p.every(x => typeof x === 'string') ? { at, argv: p } : null
  } catch { return null }
}

/** Is the command itself ours (not only somewhere inside it)? `self`: how this program starts itself ([exe] or [node, script]). */
export const directOurs = (argv, self) => argv.slice(0, 2).some(a => norm(a) === norm(self[0]) || (self[1] && norm(a) === norm(self[1])) || base(a).startsWith('token-tracker') || /collectors\/(codex|token-tracker)\.mjs$/.test(norm(a)))

/** Is our command the notify, directly or inside a --previous-notify (however deep)? */
export function isOurs(argv, self) {
  if (directOurs(argv, self)) return true
  const p = previousOf(argv)
  return Boolean(p && isOurs(p.argv, self))
}

/** The helper that keeps the previous notify itself. */
export const isHost = argv => argv.length > 0 && base(argv[0]).startsWith('codex-computer-use')

/** `argv` without us: what was there before; null if nothing is left (the notify can go). */
export function stripOurs(argv, self) {
  if (directOurs(argv, self)) { const t = argv.indexOf('--then'); return t >= 0 && t + 1 < argv.length ? argv.slice(t + 1) : null }
  const p = previousOf(argv)
  if (p && isOurs(p.argv, self)) {
    const head = argv.slice(0, p.at), tail = argv.slice(p.at + 2)
    let rest = stripOurs(p.argv, self)
    if (rest && same(rest, head)) rest = null // that is the helper itself: kept as previous it would run twice
    return rest ? [...head, PREVIOUS, JSON.stringify(rest), ...tail] : [...head, ...tail]
  }
  return argv
}

/** Our command put in front of / inside `old` (the notify found in the config), in the form that notify understands. */
export function chainArgv(old, self) {
  const ours = [...self, 'notify']
  if (isHost(old)) {
    const p = previousOf(old)
    const mine = p ? [...ours, '--then', ...p.argv] : ours
    return p ? [...old.slice(0, p.at), PREVIOUS, JSON.stringify(mine), ...old.slice(p.at + 2)] : [...old, PREVIOUS, JSON.stringify(mine)]
  }
  return [...ours, '--then', ...old]
}
