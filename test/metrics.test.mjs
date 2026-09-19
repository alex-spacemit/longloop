/**
 * §12 metrics.
 *
 * This module's whole value is that it refuses to invent numbers, so the tests
 * are about the refusals as much as the arithmetic: a self-declared verdict must
 * not count as verification, a re-assessed round must not count twice, and an
 * empty ledger must produce `undefined` rather than zero.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { computeMetrics, isExecutable, renderMetrics } from '../src/metrics.js'

/** A ledger shaped like the real one, one fact per line of a small run. */
const ledger = [
  { kind: 'run-start', at: 1000, runId: 'R-aaa111', objective: 'A', acceptance: 2, checkable: 2, frozen: 1, contractWarnings: 0 },
  { kind: 'round-dispatch', at: 1100, runId: 'R-aaa111', round: 1, roundId: 'R-aaa111-r1' },
  { kind: 'round', at: 1200, runId: 'R-aaa111', round: 1, roundId: 'R-aaa111-r1', signals: ['no-tool-activity'], escalation: 'nudge' },
  // The same round finished again by a human re-assess: not a second round.
  { kind: 'round', at: 1300, runId: 'R-aaa111', round: 1, roundId: 'R-aaa111-r1', signals: [], escalation: 'continue' },
  { kind: 'process-verify', at: 1400, runId: 'R-aaa111', round: 1, status: 'partial' },
  { kind: 'verdict', at: 1500, runId: 'R-aaa111', round: 1, level: 'executable', status: 'fail', counts: { pass: 1, fail: 1 } },
  { kind: 'verdict', at: 1600, runId: 'R-aaa111', round: 1, level: 'executable', status: 'pass', counts: { pass: 2, fail: 0 } },
  { kind: 'dead-end', at: 1700, runId: 'R-aaa111', round: 1, detail: 'x' },
  { kind: 'run-end', at: 1800, runId: 'R-aaa111', state: 'done' },
  { kind: 'run-start', at: 2000, runId: 'R-bbb222', objective: 'B', acceptance: 1, checkable: 0, frozen: 0, contractWarnings: 1 },
  { kind: 'verdict', at: 2100, runId: 'R-bbb222', round: 0, level: 'self', status: 'pass', counts: {} },
  { kind: 'run-stop', at: 2200, runId: 'R-bbb222', round: 0 },
]

test('rounds are counted by identity, not by rows', () => {
  const report = computeMetrics(ledger)
  const run = report.rounds.perRun.find((entry) => entry.id === 'R-aaa111')
  assert.equal(run.rounds, 1, 'two finishes of R-aaa111-r1 are one round')
  assert.equal(run.attempts, 2, 'and the fact that it was assessed twice is kept')
  assert.equal(run.dispatches, 1)
  assert.equal(report.rounds.worstRun, 1)
})

test('a self-declared verdict is not verification', () => {
  assert.equal(isExecutable('self'), false)
  assert.equal(isExecutable('executable'), true)
  assert.equal(isExecutable('independent'), true)
  const report = computeMetrics(ledger)
  assert.equal(report.verification.verdicts, 2, 'only the two executable verdicts count')
  assert.equal(report.verification.executablePassRate, 0.5)
  // Both runs store a verdict, but one of them said nothing about itself.
  assert.equal(report.verification.verdictCoverage, 1)
  assert.equal(report.verification.selfDeclaredOnly, 0)
  assert.equal(report.verification.firstVerdictPasses, 0, 'the first verdict of R-aaa111 failed')
})

test('contract quality, drift, and outcomes are read off the facts', () => {
  const report = computeMetrics(ledger)
  assert.deepEqual(report.outcomes.byState, { done: 1, aborted: 1 })
  assert.equal(report.outcomes.completionRate, 0.5)
  assert.equal(report.contracts.noMachineCheck, 1)
  assert.equal(report.contracts.withDowngradeWarnings, 1)
  assert.equal(report.contracts.frozen, 1)
  assert.equal(report.drift.processPasses, 1)
  assert.equal(report.drift.processPassesFailing, 1)
  assert.equal(report.drift.runsThatEscalated, 1)
  assert.equal(report.drift.deadEnds, 1)
  assert.equal(report.drift.unknownOutcomes, 0)
})

test('open runs are not counted as finished, and suspensions are visible', () => {
  const report = computeMetrics([
    { kind: 'run-start', at: 1, runId: 'R-open1', acceptance: 1, checkable: 1, frozen: 0, contractWarnings: 0 },
    { kind: 'round-dispatch', at: 2, runId: 'R-open1', round: 1, roundId: 'R-open1-r1' },
    { kind: 'round-outcome-unknown', at: 3, runId: 'R-open1', round: 1, roundId: 'R-open1-r1' },
    { kind: 'run-suspended', at: 4, runId: 'R-open1', round: 1 },
  ])
  assert.equal(report.outcomes.open, 1)
  assert.equal(report.outcomes.finished, 0)
  assert.equal(report.outcomes.completionRate, undefined, 'no finished run means no rate, not zero')
  assert.equal(report.drift.unknownOutcomes, 1)
  assert.equal(report.drift.suspensions, 1)
})

test('an empty or junk ledger reports nothing rather than zeroes', () => {
  const empty = computeMetrics([])
  assert.equal(empty.scope.runs, 0)
  assert.equal(empty.rounds.medianToFinish, undefined)
  assert.equal(empty.verification.executablePassRate, undefined)
  assert.equal(empty.outcomes.completionRate, undefined)
  assert.ok(empty.gaps.length >= 3, 'the report always states what it cannot know')

  // Junk must not invent a run: a fact of an unknown kind is skipped, and only a
  // recognised fact opens a bucket.
  const junk = computeMetrics([null, 'nonsense', { kind: 'unknown-kind' }])
  assert.equal(junk.scope.facts, 3)
  assert.equal(junk.scope.runs, 0)
  const partial = computeMetrics([{ kind: 'note', at: 1, runId: 'R-x', detail: 'n' }])
  assert.equal(partial.scope.runs, 1, 'a known fact without a run-start still belongs to its run')
})

test('renderMetrics is a readable digest with the gaps spelled out', () => {
  const text = renderMetrics(computeMetrics(ledger))
  assert.match(text, /运行 2 条 · 台账 12 条/)
  assert.match(text, /完成率 50%/)
  assert.match(text, /可执行裁决通过率 50%/)
  assert.match(text, /缺什么：/)
  assert.doesNotMatch(text, /NaN|undefined/)
})
