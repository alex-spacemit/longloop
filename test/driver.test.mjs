/**
 * The round driver's state machine.
 *
 * The driver is the one part of the framework that can spend money without a
 * human in the loop, so its preconditions get tested exhaustively: it must not
 * queue when disabled, must not double-queue, must consume a round only on
 * admission, and must yield the moment a human speaks.
 */

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { PLUGIN_SOURCE, ROUND_LIMIT_CODE, createRoundDriver, isRoundMessage } from '../src/driver.js'

let state
let driver
let queued
let terminated

function makeDriver(overrides = {}) {
  queued = []
  terminated = []
  state = {
    run: {
      id: 'R-abc123',
      state: 'armed',
      round: 3,
      maxRounds: 40,
      ...overrides.run,
    },
    patches: [],
  }
  return createRoundDriver({
    logger: { warn: () => {} },
    now: () => 1000,
    getRun: () => state.run,
    patchRun: (patch) => {
      state.patches.push(patch)
      state.run = { ...state.run, ...patch }
      return state.run
    },
    renderPrompt: overrides.renderPrompt ?? ((run, reservation) => ({
      role: 'user',
      id: `round-${reservation.round}`,
      content: [{ type: 'text', text: `<run_round round="${reservation.round}"/>` }],
      source: { ...PLUGIN_SOURCE },
    })),
    onTerminate: (run, outcome) => terminated.push({ runId: run.id, ...outcome }),
    onAdmit: overrides.onAdmit,
  })
}

const agent = () => ({
  id: 'sess-1',
  followup(message) {
    queued.push(message)
  },
})

beforeEach(() => {
  driver = makeDriver()
})

/* ─────────────────────────────── the gate ──────────────────────────────── */

test('a disabled driver never queues, and disabling clears a pending round', () => {
  driver.setEnabled(false)
  driver.handleStatus({ agent: agent(), status: 'idle' })
  assert.equal(queued.length, 0)

  driver.setEnabled(true)
  driver.handleStatus({ agent: agent(), status: 'idle' })
  assert.equal(queued.length, 1)

  driver.setEnabled(false)
  assert.equal(driver.peekReservation(), undefined, 'disabling must not leave a live reservation')
})

test('only an idle, armed run queues a round', () => {
  driver.setEnabled(true)
  driver.handleStatus({ agent: agent(), status: 'running' })
  assert.equal(queued.length, 0, 'a busy agent is never interrupted')

  state.run = { ...state.run, state: 'paused' }
  driver.handleStatus({ agent: agent(), status: 'idle' })
  assert.equal(queued.length, 0, 'a paused run stays paused')

  state.run = { ...state.run, state: 'armed' }
  driver.handleStatus({ agent: agent(), status: 'idle' })
  assert.equal(queued.length, 1)
})

test('a pending reservation blocks a second queue attempt', () => {
  driver.setEnabled(true)
  const a = agent()
  driver.handleStatus({ agent: a, status: 'idle' })
  driver.handleStatus({ agent: a, status: 'idle' })
  driver.handleStatus({ agent: a, status: 'idle' })
  assert.equal(queued.length, 1, 'two idle notifications must not stack two rounds')
})

/* ────────────────────────────── admission ──────────────────────────────── */

test('admission consumes exactly one round number', async () => {
  driver.setEnabled(true)
  driver.handleStatus({ agent: agent(), status: 'idle' })

  const next = async () => ({ kind: 'enter', messages: queued })
  const decision = await driver.handlePreStep({ agent: agent(), messages: queued }, next)

  assert.equal(decision.kind, 'enter')
  assert.equal(state.run.round, 4, 'the reserved round is committed on admission')
  assert.equal(driver.peekReservation(), undefined)
  assert.ok(
    state.patches.some((p) => p.round === 4),
    'the round number is written durably, not only held in memory',
  )
})

