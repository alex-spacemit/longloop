/**
 * LongLoop round driver — same-session continuation for one armed run.
 *
 * The driver owns **no state a crash must preserve**: everything durable lives
 * in `run.json`, and the two fields it holds in memory are the reservation for
 * the round it just queued and whether it is enabled at all. That is deliberate
 * — §8.6 says a resumed process must not resume work on its own, and a driver
 * that remembered its own intent would do exactly that.
 *
 * Wiring (see index.js):
 *   agent/status         -> handleStatus        queue the next round at idle
 *   agent/pre-step       -> handlePreStep       fence a stale reservation out
 *   agent/inbox/inserted -> handleHumanInput    yield to a human immediately
 *
 * The pattern is the one `dsh-goal-round-driver` already proved in production:
 * reserve, admit, re-check on both sides of `next()`, and fail closed.
 */

import { roundIdFor } from './run.js'

/** Identifies this plugin's own queued rounds, in both directions. */
export const PLUGIN_SOURCE = Object.freeze({ kind: 'plugin', plugin: 'longloop-console', form: 'instructions' })

/** Whether one message is a round this driver queued. */
export function isRoundMessage(message) {
  return message?.source?.kind === 'plugin' && message?.source?.plugin === 'longloop-console'
}

/** The stable blocker code recorded when the round cap is reached. */
export const ROUND_LIMIT_CODE = 'round-limit'

/**
 * @param deps.getRun    - read the durable run, or `undefined`
 * @param deps.patchRun  - apply a patch and return the updated run
 * @param deps.observeRound - measure what the finished round actually did
 * @param deps.renderPrompt - build the `UserMessage` for one round
 * @param deps.onTerminate  - record a terminal state (`exhausted` / `blocked`)
 * @param deps.now, deps.logger
 */
