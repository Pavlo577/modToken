// Our `Stop` hook in Codex's hooks.json (next to config.toml). Shape, as Codex reads it:
//   { "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "<command line>", "timeout": 10 } ] } ] } }
// The file accepts no other top-level keys than "description" and "hooks", so nothing else is ever added.
// Several hooks live side by side (unlike `notify`), so ours never has to replace or wrap anyone's.

const norm = p => String(p).replace(/["']/g, '').replace(/\\/g, '/').toLowerCase()

/** One argument for the command line Codex hands to cmd.exe /C (Windows) or sh -lc. */
export const quoteArg = (a, platform = process.platform) => (platform === 'win32' ? `"${a}"` : `'${a.replace(/'/g, `'\\''`)}'`)

/** `"C:\path\token-tracker.exe" hook-stop` (self: [exe] or [node, script]). */
export const hookCommand = (self, platform = process.platform) => [...self.map(a => quoteArg(a, platform)), 'hook-stop'].join(' ')

/** Is this command line our hook? */
export const isOurHook = (command, self) => {
  const c = norm(command)
  return c.includes('hook-stop') && (c.includes(norm(self[0])) || (self[1] && c.includes(norm(self[1]))) || /token-tracker|collectors\/(codex|token-tracker)\.mjs/.test(c))
}

const stopGroups = doc => (doc?.hooks && Array.isArray(doc.hooks.Stop) ? doc.hooks.Stop : [])
const commandsOf = group => (Array.isArray(group?.hooks) ? group.hooks.filter(h => h && h.type === 'command' && typeof h.command === 'string') : [])

/** Does the document hold our hook? */
export const hasOurHook = (doc, self) => stopGroups(doc).some(g => commandsOf(g).some(h => isOurHook(h.command, self)))

/** The document with our hook added (a new group, nothing else touched). */
export function withHook(doc, command) {
  const out = structuredClone(doc ?? {})
  out.hooks = out.hooks && typeof out.hooks === 'object' ? out.hooks : {}
  out.hooks.Stop = Array.isArray(out.hooks.Stop) ? out.hooks.Stop : []
  out.hooks.Stop.push({ hooks: [{ type: 'command', command, timeout: 10 }] })
  return out
}

/** The document without our hook; groups and lists that become empty because of it go too. */
export function withoutHook(doc, self) {
  const out = structuredClone(doc ?? {})
  if (!out.hooks || !Array.isArray(out.hooks.Stop)) return out
  out.hooks.Stop = out.hooks.Stop.flatMap(g => {
    if (!Array.isArray(g?.hooks)) return [g]
    const rest = g.hooks.filter(h => !(h && h.type === 'command' && typeof h.command === 'string' && isOurHook(h.command, self)))
    return rest.length === g.hooks.length ? [g] : rest.length ? [{ ...g, hooks: rest }] : []
  })
  if (!out.hooks.Stop.length) delete out.hooks.Stop
  return out
}

/** Nothing left worth keeping in the file: no description and no hook of anybody's. */
export const isEmptyDoc = doc => Object.keys(doc ?? {}).every(k => k === 'hooks') && Object.keys(doc?.hooks ?? {}).length === 0
