/**
 * The run model's contract normalization (§8.4 / §8.6).
 *
 * The interesting behaviour is what happens to a contract that is *almost*
 * right: an expectation the evaluator does not understand used to be replaced by
 * `{exitCode: 0}` in silence, which made a criterion look decidable while it
 * tested something else. It is now accepted under its alias or reported.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createRun, roundIdFor } from '../src/run.js'

const runWith = (acceptance) => createRun({ objective: 'o', contract: { acceptance }, id: 'R-test01' })

test('an expectation under its alias is understood, not dropped', () => {
  const run = runWith([{ statement: '输出正确', check: { command: 'x', expect: { stdout: 'console' } } }])
  assert.deepEqual(run.contract.acceptance[0].check.expect, { stdoutMatches: 'console' })
  assert.deepEqual(run.contractWarnings, [])

  const canonical = runWith([{ statement: '输出正确', check: { command: 'x', expect: { stdoutMatches: 'console' } } }])
  assert.deepEqual(canonical.contract.acceptance[0].check.expect, { stdoutMatches: 'console' })
})

test('an unrecognised expectation is downgraded AND reported', () => {
  const run = runWith([{ statement: '慢查询要报警', check: { command: 'x', expect: { latencyMs: 200 } } }])
  assert.deepEqual(run.contract.acceptance[0].check.expect, { exitCode: 0 })
  assert.equal(run.contractWarnings.length, 1)
  assert.match(run.contractWarnings[0], /慢查询要报警/)
  assert.match(run.contractWarnings[0], /latencyMs/)
})

test('a check with no command is reported rather than stored as decidable', () => {
  const run = runWith([{ statement: '代码整洁', check: { expect: { exitCode: 0 } } }])
  assert.equal(run.contract.acceptance[0].check, undefined)
  assert.equal(run.contractWarnings.length, 1)
  assert.match(run.contractWarnings[0], /没有命令/)
})

test('a plain statement is not a warning — it is simply not machine-decidable', () => {
  const run = runWith([{ statement: '用户满意' }])
  assert.deepEqual(run.contractWarnings, [])
  assert.equal(run.contract.acceptance[0].check, undefined)
})

test('roundIdFor is stable and undefined without a run id', () => {
  assert.equal(roundIdFor({ id: 'R-abc123', round: 4 }), 'R-abc123-r4')
  assert.equal(roundIdFor({ id: 'R-abc123', round: 4 }, 7), 'R-abc123-r7')
  assert.equal(roundIdFor(undefined), undefined)
})