export function createRoundDriver(deps) {
  const {
    getRun,
    patchRun,
    observeRound,
    renderPrompt,
    onTerminate,
    // L3 runs a round in a fresh child instead of this session. Injected rather
    // than imported so the driver stays testable without a subagent registry.
    runFreshRound,
    recordFreshRound,
    // §8.3 governance, run at the idle boundary — the one moment the agent is
    // idle enough for a maintenance compaction to be legal. Injected so the
    // driver keeps knowing nothing about compaction.
    beforeRound,
    // §8.6: called once per admitted round with its durable id, so the host can
    // record the dispatch. Injected so the driver owns no I/O of its own.
    onAdmit,
    schedule = (fn) => setTimeout(fn, 0),
    now = Date.now,
    logger,
  } = deps

  let enabled = false
  /** The round this driver queued and has not yet seen admitted. */
  let reservation
  /** One fresh round at a time: two would double-charge the budget. */
  let freshInFlight = false

  const warn = (message) => logger?.warn?.(`longloop-driver: ${message}`)

  function clearReservation() {
    reservation = undefined
  }

  /**
   * Run one round in a fresh child, then ask for the next one.
   *
   * A fresh round does not make the owner agent non-idle, so nothing would ever
   * re-enter `handleStatus`. Rescheduling here is what keeps the loop going —
   * and it is also the one place the driver can spin, so every terminal
   * condition is re-read before the next round is requested.
   */
  async function advanceFreshRound(agent, run) {
    if (freshInFlight) return
    freshInFlight = true
    const round = run.round + 1
    let outcome
    try {
      outcome = await runFreshRound(run, round)
      await recordFreshRound(run, round, outcome)
    } catch (error) {
      warn(`fresh round ${round} failed: ${error?.message ?? error}`)
      outcome = { started: false, reason: String(error?.message ?? error) }
    } finally {
      freshInFlight = false
    }

    if (outcome?.started === true) {
      patchRun({ round, lastRoundAt: now(), lastFreshReport: String(outcome.report ?? '').slice(0, 4000) })
    } else {
      // Falling back is better than stalling: the round stays unspent and the
      // next tick runs it in-session, which is exactly the old behaviour.
      warn(`fresh round could not start (${outcome?.reason}); falling back to the same session`)
      patchRun({ mode: 'inline', freshFallbackReason: outcome?.reason })
    }

    const latest = getRun()
    if (latest === undefined || latest.state !== 'armed') return
    if (latest.round >= latest.maxRounds) {
      onTerminate(latest, { state: 'blocked', code: ROUND_LIMIT_CODE, message: `达到轮数上限 ${latest.maxRounds}` })
      return
    }
    schedule(() => handleStatus({ agent, status: 'idle' }))
  }

  /**
   * Queue one round if — and only if — every precondition still holds at the
   * moment of queueing. Each check is re-read here rather than trusted from an
   * earlier tick, because a human can arm, pause, or stop between two idles.
   */
  function handleStatus(payload) {
    if (!enabled) return
    const { agent, status } = payload ?? {}
    if (status !== 'idle' || agent === undefined) return
    if (reservation !== undefined) return

    const run = getRun()
    if (run === undefined || run.state !== 'armed') return

    if (run.round >= run.maxRounds) {
      onTerminate(run, { state: 'blocked', code: ROUND_LIMIT_CODE, message: `达到轮数上限 ${run.maxRounds}` })
      return
    }

    // L3 puts the next round in a fresh child. The mode is decided by the
    // escalation policy in `finishRound`, never here: the driver reads state,
    // it does not set policy.
    if (run.mode === 'fresh' && typeof runFreshRound === 'function') {
      void advanceFreshRound(agent, run)
      return
    }

    if (typeof beforeRound === 'function') {
      // Compaction must finish before the round's prompt is assembled, or the
      // round starts on the very context it was meant to escape. The reservation
      // therefore waits on governance — and a governance failure still queues the
      // round, because §8.3 is an optimisation, not a gate.
      Promise.resolve(beforeRound(agent, run))
        .catch((error) => warn(`beforeRound failed: ${error?.message ?? error}`))
        .then(() => queueRound(agent, run))
      return
    }

    queueRound(agent, run)
  }

  /** Reserve, render, and queue one round — the tail of {@link handleStatus}. */
  function queueRound(agent, run) {
    if (reservation !== undefined) return
    const latest = getRun()
    if (latest === undefined || latest.state !== 'armed') return

    // Reserve before queueing: an id is cheap, and only an admitted round
    // consumes a round number (§11.7).
    const round = latest.round + 1
    reservation = { runId: latest.id, round, at: now() }

    let message
    try {
      message = renderPrompt(latest, reservation)
    } catch (error) {
      clearReservation()
      warn(`could not render round ${round}: ${error?.message ?? error}`)
      return
    }

    try {
      agent.followup(message)
    } catch (error) {
      clearReservation()
      warn(`could not queue round ${round} for "${agent.id}": ${error?.message ?? error}`)
      return
    }
    patchRun({ inFlightRound: round })
  }

  /**
   * Admit or reject a queued round.
   *
   * The check runs on both sides of `next()`: a later listener may replace the
   * message batch, and a reservation that stopped being valid in between must
   * not enter the step.
   */
  async function handlePreStep(payload, next) {
    const mine = (payload?.messages ?? []).find(isRoundMessage)
    if (mine === undefined) return next()

    const accept = () => {
      const run = getRun()
      return (
        reservation !== undefined &&
        run !== undefined &&
        run.id === reservation.runId &&
        run.state === 'armed'
      )
    }

    if (!accept()) return { kind: 'reject' }
    const decision = await next()
    if (!accept()) return { kind: 'reject' }

    // Admission is the only place a round number is consumed, and it is also
    // where the round gets its durable id (§8.6): a fact written later can then
    // name the round it belongs to even after a restart.
    const admittedRoundId = roundIdFor({ id: reservation.runId }, reservation.round)
    const admittedRound = reservation.round
    patchRun({
      round: admittedRound,
      roundId: admittedRoundId,
      inFlightRound: undefined,
      lastRoundAt: now(),
    })
    clearReservation()
    // §8.6: record the dispatch, so "was this round ever finished?" is a question
    // the ledger answers rather than one inferred from a counter in the state
    // file. A hook that throws must not cost the round.
    try {
      await onAdmit?.(admittedRoundId, admittedRound)
    } catch {
      // telemetry only
    }
    return decision
  }

  /**
   * A human message always wins. Continuing to queue rounds while someone is
   * typing would make the console a race, and §8.5 puts humans above the loop.
   */
  function handleHumanInput(payload) {
    const { message } = payload ?? {}
    if (message?.source?.kind !== 'user') return
    const run = getRun()
    if (run === undefined || run.state !== 'armed') return
    if (reservation !== undefined) {
      clearReservation()
      warn('a human message arrived while a round was queued; yielding')
    }
    patchRun({ state: 'paused', pausedAt: now(), pausedReason: 'human-input' })
  }

  return {
    isEnabled: () => enabled,
    setEnabled(next) {
      enabled = next === true
      if (!enabled) clearReservation()
    },
    handleStatus,
    handlePreStep,
    handleHumanInput,
    /** Test seam: what the driver believes it has queued. */
    peekReservation: () => reservation,
    /** Test seam: whether a fresh round is in flight. */
    isFreshRoundInFlight: () => freshInFlight,
    observeRound,
  }
}

/** The reason string a terminal patch carries, for the console to display. */
export function terminalReason(patch) {
  return patch?.message ?? patch?.code ?? 'stopped'
}
