/**
 * LongLoop verification gate.
 *
 * §8.4 asks for a funnel, cheapest layer first, because the empirical record is
 * unambiguous about what does *not* work:
 *
 *   Layer 1  non-LLM evidence gate   always runs, microseconds
 *   Layer 2  deterministic checks    runs the frozen commands, seconds
 *   Layer 3  independent evaluator   fresh context, read-only, fresh policy
 *
 * The reason layer 1 exists at all: False Success (ICML 2026) measured five LLM
 * judges across five prompt strategies and **none reached AUROC 0.65**, because
 * a judge is anchored by a confident closing tone — assertion-rich traces
 * scored 0.27–0.36 *higher* regardless of tool evidence. A cheap deterministic
 * gate is not a compromise here; it is the better detector.
 *
 * The reason layer 2 must run the *frozen* commands: ExecCritic (2609.09133)
 * held the repair agent fixed and swapped only the test source — 61.2% with no
 * tests, **57.3% when the agent wrote its own tests**, 65.3% with strong
 * external tests. Same-trajectory patch and test share their misconceptions and
 * "agree" with each other. So the executor may not author or edit a check.
 */

import { createHash } from 'node:crypto'

import { commandTouchesQuarantine, quarantineSummary } from './quarantine.js'

/** Default per-check wall clock. Generous enough for a test suite, bounded. */
export const DEFAULT_CHECK_TIMEOUT_MS = 300_000

/** How many times a claim may be challenged before the run accepts it as unknown. */
export const VERIFY_CHALLENGE_MAX = 2

/**
 * Phrases that mark a completion claim. Deliberately short: this is a *trigger*
 * for the rest of the gate, not a classifier, and a false positive costs one
 * cheap deterministic check rather than a wrong verdict.
 *
 * Every phrasing below was added because a test (or a real claim) used it and
 * the list missed it — "I have completed" is the most common form in the wild,
 * and the first version of this list only matched the contraction.
 */
