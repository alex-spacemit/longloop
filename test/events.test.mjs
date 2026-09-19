/**
 * The session-log half of the durable store.
 *
 * `emitLongloop` is the one path a fact takes from the run into the log, so it
 * is exercised against a fake `sessions` service: what gets appended, to which
 * session, and — most importantly — that a broken session costs the run nothing.
 * The folds are pure and are checked directly, including the ring caps.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  LONGLOOP_EVENT,
  PROJECTION_KEY,
  emitLongloop,
  foldLedger,
  foldRounds,
  foldRun,
  ledgerEventData,
  projectionAvailability,
  readProjections,
  registerLongloopProjections,
  runEventData,
  sessionIdsOf,
} from '../src/events.js'

/** A host context with just enough of the session services to be exercised. */
function makeCtx({ append } = {}) {
  const appended = []
  const sessions = new Map()
  const ctx = {
    get(key) {
      if (key === 'sessions') return { get: (id) => sessions.get(id) }
      if (key === 'sessionProjections') return ctx.__registry
      return undefined
    },
  }
  ctx.__appended = appended
  ctx.__sessions = sessions
  return ctx
}

function liveSession(record, id, impl) {
  record.set(id, { id, append: impl ?? ((type, data) => record.appendedPush?.(type, data)) })
  return record.get(id)
}

test('sessionIdsOf prefers the owner, dedupes, and drops non-strings', () => {
  assert.deepEqual(sessionIdsOf({ ownerSessionId: 's1', sessionIds: ['s1', 's2', undefined, ''] }), ['s1', 's2'])
  assert.deepEqual(sessionIdsOf(undefined), [])
})

test('runEventData drops the fields a run does not have', () => {
  const data = runEventData({
    id: 'R-1',
    state: 'armed',
    objective: 'o',
    round: 2,
    maxRounds: 10,
    contract: { acceptance: [{ statement: 'a' }, { statement: 'b', check: { command: 'true' } }] },
    ownerSessionId: 's1',
  })
  assert.equal(data.run.id, 'R-1')
  assert.equal(data.run.acceptance, 2)
  assert.equal(data.run.checkable, 1)
  assert.equal(data.run.endedAt, 0)
  assert.equal(data.run.endReason, '')
  assert.deepEqual(data.run.sessionIds, ['s1'])
})

test('emitLongloop appends to the owner session and reports success', () => {
  const ctx = makeCtx()
  const seen = []
  ctx.__sessions.set('s1', { id: 's1', append: (type, data) => seen.push([type, data]) })
  const ok = emitLongloop(ctx, { ownerSessionId: 's1', sessionIds: [] }, LONGLOOP_EVENT.run, { run: null })
  assert.equal(ok, true)
  assert.deepEqual(seen, [[LONGLOOP_EVENT.run, { run: null }]])
})

test('emitLongloop falls back to the next live session and never throws', () => {
  const ctx = makeCtx()
  ctx.__sessions.set('dead', { id: 'dead', append: () => { throw new Error('session disposed') } })
  const seen = []
  ctx.__sessions.set('live', { id: 'live', append: (type) => seen.push(type) })
  const ok = emitLongloop(ctx, { ownerSessionId: 'dead', sessionIds: ['live'] }, LONGLOOP_EVENT.ledger, { runId: 'R-1' })
  assert.equal(ok, true)
  assert.deepEqual(seen, [LONGLOOP_EVENT.ledger])
})

test('emitLongloop reports false when nothing is live or the service is absent', () => {
  const ctx = makeCtx()
  assert.equal(emitLongloop(ctx, { ownerSessionId: 'nope' }, LONGLOOP_EVENT.run, {}), false)
  assert.equal(emitLongloop({ get: () => undefined }, { ownerSessionId: 'nope' }, LONGLOOP_EVENT.run, {}), false)
})

test('foldRun tracks the run header and the latest round context', () => {
  const started = foldRun({ run: null, updatedAt: 0 }, {
    type: LONGLOOP_EVENT.run,
    time: 10,
    data: { run: { id: 'R-1', state: 'armed', round: 0 } },
  })
  assert.equal(started.run.id, 'R-1')
  assert.equal(started.updatedAt, 10)

  const rounded = foldRun(started, {
    type: LONGLOOP_EVENT.round,
    time: 20,
    data: { round: 3, context: { band: 'warm', ratio: 0.71 } },
  })
  assert.equal(rounded.run.round, 3)
  assert.equal(rounded.run.state, 'armed')
  assert.deepEqual(rounded.run.context, { band: 'warm', ratio: 0.71 })

  const unrelated = foldRun(rounded, { type: 'user/message', time: 30, data: {} })
  assert.equal(unrelated, rounded)
})

