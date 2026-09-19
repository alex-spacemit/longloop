/**
 * LongLoop governors — the pure half.
 *
 * Budget, progress/stall, and escalation are decisions, not effects: every
 * function here takes plain values and returns plain values, so the whole
 * governance policy is unit-testable without a Host, a Session, or a model.
 * `index.js` owns the I/O that feeds them.
 *
 * Design references (see docs/longloop-framework-design.md):
 *   §8.1  budget ladder          §8.2  stall signals + L0–L5 escalation
 *   §7.4  round prompt           §4.4  escape valves
 */

/** The escalation ladder: stalled rounds to the action taken. */
export const ESCALATION_LADDER = [
  { atStalled: 1, level: 1, action: 'nudge' },
  { atStalled: 2, level: 2, action: 'replan' },
  { atStalled: 3, level: 3, action: 'switch-mode' },
  { atStalled: 4, level: 4, action: 'diagnose' },
  { atStalled: 5, level: 5, action: 'block' },
]

/**
 * The budget ladder. Each rung is a *degradation*, not just a warning: the
 * whole point is that the loop narrows its own scope before it runs out.
 */
export const BUDGET_LADDER = [
  { atRatio: 0.7, action: 'disable-exploration' },
  { atRatio: 0.8, action: 'narrow-scope' },
  { atRatio: 0.9, action: 'force-wrapup' },
  { atRatio: 1.0, action: 'stop' },
]

/**
 * What the model is told when a rung is crossed. Phrased as an instruction the
 * model can act on in one round, never as a status report.
 */
const RUNG_DIRECTIVE = {
  'disable-exploration': '预算已用 70%。停止探索性阅读与搜索，只在必要时读取具体文件。',
  'narrow-scope': '预算已用 80%。把范围收窄到必达的验收标准，放弃次要项。',
  'force-wrapup': '预算已用 90%。开始收尾：完成当前任务的最后一步，然后登记证据并请求验证。',
  stop: '预算已耗尽。立即停止推进，登记已完成的部分与证据。',
}

const ESCALATION_DIRECTIVE = {
  nudge:
    '上一轮没有产生任何可观察的变化（工作区与任务板都没动）。先写下两个**互不相同**的假设，再选一个动手；不要重复上一轮的做法。',
  replan:
    '连续两轮无进展，说明当前路径不通。重新给出任务计划：必须与上一版**结构上不同**，并说明为什么这次会不一样。',
  'switch-mode': '连续三轮无进展。建议放弃在当前上下文里继续尝试，改用全新视角重做这一轮。',
  diagnose: '连续四轮无进展。先不要动手：只读地诊断——为什么卡住、缺什么信息、哪条假设是错的。',
  block: '连续五轮无进展。停止推进，用 run_block 上报具体的阻塞条件与已经尝试过的手段。',
}

/* ───────────────────────────────── budget ──────────────────────────────── */

/** One budgeted dimension, as the console and the prompt both read it. */
function dimension(name, used, limit) {
  const ratio = limit > 0 ? used / limit : 0
  return { name, used, limit, ratio, remaining: Math.max(0, limit - used) }
}

/**
 * Measure every budgeted dimension and pick the rung the run currently stands
 * on. Rounds and wall-clock are always available; tokens and tool calls are
 * measured only when the caller could supply them, so a missing meter reads as
 * "not budgeted" rather than as "zero used".
 */
export function budgetReport(input) {
  const dimensions = [
    dimension('rounds', input.round, input.maxRounds),
    dimension('wallClockMs', Math.max(0, input.now - input.startedAt - (input.pausedMs ?? 0)), input.wallClockLimitMs),
  ]
  if (Number.isFinite(input.tokens) && Number.isFinite(input.tokenLimit) && input.tokenLimit > 0) {
    dimensions.push(dimension('tokens', input.tokens, input.tokenLimit))
  }
  if (Number.isFinite(input.toolCalls) && Number.isFinite(input.toolCallLimit) && input.toolCallLimit > 0) {
    dimensions.push(dimension('toolCalls', input.toolCalls, input.toolCallLimit))
  }
  // Verification gets its own dimension (§8.4). Sharing one budget would let the
  // degradation ladder cut verification first — the one thing that must not be
  // cut, since it is the only thing standing between the run and a false claim.
  // `?? 0`, not a bare `isFinite`: a budgeted dimension that has not been spent
  // against yet is at zero, not absent. Reading "unspent" as "unbudgeted" made
  // the verification ceiling invisible until the first evaluator ran.
  if (Number.isFinite(input.verifyTokenLimit) && input.verifyTokenLimit > 0) {
    dimensions.push(dimension('verifyTokens', input.verifyTokens ?? 0, input.verifyTokenLimit))
  }

  const worst = dimensions.reduce((a, b) => (b.ratio > a.ratio ? b : a), dimensions[0])
  const ladder = input.ladder ?? BUDGET_LADDER
  let rung
  for (const candidate of ladder) {
    if (worst.ratio >= candidate.atRatio) rung = candidate
  }
  return {
    dimensions,
    worst: worst.name,
    worstRatio: worst.ratio,
    // The last rung crossed, not the next one: the loop acts on what already
    // happened, so a restart never re-fires a rung it already paid for.
    rung: rung?.action,
    rungReason: rung?.action === undefined ? undefined : RUNG_DIRECTIVE[rung.action],
    exhausted: worst.ratio >= 1,
  }
}