const COMPLETION_PHRASES = [
  /\bi(?:'?ve| have| just)? (?:completed|finished|done)\b/i,
  /\ball done\b/i,
  /\b(?:the )?task is (?:finished|complete|done)\b/i,
  /\beverything (?:is )?(?:done|works|passes|complete)\b/i,
  /\b(?:it'?s|it is) (?:done|finished|complete)\b/i,
  /\b(?:implemented|fixed) (?:it|everything|all)\b/i,
  /(?:已|全部)?完成(?:了|完毕)?[。！!]?$/m,
  /搞定|做好了|已经做好|全部搞定/,
  /全部通过|测试全绿|一切正常/,
]

/* ─────────────────────────── contract normalisation ────────────────────── */

/**
 * Read the executable checks out of a frozen contract.
 *
 * A criterion without a `check` is still a criterion — it just cannot be
 * machine-verified, and the verdict says so instead of quietly passing it.
 */
export function parseChecks(contract) {
  const acceptance = contract?.acceptance ?? []
  return acceptance.map((criterion, index) => {
    // Defence in depth: the contract writer already drops an empty command, and
    // this reader drops it again. A blank command that reached the shell would
    // exit 0 and certify the criterion for free.
    const command = typeof criterion.check?.command === 'string' ? criterion.check.command.trim() : ''
    return {
      id: `C${index + 1}`,
      statement: String(criterion.statement ?? '').trim(),
      weight: criterion.weight === 'nice-to-have' ? 'nice-to-have' : 'required',
      check:
        command.length > 0
          ? {
              command,
              expect: criterion.check.expect ?? { exitCode: 0 },
              timeoutMs: Number.isInteger(criterion.check.timeoutMs) ? criterion.check.timeoutMs : DEFAULT_CHECK_TIMEOUT_MS,
            }
          : undefined,
    }
  })
}

/** One sentence a human can act on, for the console and the model alike. */
export function describeExpect(expect) {
  if (expect?.exitCode !== undefined) return `退出码 = ${expect.exitCode}`
  if (expect?.stdoutMatches !== undefined) return `输出匹配 /${expect.stdoutMatches}/`
  if (expect?.fileExists !== undefined) return `文件存在：${expect.fileExists}`
  return '退出码 = 0'
}

/* ─────────────────────── layer 2: one check, evaluated ─────────────────── */

/**
 * Decide one criterion from one shell result. Pure, so the whole expectation
 * vocabulary is testable without spawning anything.
 */
export function evaluateExpect(expect, result) {
  if (result?.timedOut === true) {
    return { status: 'fail', detail: `命令超时（${result.timeoutMs}ms）` }
  }
  if (result?.aborted === true) {
    return { status: 'unknown', detail: '命令被取消，未得出结论' }
  }
  if (result?.sandbox?.denied === true) {
    return { status: 'unknown', detail: '沙箱拒绝了这条命令 —— 不是任务没完成，是证据拿不到' }
  }
  if (result?.spawnFailed === true) {
    return { status: 'unknown', detail: `命令无法执行：${result.error ?? '未知原因'}` }
  }

  const stdout = result?.stdout?.text ?? ''

  if (expect?.fileExists !== undefined) {
    // `fileExists` is evaluated by the caller, which can stat the path.
    return result?.fileExists === true
      ? { status: 'pass', detail: `文件存在：${expect.fileExists}` }
      : { status: 'fail', detail: `文件不存在：${expect.fileExists}` }
  }
  if (expect?.stdoutMatches !== undefined) {
    let matched = false
    try {
      matched = new RegExp(expect.stdoutMatches, 'm').test(stdout)
    } catch {
      return { status: 'unknown', detail: `契约里的正则无效：${expect.stdoutMatches}` }
    }
    return matched
      ? { status: 'pass', detail: `输出匹配 /${expect.stdoutMatches}/` }
      : { status: 'fail', detail: `输出不匹配 /${expect.stdoutMatches}/` }
  }

  const wanted = expect?.exitCode ?? 0
  return result?.exitCode === wanted
    ? { status: 'pass', detail: `退出码 ${result.exitCode}` }
    : { status: 'fail', detail: `退出码 ${result?.exitCode ?? 'null'}，期望 ${wanted}` }
}

/**
 * Roll per-criterion results into one verdict.
 *
 * `unknown` is a first-class outcome. A verifier that must return pass or fail
 * will manufacture confidence it does not have — which is worse than no
 * verifier, because it launders a guess into a certification.
 */
export function summarizeVerdict(perCriterion) {
  const required = perCriterion.filter((c) => c.weight === 'required')
  const failed = perCriterion.filter((c) => c.status === 'fail')
  const unknown = perCriterion.filter((c) => c.status === 'unknown')

  let status
  if (perCriterion.length === 0) status = 'unknown'
  else if (failed.length > 0) status = 'fail'
  else if (unknown.length > 0) status = required.some((c) => c.status === 'unknown') ? 'unknown' : 'partial'
  else status = 'pass'

  return {
    status,
    counts: {
      pass: perCriterion.filter((c) => c.status === 'pass').length,
      fail: failed.length,
      unknown: unknown.length,
      requiredUnknown: required.filter((c) => c.status === 'unknown').length,
    },
  }
}

/* ───────────────────── layer 1: the non-LLM evidence gate ──────────────── */

/**
 * Cheap gates that run before anything is executed.
 *
 * Each returns a reason the model can act on. None of them can pass a run —
 * gate 1 only decides whether it is worth spending layer 2, and whether the
 * claim is even auditable.
 */
export function evidenceGate(input) {
  const reasons = []
  const checks = input.checks ?? []
  const runnable = checks.filter((c) => c.check !== undefined)
  const required = checks.filter((c) => c.weight === 'required')

  if (checks.length === 0) {
    reasons.push({
      code: 'no-criteria',
      detail: '这条运行没有验收标准，因此没有任何东西可以证明它完成了。',
    })
  } else if (runnable.length === 0) {
    reasons.push({
      code: 'no-runnable-check',
      detail: `${checks.length} 条验收标准都没有可执行检查，只能人工复核。`,
    })
  } else if (required.some((c) => c.check === undefined)) {
    const missing = required.filter((c) => c.check === undefined).map((c) => c.id)
    reasons.push({
      code: 'required-without-check',
      detail: `必达标准 ${missing.join('、')} 没有可执行检查，无法机器验证。`,
    })
  }

  const claim = String(input.claim ?? '')
  if (COMPLETION_PHRASES.some((pattern) => pattern.test(claim)) && (input.evidenceCount ?? 0) === 0 && runnable.length === 0) {
    reasons.push({
      code: 'bare-claim',
      detail: '声明里用了完成措辞，但既没有登记证据，也没有可执行检查。',
    })
  }

  return {
    // `challenge` asks for more from the model; `unverifiable` means no amount
    // of asking will help and the verdict must be `unknown`.
    verdict: reasons.some((r) => r.code === 'bare-claim' || r.code === 'no-criteria')
      ? 'challenge'
      : reasons.length > 0
        ? 'unverifiable'
        : 'proceed',
    reasons,
  }
}

/* ────────────────────────── layer 2: run the checks ────────────────────── */

async function fileExistsAt(fs, root, relative) {
  if (fs === undefined) return undefined
  try {
    const target = await fs.resolve(relative, { cwd: root })
    return (await fs.stat(target)) !== undefined
  } catch {
    return undefined
  }
}

/**
 * Execute every frozen check and build the verdict.
 *
 * Checks run with `workspace-write` confinement rooted at the workspace, so a
 * verification command cannot reach outside the project it is verifying. The
 * workspace digest is recorded before and after: not to fail a check that
 * legitimately writes cache files, but to make the side effect auditable, and
 * to bind the evidence to the exact tree it was produced against.
 */
export async function runChecks(deps) {
  const { shell, fs, root, run, signal, now = Date.now, digest, only, quarantine, scope = 'full' } = deps
  const all = parseChecks(run.contract)
  // §8.4's third trigger is a *light* pass: the caller may name the one or two
  // criteria that are cheapest to decide, and the rest stay unexecuted.
  const checks = only === undefined ? all : all.filter((criterion) => only.includes(criterion.id))
  const started = now()
  const digestBefore = digest?.() ?? undefined
  const perCriterion = []

  const sandboxPolicy = {
    mode: 'workspace-write',
    workspaceRoot: root,
    sessionId: undefined,
  }

  for (const criterion of checks) {
    if (criterion.check === undefined) {
      perCriterion.push({
        ...criterion,
        status: 'unknown',
        method: '未执行',
        note: '没有可执行检查，只能人工复核。',
      })
      continue
    }
    if (signal?.aborted === true) {
      perCriterion.push({ ...criterion, status: 'unknown', method: '未执行', note: '验证在开始前被取消。' })
      continue
    }

    const { command, expect, timeoutMs } = criterion.check

    // §8.4 contamination control: a check may not reach for the answer. Reading
    // `.git` history on SWE-bench Pro was 9% of all "successful" fixes.
    const tainted = commandTouchesQuarantine(command)
    if (tainted !== undefined) {
      perCriterion.push({
        ...criterion,
        status: 'unknown',
        method: command,
        note: `检查命令引用检疫项 ${tainted}，未执行：验证不能读答案（§8.4）。`,
        refused: { reason: 'quarantine', item: tainted },
      })
      continue
    }

    if (expect?.fileExists !== undefined) {
      const seen = await fileExistsAt(fs, root, expect.fileExists)
      const outcome = evaluateExpect(expect, { fileExists: seen })
      perCriterion.push({
        ...criterion,
        status: outcome.status,
        method: `stat ${expect.fileExists}`,
        evidence: { command: null, exitCode: null, detail: outcome.detail, digestBefore },
        note: outcome.detail,
      })
      continue
    }

    if (shell === undefined) {
      perCriterion.push({ ...criterion, status: 'unknown', method: command, note: 'Host 没有装配 shell 服务。' })
      continue
    }

    let result
    try {
      const spec = shell.resolve({ command, workdir: root, timeoutMs, signal, sandboxPolicy })
      result = await shell.run(spec)
    } catch (error) {
      result = { spawnFailed: true, error: String(error?.message ?? error) }
    }

    const outcome = evaluateExpect(expect, result)
    const head = (result?.stdout?.text ?? '').slice(0, 400)
    perCriterion.push({
      ...criterion,
      status: outcome.status,
      method: command,
      evidence: {
        command,
        exitCode: result?.exitCode ?? null,
        timedOut: result?.timedOut === true,
        sandboxDenied: result?.sandbox?.denied === true,
        stdoutHead: head,
        stdoutTruncated: result?.stdout?.truncated === true,
        spillPath: result?.stdout?.spillPath,
        digestBefore,
      },
      note: outcome.detail,
    })
  }

  const digestAfter = digest?.() ?? undefined
  const { status, counts } = summarizeVerdict(perCriterion)

  const counterexamples = perCriterion
    .filter((c) => c.status === 'fail')
    .map((c) => `${c.id} 「${c.statement}」：${c.note}${c.evidence?.stdoutHead ? ` —— ${c.evidence.stdoutHead.split('\n').slice(-3).join(' / ')}` : ''}`)

  const nextActions = perCriterion
    .filter((c) => c.status !== 'pass')
    .map((c) => `${c.id} ${c.statement}：${c.note}`)

  return {
    id: `V-${createHash('sha256').update(`${run.id}:${run.round}:${started}`).digest('hex').slice(0, 6)}`,
    at: started,
    round: run.round,
    // A process pass is still an executable pass; `scope` is what tells an
    // auditor it was the light one, so the two can never be confused in review.
    level: checks.some((c) => c.check !== undefined) ? 'executable' : 'self',
    scope,
    status,
    counts,
    perCriterion,
    counterexamples,
    nextActions,
    // A check that writes cache files is normal; recording the change keeps the
    // side effect auditable without failing honest work.
    sideEffects: digestBefore !== undefined && digestAfter !== undefined && digestBefore !== digestAfter,
    digestBefore,
    digestAfter,
    elapsedMs: now() - started,
    workspaceFiles: run.workspaceFiles,
    quarantine: quarantineSummary(quarantine),
  }
}

/* ────────────────────────── what the model is told ─────────────────────── */

/** The verification result as one block the next round can act on. */
export function renderVerdictPrompt(verdict) {
  if (verdict === undefined) return ''
  const lines = [`<verdict id="${verdict.id}" status="${verdict.status}" level="${verdict.level}" round="${verdict.round}">`]
  for (const criterion of verdict.perCriterion) {
    lines.push(`  [${criterion.status}] ${criterion.id} ${criterion.statement} —— ${criterion.note}`)
  }
  if (verdict.counterexamples.length > 0) {
    lines.push('  反例：')
    for (const example of verdict.counterexamples) lines.push(`    · ${example}`)
  }
  if (verdict.status !== 'pass') {
    lines.push('  这份裁决不是"失败"，是"还没证明"。下一轮请针对未通过项动手，不要重述结论。')
  }
  lines.push('</verdict>')
  return lines.join('\n')
}


/* ══════════════════════ layer 3: the independent evaluator ═══════════════ */

/**
 * The evaluator's tool allowlist, **built from zero rather than inherited**.
 *
 * Codex's Guardian settled this: a reviewer that inherits the caller's policy
 * can be used by the caller to approve itself (`guardian-reviewer-bypass-exec-
 * policy`). So this is an allowlist of three read-only tools, and nothing about
 * the caller's permissions, sandbox mode, or persona reaches it.
 *
 * No `bash` is the point, not an omission: layer 2 already ran the commands.
 * Layer 3 exists to judge whether that evidence actually means what the
 * criterion says — a question a command cannot answer, and one an executor is
 * the worst possible judge of.
 */
export const EVALUATOR_TOOL_ALLOW = Object.freeze(['read', 'glob', 'grep'])

/**
 * The evaluator's own identity. It is told, plainly, that it did not do the
 * work and will not be persuaded by the narrative — because that is the whole
 * mechanism. Cognition measured it: a reviewer sharing no context with the
 * coding agent finds ~2 bugs per PR, ~58% severe, precisely *because* it is not
 * carrying the author's assumptions.
 */
export const EVALUATOR_PERSONA = [
  'You are an independent verifier. You did not do this work, you have not read',
  'the execution history, and you will not be shown it. Treat every claim of',
  'completion as unproven until you have checked it yourself.',
  '',
  'Rules:',
  '- Judge only from the contract, the workspace, and the recorded evidence below.',
  '- `pass` requires that you state what you personally checked. You may not pass',
  '  a criterion on the strength of someone else\'s summary.',
  '- `unknown` is a legitimate and expected answer when the evidence does not',
  '  settle the question. It is not a failure and you will not be penalised for it.',
  '- `fail` requires a concrete counterexample: which file, which line, which input.',
  '- Do not report gaps you cannot point at. A reviewer asked to find gaps will',
  '  always find some; inventing one costs more than reporting `unknown`.',
  '- You cannot modify anything. If something is wrong, say so; do not fix it.',
  '- The `.git` directory is not a source of truth about the current work: the',
  '  workspace as it stands now is. Do not read it.',
].join('\n')

/** The structured verdict the evaluator must return. */
export const EVALUATOR_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['perCriterion', 'summary'],
  properties: {
    perCriterion: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status', 'reasoning'],
        properties: {
          id: { type: 'string', description: 'The criterion id exactly as given, e.g. C2.' },
          status: { type: 'string', required: true, enum: ['pass', 'fail', 'unknown'] },
          reasoning: { type: 'string', required: true, description: 'What you personally checked, or why nothing settles it.' },
          counterexample: { type: 'string', description: 'Required for fail: file, line, or input.' },
        },
      },
    },
    summary: { type: 'string', required: true, description: 'One paragraph a human can act on.' },
    confidence: { type: 'number', description: 'Your confidence in this verdict, 0 to 1.' },
  },
})