test('admission reports the round it admitted, once, with its durable id', async () => {
  const admitted = []
  driver = makeDriver({ onAdmit: async (roundId, round) => admitted.push([roundId, round]) })
  driver.setEnabled(true)
  driver.handleStatus({ agent: agent(), status: 'idle' })
  await driver.handlePreStep({ agent: agent(), messages: queued }, async () => ({ kind: 'enter', messages: queued }))
  assert.deepEqual(admitted, [['R-abc123-r4', 4]])

  // A rejected round must not be reported as dispatched: the whole point of the
  // fact is that a later reader can trust it.
  driver = makeDriver({ onAdmit: async (roundId, round) => admitted.push([roundId, round]) })
  driver.setEnabled(true)
  driver.handleStatus({ agent: agent(), status: 'idle' })
  state.run = { ...state.run, state: 'paused' }
  await driver.handlePreStep({ agent: agent(), messages: queued }, async () => ({ kind: 'enter', messages: queued }))
  assert.deepEqual(admitted, [['R-abc123-r4', 4]])

  // A hook that throws must not cost the round.
  driver = makeDriver({
    onAdmit: async () => {
      throw new Error('ledger is unwritable')
    },
  })
  driver.setEnabled(true)
  driver.handleStatus({ agent: agent(), status: 'idle' })
  const decision = await driver.handlePreStep({ agent: agent(), messages: queued }, async () => ({ kind: 'enter', messages: queued }))
  assert.equal(decision.kind, 'enter')
  assert.equal(state.run.round, 4)
})

test('a stale reservation is rejected on both sides of next()', async () => {
  driver.setEnabled(true)
  driver.handleStatus({ agent: agent(), status: 'idle' })

  // Disarmed between queueing and admission: the round must not enter.
  state.run = { ...state.run, state: 'paused' }
  const rejected = await driver.handlePreStep({ agent: agent(), messages: queued }, async () => ({ kind: 'enter', messages: queued }))
  assert.deepEqual(rejected, { kind: 'reject' })
  assert.equal(state.run.round, 3, 'a rejected round consumes nothing')

  // Disarmed *during* next(): the post-check must catch it too.
  driver = makeDriver()
  driver.setEnabled(true)
  driver.handleStatus({ agent: agent(), status: 'idle' })
  const decision = await driver.handlePreStep({ agent: agent(), messages: queued }, async () => {
    state.run = { ...state.run, state: 'paused' }
    return { kind: 'enter', messages: queued }
  })
  assert.deepEqual(decision, { kind: 'reject' })
})

test('a message the driver did not queue passes through untouched', async () => {
  driver.setEnabled(true)
  const foreign = [{ role: 'user', id: 'x', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }]
  let called = false
  const decision = await driver.handlePreStep({ agent: agent(), messages: foreign }, async () => {
    called = true
    return { kind: 'enter', messages: foreign }
  })
  assert.equal(called, true, 'an unrelated step must still reach the next listener')
  assert.equal(decision.kind, 'enter')
})

test('only the driver\u2019s own messages are recognised as rounds', () => {
  assert.equal(isRoundMessage({ source: { ...PLUGIN_SOURCE } }), true)
  assert.equal(isRoundMessage({ source: { kind: 'user' } }), false)
  assert.equal(isRoundMessage({ source: { kind: 'plugin', plugin: 'someone-else' } }), false)
  assert.equal(isRoundMessage(undefined), false)
})

/* ───────────────────────────── the human wins ──────────────────────────── */

test('a human message pauses an armed run and drops the queued round', () => {
  driver.setEnabled(true)
  driver.handleStatus({ agent: agent(), status: 'idle' })
  assert.ok(driver.peekReservation() !== undefined)

  driver.handleHumanInput({ message: { source: { kind: 'user' } } })
  assert.equal(state.run.state, 'paused')
  assert.equal(driver.peekReservation(), undefined, 'the queued round does not race the human')
  assert.equal(state.run.pausedReason, 'human-input')
})

test('a plugin message is not a human message', () => {
  driver.setEnabled(true)
  driver.handleHumanInput({ message: { source: { ...PLUGIN_SOURCE } } })
  assert.equal(state.run.state, 'armed')
})

/* ──────────────────────────── escape valves ────────────────────────────── */