/* ──────────────────────────────── progress ─────────────────────────────── */

/**
 * The stall signals, weighted.
 *
 * Everything here is *observable*: a model can write ten ledger notes claiming
 * progress, but it cannot move a file tree digest. That asymmetry is the whole
 * reason the score is computed here and not asked for.
 *
 * The weights encode one judgement worth stating plainly: **a single quiet round
 * is not a stall.** Running a test suite, reading code to plan, or waiting on a
 * build all leave the tree untouched while making real progress. So the two
 * per-round signals sit at 3 — below the threshold of 4 — and only stall when
 * they corroborate each other, which is what actually happens when a round
 * achieves nothing (neither the tree nor the board moved ⇒ 6).
 *
 * `blocker-repeated` is the exception at 4: it is not a per-round observation
 * but a *repetition*, so the corroboration has already happened by the time it
 * fires. A run that keeps hitting the same wall must escalate on its own.
 */
const SIGNAL_WEIGHTS = {
  'workspace-unchanged': 3,
  'board-unchanged': 3,
  'blocker-repeated': 4,
  'tests-unchanged': 2,
  // §8.4 process verification: same weight as "the tests did not move", because
  // that is what it measures — only this one is decided by running the check.
  'process-check-failing': 2,
  'no-tool-activity': 1,
  'read-only-round': 1,
}

export const STALL_THRESHOLD = 4

/**
 * Score one round and carry the stall streak forward.
 *
 * @param observation - what the round actually did; every field is measured by
 *   the Host from a source the model cannot forge.
 * @param previous - the run's current `stalledRounds`.
 */
export function stallAssessment(observation, previous = 0) {
  const signals = []
  const add = (signal) => signals.push({ signal, weight: SIGNAL_WEIGHTS[signal] })

  if (observation.workspaceUnchanged) add('workspace-unchanged')
  if (observation.boardUnchanged) add('board-unchanged')
  if (observation.blockerRepeated) add('blocker-repeated')
  if (observation.testsUnchanged) add('tests-unchanged')
  // §8.4's process verification feeds this one: a frozen check that passed K
  // rounds ago and fails now is the cheapest evidence that the run is drifting
  // — the design's "test pass count did not improve", decided by a command
  // instead of inferred from the transcript.
  if (observation.processVerifyFailing) add('process-check-failing')
  if (observation.toolCalls === 0) add('no-tool-activity')
  else if (observation.readOnlyRatio >= 0.9) add('read-only-round')

  const score = signals.reduce((sum, entry) => sum + entry.weight, 0)
  const stalled = score >= STALL_THRESHOLD
  return {
    score,
    threshold: STALL_THRESHOLD,
    signals,
    stalled,
    // Three outcomes, not two. A stalled round extends the streak and clearly
    // productive work clears it — but an *ambiguous* round holds it, because
    // "consecutive" is the property that matters. Resetting on ambiguity would let a
    // run oscillate quiet → stall → quiet → stall and never reach L2.
    stalledRounds: stalled ? previous + 1 : score === 0 ? 0 : previous,
  }
}

/* ─────────────────────────────── escalation ────────────────────────────── */

/**
 * Map a stall streak onto the ladder. The action changes the *means*, not the
 * effort — "try harder" is exactly what the ladder exists to replace.
 */