/**
 * What the evaluator is given. Deliberately *not* the execution history: no
 * transcript, no assistant reasoning, no tool log. The contract, the current
 * workspace, and the layer-2 evidence are the whole input.
 */
export function renderEvaluatorPrompt(input) {
  const lines = [
    'Verify the following contract against the workspace as it stands now.',
    '',
    `<contract deliverable="${input.contract?.deliverable ?? ''}">`,
    '  <acceptance>',
  ]
  for (const criterion of input.checks) {
    lines.push(`    ${criterion.id} [${criterion.weight}] ${criterion.statement}`)
    if (criterion.check !== undefined) {
      lines.push(`        recorded check: ${criterion.check.command} → ${describeExpect(criterion.check.expect)}`)
    } else {
      lines.push('        no recorded check — this criterion can only be judged by reading the workspace')
    }
  }
  lines.push('  </acceptance>')
  if ((input.contract?.constraints ?? []).length > 0) {
    lines.push(`  <constraints>${input.contract.constraints.join('；')}</constraints>`)
  }
  lines.push('</contract>', '')

  if (input.deterministic !== undefined) {
    lines.push('<recorded_evidence note="produced by deterministic checks you did not run">')
    for (const criterion of input.deterministic.perCriterion ?? []) {
      lines.push(`  ${criterion.id}: ${criterion.status} — ${criterion.note}`)
      if (criterion.evidence?.command) lines.push(`      $ ${criterion.evidence.command}`)
      if (criterion.evidence?.stdoutHead) {
        lines.push(`      output: ${String(criterion.evidence.stdoutHead).split('\n').slice(0, 8).join('\n              ')}`)
      }
    }
    lines.push('</recorded_evidence>', '')
  } else {
    lines.push('No command decided these criteria. You must judge them by reading the workspace.', '')
  }

  lines.push(
    `Workspace root: ${input.root}`,
    '',
    'For each criterion, decide pass, fail, or unknown — and say what you checked.',
  )
  return [{ type: 'text', text: lines.join('\n') }]
}

