/**
 * Governor policy: budget, stall, and escalation.
 *
 * These are the decisions the whole loop is built on, and they are pure — so
 * they get tested as policy, without a Host, a Session, or a model.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BUDGET_LADDER,
  ESCALATION_LADDER,
  budgetReport,
  escalationFor,
  renderRecoveryBlock,
  renderRoundPrompt,
  mintRunId,
  renderContractBlock,
  stallAssessment,
} from '../src/governors.js'

const HOUR = 60 * 60 * 1000

function runInput(overrides = {}) {
  return {
    round: 0,
    maxRounds: 40,
    startedAt: 0,
    pausedMs: 0,
    now: 0,
    wallClockLimitMs: 4 * HOUR,
    ladder: BUDGET_LADDER,
    ...overrides,
  }
}

/* ──────────────────────────────── budget ───────────────────────────────── */

test('budget: rounds and wall-clock are always measured', () => {
  const report = budgetReport(runInput({ round: 10, now: 2 * HOUR }))
  assert.deepEqual(report.dimensions.map((d) => d.name), ['rounds', 'wallClockMs'])
  assert.equal(report.worstRatio, 0.5, 'both dimensions sit at half')
  assert.equal(report.rung, undefined, 'no rung before 0.7')
  assert.equal(report.exhausted, false)
})

test('budget: an unmetered dimension is absent, never zero', () => {
  const report = budgetReport(runInput({ tokens: 500, tokenLimit: undefined }))
  assert.deepEqual(report.dimensions.map((d) => d.name), ['rounds', 'wallClockMs'], 'no token row without a limit')

  const metered = budgetReport(runInput({ tokens: 500, tokenLimit: 1000 }))
  assert.equal(metered.dimensions.find((d) => d.name === 'tokens').ratio, 0.5)
})

test('budget: the ladder reports the rung already crossed, and degradation is progressive', () => {
  const at = (ratio) =>
    budgetReport(runInput({ round: Math.round(40 * ratio), maxRounds: 40 })).rung

  assert.equal(at(0.5), undefined)
  assert.equal(at(0.7), 'disable-exploration')
  assert.equal(at(0.8), 'narrow-scope')
  assert.equal(at(0.9), 'force-wrapup')
  assert.equal(at(1), 'stop')
})

test('budget: the worst dimension decides, not the first', () => {
  // Rounds barely used, wall clock nearly gone.
  const report = budgetReport(runInput({ round: 2, now: 3.9 * HOUR }))
  assert.equal(report.worst, 'wallClockMs')
  assert.equal(report.rung, 'force-wrapup')
})

test('budget: exhaustion is recognised and pause time is excluded', () => {
  const paced = budgetReport(runInput({ now: 5 * HOUR, pausedMs: 2 * HOUR }))
  assert.equal(paced.worstRatio, 0.75, 'paused time is not work')
  assert.equal(paced.exhausted, false)

  assert.equal(budgetReport(runInput({ round: 40 })).exhausted, true)
})

/* ──────────────────────────────── stall ────────────────────────────────── */

test('stall: a repeated blocker stalls on its own', () => {
  // Repetition is its own corroboration: by the time this fires, the same wall
  // has already been hit more than once.
  const repeated = stallAssessment({ blockerRepeated: true, toolCalls: 5, readOnlyRatio: 0 })
  assert.equal(repeated.score, 4)
  assert.equal(repeated.stalled, true)
  assert.deepEqual(repeated.signals.map((s) => s.signal), ['blocker-repeated'])
})

test('stall: one quiet round is not a stall, two agreeing signals are', () => {
  const quietTree = stallAssessment({ workspaceUnchanged: true, toolCalls: 5, readOnlyRatio: 0 })
  assert.equal(quietTree.stalled, false, 'running tests or reading to plan leaves the tree untouched')

  const quietEverything = stallAssessment({ workspaceUnchanged: true, boardUnchanged: true, toolCalls: 5, readOnlyRatio: 0 })
  assert.equal(quietEverything.score, 6)
  assert.equal(quietEverything.stalled, true, 'neither the tree nor the board moved — that is a stall')
  assert.deepEqual(quietEverything.signals.map((s) => s.signal), ['workspace-unchanged', 'board-unchanged'])
})

test('stall: weak signals alone do not stall', () => {
  const quiet = stallAssessment({ toolCalls: 0 })
  assert.equal(quiet.score, 1, 'no tool activity alone is a weak signal')
  assert.equal(quiet.stalled, false)

  const reading = stallAssessment({ toolCalls: 9, readOnlyRatio: 0.95 })
  assert.equal(reading.stalled, false)
})

test('stall: weak signals accumulate into a stall without any strong one', () => {
  const combined = stallAssessment({ workspaceUnchanged: true, toolCalls: 9, readOnlyRatio: 1 })
  assert.equal(combined.score, 4)
  assert.equal(combined.stalled, true)
})

test('stall: a productive round resets the streak, a stalled one extends it', () => {
  const productive = stallAssessment({ workspaceUnchanged: false, boardUnchanged: false, toolCalls: 4 }, 3)
  assert.equal(productive.stalledRounds, 0, 'any real progress clears the streak')

  const stalled = stallAssessment({ workspaceUnchanged: true, boardUnchanged: true }, 3)
  assert.equal(stalled.stalledRounds, 4)

  const quiet = stallAssessment({ workspaceUnchanged: true }, 3)
  assert.equal(quiet.stalledRounds, 3, 'a merely quiet round neither extends nor clears the streak')
})

