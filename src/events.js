/**
 * LongLoop durable facts, as session events with three projections.
 *
 * §4 A1: the session log is the only source of truth — a round that is not in
 * the log did not happen. `.longloop/*.json` stays the working store that the
 * console, the model, and `git` can read, but every fact that decides a run's
 * fate is *also* appended here, so a run can be replayed, audited, and
 * projected without trusting a file the model may rewrite.
 *
 * Two host constraints shape this module:
 *
 *   · `session.append(type, data)` requires **lossless JSON** and throws
 *     otherwise (`snapshotJsonValue`), so every payload built below is plain
 *     scalars, arrays, and objects — never `undefined` fields.
 *   · The projection registry types `stateSchema` as a Zod schema and calls
 *     `.parse()` when restoring a checkpoint row. This plugin ships no
 *     dependencies, so {@link projectionStateSchema} is a validating
 *     stand-in with the same one-method surface.
 */

/** The six facts §5 names. One event type per fact, never a kitchen-sink blob. */
export const LONGLOOP_EVENT = Object.freeze({
  run: 'longloop/run',
  round: 'longloop/round',
  ledger: 'longloop/ledger',
  verdict: 'longloop/verdict',
  escalation: 'longloop/escalation',
  handoff: 'longloop/handoff',
})

/** Projection keys. Stable: a client that read one keeps reading it. */
export const PROJECTION_KEY = Object.freeze({
  run: 'longloopRun',
  rounds: 'longloopRounds',
  ledger: 'longloopLedger',
})

const STATE_VERSION = 1
const MAX_ROUNDS_KEPT = 200
const MAX_LEDGER_KEPT = 500

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * A Zod-shaped validator for projection state.
 *
 * The registry calls `stateSchema.parse(row.val)` when it restores a
 * checkpoint; a passthrough would silently accept a corrupted row, so this
 * checks the declared shape and throws the one error the registry can surface.
 */
function projectionStateSchema(validate) {
  return {
    parse(value) {
      if (!validate(value)) throw new Error('longloop: projection state does not match its declared shape')
      return value
    },
  }
}

/**
 * Append one longloop fact to the live session that owns the run.
 *
 * Never throws. Telemetry must cost a run nothing: a disposed session, a
 * non-lossless payload, or a missing `sessions` service degrades to "not
 * recorded", which the boolean return reports. A run that cannot be written to
 * the log still has to run.
 *
 * @param ctx - host context.
 * @param run - the run the fact belongs to (its session ids name the target).
 * @param type - one of {@link LONGLOOP_EVENT}.
 * @param data - lossless-JSON payload.
 * @returns whether an event was appended.
 */
export function emitLongloop(ctx, run, type, data) {
  const sessions = ctx.get('sessions')
  if (sessions === undefined) return false
  for (const id of sessionIdsOf(run)) {
    try {
      const session = sessions.get(id)
      if (session === undefined || typeof session.append !== 'function') continue
      session.append(type, data)
      return true
    } catch {
      /* try the next id: a run may outlive the session that opened it */
    }
  }
  return false
}

/** Every session id a run is known by, owner first, duplicates dropped. */
export function sessionIdsOf(run) {
  const ids = [run?.ownerSessionId, ...(run?.sessionIds ?? [])]
  return [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))]
}

/** The `longloop/run` payload: the run's identity and contract, not its whole file. */
export function runEventData(run, extra = {}) {
  if (run === undefined || run === null) return { run: null, ...extra }
  return {
    run: {
      id: String(run.id ?? ''),
      state: String(run.state ?? ''),
      objective: String(run.objective ?? ''),
      round: Number(run.round ?? 0),
      maxRounds: Number(run.maxRounds ?? 0),
      mode: run.mode === 'fresh' ? 'fresh' : 'inline',
      assurance: String(run.assurance ?? 'executable'),
      acceptance: (run.contract?.acceptance ?? []).length,
      checkable: (run.contract?.acceptance ?? []).filter((criterion) => criterion.check?.command).length,
      startedAt: Number(run.startedAt ?? 0),
      endedAt: run.endedAt === undefined ? 0 : Number(run.endedAt),
      endReason: String(run.endReason ?? ''),
      sessionIds: sessionIdsOf(run),
    },
    ...extra,
  }
}

/** The `longloop/ledger` payload for one ledger fact. */
export function ledgerEventData(run, entry) {
  return {
    runId: String(run?.id ?? ''),
    round: Number(entry.round ?? run?.round ?? 0),
    kind: String(entry.kind ?? 'note'),
    detail: String(entry.detail ?? '').slice(0, 400),
    at: Number(entry.at ?? Date.now()),
  }
}

/* ───────────────────────────── the projections ───────────────────────────── */

/** Fold `longloop/run` and `longloop/round` into the current run header. */
export function foldRun(state, event) {
  if (event.type === LONGLOOP_EVENT.run) {
    const run = event.data?.run
    return { run: run ?? null, updatedAt: event.time ?? 0 }
  }
  if (event.type === LONGLOOP_EVENT.round && isRecord(state.run)) {
    return {
      ...state,
      run: {
        ...state.run,
        round: Number(event.data?.round ?? state.run.round),
        context: event.data?.context ?? null,
      },
      updatedAt: event.time ?? 0,
    }
  }
  return state
}

