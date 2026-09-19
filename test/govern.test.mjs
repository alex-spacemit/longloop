/**
 * §8.3 context governance, wired.
 *
 * The interesting behaviours are all about degradation: no meter, no
 * compaction service, a busy agent, a log that lost a tool result. Every one of
 * them must produce a *record*, never an exception — a governance pass that can
 * kill a run would be worse than no governance.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { contextReport, governBeforeRound, measurePressure, toolPairing } from '../src/govern.js'

/** A host context whose meter projection says whatever the test wants. */
function makeCtx({ pressure, compaction, events } = {}) {
  const session = { id: 's1', snapshotEvents: () => events ?? [] }
  const sessions = new Map([['s1', session]])
  return {
    get(key) {
      if (key === 'sessions') return { get: (id) => sessions.get(id) }
      if (key === 'sessionProjections') {
        return pressure === undefined ? undefined : { stateOf: () => pressure }
      }
      if (key === 'compaction') return compaction
      return undefined
    },
  }
}

test('measurePressure reads the same projection the automatic trigger reads', () => {
  const ctx = makeCtx({ pressure: { pressureTokens: 90_000, contextWindow: 128_000 } })
  assert.deepEqual(measurePressure(ctx, 's1'), { pressureTokens: 90_000, contextWindow: 128_000 })
})

test('measurePressure falls back to surfaceTokens and degrades to undefined', () => {
  const ctx = makeCtx({ pressure: { surfaceTokens: 1000, contextWindow: 100_000 } })
  assert.deepEqual(measurePressure(ctx, 's1'), { pressureTokens: 1000, contextWindow: 100_000 })
  assert.equal(measurePressure(makeCtx({}), 's1'), undefined)
  assert.equal(measurePressure(ctx, undefined), undefined)
  assert.equal(measurePressure(ctx, 'missing'), undefined)
})

test('contextReport: below the proactive threshold the run is left alone', () => {
  const ctx = makeCtx({ pressure: { pressureTokens: 10_000, contextWindow: 128_000 } })
  const { health, verdict } = contextReport(ctx, { round: 1, ownerSessionId: 's1' })
  assert.equal(health.measured, true)
  assert.equal(health.band, 'ok')
  assert.equal(verdict.due, false)
})

test('contextReport: an unmeasurable context is reported, not assumed healthy', () => {
  const { health, verdict } = contextReport(makeCtx({}), { round: 3, ownerSessionId: 's1' })
  assert.equal(health.measured, false)
  assert.equal(health.band, 'unknown')
  assert.equal(verdict.due, false)
})

test('governBeforeRound records "unavailable" when no compaction service is mounted', async () => {
  const ctx = makeCtx({ pressure: { pressureTokens: 120_000, contextWindow: 128_000 } })
  const pass = await governBeforeRound(ctx, { id: 'a' }, { id: 'R-1', round: 4, ownerSessionId: 's1' })
  assert.equal(pass.due, true)
  assert.equal(pass.action, 'unavailable')
  assert.equal(pass.round, 4)
  assert.equal(pass.band, 'hot')
})

test('governBeforeRound compacts when due, then re-checks tool pairing', async () => {
  const calls = []
  const ctx = makeCtx({
    pressure: { pressureTokens: 120_000, contextWindow: 128_000 },
    compaction: {
      compactNow: async (agent, signal) => {
        calls.push({ agentId: agent.id, aborted: signal.aborted })
        return { id: 'C-1', replacedEventCount: 42, summaryTokens: 900 }
      },
    },
    events: [{ type: 'tool/call' }, { type: 'tool/result' }, { type: 'tool/call' }],
  })
  const pass = await governBeforeRound(ctx, { id: 'a', session: { id: 's1', snapshotEvents: () => [{ type: 'tool/call' }, { type: 'tool/result' }] } }, {
    id: 'R-1',
    round: 5,
    ownerSessionId: 's1',
  })
  assert.equal(pass.action, 'compacted')
  assert.deepEqual(calls, [{ agentId: 'a', aborted: false }])
  assert.equal(pass.compaction.id, 'C-1')
  assert.equal(pass.compaction.replaced, 42)
  assert.deepEqual(pass.pairing, { checked: true, balanced: true, calls: 1, results: 1 })
})

test('governBeforeRound records a busy agent as deferred instead of failing the round', async () => {
  const ctx = makeCtx({
    pressure: { pressureTokens: 120_000, contextWindow: 128_000 },
    compaction: { compactNow: async () => { throw new Error('compaction is busy') } },
  })
  const pass = await governBeforeRound(ctx, { id: 'a' }, { id: 'R-1', round: 2, ownerSessionId: 's1' })
  assert.equal(pass.action, 'deferred')
  assert.match(pass.error, /busy/)
})

test('governBeforeRound says "nothing-to-compact" when the backend declines', async () => {
  const ctx = makeCtx({
    pressure: { pressureTokens: 130_000, contextWindow: 128_000 },
    compaction: { compactNow: async () => null },
  })
  const pass = await governBeforeRound(ctx, { id: 'a' }, { id: 'R-1', round: 6, ownerSessionId: 's1' })
  assert.equal(pass.action, 'nothing-to-compact')
})

test('every governance record is lossless JSON — session.append rejects anything else', async () => {
  const cases = [
    makeCtx({ pressure: { pressureTokens: 10_000, contextWindow: 128_000 } }),
    makeCtx({ pressure: { pressureTokens: 130_000, contextWindow: 128_000 } }),
    makeCtx({}),
  ]
  for (const ctx of cases) {
    const pass = await governBeforeRound(ctx, { id: 'a' }, { id: 'R-1', round: 1, ownerSessionId: 's1' })
    assert.deepEqual(JSON.parse(JSON.stringify(pass)), pass)
    for (const value of Object.values(pass)) assert.notEqual(value, undefined)
  }
})

test('toolPairing reads the log when it can and reports when it cannot', () => {
  assert.deepEqual(toolPairing({ snapshotEvents: () => [{ type: 'tool/call' }, { type: 'tool/result' }] }), {
    checked: true,
    balanced: true,
    calls: 1,
    results: 1,
  })
  assert.equal(toolPairing({ snapshotEvents: () => [{ type: 'tool/call' }] }).balanced, false)
  assert.equal(toolPairing({}).checked, false)
  assert.equal(toolPairing(undefined).checked, false)
  assert.equal(toolPairing({ snapshotEvents: () => { throw new Error('disposed') } }).checked, false)
})
