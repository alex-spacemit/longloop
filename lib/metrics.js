/**
 * §12: the measurements that decide whether any of this works.
 *
 * The design puts metrics last for a reason, and the reason is the honest one:
 * without a baseline, every claim about a governance feature is a story. So this
 * module computes only what the ledger can actually prove, and reports the rest
 * as `undefined` rather than as zero — "no data" and "zero" are different facts,
 * and a report that conflates them is worse than no report.
 *
 * The ledger is the source. Each fact is one JSON line (`round`, `verdict`,
 * `run-end`, …), written by the host half, so these numbers describe what
 * happened rather than what the state file currently claims.
 */

/** Terminal outcomes, by how much they cost the human. */
export const OUTCOMES = Object.freeze(['done', 'blocked', 'exhausted', 'aborted', 'suspended'])

/**
 * Whether a verification level proves something beyond the run's own claim.
 *
 * `self` is a statement the executor makes about itself; it is recorded, and it
 * is *not* evidence. Keeping that distinction in one place is what stops the
 * report from calling a self-declared run "verified".
 */
export function isExecutable(level) {
  return level === 'executable' || level === 'independent'
}

/** Per-run rollups, keyed by run id, in first-seen order. */
function collectRuns(ledger) {
  const runs = new Map()
  const ensure = (id) => {
    const key = String(id ?? 'unknown')
    if (!runs.has(key)) {
      runs.set(key, {
        id: key,
        startedAt: undefined,
        endedAt: undefined,
        objective: '',
        acceptance: undefined,
        checkable: undefined,
        frozen: undefined,
        contractWarnings: undefined,
        dispatches: 0,
        rounds: new Set(),
        roundAttempts: 0,
        verdicts: [],
        processPasses: [],
        escalations: [],
        contextPasses: [],
        deadEnds: 0,
        notes: 0,
        handoffs: 0,
        unknownOutcomes: 0,
        suspended: 0,
        outcome: undefined,
      })
    }
    return runs.get(key)
  }

  for (const entry of ledger ?? []) {
    if (entry === null || typeof entry !== 'object') continue
    switch (entry.kind) {
      case 'run-start': {
        const run = ensure(entry.runId)
        run.startedAt = entry.at
        run.objective = String(entry.objective ?? '')
        if (entry.acceptance !== undefined) run.acceptance = Number(entry.acceptance)
        if (entry.checkable !== undefined) run.checkable = Number(entry.checkable)
        if (entry.frozen !== undefined) run.frozen = Number(entry.frozen)
        if (entry.contractWarnings !== undefined) run.contractWarnings = Number(entry.contractWarnings)
        break
      }
      case 'round': {
        const run = ensure(entry.runId)
        run.roundAttempts += 1
        run.rounds.add(String(entry.roundId ?? `r${entry.round}`))
        if (Array.isArray(entry.signals) && entry.signals.length > 0) {
          run.escalations.push({ round: entry.round, signals: entry.signals, action: entry.escalation ?? 'continue' })
        }
        break
      }
      case 'round-dispatch':
        ensure(entry.runId).dispatches += 1
        break
      case 'round-outcome-unknown':
        ensure(entry.runId).unknownOutcomes += 1
        break
      case 'verdict': {
        const run = ensure(entry.runId)
        run.verdicts.push({
          at: entry.at,
          round: entry.round,
          level: String(entry.level ?? 'self'),
          status: String(entry.status ?? 'unknown'),
          counts: entry.counts ?? {},
        })
        break
      }
      case 'process-verify': {
        const run = ensure(entry.runId)
        run.processPasses.push({ at: entry.at, round: entry.round, status: String(entry.status ?? 'unknown') })
        break
      }
      case 'context':
        ensure(entry.runId).contextPasses.push({ at: entry.at, band: entry.band, action: entry.action })
        break
      case 'dead-end':
        ensure(entry.runId).deadEnds += 1
        break
      case 'note':
        ensure(entry.runId).notes += 1
        break
      case 'handoff':
        ensure(entry.runId).handoffs += 1
        break
      case 'run-suspended':
        ensure(entry.runId).suspended += 1
        break
      case 'run-end':
      case 'run-stop': {
        const run = ensure(entry.runId)
        run.endedAt = entry.at
        run.outcome = String(entry.state ?? (entry.kind === 'run-stop' ? 'aborted' : 'unknown'))
        break
      }
      default:
        break
    }
  }
  return runs
}

/** A median that says `undefined` for an empty set instead of pretending zero. */
function median(values) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

function share(part, whole) {
  return whole === 0 || whole === undefined ? undefined : Number((part / whole).toFixed(3))
}

/**
 * The whole report.
 *
 * Deliberately narrow: every field here is computed from facts the framework
 * already writes. Fields the ledger cannot support (token spend per run, for
 * instance — only a pressure snapshot is recorded) are reported under `gaps`
 * instead of being estimated, because a metric nobody can trust is worse than a
 * metric nobody has.
 */