/** Keep the last {@link MAX_ROUNDS_KEPT} round summaries. */
export function foldRounds(state, event) {
  if (event.type !== LONGLOOP_EVENT.round) return state
  const round = Number(event.data?.round ?? 0)
  const roundId = event.data?.roundId === undefined ? undefined : String(event.data.roundId)
  const summary = {
    round,
    roundId,
    maxRounds: Number(event.data?.maxRounds ?? 0),
    stallScore: Number(event.data?.stallScore ?? 0),
    stalledRounds: Number(event.data?.stalledRounds ?? 0),
    signals: Array.isArray(event.data?.signals) ? event.data.signals.map(String) : [],
    escalation: event.data?.escalation ?? null,
    context: event.data?.context ?? null,
    at: event.time ?? 0,
  }
  // A round can legitimately be finished more than once (a human re-assessing
  // with the driver off). `count` is therefore *distinct* rounds — a row count
  // would report three rounds where the run only ever ran one.
  const finished = state.rounds.map((entry) => entry.roundId)
  const isNew =
    roundId !== undefined
      ? !finished.includes(roundId)
      : !state.rounds.some((entry) => entry.round === round)
  return {
    count: isNew ? state.count + 1 : state.count,
    attempts: (state.attempts ?? 0) + 1,
    rounds: [...state.rounds, summary].slice(-MAX_ROUNDS_KEPT),
  }
}

/** Keep the last {@link MAX_LEDGER_KEPT} ledger facts, plus a kind histogram. */
export function foldLedger(state, event) {
  if (event.type !== LONGLOOP_EVENT.ledger) return state
  const entry = {
    round: Number(event.data?.round ?? 0),
    kind: String(event.data?.kind ?? 'note'),
    detail: String(event.data?.detail ?? ''),
    at: event.time ?? 0,
  }
  const byKind = { ...state.byKind }
  byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1
  return { count: state.count + 1, byKind, entries: [...state.entries, entry].slice(-MAX_LEDGER_KEPT) }
}

const EMPTY_RUN = { run: null, updatedAt: 0 }
const isRunState = (value) => isRecord(value) && 'run' in value && Number.isFinite(value.updatedAt)
const isRoundsState = (value) => isRecord(value) && Array.isArray(value.rounds) && Number.isFinite(value.count)
const isLedgerState = (value) => isRecord(value) && Array.isArray(value.entries) && isRecord(value.byKind) && Number.isFinite(value.count)

/**
 * Register the three units the console and any auditor read.
 *
 * `ctx.inject(['sessionProjections'], …)` rather than `inject:` on the plugin:
 * a host without the projection capability must still get its task board, so
 * this registration is optional by construction (§10.3's "optional
 * registration" note). The client-visible `wire` half is deliberately omitted
 * — the console reads the same state over its own authenticated prefix, and a
 * second client contract would be a second thing to keep in step.
 */
export function registerLongloopProjections(ctx) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    const registry = projectionCtx.sessionProjections
    if (registry === undefined || typeof registry.register !== 'function') return
    registry.register({
      key: PROJECTION_KEY.run,
      stateVersion: STATE_VERSION,
      stateSchema: projectionStateSchema(isRunState),
      init: () => EMPTY_RUN,
      apply: foldRun,
    })
    registry.register({
      key: PROJECTION_KEY.rounds,
      stateVersion: STATE_VERSION,
      stateSchema: projectionStateSchema(isRoundsState),
      init: () => ({ count: 0, rounds: [] }),
      apply: foldRounds,
    })
    registry.register({
      key: PROJECTION_KEY.ledger,
      stateVersion: STATE_VERSION,
      stateSchema: projectionStateSchema(isLedgerState),
      init: () => ({ count: 0, byKind: {}, entries: [] }),
      apply: foldLedger,
    })
  })
}

/**
 * Why the projections are absent, in words.
 *
 * The console used to assert one cause ("the host has no projection
 * capability") for every absent case, which is a claim it cannot support: an
 * empty new session, a missing service, and a run owned by another session all
 * look the same from there. Naming the actual reason keeps a degraded read from
 * being mistaken for a broken host.
 */
export function projectionAvailability(ctx, sessionId) {
  if (ctx.get('sessions') === undefined) return '宿主没有会话服务'
  if (ctx.get('sessionProjections') === undefined) return '宿主没有 sessionProjections 能力'
  if (sessionId === undefined) return '还没有确定会话 id'
  const session = ctx.get('sessions').get(sessionId)
  return session === undefined ? '这个会话还没落进会话存储' : undefined
}

/**
 * Read the three units for one session, for the console's own state payload.
 * Absent keys report `undefined` rather than a fabricated empty shape, so the
 * console can say "no projection capability" instead of "no rounds".
 */
export function readProjections(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  const registry = ctx.get('sessionProjections')
  if (sessions === undefined || registry === undefined || sessionId === undefined) return undefined
  try {
    const session = sessions.get(sessionId)
    if (session === undefined) return undefined
    return {
      run: registry.stateOf(session, PROJECTION_KEY.run) ?? undefined,
      rounds: registry.stateOf(session, PROJECTION_KEY.rounds) ?? undefined,
      ledger: registry.stateOf(session, PROJECTION_KEY.ledger) ?? undefined,
    }
  } catch {
    return undefined
  }
}
