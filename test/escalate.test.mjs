/**
 * Escalation actions: L4 diagnosis and L3 fresh rounds.
 *
 * Both start a child, so both are tested against a stub `subagents` — and the
 * assertions that matter most are about what the child is *given*: its own
 * policy, and a seed that carries state rather than the conversation the run is
 * trying to escape.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DIAGNOSTIC_PERSONA,
  DIAGNOSTIC_SCHEMA,
  freshRoundLedgerEntry,
  renderDiagnosticPrompt,
  renderDiagnosticReport,
  renderFreshRoundPrompt,
  runDiagnosis,
  runFreshRound,
} from '../src/escalate.js'
import { EVALUATOR_TOOL_ALLOW } from '../src/verify.js'

const RUN = {
  id: 'R-abc123',
  objective: '把会话存储迁到 Redis',
  round: 12,
  maxRounds: 40,
  stalledRounds: 3,
  ownerSessionId: 'sess-1',
  notes: [
    { kind: 'decision', detail: '用 ioredis' },
    { kind: 'dead-end', detail: '试过 JSON 序列化：处理不了 Date' },
  ],
  constraints: [
    { kind: 'prohibition', text: '动 public API' },
    { kind: 'boundary', text: '保留现有 session 格式' },
  ],
  contract: {
    acceptance: [
      { statement: '测试全绿', weight: 'required', check: { command: 'pnpm test', expect: { exitCode: 0 } } },
      { statement: '重启不丢会话', weight: 'required' },
    ],
  },
}

/* ───────────────────────────── L4: diagnosis ──────────────────────────── */

test('the diagnostician is read-only and its policy is its own', () => {
  assert.match(DIAGNOSTIC_PERSONA, /read-only/)
  assert.match(DIAGNOSTIC_PERSONA, /should not try/)
  assert.match(DIAGNOSTIC_PERSONA, /One action, not a plan/)
  assert.match(DIAGNOSTIC_PERSONA, /Do not restate the objective/)
  assert.deepEqual(DIAGNOSTIC_SCHEMA.required, ['blocker', 'falseAssumption', 'nextAction'])
})

test('the diagnostic prompt carries state and refuses to carry a transcript', () => {
  const text = renderDiagnosticPrompt({
    run: RUN,
    root: '/ws',
    tasks: [
      { id: 'T1', title: '抽接口', status: 'done' },
      { id: 'T2', title: '实现 Redis 后端', status: 'in_progress' },
    ],
    verdict: { perCriterion: [{ id: 'C1', status: 'fail', statement: '测试全绿', note: '退出码 1' }] },
    blockers: [{ blocker: '缺 Redis 实例', attempted: ['本地起容器失败'] }],
  })
  assert.match(text, /<objective>把会话存储迁到 Redis<\/objective>/)
  assert.match(text, /Consecutive rounds with no observable progress: 3/)
  assert.match(text, /\[in_progress\] T2 实现 Redis 后端/)
  assert.doesNotMatch(text, /T1 抽接口/, 'finished work is not the diagnostician\'s business')
  assert.match(text, /\[fail\] C1 测试全绿/)
  assert.match(text, /\[dead-end\] 试过 JSON 序列化/)
  assert.match(text, /缺 Redis 实例/)
  assert.match(text, /Workspace root: \/ws/)
})

test('the diagnosis renders as a block the next round can act on', () => {
  const block = renderDiagnosticReport(
    { blocker: '缺 Redis 实例', falseAssumption: '以为本机有 Redis', nextAction: '用 testcontainers 起一个', evidence: 'docker ps 为空' },
    'child-1',
  )
  assert.match(block, /<diagnosis source="child-1">/)
  assert.match(block, /阻塞：缺 Redis 实例/)
  assert.match(block, /站不住的假设：以为本机有 Redis/)
  assert.match(block, /下一步：用 testcontainers 起一个/)
  assert.equal(renderDiagnosticReport(undefined), '')
})

function stubSubagents(outcome) {
  const started = []
  return {
    started,
    getProvider: () => ({ name: 'spawn' }),
    async start(name, request) {
      started.push({ name, request })
      return {
        id: 'child-1',
        result: Promise.resolve(outcome),
        dispose: async () => {},
      }
    },
  }
}

const diagnosisDeps = (subagents) => ({
  subagents,
  agents: { get: () => ({ id: 'sess-1' }), roots: () => [{ id: 'sess-1' }] },
  run: RUN,
  root: '/ws',
  tasks: [],
})

test('a diagnosis is asked for with a read-only policy and returned structured', async () => {
  const subagents = stubSubagents({
    stopReason: 'completed',
    output: [],
    structured: { blocker: 'B', falseAssumption: 'A', nextAction: 'N', evidence: 'E' },
  })
  const report = await runDiagnosis(diagnosisDeps(subagents))

  assert.equal(report.blocker, 'B')
  assert.equal(report.nextAction, 'N')
  assert.equal(report.childId, 'child-1')
  assert.deepEqual(subagents.started[0].request.toolFilter, { allow: [...EVALUATOR_TOOL_ALLOW] })
  assert.equal(subagents.started[0].request.maxDepth, 1)
  assert.match(subagents.started[0].request.label, /^diagnose-R-abc123/)
})

