/**
 * The context governor: constraint pinning, health, and the proactive trigger.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_PINNED_CONSTRAINTS,
  PROACTIVE_COMPACT_AT,
  contextHealth,
  explorationDirective,
  extractConstraints,
  mergeConstraints,
  proactiveCompactDue,
  renderConstraints,
} from '../src/context.js'

/* ─────────────────────── constraint extraction (pure) ──────────────────── */

test('prohibitions are lifted out of ordinary prose', () => {
  const found = extractConstraints('重构 auth 模块。不要动 public API。不得新增依赖。')
  assert.deepEqual(found.map((c) => c.kind), ['prohibition', 'prohibition'])
  assert.match(found[0].text, /动 public API/)
  assert.match(found[1].text, /新增依赖/)
})

test('obligations and preconditions are recognised as different shapes', () => {
  const found = extractConstraints('必须保留现有的 session 格式。改动 schema 之前先备份。')
  const kinds = found.map((c) => c.kind)
  assert.ok(kinds.includes('boundary'))
  assert.ok(kinds.includes('precondition'))
})

test('English constraints are recognised too', () => {
  const found = extractConstraints('Refactor the auth module. Do not add dependencies. You must keep the public API stable.')
  assert.ok(found.some((c) => c.kind === 'prohibition' && /add dependencies/i.test(c.text)))
  assert.ok(found.some((c) => c.kind === 'boundary' && /keep the public API stable/i.test(c.text)))
})

test('a question is not a constraint', () => {
  assert.deepEqual(extractConstraints('不要动 public API 吗？'), [])
  assert.deepEqual(extractConstraints('Should I avoid adding dependencies?'), [])
})

test('an ordinary task statement yields nothing to pin', () => {
  assert.deepEqual(extractConstraints('实现 Redis 后端，然后跑测试。'), [])
})

test('candidates are deduplicated within one message', () => {
  const found = extractConstraints('不要删数据。不要删数据。')
  assert.equal(found.length, 1)
})

test('a terse Chinese constraint is not dropped by a length floor tuned for English', () => {
  // "删数据" is three characters and the whole of "do not delete data".
  assert.deepEqual(extractConstraints('不要删数据。').map((c) => c.text), ['删数据'])
  assert.deepEqual(extractConstraints('不得改接口。').map((c) => c.text), ['改接口'])
})

test('one message cannot flood the pinned list', () => {
  const many = Array.from({ length: 30 }, (_, i) => `不要做第${i}件事。`).join('')
  assert.ok(extractConstraints(many).length <= 8)
})

test('empty or non-text input is handled without a special case', () => {
  assert.deepEqual(extractConstraints(''), [])
  assert.deepEqual(extractConstraints(undefined), [])
  assert.deepEqual(extractConstraints('   '), [])
})

/* ──────────────────────────────── pinning ──────────────────────────────── */

test('merging is idempotent, so re-scanning the same transcript grows nothing', () => {
  const first = mergeConstraints([], extractConstraints('不要动 public API'), { round: 3 })
  assert.equal(first.added.length, 1)
  const second = mergeConstraints(first.constraints, extractConstraints('不要动 public API'), { round: 4 })
  assert.equal(second.added.length, 0)
  assert.equal(second.constraints.length, 1)
  assert.equal(second.constraints[0].pinnedAtRound, 3, 'the original pin round is preserved')
})

test('the pinned list keeps the newest when it overflows', () => {
  let state = { constraints: [] }
  for (let i = 0; i < MAX_PINNED_CONSTRAINTS + 5; i += 1) {
    state = mergeConstraints(state.constraints, [{ kind: 'prohibition', text: `不要做第${i}件事` }], { round: i })
  }
  assert.equal(state.constraints.length, MAX_PINNED_CONSTRAINTS)
  assert.match(state.constraints.at(-1).text, /不要做第28件事/, 'the most recent instruction is the one still likely to be live')
  assert.doesNotMatch(state.constraints[0].text, /第0件事/)
})

test('rendering an empty list costs nothing', () => {
  assert.equal(renderConstraints([]), '')
  assert.equal(renderConstraints(undefined), '')
})

test('the rendered block names each constraint and says why it is there', () => {
  const text = renderConstraints([
    { kind: 'prohibition', text: '动 public API', pinnedAtRound: 2 },
    { kind: 'boundary', text: '保留现有的 session 格式', pinnedAtRound: 5 },
  ])
  assert.match(text, /<pinned_constraints/)
  assert.match(text, /they stay true until withdrawn/)
  assert.match(text, /\[prohibition\] 动 public API/)
  assert.match(text, /\[boundary\] 保留现有的 session 格式/)
})

/* ──────────────────────────── context health ───────────────────────────── */

test('an unmeasured context reports itself as unmeasured rather than as empty', () => {
  const health = contextHealth({})
  assert.equal(health.measured, false)
  assert.equal(health.health, 1, 'an unknown context must not by itself trigger anything')
  assert.equal(health.band, 'unknown')
})

test('health falls with pressure and bands at the documented thresholds', () => {
  const at = (ratio) => contextHealth({ pressureTokens: ratio * 200_000, contextWindow: 200_000, rounds: 0 })
  assert.equal(at(0.2).band, 'ok')
  assert.equal(at(0.75).band, 'warm')
  assert.equal(at(0.9).band, 'hot')
  assert.ok(at(0.2).health > at(0.9).health)
})

test('a long history and open questions discount health even at low pressure', () => {
  const fresh = contextHealth({ pressureTokens: 20_000, contextWindow: 200_000, rounds: 0, openQuestions: 0 })
  const worn = contextHealth({ pressureTokens: 20_000, contextWindow: 200_000, rounds: 40, openQuestions: 4 })
  assert.ok(worn.health < fresh.health, 'context rot is about position and dilution, not only the ceiling')
  assert.ok(worn.reasons.some((r) => /40 轮/.test(r)))
  assert.ok(worn.reasons.some((r) => /4 个未决问题/.test(r)))
})

test('health never goes negative or above one however extreme the inputs', () => {
  const extreme = contextHealth({ pressureTokens: 999_999, contextWindow: 1000, rounds: 400, openQuestions: 30 })
  assert.ok(extreme.health >= 0 && extreme.health <= 1)
  assert.equal(extreme.ratio, 1, 'the ratio is clamped, so the ladder cannot see above 100%')
})

/* ─────────────────────── proactive compaction trigger ──────────────────── */

test('compaction is proactive at seventy percent, long before the automatic trigger', () => {
  assert.equal(PROACTIVE_COMPACT_AT, 0.7)
  const below = proactiveCompactDue(contextHealth({ pressureTokens: 130_000, contextWindow: 200_000 }))
  assert.equal(below.due, false)
  assert.match(below.reason, /65% 未达 70%/)

  const at = proactiveCompactDue(contextHealth({ pressureTokens: 145_000, contextWindow: 200_000 }))
  assert.equal(at.due, true)
  assert.match(at.reason, /现在压缩比等自动触发保留得更好/)
})

test('an unmeasured context never triggers compaction', () => {
  const decision = proactiveCompactDue(contextHealth({}))
  assert.equal(decision.due, false)
  assert.match(decision.reason, /未测量/)
})

/* ─────────────────────── the degradation directive ─────────────────────── */

test('the exploration rung changes what the model may do, not just a number', () => {
  assert.equal(explorationDirective(false), '')
  const text = explorationDirective(true)
  assert.match(text, /<exploration_disabled>/)
  assert.match(text, /禁止探索性阅读与搜索/)
  assert.match(text, /一次只读一个/)
})
