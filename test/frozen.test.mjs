/**
 * §8.4 contract freeze.
 *
 * The guard is the only thing standing between a run and rewriting its own
 * acceptance test, so the pure decision function is tested exhaustively: which
 * calls it denies, which it must let through, and the two ways it could get
 * this catastrophically wrong (denying honest work, or missing an edit).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  FROZEN_GUARD_STATES,
  WRITE_TOOLS,
  frozenViolation,
  isFrozenPath,
  normalizeFrozenPath,
  normalizeFrozenPaths,
  relativizeToRoot,
  shellViolation,
  writeTarget,
} from '../src/frozen.js'

test('normalizeFrozenPaths: relative, deduped, and refuses to escape the root', () => {
  assert.deepEqual(
    normalizeFrozenPaths(['tests/', './tests/a.test.mjs', 'tests', '', '/etc/passwd', '../outside', 'src/**/*.test.mjs']),
    ['tests', 'tests/a.test.mjs', 'src/**/*.test.mjs'],
  )
  assert.equal(normalizeFrozenPath('./a/./b/'), 'a/./b')
})

test('isFrozenPath: exact, directory prefix, and glob all freeze', () => {
  const frozen = ['tests', 'vitest.config.mjs', 'src/**/*.test.mjs']
  assert.equal(isFrozenPath('tests', frozen), true)
  assert.equal(isFrozenPath('tests/unit/a.test.mjs', frozen), true)
  assert.equal(isFrozenPath('vitest.config.mjs', frozen), true)
  assert.equal(isFrozenPath('src/lib/a.test.mjs', frozen), true)
  assert.equal(isFrozenPath('src/lib/a.ts', frozen), false)
  assert.equal(isFrozenPath('tests-extra/a.ts', frozen), false)
  assert.equal(isFrozenPath('', frozen), false)
})

test('writeTarget reads the argument each write tool actually uses', () => {
  assert.equal(writeTarget('write', { file_path: 'a.ts' }), 'a.ts')
  assert.equal(writeTarget('edit', { file_path: 'a.ts' }), 'a.ts')
  assert.equal(writeTarget('str_replace_editor', { path: 'tests/a.test.mjs' }), 'tests/a.test.mjs')
  assert.equal(writeTarget('str_replace_editor', { command: 'view' }), undefined)
  assert.equal(writeTarget('bash', { command: 'rm tests\na' }), undefined)
  assert.deepEqual(Object.keys(WRITE_TOOLS).sort(), ['edit', 'str_replace_editor', 'write'])
})

test('frozenViolation denies an edit into a frozen test file', () => {
  const reason = frozenViolation('edit', { file_path: 'tests/a.test.mjs' }, ['tests'])
  assert.match(reason, /契约冻结/)
  assert.match(reason, /tests\/a\.test\.mjs/)
  assert.match(reason, /run_block/)
})

test('frozenViolation lets honest work through', () => {
  const frozen = ['tests']
  assert.equal(frozenViolation('edit', { file_path: 'src/a.ts' }, frozen), undefined)
  assert.equal(frozenViolation('write', { file_path: 'README.md' }, frozen), undefined)
  assert.equal(frozenViolation('read', { file_path: 'tests/a.test.mjs' }, frozen), undefined)
  assert.equal(frozenViolation('edit', { file_path: 'tests/a.test.mjs' }, []), undefined)
  assert.equal(frozenViolation('bash', { command: 'npm test' }, frozen), undefined)
  assert.equal(frozenViolation('bash', { command: 'cat tests/a.test.mjs' }, frozen), undefined)
})

test('shellViolation: a mutating command that names a frozen path is denied', () => {
  const frozen = ['tests']
  for (const command of [
    'echo > tests/a.test.mjs',
    'echo x >> tests/a.test.mjs',
    'sed -i s/true/false/ tests/a.test.mjs',
    'rm -rf tests',
    'cp tests/a.test.mjs tests/b.test.mjs',
    'git checkout HEAD -- tests/a.test.mjs',
    'git restore tests',
    "python3 -c \"open('tests/a.test.mjs','w').write('')\"",
    'cat x | tee tests/a.test.mjs',
  ]) {
    assert.notEqual(shellViolation(command, frozen), undefined, `should deny: ${command}`)
  }
  // Reading a frozen file is exactly what a check does; it must stay allowed.
  for (const command of ['node --test tests/a.test.mjs', 'grep -n expect tests/a.test.mjs', 'cat tests/a.test.mjs']) {
    assert.equal(shellViolation(command, frozen), undefined, `should allow: ${command}`)
  }
})