/* ────────────────────────── parsing what came back ─────────────────────── */

/**
 * Turn the evaluator's structured output into per-criterion results.
 *
 * Anything malformed degrades to `unknown` rather than being dropped or
 * coerced: a criterion the evaluator failed to address has not been verified,
 * and pretending otherwise is the exact failure mode layer 3 exists to prevent.
 */
export function parseEvaluatorOutput(structured, checks) {
  const byId = new Map()
  const entries = Array.isArray(structured?.perCriterion) ? structured.perCriterion : []
  for (const entry of entries) {
    const id = typeof entry?.id === 'string' ? entry.id.trim().toUpperCase() : undefined
    const status = entry?.status
    if (id === undefined || !['pass', 'fail', 'unknown'].includes(status)) continue
    byId.set(id, {
      status,
      reasoning: typeof entry.reasoning === 'string' ? entry.reasoning : '',
      counterexample: typeof entry.counterexample === 'string' ? entry.counterexample : undefined,
    })
  }

  return checks.map((criterion) => {
    const judged = byId.get(criterion.id)
    if (judged === undefined) {
      return {
        ...criterion,
        status: 'unknown',
        method: '独立评估器',
        note: '评估器没有对这条标准给出判断，按未验证处理。',
      }
    }
    // A `fail` with no counterexample is not actionable, and §8.4 forbids
    // passing one through as fact. It becomes unknown, which says exactly what
    // happened: an assertion without evidence.
    if (judged.status === 'fail' && (judged.counterexample ?? '').trim().length === 0) {
      return {
        ...criterion,
        status: 'unknown',
        method: '独立评估器',
        note: `评估器判为 fail 但没有给出具体反例，按未验证处理：${judged.reasoning}`,
      }
    }
    return {
      ...criterion,
      status: judged.status,
      method: '独立评估器',
      note: judged.reasoning,
      ...(judged.counterexample === undefined ? {} : { counterexample: judged.counterexample }),
    }
  })
}