/* ────────────────────────────── escalation ─────────────────────────────── */

test('escalation: the ladder is walked one rung per stalled round', () => {
  assert.equal(escalationFor(0).action, 'continue')
  assert.equal(escalationFor(1).action, 'nudge')
  assert.equal(escalationFor(2).action, 'replan')
  assert.equal(escalationFor(3).action, 'switch-mode')
  assert.equal(escalationFor(4).action, 'diagnose')
  assert.equal(escalationFor(5).action, 'block')
  assert.equal(escalationFor(9).action, 'block', 'past the ladder it stays blocked')
})

test('escalation: every rung above L0 carries an actionable directive', () => {
  for (const rung of ESCALATION_LADDER) {
    const level = escalationFor(rung.atStalled)
    assert.equal(level.level, rung.level)
    assert.equal(typeof level.directive, 'string')
    assert.ok(level.directive.length > 20, `L${rung.level} must tell the model what to do differently`)
    assert.doesNotMatch(level.directive, /再试一次|try again/, 'the ladder changes the means, never the effort')
  }
})

test('escalation: the nudge carries an external fact, not advice to think harder', () => {
  const directive = escalationFor(1).directive
  assert.match(directive, /没有产生任何可观察的变化/, 'the signal must be stated as an observation')
})

/* ──────────────────────────── prompt rendering ─────────────────────────── */

test('contract block: static, and it names every acceptance criterion', () => {
  const block = renderContractBlock({
    id: 'R-abc123',
    state: 'armed',
    objective: '把会话存储迁到 Redis',
    contract: {
      deliverable: '可合并的 PR',
      acceptance: [
        { statement: 'pnpm test packages/auth 全绿', weight: 'required' },
        { statement: '无 TODO 遗留', weight: 'nice-to-have' },
      ],
      constraints: ['不得修改 public API'],
      nonGoals: ['不做多实例一致性'],
    },
  })
  assert.match(block, /<run_contract id="R-abc123" state="armed">/)
  assert.match(block, /\[required\] pnpm test packages\/auth 全绿/)
  assert.match(block, /\[nice-to-have\] 无 TODO 遗留/)
  assert.match(block, /不得修改 public API/)
  assert.match(block, /不做多实例一致性/)
  assert.equal(renderContractBlock(undefined), '', 'no run means no tokens')
})

test('round prompt: dynamic half carries round, budget, tasks, and the escalation', () => {
  const run = {
    id: 'R-abc123',
    round: 7,
    maxRounds: 40,
    tasks: [
      { id: 'T1', title: '抽接口', status: 'done', priority: 2 },
      { id: 'T2', title: '实现 Redis 后端', status: 'in_progress', priority: 0 },
      { id: 'T3', title: '清理 TODO', status: 'pending', priority: 3 },
    ],
  }
  const budget = budgetReport(runInput({ round: 28, maxRounds: 40 }))
  const prompt = renderRoundPrompt(run, budget, escalationFor(0))

  assert.match(prompt, /<run_round id="R-abc123" round="7" cap="40">/)
  assert.match(prompt, /\[~\] T2 P0 实现 Redis 后端/)
  assert.match(prompt, /\[ \] T3 P3 清理 TODO/)
  assert.doesNotMatch(prompt, /T1/, 'finished tasks are not carried into the prompt')
  assert.match(prompt, /rung="disable-exploration"/)
  assert.match(prompt, /宣称完成不会结束运行/)
  assert.doesNotMatch(prompt, /<stalled/, 'L0 adds no escalation text')
})

test('round prompt: an escalated round names the level and the required change', () => {
  const prompt = renderRoundPrompt(
    { id: 'R-1', round: 12, maxRounds: 40, tasks: [] },
    budgetReport(runInput()),
    escalationFor(2),
  )
  assert.match(prompt, /<stalled rounds="2" level="L2" action="replan"\/>/)
  assert.match(prompt, /结构上不同/)
})

test('run ids are short enough to say out loud', () => {
  const id = mintRunId()
  assert.match(id, /^R-[0-9a-f]{6}$/)
})

test('renderRecoveryBlock appears only while a dispatch outcome is unknown', () => {
  assert.equal(renderRecoveryBlock({ id: 'R-x', round: 3 }), undefined)
  const block = renderRecoveryBlock({ id: 'R-x', round: 3, unknownOutcomeRoundId: 'R-x-r2' })
  assert.match(block, /<recovery round_id="R-x-r2">/)
  assert.match(block, /副作用可能已发生/)
  assert.match(block, /不要盲目重放/)
})

test('a run with no unknown outcome renders no recovery block', () => {
  const prompt = renderRoundPrompt(
    { id: 'R-x', round: 3, maxRounds: 5 },
    { worst: 'rounds', worstRatio: 0.6 },
    { level: 0, action: 'continue', directive: '' },
  )
  assert.doesNotMatch(prompt, /<recovery/)
})