test('the guard states are the non-terminal ones', () => {
  assert.deepEqual([...FROZEN_GUARD_STATES].sort(), ['armed', 'paused', 'running', 'suspended'])
})

/**
 * Both shapes below were *real denials* a live run reported back: an `ls ... 2>/dev/null`
 * and a `node -e` whose log line contained `=>`. A guard that denies read-only work
 * costs the run rounds, so each false positive gets a regression test.
 */
test('shellViolation ignores redirects that are not writes', () => {
  const frozen = ['notes.md', 'tests/a.test.mjs']
  assert.equal(shellViolation('ls notes.md 2>/dev/null', frozen), undefined)
  assert.equal(shellViolation('node -e "console.log(\'read notes.md => ok\')"', frozen), undefined)
  assert.equal(shellViolation('cmd 2>&1 | grep notes.md', frozen), undefined)
  assert.equal(shellViolation('cat notes.md > /dev/null', frozen), undefined)
  // …while a descriptor redirect into a real file is still a write.
  assert.equal(shellViolation('cmd 2>notes.md', frozen), 'notes.md')
})

test('shellViolation covers the tool-shaped writers, not just shell verbs', () => {
  const frozen = ['tests/a.test.mjs']
  assert.equal(shellViolation('node -e "require(\'fs\').writeFileSync(\'tests/a.test.mjs\',\'\')"', frozen), 'tests/a.test.mjs')
  assert.equal(shellViolation('node -e "fs.unlinkSync(\'tests/a.test.mjs\')"', frozen), 'tests/a.test.mjs')
  assert.equal(shellViolation('node --test tests/a.test.mjs', frozen), undefined)
})

test('shellViolation is total on garbage input', () => {
  assert.equal(shellViolation(undefined, ['notes.md']), undefined)
  assert.equal(shellViolation('', ['notes.md']), undefined)
  assert.equal(shellViolation('printf x > notes.md', undefined), undefined)
})

/**
 * A live run wrote `/ws/notes.md` straight through a freeze on `notes.md`:
 * the target arrived absolute and the entry was relative. Comparing forms
 * literally is the bug, so both forms are reduced before the comparison.
 */
test('an absolute target still matches a relative frozen entry', () => {
  const root = '/Users/me/ws'
  const frozen = ['notes.md', 'tests/a.test.mjs', 'packages/api/test']
  assert.equal(writeTarget('write', { file_path: '/Users/me/ws/notes.md' }, root), 'notes.md')
  assert.notEqual(frozenViolation('write', { file_path: '/Users/me/ws/notes.md' }, frozen, root), undefined)
  assert.notEqual(frozenViolation('edit', { file_path: '/Users/me/ws/tests/a.test.mjs' }, frozen, root), undefined)
  assert.notEqual(
    frozenViolation('str_replace_editor', { path: '/Users/me/ws/packages/api/test/fixtures/x.json' }, frozen, root),
    undefined,
  )
  // Trailing slashes and `./` on either side are the same path.
  assert.equal(writeTarget('write', { file_path: './notes.md' }, root), 'notes.md')
  assert.equal(writeTarget('write', { file_path: '/Users/me/ws//notes.md' }, root), 'notes.md')
  // Outside the root, or outside the freeze: untouched.
  assert.equal(frozenViolation('write', { file_path: '/Users/me/other/notes.md' }, frozen, root), undefined)
  assert.equal(frozenViolation('write', { file_path: '/Users/me/ws/README.md' }, frozen, root), undefined)
})

test('relativizeToRoot is total on odd input', () => {
  assert.equal(relativizeToRoot('/ws/a', '/ws'), 'a')
  assert.equal(relativizeToRoot('/ws', '/ws'), '')
  assert.equal(relativizeToRoot('a/b', '/ws'), 'a/b')
  assert.equal(relativizeToRoot('/ws/a', undefined), '/ws/a')
  assert.equal(relativizeToRoot('/ws/a', '/'), '/ws/a')
})
