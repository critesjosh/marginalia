// Validate documentation/configuration using only repository fixtures.
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

for (const entry of await readdir('.github', { recursive: true })) {
  if (!entry.endsWith('.yml')) continue
  const parsed = parse(await readFile(join('.github', entry), 'utf8'))
  assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), entry)
}
const api = parse(await readFile('docs/api.openapi.yml', 'utf8'))
assert(api.openapi === '3.1.0', 'OpenAPI version must be 3.1.0')
const paths = Object.keys(api.paths).sort().join(',')
assert(
  paths ===
    '/api/books,/api/books/{id},/api/chat,/api/covers,/api/gutenberg,/api/threads,/api/threads/{id},/b/{id},/b/{id}/cover,/health,/t/{id}',
  `Unexpected API paths: ${paths}`,
)
const container = JSON.parse(await readFile('.devcontainer/devcontainer.json', 'utf8'))
assert(
  container.postCreateCommand ===
    'npm run setup && npx --no-install playwright install --with-deps chromium firefox webkit',
  'Unexpected devcontainer postCreateCommand',
)
assert(container.waitFor === 'postCreateCommand', 'Devcontainer must wait for setup')
assert((await stat('.devcontainer/smoke.sh')).isFile(), 'Missing devcontainer smoke check')
console.log('Workflow, API, and devcontainer contracts passed')