/**
 * Combine the two layers.
 *
 * Precedence, and the reasoning for each rule:
 *
 *   deterministic fail                     → fail. A command ran and missed.
 *   deterministic pass + evaluator fail    → fail. This is the case layer 3
 *                                            exists for: the check passes but
 *                                            does not test what the criterion
 *                                            means (ExecCritic's whole point).
 *   deterministic pass + evaluator pass    → pass.
 *   deterministic unknown                  → the evaluator's judgement, if any.
 *   evaluator absent                       → the deterministic result stands.
 */
export function mergeVerdicts(deterministic, independent) {
  if (independent === undefined) return deterministic ?? { perCriterion: [], status: 'unknown', merged: 'deterministic-only' }
  if (deterministic === undefined) return { ...independent, merged: 'independent-only' }

  const byId = new Map(independent.perCriterion.map((c) => [c.id, c]))
  const perCriterion = deterministic.perCriterion.map((det) => {
    const ind = byId.get(det.id)
    if (ind === undefined) return det
    if (det.status === 'fail') return det
    if (det.status === 'pass' && ind.status === 'fail') {
      return {
        ...det,
        status: 'fail',
        method: `${det.method} + 独立评估器`,
        note: `确定性检查通过，但独立评估器不同意：${ind.note}`,
        counterexample: ind.counterexample,
      }
    }
    if (det.status === 'unknown') {
      return { ...ind, method: `独立评估器（确定性检查未能定论）` }
    }
    return { ...det, note: `${det.note}；独立评估器复核通过` }
  })

  const { status, counts } = summarizeVerdict(perCriterion)
  return {
    ...deterministic,
    perCriterion,
    status,
    counts,
    level: 'independent',
    merged: 'two-layer',
    independentSummary: independent.summary,
    counterexamples: [
      ...deterministic.counterexamples,
      ...perCriterion.filter((c) => c.status === 'fail' && c.counterexample !== undefined).map((c) => `${c.id} ${c.counterexample}`),
    ],
    nextActions: perCriterion.filter((c) => c.status !== 'pass').map((c) => `${c.id} ${c.statement}：${c.note}`),
  }
}

