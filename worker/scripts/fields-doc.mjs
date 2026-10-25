// Writes docs/OTLP-fields.md from the registry in src/otlp-fields.ts:  bun run fields
import { writeFileSync } from 'node:fs'
import { fieldsMarkdown } from '../src/otlp-fields.ts'

writeFileSync(new URL('../../docs/OTLP-fields.md', import.meta.url), fieldsMarkdown())
console.log('docs/OTLP-fields.md written')