test('the round cap terminates with a stable, actionable code', () => {
  driver = makeDriver({ run: { round: 40, maxRounds: 40 } })
  driver.setEnabled(true)
  driver.handleStatus({ agent: agent(), status: 'idle' })

  assert.equal(queued.length, 0, 'no round is queued past the cap')
  assert.equal(terminated.length, 1)
  assert.equal(terminated[0].state, 'blocked')
  assert.equal(terminated[0].code, ROUND_LIMIT_CODE)
  assert.match(terminated[0].message, /轮数上限/)
})

test('a failed render or queue clears the reservation so the next idle retries', () => {
  const boom = () => {
    throw new Error('render failed')
  }
  driver = makeDriver({ renderPrompt: boom })
  driver.setEnabled(true)
  driver.handleStatus({ agent: agent(), status: 'idle' })
  assert.equal(driver.peekReservation(), undefined, 'a failed attempt must not block the next one')

  const failing = {
    id: 'sess-1',
    followup() {
      throw new Error('queue failed')
    },
  }
  driver = makeDriver()
  driver.setEnabled(true)
  driver.handleStatus({ agent: failing, status: 'idle' })
  assert.equal(driver.peekReservation(), undefined)
})

/* ══════════════════════ L3: rounds in a fresh child ═════════════════════ */

function makeFreshDriver(overrides = {}) {
  const fresh = []
  const recorded = []
  const scheduled = []
  const driver = createRoundDriver({
    logger: { warn: () => {} },
    now: () => 2000,
    getRun: () => state.run,
    patchRun: (patch) => {
      state.patches.push(patch)
      state.run = { ...state.run, ...patch }
      return state.run
    },
    renderPrompt: () => ({ role: 'user', id: 'r', content: [], source: { ...PLUGIN_SOURCE } }),
    onTerminate: (run, outcome) => terminated.push({ runId: run.id, ...outcome }),
    runFreshRound: async (run, round) => {
      fresh.push({ runId: run.id, round })
      return overrides.outcome ?? { started: true, childId: 'child-1', stopReason: 'completed', report: 'did a thing' }
    },
    recordFreshRound: async (run, round, outcome) => {
      recorded.push({ round, started: outcome?.started })
    },
    schedule: (fn) => scheduled.push(fn),
  })
  return { driver, fresh, recorded, scheduled }
}

test('a fresh-mode run dispatches to a child instead of the session inbox', async () => {
  driver = makeDriver({ run: { mode: 'fresh' } })
  driver.setEnabled(true)
  driver.handleStatus({ agent: agent(), status: 'idle' })
  // Without the fresh dependency the driver falls back to the inbox, which is
  // the right behaviour for a composition that has no subagents service.
  assert.equal(queued.length, 1)
})

test('with a fresh round available the session inbox is left alone', async () => {
  state = { run: { id: 'R-abc123', state: 'armed', round: 3, maxRounds: 40, mode: 'fresh' }, patches: [] }
  const made = makeFreshDriver()
  made.driver.setEnabled(true)
  made.driver.handleStatus({ agent: agent(), status: 'idle' })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(queued.length, 0, 'a fresh round never touches the owner session')
  assert.deepEqual(made.fresh, [{ runId: 'R-abc123', round: 4 }])
  assert.equal(state.run.round, 4, 'the fresh round consumes its number')
  assert.match(state.run.lastFreshReport, /did a thing/)
  assert.deepEqual(made.recorded, [{ round: 4, started: true }])
})

test('a fresh round asks for the next one, which is what keeps the loop alive', async () => {
  state = { run: { id: 'R-abc123', state: 'armed', round: 3, maxRounds: 40, mode: 'fresh' }, patches: [] }
  const made = makeFreshDriver()
  made.driver.setEnabled(true)
  made.driver.handleStatus({ agent: agent(), status: 'idle' })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(made.scheduled.length, 1, 'a fresh round does not make the owner non-idle, so nothing else would re-enter')
})

