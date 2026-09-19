import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * src/ → lib/, byte for byte.
 *
 * This plugin is dependency-free ESM JavaScript: there is nothing to transpile
 * and nothing to bundle. The step exists so the package matches dsh's src/lib
 * convention — and because `lib/` is committed (a git install has no build
 * step), `--check` is what keeps the two in sync instead of a hope.
 *
 * Run with `--check` to verify instead of write; exits non-zero on drift.
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const check = process.argv.includes('--check')

const list = async (dir) => (await readdir(dir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
  .map((entry) => entry.name)
  .sort()

const files = await list(join(root, 'src'))
if (files.length === 0) throw new Error('src/ has no .js files')

const drift = []
if (!check) await mkdir(join(root, 'lib'), { recursive: true })
for (const name of files) {
  const source = await readFile(join(root, 'src', name), 'utf8')
  const target = join(root, 'lib', name)
  if (check) {
    const built = existsSync(target) ? await readFile(target, 'utf8') : undefined
    if (built !== source) drift.push(name)
    continue
  }
  await writeFile(target, source, 'utf8')
}

if (!check) {
  // Delete artifacts whose source is gone: a stale module in lib/ is a module
  // dsh can still load, which makes it worse than a missing one.
  for (const name of await list(join(root, 'lib'))) {
    if (!files.includes(name)) await rm(join(root, 'lib', name))
  }
  console.log(`built ${files.length} files → lib/`)
} else if (drift.length > 0) {
  console.error(`lib/ is out of sync with src/: ${drift.join(', ')}`)
  console.error('run: npm run build')
  process.exit(1)
} else {
  console.log(`lib/ matches src/ (${files.length} files)`)
}
