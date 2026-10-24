import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const roots = ['src', 'shared', 'dev', 'workers/app/src', 'koreader/marginalia.koplugin']
const failures = []
async function inspect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await inspect(path)
    else if (/\.(tsx?|lua)$/.test(path)) {
      const source = await readFile(path, 'utf8')
      const count = source.split('\n').length
      if (count > 750) failures.push(`${path}: ${count} lines exceeds module budget`)
      if (path.startsWith('workers/') && /from ['"].*src\/(components|pages|db)/.test(source))
        failures.push(`${path}: Worker imports browser application code`)
      if (/\b(?:TODO|FIXME)\b(?![^\n]*#\d)/.test(source))
        failures.push(`${path}: debt marker needs an issue number`)
    }
  }
}
for (const root of roots) await inspect(root)
if (failures.length) {
  console.error(failures.join('\n'))
  process.exitCode = 1
} else console.log('Module size, boundaries, and debt checks passed')