test('two idle notifications do not start two fresh rounds', async () => {
  state = { run: { id: 'R-abc123', state: 'armed', round: 3, maxRounds: 40, mode: 'fresh' }, patches: [] }
  let release
  const gate = new Promise((resolve) => (release = resolve))
  const started = []
  const driverWithGate = createRoundDriver({
    logger: { warn: () => {} },
    getRun: () => state.run,
    patchRun: (patch) => ((state.run = { ...state.run, ...patch }), state.run),
    renderPrompt: () => ({}),
    onTerminate: () => {},
    runFreshRound: async () => {
      started.push(state.run.round)
      await gate
      return { started: true, childId: 'c', stopReason: 'completed', report: '' }
    },
    recordFreshRound: async () => {},
    schedule: () => {},
  })
  driverWithGate.setEnabled(true)

  driverWithGate.handleStatus({ agent: agent(), status: 'idle' })
  assert.equal(driverWithGate.isFreshRoundInFlight(), true)
  driverWithGate.handleStatus({ agent: agent(), status: 'idle' })
  driverWithGate.handleStatus({ agent: agent(), status: 'idle' })

  release()
  await gate
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(started.length, 1, 'a second wake while a round is in flight must be ignored, not queued')
})

test('the round cap still terminates a fresh-mode run', async () => {
  state = { run: { id: 'R-abc123', state: 'armed', round: 40, maxRounds: 40, mode: 'fresh' }, patches: [] }
  const made = makeFreshDriver()
  made.driver.setEnabled(true)
  driver = made.driver
  made.driver.handleStatus({ agent: agent(), status: 'idle' })

  assert.equal(made.fresh.length, 0, 'no fresh round past the cap')
  assert.equal(terminated.length, 1)
  assert.equal(terminated[0].code, ROUND_LIMIT_CODE)
})

test('a run paused mid-round is not handed another one', async () => {
  state = { run: { id: 'R-abc123', state: 'armed', round: 3, maxRounds: 40, mode: 'fresh' }, patches: [] }
  const scheduled = []
  const pausing = createRoundDriver({
    logger: { warn: () => {} },
    now: () => 2000,
    getRun: () => state.run,
    patchRun: (patch) => ((state.run = { ...state.run, ...patch }), state.run),
    renderPrompt: () => ({}),
    onTerminate: () => {},
    runFreshRound: async () => {
      // The human pauses while the child is still running.
      state.run = { ...state.run, state: 'paused' }
      return { started: true, childId: 'c', stopReason: 'completed', report: '' }
    },
    recordFreshRound: async () => {},
    schedule: (fn) => scheduled.push(fn),
  })
  pausing.setEnabled(true)
  pausing.handleStatus({ agent: agent(), status: 'idle' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(scheduled.length, 0, 'the pause is re-read after the round, so no further round is requested')
})

test('the round cap still terminates a fresh-mode run', async () => {
  state = { run: { id: 'R-abc123', state: 'armed', round: 40, maxRounds: 40, mode: 'fresh' }, patches: [] }
  const made = makeFreshDriver()
  made.driver.setEnabled(true)
  driver = made.driver
  made.driver.handleStatus({ agent: agent(), status: 'idle' })

  assert.equal(made.fresh.length, 0, 'no fresh round past the cap')
  assert.equal(terminated.length, 1)
  assert.equal(terminated[0].code, ROUND_LIMIT_CODE)
})

test('a fresh round that stopped being armed does not schedule another', async () => {
  state = { run: { id: 'R-abc123', state: 'armed', round: 3, maxRounds: 40, mode: 'fresh' }, patches: [] }
  const made = makeFreshDriver()
  made.driver.setEnabled(true)
  // The human pauses while the child is running.
  const pausing = createRoundDriver({
    logger: { warn: () => {} },
    now: () => 2000,
    getRun: () => state.run,
    patchRun: (patch) => ((state.run = { ...state.run, ...patch }), state.run),
    renderPrompt: () => ({}),
    onTerminate: () => {},
    runFreshRound: async () => {
      state.run = { ...state.run, state: 'paused' }
      return { started: true, childId: 'c', stopReason: 'completed', report: '' }
    },
    recordFreshRound: async () => {},
    schedule: (fn) => made.scheduled.push(fn),
  })
  pausing.setEnabled(true)
  pausing.handleStatus({ agent: agent(), status: 'idle' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(made.scheduled.length, 0, 'a paused run must not be handed another round')
})
