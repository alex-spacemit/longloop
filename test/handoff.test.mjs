/**
 * The handoff package: every termination owes a human this document.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildHandoff, extractRisks, formatDuration, summarizeHandoff } from '../src/handoff.js'

const RUN = {
  id: 'R-7f3a11',
  objective: '把 packages/auth 的会话存储从内存改成 Redis',
  state: 'exhausted',
  endReason: 'tokens 预算耗尽',
  round: 27,
  assurance: 'executable',
  startedAt: 0,
  endedAt: 3 * 3600_000 + 41 * 60_000,
  pausedMs: 0,
  contract: {
    deliverable: '可合并的 PR',
    acceptance: [
      { statement: 'pnpm test packages/auth 全绿', weight: 'required' },
      { statement: '重启不丢会话', weight: 'required' },
      { statement: '无 TODO 遗留', weight: 'nice-to-have' },
    ],
    constraints: ['不得修改 public API'],
  },
  notes: [
    { kind: 'decision', detail: '用 ioredis：依赖树里已有，避免新增依赖' },
    { kind: 'dead-end', detail: '试过 JSON 序列化：处理不了 Date，改用 msgpack' },
  ],
}

const LEDGER = [
  { kind: 'run-start', runId: 'R-7f3a11' },
  { kind: 'round', round: 24, stallScore: 0 },
  { kind: 'evidence', detail: 'E-12: pnpm test → exit 0' },
  { kind: 'dead-end', detail: '试过 JSON 序列化：处理不了 Date' },
  { kind: 'blocker', detail: 'redis.conf 未开 AOF' },
]

const VERDICT = {
  level: 'executable',
  status: 'fail',
  digestBefore: 'aaa111',
  digestAfter: 'bbb222',
  sideEffects: true,
  perCriterion: [
    { id: 'C1', status: 'pass', statement: 'pnpm test packages/auth 全绿', note: '退出码 0' },
    { id: 'C2', status: 'fail', statement: '重启不丢会话', note: '退出码 1', counterexample: 'Redis 未配置持久化，重启后 key 丢失' },
    { id: 'C3', status: 'unknown', statement: '无 TODO 遗留', note: '未检查' },
  ],
}

const TASKS = [
  { id: 'T1', title: '抽出 SessionStore 接口', status: 'done', priority: 2 },
  { id: 'T2', title: '实现 RedisSessionStore', status: 'done', priority: 0 },
  { id: 'T3', title: '补重启持久化脚本', status: 'in_progress', priority: 1, note: '需要真实 Redis 实例' },
]

/* ─────────────────────────────── durations ─────────────────────────────── */

test('durations are written the way a human reads them', () => {
  assert.equal(formatDuration(3 * 3600_000 + 41 * 60_000), '3h 41m')
  assert.equal(formatDuration(12 * 60_000 + 5_000), '12m 05s')
  assert.equal(formatDuration(45_000), '45s')
  assert.equal(formatDuration(-1), '—')
  assert.equal(formatDuration(Number.NaN), '—')
})

/* ──────────────────────────────── the document ─────────────────────────── */

