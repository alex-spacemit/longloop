/**
 * §8.3 context governance, wired to the host's real measurement and compaction.
 *
 * The pure half already existed in `context.js` (`contextHealth`,
 * `proactiveCompactDue`, `explorationDirective`) and was never called. This is
 * the other half: read the pressure the token meter publishes, decide whether
 * the run is due for a proactive compaction, ask the host's compaction service
 * to do it *between* rounds (where the agent is idle, which is the only moment
 * `compactNow` accepts), and verify the invariant a summary may not break.
 *
 * Why proactive at all, when the framework already compacts on pressure? The
 * automatic trigger fires at 80% of the window (`dsh-compaction-basic`'s
 * default `thresholdRatio`), by which point the summary model has the least
 * attention left to decide what mattered. §8.3 compacts earlier because it is
 * cheaper *and* better.
 */

import { contextHealth, proactiveCompactDue, PROACTIVE_COMPACT_AT } from './context.js'

/** The key `@deepseek-ai/dsh-token-meter` publishes its pressure projection under. */
const PRESSURE_PROJECTION_KEY = 'contextPressure'

/**
 * Read the token meter's pressure for one session.
 *
 * The meter's `measure()` returns counts, not the window; the window and
 * `pressureTokens` live in its `contextPressure` projection, which is what
 * decides the automatic compaction trigger too — reading the same number is the
 * point.
 *
 * @returns `{ pressureTokens, contextWindow }`, or `undefined` when unmeasurable.
 */
export function measurePressure(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  const sessions = ctx.get('sessions')
  const registry = ctx.get('sessionProjections')
  if (sessions === undefined || registry === undefined || typeof registry.stateOf !== 'function') return undefined
  try {
    const session = sessions.get(sessionId)
    if (session === undefined) return undefined
    const pressure = registry.stateOf(session, PRESSURE_PROJECTION_KEY)
    if (pressure === null || pressure === undefined) return undefined
    const tokens = Number(pressure.pressureTokens ?? pressure.surfaceTokens ?? Number.NaN)
    const window = Number(pressure.contextWindow ?? Number.NaN)
    return { pressureTokens: tokens, contextWindow: window }
  } catch {
    return undefined
  }
}

/**
 * The §8.3 health number for one run, plus the proactive-compaction verdict.
 * Pure with respect to the host: one measurement, one decision, nothing written.
 */
export function contextReport(ctx, run, threshold = PROACTIVE_COMPACT_AT) {
  const pressure = measurePressure(ctx, run?.ownerSessionId)
  const health = contextHealth({
    pressureTokens: pressure?.pressureTokens,
    contextWindow: pressure?.contextWindow,
    rounds: run?.round ?? 0,
    openQuestions: (run?.notes ?? []).filter((note) => note.kind === 'open-question').length,
  })
  return { health, verdict: proactiveCompactDue(health, threshold), threshold }
}

/**
 * Whether the log still pairs every tool call with its result.
 *
 * §8.3's first hard invariant, and the one a summariser can break silently: a
 * dangling `tool_call` makes the next request invalid. The log is read once,
 * synchronously, right after compaction — a maintenance path, not a hot one.
 *
 * @returns `{ checked, balanced, calls, results }`.
 */
export function toolPairing(session) {
  let events
  try {
    events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : undefined
  } catch {
    events = undefined
  }
  if (!Array.isArray(events)) return { checked: false, balanced: false, calls: 0, results: 0 }

  let calls = 0
  let results = 0
  for (const event of events) {
    if (event?.type === 'tool/call') calls += 1
    if (event?.type === 'tool/result') results += 1
  }
  return { checked: true, balanced: calls === results, calls, results }
}

/**
 * The record the run keeps about one governance pass.
 *
 * Built without `undefined` fields on purpose: `session.append` rejects a
 * non-lossless payload, and a dropped key is the honest shape for "not
 * measured" anyway.
 */
function record(round, health, verdict, action, extra = {}) {
  const out = {
    at: Date.now(),
    round: Number(round ?? 0),
    measured: health.measured === true,
    band: String(health.band ?? 'unknown'),
    ratio: Number(health.ratio ?? 0),
    due: verdict.due === true,
    action,
    reason: String(verdict.reason ?? ''),
  }
  if (health.measured === true) {
    out.pressureTokens = Number(health.pressureTokens ?? 0)
    out.contextWindow = Number(health.contextWindow ?? 0)
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * One governance pass, run at the idle boundary before a round is queued.
 *
 * Order matters: measure, then — only if due — compact, then re-check the
 * pairing invariant on the compacted log. Every branch returns a record; the
 * caller writes it to the ledger and the event log, so "the console did
 * nothing" is distinguishable from "the console could not measure".
 *
 * @param ctx - host context.
 * @param agent - the agent whose session the round will run in (idle here).
 * @param run - the current run.
 * @returns a lossless-JSON record of the pass.
 */
export async function governBeforeRound(ctx, agent, run) {
  const { health, verdict, threshold } = contextReport(ctx, run)
  if (verdict.due !== true) {
    return record(run?.round, health, verdict, health.measured === true ? 'within-budget' : 'unmeasurable', { threshold })
  }

  const compaction = ctx.get('compaction')
  if (compaction === undefined || typeof compaction.compactNow !== 'function') {
    // No compaction capability mounted: the run continues, and the record says
    // why nothing happened instead of pretending the window is comfortable.
    return record(run?.round, health, verdict, 'unavailable', { threshold })
  }

  try {
    const controller = new AbortController()
    const result = await compaction.compactNow(agent, controller.signal)
    const pairing = toolPairing(agent?.session)
    return record(run?.round, health, verdict, result === null ? 'nothing-to-compact' : 'compacted', {
      threshold,
      compaction: {
        id: String(result?.id ?? ''),
        replaced: Number(result?.replacedEventCount ?? result?.replaced ?? 0),
        summaryTokens: Number(result?.summaryTokens ?? 0),
      },
      pairing,
    })
  } catch (error) {
    // `busy` is the expected failure when the agent is not actually idle; it is
    // recorded, not raised, because a governance nicety must not stop a run.
    return record(run?.round, health, verdict, 'deferred', {
      threshold,
      error: String(error?.message ?? error).slice(0, 200),
    })
  }
}
