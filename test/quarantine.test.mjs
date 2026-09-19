/**
 * §8.4 verification-environment quarantine.
 *
 * Two behaviours carry the whole point: a check command may not reach for the
 * answer (`.git`, `.env`, keys), and a tree that escapes itself is refused
 * rather than verified. Both are pure enough to test without a workspace, and
 * the scan is exercised against a fake `fs` so the walk's pruning is visible.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  QUARANTINE_NAMES,
  QUARANTINE_SUFFIXES,
  commandTouchesQuarantine,
  escapesRoot,
  isQuarantined,
  quarantineIgnore,
  quarantineSummary,
  scanVerificationEnv,
} from '../src/quarantine.js'

test('the quarantine lists are the design’s, verbatim', () => {
  assert.deepEqual(QUARANTINE_NAMES, [
    '.git',
    '.env',
    '.env.local',
    '.ssh',
    '.aws',
    '.gnupg',
    '.netrc',
    'credentials',
    'id_rsa',
    'id_dsa',
    'id_ecdsa',
    'id_ed25519',
  ])
  assert.deepEqual(QUARANTINE_SUFFIXES, ['.pem', '.key', '.p12', '.pfx'])
})

test('isQuarantined is case-insensitive and matches names or suffixes', () => {
  assert.equal(isQuarantined('.GIT'), true)
  assert.equal(isQuarantined('id_rsa'), true)
  assert.equal(isQuarantined('server.pem'), true)
  assert.equal(isQuarantined('release.P12'), true)
  assert.equal(isQuarantined('environment.ts'), false)
  assert.equal(isQuarantined(''), false)
  assert.deepEqual(quarantineIgnore(['.git', 'src', 'key.pem', 'README.md']), ['.git', 'key.pem'])
})

test('commandTouchesQuarantine catches the answer-fishing shapes', () => {
  assert.equal(commandTouchesQuarantine('git show HEAD~1 -p'), 'git-history')
  assert.equal(commandTouchesQuarantine('git cherry-pick abc123'), 'git-history')
  assert.equal(commandTouchesQuarantine('cat .git/HEAD'), '.git')
  assert.equal(commandTouchesQuarantine('source .env && pytest'), '.env')
  assert.equal(commandTouchesQuarantine('ls ~/.ssh'), '.ssh')
  assert.equal(commandTouchesQuarantine('openssl pkey -in cert.pem'), '.pem')
  assert.equal(commandTouchesQuarantine('cat credentials'), 'credentials')
})

test('commandTouchesQuarantine leaves honest checks alone', () => {
  assert.equal(commandTouchesQuarantine('node --test tests/'), undefined)
  assert.equal(commandTouchesQuarantine('npm run build'), undefined)
  assert.equal(commandTouchesQuarantine('grep -n TODO src/*.ts'), undefined)
  assert.equal(commandTouchesQuarantine('pytest -k environment'), undefined)
  assert.equal(commandTouchesQuarantine('git diff --stat'), undefined)
  assert.equal(commandTouchesQuarantine(''), undefined)
})

test('escapesRoot resolves relative targets, including above the root', () => {
  assert.equal(escapesRoot('/w', 'seed', '/home/user/.ssh'), true)
  assert.equal(escapesRoot('/w', 'seed', '/w/src/app.ts'), false)
  assert.equal(escapesRoot('/w', 'seed', '/w'), false)
  assert.equal(escapesRoot('/w', 'a/b/seed', '../../../outside'), true)
  assert.equal(escapesRoot('/w', 'a/b/seed', '../../outside'), false)
  assert.equal(escapesRoot('/w', 'a/b/seed', '../c/target'), false)
  assert.equal(escapesRoot('/w', 'a/seed', './target'), false)
})

/** A tiny in-memory tree: { 'path': 'dir' | { symlink: target } }. */
function fakeFs(tree) {
  return {
    async readdir(path) {
      const prefix = path.endsWith('/') ? path : `${path}/`
      const seen = new Set()
      const out = []
      for (const [key, value] of Object.entries(tree)) {
        if (!`${key}/`.startsWith(prefix) && key !== path) continue
        const rest = key.slice(prefix.length)
        if (rest.length === 0 || rest.includes('/')) continue
        const child = key
        if (seen.has(child)) continue
        seen.add(child)
        const kind = typeof value === 'string' ? value : value !== null && typeof value === 'object' && 'symlink' in value ? 'symlink' : 'file'
        out.push({
          name: rest,
          isDirectory: () => kind === 'dir',
          isSymbolicLink: () => kind === 'symlink',
          ...(kind === 'symlink' ? {} : {}),
        })
      }
      return out
    },
    async readlink(path) {
      const value = tree[path]
      return typeof value === 'object' && value !== null ? value.symlink : undefined
    },
  }
}

test('scanVerificationEnv finds quarantined entries, prunes .git, and flags escapes', async () => {
  const fs = fakeFs({
    '/w/src': 'dir',
    '/w/src/app.ts': 'file',
    '/w/.git': 'dir',
    '/w/.git/objects': 'dir',
    '/w/.env': 'file',
    '/w/tests': 'dir',
    '/w/server.pem': 'file',
    '/w/seed': { symlink: '/home/user/.ssh' },
    '/w/link': { symlink: 'src/app.ts' },
  })
  const report = await scanVerificationEnv({ fs, root: '/w' })
  const paths = report.quarantined.map((entry) => entry.path).sort()
  assert.deepEqual(paths, ['.env', '.git', 'server.pem'])
  assert.deepEqual(report.escapingSymlinks.map((entry) => entry.path), ['seed'])
  assert.deepEqual(report.symlinks.map((entry) => entry.path).sort(), ['link', 'seed'])
  assert.equal(report.truncated, false)
})

test('scanVerificationEnv stops at the limit and says so', async () => {
  const tree = { '/w/src': 'dir' }
  for (let index = 0; index < 50; index += 1) tree[`/w/src/f${index}.ts`] = 'file'
  const report = await scanVerificationEnv({ fs: fakeFs(tree), root: '/w', limit: 10 })
  assert.equal(report.truncated, true)
  assert.ok(report.inspected <= 11)
})

test('scanVerificationEnv counts unreadable directories instead of reporting clean', async () => {
  const report = await scanVerificationEnv({
    fs: {
      readdir: async () => {
        throw new Error('EACCES')
      },
    },
    root: '/w',
  })
  assert.equal(report.inspected, 0)
  assert.equal(report.errors, 1)
  assert.deepEqual(report.quarantined, [])
  assert.equal(quarantineSummary(report).errors, 1)
})

test('quarantineSummary is lossless and bounded, and honest when absent', () => {
  assert.deepEqual(quarantineSummary(undefined), { available: false })
  const summary = quarantineSummary({
    quarantined: Array.from({ length: 30 }, (_, i) => ({ path: `p${i}` })),
    escapingSymlinks: [{ path: 'seed', target: '/etc' }],
    inspected: 12,
    truncated: true,
  })
  assert.equal(summary.available, true)
  assert.equal(summary.quarantinedCount, 30)
  assert.equal(summary.quarantined.length, 20)
  assert.deepEqual(summary.escapingSymlinks, ['seed -> /etc'])
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), summary)
})
