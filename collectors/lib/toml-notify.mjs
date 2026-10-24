// Finds and writes the top-level `notify = [...]` of Codex's config.toml without a TOML library.
// Only what is needed: an array of strings ("basic" with escapes or 'literal'), spread over several lines, with comments.

const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }

/** Index where the first [table] header starts (everything before it is the top level); text.length if none. */
const topLevelEnd = text => { const m = /^[ \t]*\[/m.exec(text); return m ? m.index : text.length }

/**
 * { start, end, argv }: `start`..`end` is the whole statement `notify = [...]` in `text`;
 * argv is the list of strings, or null when the value is not an array of plain strings (it is then left alone).
 * Returns null when there is no top-level `notify`.
 */
export function findNotify(text) {
  const head = text.slice(0, topLevelEnd(text))
  const m = /^[ \t]*notify[ \t]*=[ \t]*/m.exec(head)
  if (!m) return null
  const start = m.index
  let i = m.index + m[0].length
  const rest = () => { const nl = text.indexOf('\n', i); return nl < 0 ? text.length : nl }
  if (text[i] !== '[') return { start, end: rest(), argv: null }
  i++
  const argv = []
  for (;;) {
    while (i < text.length && /[\s,]/.test(text[i])) i++
    if (text[i] === '#') { i = rest(); continue }
    if (text[i] === ']') return { start, end: i + 1, argv }
    const q = text[i]
    if ((q !== '"' && q !== "'") || text.startsWith(q.repeat(3), i)) return { start, end: rest(), argv: null }
    i++
    let s = ''
    for (;;) {
      if (i >= text.length || text[i] === '\n') return { start, end: rest(), argv: null }
      const c = text[i]
      if (c === q) { i++; break }
      if (q === '"' && c === '\\') {
        const n = text[i + 1]
        if (n === 'u' || n === 'U') {
          const len = n === 'u' ? 4 : 8
          const code = parseInt(text.slice(i + 2, i + 2 + len), 16)
          if (!Number.isFinite(code)) return { start, end: rest(), argv: null }
          s += String.fromCodePoint(code); i += 2 + len; continue
        }
        if (!(n in ESCAPES)) return { start, end: rest(), argv: null }
        s += ESCAPES[n]; i += 2; continue
      }
      s += c; i++
    }
    argv.push(s)
  }
}

const quote = a => `"${a.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** `notify = ["a", "b"]` */
export const formatNotify = argv => `notify = [${argv.map(quote).join(', ')}]`