/* ───────────────────────────── running layer 3 ─────────────────────────── */

/**
 * Ask an independent evaluator to judge the contract.
 *
 * Every capability is requested explicitly — `toolFilter`, `persona`,
 * `outputSchema`, `maxDepth` — and the child never inherits the caller's. When
 * the deployment has no `subagents` service, or no live Agent to parent the
 * child, this returns `undefined` and the caller keeps the layer-2 result:
 * a missing evaluator must degrade to "less verification", never to "verified".
 */
export async function independentEvaluate(deps) {
  const { subagents, agents, run, root, checks, deterministic, signal, provider = 'spawn' } = deps
  if (subagents === undefined || agents === undefined) return undefined

  const parent = (run.ownerSessionId === undefined ? undefined : agents.get(run.ownerSessionId)) ?? agents.roots()[0]
  if (parent === undefined) return undefined
  if (typeof subagents.getProvider === 'function' && subagents.getProvider(provider) === undefined) return undefined

  let handle
  try {
    handle = await subagents.start(provider, {
      label: `verify-${run.id}`,
      prompt: renderEvaluatorPrompt({ contract: run.contract, checks, deterministic, root }),
      parent,
      signal,
      persona: EVALUATOR_PERSONA,
      outputSchema: EVALUATOR_SCHEMA,
      toolFilter: { allow: [...EVALUATOR_TOOL_ALLOW] },
      // An evaluator that can spawn evaluators is a fork bomb with a budget.
      maxDepth: 1,
    })
  } catch {
    return undefined
  }

  try {
    const result = await handle.result
    if (result?.stopReason !== 'completed') return undefined
    const perCriterion = parseEvaluatorOutput(result.structured, checks)
    const { status, counts } = summarizeVerdict(perCriterion)
    return {
      id: `V-i${String(handle.id).slice(0, 6)}`,
      // Kept so the caller can price the verification: §8.4 puts verification in
      // its own budget dimension, and the only place that cost is observable is
      // the evaluator's own Session.
      childSessionId: String(handle.id),
      at: Date.now(),
      round: run.round,
      level: 'independent',
      status,
      counts,
      perCriterion,
      summary: result.structured?.summary,
      confidence: result.structured?.confidence,
      counterexamples: perCriterion.filter((c) => c.counterexample !== undefined).map((c) => `${c.id} ${c.counterexample}`),
      nextActions: perCriterion.filter((c) => c.status !== 'pass').map((c) => `${c.id} ${c.statement}：${c.note}`),
    }
  } catch {
    return undefined
  } finally {
    await handle.dispose?.().catch(() => {})
  }
}

/** Layer 3 shipped, so `assurance: 'independent'` may now be advertised. */
export const INDEPENDENT_EVALUATOR_IMPLEMENTED = true
