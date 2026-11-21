// SQLite for the Antigravity collector: `bun:sqlite` inside the compiled program and under `bun test`, `node:sqlite` under Node.
// The specifier is computed so that `bun build` does not try to resolve `node:sqlite` at build time.
const isBun = typeof Bun !== 'undefined'
let driver

const specifier = isBun ? 'bun:sqlite' : 'node:sqlite'
const load = async () => (driver ??= await import(specifier))

/**
 * Opens a database. `readOnly` for the agent's files (never writes to them; a writer such as Antigravity can be using them).
 * The result has `all(sql, ...params)`, `exec(sql)`, `run(sql, ...params)` and `close()`.
 */
export async function openSqlite(path, { readOnly = false } = {}) {
  const mod = await load()
  const db = isBun ? new mod.Database(path, readOnly ? { readonly: true } : { create: true }) : new mod.DatabaseSync(path, { readOnly })
  if (readOnly) { try { db.exec('PRAGMA busy_timeout = 2000') } catch { /* the pragma is only a convenience */ } }
  return {
    all: (sql, ...p) => db.prepare(sql).all(...p),
    run: (sql, ...p) => db.prepare(sql).run(...p),
    exec: sql => db.exec(sql),
    close: () => db.close(),
  }
}