export function escalationFor(stalledRounds, ladder = ESCALATION_LADDER) {
  let current = { level: 0, action: 'continue' }
  for (const rung of ladder) {
    if (stalledRounds >= rung.atStalled) current = rung
  }
  return { ...current, directive: ESCALATION_DIRECTIVE[current.action] }
}

/* ───────────────────────────── prompts and blocks ──────────────────────── */

/** `R-7f3a`, minted locally: a run needs an id a human can say out loud. */
export function mintRunId(random = Math.random) {
  return `R-${Math.floor(random() * 0xffffff).toString(16).padStart(6, '0')}`
}

/** Render the acceptance criteria as the model will read them. */
function renderCriteria(contract) {
  return (contract.acceptance ?? [])
    .map((criterion, index) => `    ${index + 1}. [${criterion.weight ?? 'required'}] ${criterion.statement}`)
    .join('\n')
}

/**
 * The **static** half of the run state: objective and contract. It changes only
 * when the contract does, so it can live in the prompt prefix without breaking
 * the cache, and it is re-injected rather than summarised (§7.3).
 */
export function renderContractBlock(run) {
  if (run === undefined || run === null) return ''
  const contract = run.contract ?? {}
  const lines = [
    `<run_contract id="${run.id}" state="${run.state}">`,
    `  <objective>${run.objective}</objective>`,
    '  <contract>',
    `    <deliverable>${contract.deliverable ?? '(未声明)'}</deliverable>`,
    '    <acceptance>',
  ]
  const criteria = renderCriteria(contract)
  lines.push(criteria.length === 0 ? '    (未声明)' : criteria)
  lines.push('    </acceptance>')
  lines.push(`    <constraints>${(contract.constraints ?? []).join('；') || '(无)'}</constraints>`)
  lines.push(`    <non_goals>${(contract.nonGoals ?? []).join('；') || '(无)'}</non_goals>`)
  lines.push('  </contract>')
  lines.push('</run_contract>')
  return lines.join('\n')
}

/**
 * The **dynamic** half: round, budget, stall, and the escalation directive.
 * It is appended as a message each round, never rendered into the prefix.
 */
export function renderRoundPrompt(run, budget, escalation) {
  const openTasks = (run.tasks ?? []).filter((t) => t.status === 'pending' || t.status === 'in_progress')
  const lines = [
    `<run_round id="${run.id}" round="${run.round}" cap="${run.maxRounds}">`,
    '',
    '继续推进目标。要求：',
    '1. 先读上面的 <run_contract>，确认这次要满足哪条验收标准。',
    '2. 只做能推进当前任务的事；做完就登记证据。',
    '3. 不要重复已经记录在案的探索。',
    '4. 达成验收标准就调 run_finish；需要人类决策就调 run_block。',
    '5. 记住：宣称完成不会结束运行，验证通过才会。',
  ]
  if (openTasks.length > 0) {
    lines.push('', '当前未完成任务：')
    for (const task of openTasks.slice(0, 10)) {
      lines.push(`  [${task.status === 'in_progress' ? '~' : ' '}] ${task.id} P${task.priority} ${task.title}`)
    }
  }
  lines.push(
    '',
    `<budget worst="${budget.worst}" ratio="${budget.worstRatio.toFixed(2)}"${budget.rung === undefined ? '' : ` rung="${budget.rung}"`}/>`,
  )
  if (budget.rungReason !== undefined) lines.push(budget.rungReason)
  // A rung that only changes a number changes nothing. The caller appends the
  // rung's *behavioural* directive (`explorationDirective`) — this renderer
  // stays a pure function of the data it is handed.
  if (budget.rung === 'disable-exploration' || budget.rung === 'narrow-scope') {
    lines.push('', '<exploration_disabled>本轮禁止探索性阅读与搜索，只允许读取已知路径的文件。</exploration_disabled>')
  }
  if (escalation.level > 0) {
    lines.push('', `<stalled rounds="${escalation.level}" level="L${escalation.level}" action="${escalation.action}"/>`)
    lines.push(escalation.directive)
  }
  // The previous verdict is the only channel by which a concrete gap reaches
  // the next round. Without it the model re-derives the same wrong conclusion.
  if (run.lastVerdict !== undefined && run.lastVerdict.status !== 'pass') {
    lines.push('', `<last_verdict id="${run.lastVerdict.id}" status="${run.lastVerdict.status}">`)
    for (const criterion of (run.lastVerdict.perCriterion ?? []).filter((c) => c.status !== 'pass').slice(0, 10)) {
      lines.push(`  [${criterion.status}] ${criterion.id} ${criterion.statement} —— ${criterion.note}`)
    }
    lines.push('  针对以上未通过项动手，不要重述结论。')
    lines.push('</last_verdict>')
  }
  // §8.4's process pass: the run is checked every K rounds even without a
  // completion claim, and the gap that check found has to reach the next round —
  // that is the whole point of "moving the correction point earlier".
  if (run.lastProcessVerdict !== undefined && run.lastProcessVerdict.status !== 'pass') {
    lines.push('', `<process_check round="${run.lastProcessVerdict.round}" status="${run.lastProcessVerdict.status}">`)
    for (const criterion of (run.lastProcessVerdict.perCriterion ?? []).filter((c) => c.status !== 'pass').slice(0, 5)) {
      lines.push(`  [${criterion.status}] ${criterion.id} ${criterion.statement} —— ${criterion.note}`)
    }
    lines.push('  这不是完成裁决，只是过程抽查：这一条此刻是不过的，先把它弄绿再继续往下做。')
    lines.push('</process_check>')
  }
  lines.push('</run_round>')
  return lines.join('\n')
}