test('the handoff states the terminal condition, the cost, and the objective', () => {
  const doc = buildHandoff({ run: RUN, ledger: LEDGER, verdict: VERDICT, tasks: TASKS })
  assert.match(doc, /^# Run R-7f3a11 交接包/)
  assert.match(doc, /\*\*终态\*\*: 预算耗尽 —— tokens 预算耗尽/)
  assert.match(doc, /\*\*耗时\*\*: 3h 41m · 27 轮/)
  assert.match(doc, /## 目标\n把 packages\/auth 的会话存储从内存改成 Redis/)
  assert.match(doc, /## 交付物\n可合并的 PR/)
})

test('the acceptance table names every criterion and never rounds an unknown into a pass', () => {
  const doc = buildHandoff({ run: RUN, ledger: LEDGER, verdict: VERDICT, tasks: TASKS })
  assert.match(doc, /\| C1 \| pnpm test packages\/auth 全绿 \| 必达 \| ✅ pass \| 退出码 0 \|/)
  assert.match(doc, /\| C2 \| 重启不丢会话 \| 必达 \| ❌ fail \| Redis 未配置持久化/)
  assert.match(doc, /\| C3 \| 无 TODO 遗留 \| 次要 \| ⚠️ unknown \| 未检查 \|/)
})

test('a run with no verdict marks every criterion unverified rather than assuming', () => {
  const doc = buildHandoff({ run: { ...RUN, state: 'aborted' }, ledger: [], tasks: [] })
  assert.match(doc, /⚠️ 未验证/)
  assert.match(doc, /本轮未产生裁决/)
  assert.doesNotMatch(doc, /✅ pass/)
})

test('a run with no acceptance criteria says so instead of showing an empty table', () => {
  const doc = buildHandoff({ run: { ...RUN, contract: {} }, ledger: [], tasks: [] })
  assert.match(doc, /没有验收标准，因此无法判定成败/)
})

test('finished and remaining work are split, and the remaining one keeps its note', () => {
  const doc = buildHandoff({ run: RUN, ledger: LEDGER, verdict: VERDICT, tasks: TASKS })
  assert.match(doc, /## 已完成\n\n- T1 抽出 SessionStore 接口\n- T2 实现 RedisSessionStore/)
  assert.match(doc, /## 未完成 \/ 下一步\n\n- \[~\] T3 P1 补重启持久化脚本 —— 需要真实 Redis 实例/)
})

test('decisions and dead ends survive into the handoff, marked as rejected where they are', () => {
  const doc = buildHandoff({ run: RUN, ledger: LEDGER, verdict: VERDICT, tasks: TASKS })
  assert.match(doc, /\[decision\] 用 ioredis/)
  assert.match(doc, /❌ 已否决 试过 JSON 序列化/)
  assert.ok(doc.includes('避免重复探索'), 'the section says why it exists')
})

test('a dead end recorded in both the notes and the ledger appears once', () => {
  const doc = buildHandoff({ run: RUN, ledger: LEDGER, verdict: VERDICT, tasks: TASKS })
  const appearances = doc.split('试过 JSON 序列化').length - 1
  // One in the decision section, and the risk section names it as a known dead
  // end; but the decision list itself must not print it twice.
  const decisionsBlock = doc.slice(doc.indexOf('## 关键决策'), doc.indexOf('## 阻塞'))
  assert.equal(decisionsBlock.split('试过 JSON 序列化').length - 1, 1)
  assert.ok(appearances >= 1)
})

test('evidence and blockers are carried over verbatim', () => {
  const doc = buildHandoff({ run: RUN, ledger: LEDGER, verdict: VERDICT, tasks: TASKS })
  assert.match(doc, /## 证据\n\n- E-12: pnpm test → exit 0/)
  assert.match(doc, /## 阻塞\n\n- redis\.conf 未开 AOF/)
})

/* ──────────────────────────────── risks ────────────────────────────────── */

test('risks are derived from evidence, and each names its source', () => {
  const risks = extractRisks(RUN, LEDGER, VERDICT)
  const kinds = risks.map((r) => r.kind)
  assert.ok(kinds.includes('verification-side-effects'), 'a verification that moved the tree is an audit trail')
  assert.ok(kinds.includes('unverified-criterion'))
  assert.ok(kinds.includes('known-dead-ends'))
  assert.ok(kinds.includes('weaker-assurance'), 'an executable-only verdict is weaker than an independent one')

  for (const risk of risks) assert.ok(risk.detail.length > 10, `${risk.kind} must say something actionable`)
  assert.match(risks.find((r) => r.kind === 'verification-side-effects').detail, /aaa111 → bbb222/)
})

test('an independent verdict at full pass raises no assurance risk', () => {
  const risks = extractRisks(
    RUN,
    [],
    {
      level: 'independent',
      sideEffects: false,
      perCriterion: [{ id: 'C1', status: 'pass', statement: 'x', note: 'ok' }],
    },
  )
  assert.deepEqual(risks, [])
})

test('a degraded verification is reported as a risk, not swallowed', () => {
  const risks = extractRisks(RUN, [{ kind: 'verify-degraded', reason: '独立评估器不可用' }], undefined)
  assert.ok(risks.some((r) => r.kind === 'verification-degraded' && /独立评估器不可用/.test(r.detail)))
})

test('the document carries the risk section even when there is nothing to report', () => {
  const doc = buildHandoff({ run: { ...RUN, state: 'done' }, ledger: [], tasks: [], verdict: { level: 'independent', perCriterion: [] } })
  assert.match(doc, /## 风险\n\n未从记录中提取到风险。/)
})

/* ──────────────────────────────── summary ──────────────────────────────── */

test('the summary is enough for a panel to show without opening the file', () => {
  const summary = summarizeHandoff(buildHandoff({ run: RUN, ledger: LEDGER, verdict: VERDICT, tasks: TASKS }))
  assert.ok(summary.bytes > 400)
  assert.ok(summary.lines > 20)
  assert.ok(summary.risks >= 3)
  assert.equal(summarizeHandoff(undefined), undefined)
})

test('every terminal state has words a human recognises', () => {
  for (const state of ['done', 'exhausted', 'blocked', 'aborted', 'suspended']) {
    const doc = buildHandoff({ run: { ...RUN, state }, ledger: [], tasks: [] })
    assert.doesNotMatch(doc, new RegExp(`终态\\*\\*: ${state}\\b`), `${state} must not leak its internal spelling`)
  }
})
