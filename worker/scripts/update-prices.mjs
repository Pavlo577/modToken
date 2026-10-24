#!/usr/bin/env node
// Refreshes the OpenAI prices in public/admin/prices.json from the community price list (no scraping of vendor pages).
//   node scripts/update-prices.mjs [--dry] [--force] [--file list.json]
// Entries without "auto" in prices.json (the Claude ones, anything you wrote or fixed by hand) are never touched.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { convert, merge, suspicious } from './prices-lib.mjs'

const URL_LIST = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const SOURCE = 'https://github.com/BerriAI/litellm (OpenAI)'
const target = fileURLToPath(new URL('../public/admin/prices.json', import.meta.url))
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined }
const has = n => process.argv.includes(n)

const list = arg('--file') ? JSON.parse(readFileSync(arg('--file'), 'utf8')) : await (async () => {
  const res = await fetch(URL_LIST, { headers: { 'user-agent': 'token-tracker-prices/1.0' } })
  if (!res.ok) throw new Error(`the price list answered HTTP ${res.status}`)
  return res.json()
})()

const current = JSON.parse(readFileSync(target, 'utf8'))
const generated = convert(list)
const { file, changes } = merge(current, generated, { today: new Date().toISOString().slice(0, 10), source: SOURCE })
const problems = suspicious(changes, generated)
const fmt = e => `${e.input} / ${e.cache_read} / ${e.output}`
for (const c of changes) console.log(`${c.kind.padEnd(8)} ${c.id.padEnd(28)} ${c.was ? fmt(c.was) + ' -> ' : ''}${c.now ? fmt(c.now) : ''}`)
console.log(`${generated.length} OpenAI models in the list, ${changes.length} changes (columns: input / cached / output, USD per million)`)
if (problems.length && !has('--force')) {
  console.error('Not written, the result looks wrong:\n  ' + problems.join('\n  ') + '\nCheck the list, or run with --force.')
  process.exit(1)
}
if (has('--dry')) { console.log('dry run: nothing written'); process.exit(0) }
// one model per line, like the hand-written part of the file
const head = Object.entries(file).filter(([k]) => k !== 'models').map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
const body = file.models.map(m => '    { ' + Object.entries(m).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ') + ' }')
writeFileSync(target, ['{', ...head, '  "models": [', body.join(',\n'), '  ]', '}', ''].join('\n'))
console.log('written ' + target)