export function computeMetrics(ledger) {
  const runs = [...collectRuns(ledger).values()]
  const finished = runs.filter((run) => run.outcome !== undefined && run.outcome !== 'suspended')
  const withVerdicts = runs.filter((run) => run.verdicts.length > 0)
  const executableVerdicts = runs.flatMap((run) => run.verdicts).filter((verdict) => isExecutable(verdict.level))
  const passingVerdicts = executableVerdicts.filter((verdict) => verdict.status === 'pass')
  const firstVerdicts = runs.map((run) => run.verdicts[0]).filter((verdict) => verdict !== undefined)
  const declaredOnly = runs.filter((run) => run.acceptance !== undefined && (run.checkable ?? 0) === 0)
  const unverifiable = runs.filter((run) => (run.acceptance ?? 0) > 0 && (run.checkable ?? 0) === 0)
  const driftedWarnings = runs.filter((run) => (run.contractWarnings ?? 0) > 0)

  return {
    scope: { runs: runs.length, facts: Array.isArray(ledger) ? ledger.length : 0 },
    outcomes: {
      byState: OUTCOMES.reduce((acc, state) => {
        const count = runs.filter((run) => run.outcome === state).length
        if (count > 0) acc[state] = count
        return acc
      }, {}),
      finished: finished.length,
      open: runs.length - finished.length,
      completionRate: share(runs.filter((run) => run.outcome === 'done').length, finished.length),
    },
    rounds: {
      // Distinct rounds, so a human re-assessing a round does not inflate this.
      perRun: runs.map((run) => ({ id: run.id, rounds: run.rounds.size, attempts: run.roundAttempts, dispatches: run.dispatches })),
      medianToFinish: median(finished.filter((run) => run.rounds.size > 0).map((run) => run.rounds.size)),
      worstRun: runs.reduce((worst, run) => Math.max(worst, run.rounds.size), 0),
    },
    verification: {
      runsWithAVerdict: withVerdicts.length,
      verdictCoverage: share(withVerdicts.length, runs.length),
      verdicts: executableVerdicts.length,
      // The number that matters: of the verdicts that actually ran something,
      // how many passed. A `self` verdict is excluded on purpose — it is a claim.
      executablePassRate: share(passingVerdicts.length, executableVerdicts.length),
      selfDeclaredOnly: runs.length - withVerdicts.length,
      firstVerdictPasses: firstVerdicts.filter((verdict) => verdict.status === 'pass' && isExecutable(verdict.level)).length,
      firstVerdictAttempts: firstVerdicts.length,
    },
    contracts: {
      declaredOnly: declaredOnly.length,
      noMachineCheck: unverifiable.length,
      withDowngradeWarnings: driftedWarnings.length,
      frozen: runs.filter((run) => (run.frozen ?? 0) > 0).length,
    },
    drift: {
      processPasses: runs.reduce((total, run) => total + run.processPasses.length, 0),
      processPassesFailing: runs.reduce(
        (total, run) => total + run.processPasses.filter((pass) => pass.status !== 'pass').length,
        0,
      ),
      runsThatEscalated: runs.filter((run) => run.escalations.length > 0).length,
      escalationsRecorded: runs.reduce((total, run) => total + run.escalations.length, 0),
      deadEnds: runs.reduce((total, run) => total + run.deadEnds, 0),
      unknownOutcomes: runs.reduce((total, run) => total + run.unknownOutcomes, 0),
      suspensions: runs.reduce((total, run) => total + run.suspended, 0),
    },
    context: {
      passes: runs.reduce((total, run) => total + run.contextPasses.length, 0),
      compactions: runs.reduce(
        (total, run) => total + run.contextPasses.filter((pass) => pass.action === 'compacted' || pass.action === 'compact').length,
        0,
      ),
    },
    handoffs: runs.reduce((total, run) => total + run.handoffs, 0),
    /**
     * What this report cannot say, stated instead of faked. Each entry names the
     * fact that would be needed to fill it in.
     */
    gaps: [
      '每次运行的实际 token 花费没有逐条记录（只有上下文压力快照），所以没有「每完成一任务的成本」。',
      '没有对照组，因此这些数字描述的是现状，不是这套治理带来的增益。',
      '「虚假完成率」只能间接看：可执行裁决的通过率 + 过程抽查失败次数，都不是直接度量。',
    ],
  }
}

/** Rows for the console and for `/longloop metrics`. */
export function renderMetrics(report) {
  const percent = (value) => (value === undefined ? '—' : `${(value * 100).toFixed(0)}%`)
  const lines = [
    `运行 ${report.scope.runs} 条 · 台账 ${report.scope.facts} 条`,
    `结局：${Object.entries(report.outcomes.byState).map(([state, count]) => `${state} ${count}`).join(' · ') || '还没有终局'}`
      + `（完成率 ${percent(report.outcomes.completionRate)}）`,
    `轮次：中位数 ${report.rounds.medianToFinish ?? '—'} 轮 · 最长 ${report.rounds.worstRun} 轮`,
    `验证：有裁决的运行 ${report.verification.runsWithAVerdict}/${report.scope.runs}（覆盖 ${percent(report.verification.verdictCoverage)}）· `
      + `可执行裁决通过率 ${percent(report.verification.executablePassRate)}`,
    `契约：只靠声明的运行 ${report.contracts.declaredOnly} 条 · 开工时降级过 ${report.contracts.withDowngradeWarnings} 条 · 冻结过文件 ${report.contracts.frozen} 条`,
    `漂移：过程抽查 ${report.drift.processPasses} 次（不过 ${report.drift.processPassesFailing} 次）· 升级 ${report.drift.escalationsRecorded} 次 · `
      + `死路 ${report.drift.deadEnds} 条 · 结果未知 ${report.drift.unknownOutcomes} 次`,
    `上下文：治理 ${report.context.passes} 次 · 主动压缩 ${report.context.compactions} 次 · 交接包 ${report.handoffs} 份`,
  ]
  for (const gap of report.gaps) lines.push(`缺什么：${gap}`)
  return lines.join('\n')
}