/**
 * The §8.6 recovery block, rendered before the round body.
 *
 * Separate from {@link renderRoundPrompt} because it is a fact about the run's
 * *past* rather than about this round's budget, and it stays in the prompt until
 * the state it warns about has been reconciled away.
 */
export function renderRecoveryBlock(run) {
  if (run.unknownOutcomeRoundId === undefined) return undefined
  return [
    `<recovery round_id="${run.unknownOutcomeRoundId}">`,
    `派发「${run.unknownOutcomeRoundId}」的结果未知（进程中断或崩溃）。那一步的副作用可能已发生，也可能没有。`,
    '动手之前先核对状态：读文件 / git status / 任务板 / 相关命令的实际输出。',
    '确认已完成的不要重做；确认没做的再补。不要盲目重放副作用。',
    '</recovery>',
  ].join('\n')
}

/**
 * The per-turn digest: what the console, the prompt, and `/longloop status` all show.
 * Kept in one place so those three can never disagree.
 */
export function runSummary(run, budget, escalation) {
  if (run === undefined || run === null) return undefined
  return {
    id: run.id,
    objective: run.objective,
    // The console renders the contract, so the summary carries it: the panel and
    // the prompt must never be able to disagree about what "done" means.
    contract: run.contract,
    state: run.state,
    round: run.round,
    maxRounds: run.maxRounds,
    stalledRounds: run.stalledRounds ?? 0,
    startedAt: run.startedAt,
    pausedMs: run.pausedMs ?? 0,
    lastRoundAt: run.lastRoundAt,
    endedAt: run.endedAt,
    endReason: run.endReason,
    escalation,
    budget,
    tasks: run.tasks ?? [],
    notes: (run.notes ?? []).slice(-20),
    lastBlockers: run.lastBlockers ?? [],
    // The console renders the verdict and the frozen checks, so the summary
    // carries them: the panel and the prompt must not be able to disagree about
    // what was proven.
    lastVerdict: run.lastVerdict,
    verdicts: (run.verdicts ?? []).slice(-5),
    challenges: run.challenges ?? 0,
    // Everything the console and `/longloop status` render. A field the summary
    // forgets is a field the panel cannot show, which is how `mode` and
    // `suspendReason` went missing the first time.
    mode: run.mode ?? 'inline',
    diagnosis: run.diagnosis,
    constraints: run.constraints ?? [],
    verifyTokens: run.verifyTokens ?? 0,
    suspendedAt: run.suspendedAt,
    // §8.4's third trigger, carried for the console and the handoff: a process
    // verdict is not a completion verdict, and the summary keeps them apart.
    lastProcessVerdict: run.lastProcessVerdict,
    processVerifyRound: run.processVerifyRound ?? 0,
    frozenPaths: run.contract?.frozenPaths ?? [],
    // §8.4: a criterion stored without the expectation it was written with looks
    // decidable and is not — the console and the prompt both carry the warning.
    contractWarnings: run.contractWarnings ?? [],
    unknownOutcomeRoundId: run.unknownOutcomeRoundId,
    roundId: run.roundId,
    suspendReason: run.suspendReason,
    handoff: run.handoff,
    freshFallbackReason: run.freshFallbackReason,
    lastFreshReport: run.lastFreshReport,
  }
}