test('a diagnosis that did not complete is absent, never an empty diagnosis', async () => {
  for (const outcome of [
    { stopReason: 'aborted', output: [] },
    { stopReason: 'completed', output: [] },
    { stopReason: 'error', output: [] },
  ]) {
    assert.equal(await runDiagnosis(diagnosisDeps(stubSubagents(outcome))), undefined)
  }
})

test('a missing registry or parent means no diagnosis rather than a failed run', async () => {
  const deps = diagnosisDeps(stubSubagents({ stopReason: 'completed', structured: {} }))
  assert.equal(await runDiagnosis({ ...deps, subagents: undefined }), undefined)
  assert.equal(await runDiagnosis({ ...deps, agents: { get: () => undefined, roots: () => [] } }), undefined)
  assert.equal(
    await runDiagnosis({ ...deps, subagents: { ...deps.subagents, getProvider: () => undefined } }),
    undefined,
  )
})

test('a start failure is swallowed into an absent diagnosis', async () => {
  const subagents = {
    getProvider: () => ({ name: 'spawn' }),
    start: async () => {
      throw new Error('no capacity')
    },
  }
  assert.equal(await runDiagnosis(diagnosisDeps(subagents)), undefined)
})

/* ──────────────────────────── L3: fresh round ─────────────────────────── */

test('the fresh seed carries state, not the conversation', () => {
  const prompt = renderFreshRoundPrompt({
    run: RUN,
    round: 13,
    avoid: ['试过 JSON 序列化：处理不了 Date', '动 public API'],
    verdict: { status: 'fail', perCriterion: [{ id: 'C1', status: 'fail', statement: '测试全绿', note: '退出码 1' }] },
    diagnosis: { blocker: 'B', falseAssumption: 'A', nextAction: 'N', childId: 'child-9' },
  })

  assert.match(prompt, /round="13" cap="40" mode="fresh"/)
  assert.match(prompt, /你没有参与之前的尝试/)
  assert.match(prompt, /共享工作区是你的长期记忆/)
  assert.match(prompt, /C1 \[必达\] 测试全绿\n {6}检查：pnpm test/)
  assert.match(prompt, /\[prohibition\] 动 public API/)
  assert.match(prompt, /<do_not_retry/)
  assert.match(prompt, /试过 JSON 序列化/)
  assert.match(prompt, /<last_verdict>/)
  assert.match(prompt, /<diagnosis source="child-9">/)
  assert.match(prompt, /下一步：N/)
})

test('the fresh seed omits empty sections rather than emitting bare headings', () => {
  const prompt = renderFreshRoundPrompt({ run: { id: 'R-1', round: 1, maxRounds: 5, objective: 'x', contract: {} }, round: 1 })
  assert.doesNotMatch(prompt, /<acceptance>/)
  assert.doesNotMatch(prompt, /<do_not_retry/)
  assert.doesNotMatch(prompt, /<diagnosis/)
  assert.match(prompt, /完成这一轮能推进目标的\*\*一件事\*\*/)
})

test('a fresh round runs in a child and reports what it said', async () => {
  const subagents = stubSubagents({
    stopReason: 'completed',
    output: [{ type: 'text', text: '做了 X，看到 Y，下一步 Z' }],
  })
  const outcome = await runFreshRound({
    subagents,
    agents: { get: () => ({ id: 'sess-1' }), roots: () => [{ id: 'sess-1' }] },
    run: RUN,
    root: '/ws',
    prompt: '<run_round/>',
  })

  assert.equal(outcome.started, true)
  assert.equal(outcome.childId, 'child-1')
  assert.match(outcome.report, /下一步 Z/)
  assert.equal(subagents.started[0].request.maxDepth, 1)
  assert.equal(subagents.started[0].request.prompt[0].text, '<run_round/>')
})

test('a fresh round that cannot start reports why, so the caller can fall back', async () => {
  const outcome = await runFreshRound({
    subagents: undefined,
    agents: undefined,
    run: RUN,
    root: '/ws',
    prompt: 'x',
  })
  assert.equal(outcome.started, false)
  assert.match(outcome.reason, /subagents/)
})

test('the ledger entry distinguishes a round that ran from one that never started', () => {
  const ran = freshRoundLedgerEntry(RUN, 13, { started: true, childId: 'c1', stopReason: 'completed', report: 'did things' })
  assert.equal(ran.kind, 'round-fresh')
  assert.equal(ran.started, true)
  assert.equal(ran.round, 13)
  assert.match(ran.reportHead, /did things/)

  const never = freshRoundLedgerEntry(RUN, 13, { started: false, reason: 'no capacity' })
  assert.equal(never.started, false)
  assert.equal(never.reason, 'no capacity')
  assert.equal(never.reportHead, undefined)
})