test('foldRounds and foldLedger fold only their own events and stay capped', () => {
  let state = { count: 0, rounds: [] }
  for (let index = 0; index < 260; index += 1) {
    state = foldRounds(state, {
      type: LONGLOOP_EVENT.round,
      time: index,
      data: { round: index, maxRounds: 300, stallScore: 0, signals: ['no-progress'] },
    })
  }
  assert.equal(state.count, 260)
  assert.equal(state.rounds.length, 200)
  assert.equal(state.rounds.at(-1).round, 259)
  assert.deepEqual(state.rounds.at(-1).signals, ['no-progress'])

  const ledger = foldLedger({ count: 0, byKind: {}, entries: [] }, {
    type: LONGLOOP_EVENT.ledger,
    time: 5,
    data: { round: 1, kind: 'verdict', detail: 'pass' },
  })
  assert.equal(ledger.count, 1)
  assert.deepEqual(ledger.byKind, { verdict: 1 })

  const untouched = foldLedger(ledger, { type: LONGLOOP_EVENT.round, time: 6, data: {} })
  assert.equal(untouched, ledger)
})

test('ledgerEventData carries the round, the kind, and a bounded detail', () => {
  const data = ledgerEventData({ id: 'R-9', round: 4 }, { kind: 'note', detail: 'x'.repeat(500) })
  assert.equal(data.runId, 'R-9')
  assert.equal(data.round, 4)
  assert.equal(data.kind, 'note')
  assert.equal(data.detail.length, 400)
})

test('registerLongloopProjections goes through ctx.inject and registers three units', () => {
  const registered = []
  let injected
  const ctx = {
    inject(services, callback) {
      injected = services
      callback({ sessionProjections: { register: (definition) => registered.push(definition) } })
    },
  }
  registerLongloopProjections(ctx)
  assert.deepEqual(injected, ['sessionProjections'])
  assert.deepEqual(registered.map((unit) => unit.key), [PROJECTION_KEY.run, PROJECTION_KEY.rounds, PROJECTION_KEY.ledger])
  for (const unit of registered) {
    assert.equal(unit.stateVersion, 1)
    assert.equal(typeof unit.init, 'function')
    assert.equal(typeof unit.apply, 'function')
    // The seam the registry calls on restore.
    assert.deepEqual(unit.stateSchema.parse(unit.init()), unit.init())
  }
})

test('registerLongloopProjections tolerates a host without the capability', () => {
  assert.doesNotThrow(() => registerLongloopProjections({}))
  assert.doesNotThrow(() => registerLongloopProjections({ inject: (services, callback) => callback({}) }))
})

test('a projection state of the wrong shape is refused, not accepted blindly', () => {
  const registered = []
  registerLongloopProjections({
    inject: (services, callback) => callback({ sessionProjections: { register: (unit) => registered.push(unit) } }),
  })
  const ledgerUnit = registered.find((unit) => unit.key === PROJECTION_KEY.ledger)
  assert.throws(() => ledgerUnit.stateSchema.parse({ entries: 'nope' }), /declared shape/)
})

test('readProjections reads through the registry and reports absence honestly', () => {
  const ctx = makeCtx()
  ctx.__sessions.set('s1', { id: 's1' })
  ctx.__registry = { stateOf: (session, key) => ({ key }) }
  assert.deepEqual(readProjections(ctx, 's1'), {
    run: { key: PROJECTION_KEY.run },
    rounds: { key: PROJECTION_KEY.rounds },
    ledger: { key: PROJECTION_KEY.ledger },
  })
  assert.equal(readProjections(ctx, undefined), undefined)
  assert.equal(readProjections({ get: () => undefined }, 's1'), undefined)
})

test('projectionAvailability names the reason instead of guessing the host is broken', () => {
  const service = { get: () => undefined }
  assert.equal(projectionAvailability({ get: () => undefined }, 's1'), '宿主没有会话服务')
  assert.equal(
    projectionAvailability({ get: (name) => (name === 'sessions' ? service : undefined) }, 's1'),
    '宿主没有 sessionProjections 能力',
  )
  assert.equal(projectionAvailability({ get: () => service }, undefined), '还没有确定会话 id')
  assert.equal(projectionAvailability({ get: () => service }, 's1'), '这个会话还没落进会话存储')
  assert.equal(
    projectionAvailability({ get: (name) => (name === 'sessions' ? { get: () => ({ id: 's1' }) } : {}) }, 's1'),
    undefined,
  )
})
