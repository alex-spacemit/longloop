/**
 * LongLoop escalation actions — the part of §8.2 that changes the *means*.
 *
 * The ladder in `governors.js` decides which rung a run stands on. This module
 * is what actually happens on the rungs that need more than a sentence:
 *
 *   L1 nudge      a directive in the next round prompt (governors.js)
 *   L2 replan     a directive that demands a structurally different plan
 *   L3 switch-mode  run the next round in a FRESH child, not the current session
 *   L4 diagnose   ask a read-only child why the run is stuck, and inject the answer
 *   L5 block      terminal, with a handoff
 *
 * L3 is the design's most valuable single mechanism (§8.2): when a context is
 * polluted, "forget and restart" beats "try harder in the same context". Claude
 * Code's own guidance says the same thing in operational terms — correct the
 * same problem twice and you should `/clear` rather than keep correcting.
 *
 * Every child started here is built the same way as the evaluator: its own
 * persona, an explicitly requested tool policy, and never an inherited one.
 */

import { EVALUATOR_TOOL_ALLOW } from './verify.js'

/* ───────────────────────────── L4: diagnosis ───────────────────────────── */

/**
 * The diagnostician is read-only for the same reason the evaluator is: a
 * child that can write will fix what it finds and report success, and a
 * diagnosis that has already acted is not a diagnosis.
 */
export const DIAGNOSTIC_PERSONA = [
  'You are diagnosing why a long-running task has stopped making progress.',
  'You are read-only: you cannot change anything, and you should not try.',
  '',
  'Your job is to answer three questions with evidence:',
  '1. What is actually blocking progress? Point at the file, the command, or the',
  '   missing piece of knowledge that is responsible.',
  '2. Which of the run\'s own assumptions is false? A stuck run is usually stuck',
  '   because something it believed is not true.',
  '3. What is the single next action that would unblock it? One action, not a plan.',
  '',
  'Rules:',
  '- Do not restate the objective or summarise what has been tried; that is already known.',
  '- Do not propose a general strategy. Name a concrete next action.',
  '- If the evidence does not let you answer, say so and name what you would need.',
  '- Ignore the `.git` directory; the workspace as it stands is the truth.',
].join('\n')

export const DIAGNOSTIC_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['blocker', 'falseAssumption', 'nextAction'],
  properties: {
    blocker: { type: 'string', required: true, description: 'The concrete thing blocking progress.' },
    falseAssumption: { type: 'string', required: true, description: 'Which belief the run holds that is not true. Write "none identified" if you cannot find one.' },
    nextAction: { type: 'string', required: true, description: 'One concrete next action, specific enough to start immediately.' },
    evidence: { type: 'string', description: 'Where you saw it: file, line, or command output.' },
  },
})

/**
 * What the diagnostician is given: the objective, the contract, what was tried,
 * and what the checks said. Not the transcript — a diagnostician reading the
 * same reasoning that got stuck tends to agree with it.
 *
 * Returns plain text; the caller wraps it. Both prompt renderers in this module
 * share that signature so a reader never has to check which one returns blocks.
 */
export function renderDiagnosticPrompt(input) {
  const lines = [
    `<objective>${input.run.objective}</objective>`,
    '',
    `Rounds spent: ${input.run.round} of ${input.run.maxRounds}`,
    `Consecutive rounds with no observable progress: ${input.run.stalledRounds ?? 0}`,
    '',
  ]

  const tasks = input.tasks ?? []
  const open = tasks.filter((t) => t.status !== 'done' && t.status !== 'dropped')
  if (open.length > 0) {
    lines.push('Open work:')
    for (const task of open.slice(0, 12)) lines.push(`  [${task.status}] ${task.id} ${task.title}`)
    lines.push('')
  }

  if (input.verdict !== undefined) {
    lines.push('Last verification result:')
    for (const criterion of input.verdict.perCriterion ?? []) {
      lines.push(`  [${criterion.status}] ${criterion.id} ${criterion.statement} —— ${criterion.note}`)
    }
    lines.push('')
  }

  const notes = (input.run.notes ?? []).slice(-12)
  if (notes.length > 0) {
    lines.push('Decisions and dead ends already recorded:')
    for (const note of notes) lines.push(`  [${note.kind}] ${note.detail}`)
    lines.push('')
  }

  if ((input.blockers ?? []).length > 0) {
    lines.push('Reported blockers:')
    for (const blocker of input.blockers.slice(-3)) lines.push(`  ${blocker.blocker}（已试：${(blocker.attempted ?? []).join(' · ')}）`)
    lines.push('')
  }

  lines.push(`Workspace root: ${input.root}`, '', 'Diagnose it. Read what you need.')
  return lines.join('\n')
}

/** The diagnosis as a prompt block for the next round. */
export function renderDiagnosticReport(report, childId) {
  if (report === undefined) return ''
  return [
    `<diagnosis source="${childId ?? 'independent'}">`,
    `  阻塞：${report.blocker}`,
    `  站不住的假设：${report.falseAssumption}`,
    `  下一步：${report.nextAction}`,
    report.evidence === undefined ? '' : `  依据：${report.evidence}`,
    '</diagnosis>',
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

/**
 * Ask a read-only child to diagnose a stuck run.
 *
 * Returns `undefined` whenever it cannot run, for the same reason the evaluator
 * does: a diagnosis that silently did not happen must not read as a diagnosis
 * that found nothing.
 */
export async function runDiagnosis(deps) {
  const { subagents, agents, run, root, tasks, verdict, blockers, signal, provider = 'spawn' } = deps
  if (subagents === undefined || agents === undefined) return undefined

  const parent = (run.ownerSessionId === undefined ? undefined : agents.get(run.ownerSessionId)) ?? agents.roots()[0]
  if (parent === undefined) return undefined
  if (typeof subagents.getProvider === 'function' && subagents.getProvider(provider) === undefined) return undefined

  let handle
  try {
    handle = await subagents.start(provider, {
      label: `diagnose-${run.id}`,
      // The renderer returns text; wrapping it into a content block is the
      // caller's job, so both renderers in this module have one return type.
      prompt: [{ type: 'text', text: renderDiagnosticPrompt({ run, tasks, verdict, blockers, root }) }],
      parent,
      signal,
      persona: DIAGNOSTIC_PERSONA,
      outputSchema: DIAGNOSTIC_SCHEMA,
      toolFilter: { allow: [...EVALUATOR_TOOL_ALLOW] },
      maxDepth: 1,
    })
  } catch {
    return undefined
  }

  try {
    const result = await handle.result
    if (result?.stopReason !== 'completed' || result.structured === undefined) return undefined
    const report = result.structured
    return {
      at: Date.now(),
      round: run.round,
      childId: String(handle.id),
      blocker: String(report.blocker ?? ''),
      falseAssumption: String(report.falseAssumption ?? ''),
      nextAction: String(report.nextAction ?? ''),
      evidence: report.evidence === undefined ? undefined : String(report.evidence),
    }
  } catch {
    return undefined
  } finally {
    await handle.dispose?.().catch(() => {})
  }
}

/* ─────────────────────────── L3: a fresh round ─────────────────────────── */

/**
 * The seed for a fresh round.
 *
 * It carries the contract, the state, and pointers to evidence — and it
 * deliberately does not carry the previous conversation. The workspace is the
 * long-term memory across rounds (§7.5); a fresh agent re-derives everything
 * else from it, which is the whole reason a fresh round escapes a polluted
 * context.
 */
export function renderFreshRoundPrompt(input) {
  const lines = [
    `<run_round id="${input.run.id}" round="${input.round}" cap="${input.run.maxRounds}" mode="fresh">`,
    '',
    '你是这个任务的**新一轮**执行者。你没有参与之前的尝试，也不要假设之前的做法是对的。',
    '共享工作区是你的长期记忆：先看当前状态，再决定做什么。',
    '',
    '<objective>',
    input.run.objective,
    '</objective>',
    '',
  ]

  const acceptance = input.run.contract?.acceptance ?? []
  if (acceptance.length > 0) {
    lines.push('<acceptance>')
    acceptance.forEach((criterion, index) => {
      lines.push(`  C${index + 1} [${criterion.weight === 'nice-to-have' ? '次要' : '必达'}] ${criterion.statement}`)
      if (criterion.check?.command) lines.push(`      检查：${criterion.check.command}`)
    })
    lines.push('</acceptance>', '')
  }

  if ((input.run.constraints ?? []).length > 0) {
    lines.push('<pinned_constraints>')
    for (const constraint of input.run.constraints) lines.push(`  [${constraint.kind}] ${constraint.text}`)
    lines.push('</pinned_constraints>', '')
  }

  if ((input.avoid ?? []).length > 0) {
    lines.push('<do_not_retry note="已被证伪的路径，重新尝试会浪费这一轮">')
    for (const item of input.avoid.slice(-10)) lines.push(`  ${item}`)
    lines.push('</do_not_retry>', '')
  }

  if (input.verdict !== undefined && input.verdict.status !== 'pass') {
    lines.push('<last_verdict>')
    for (const criterion of (input.verdict.perCriterion ?? []).filter((c) => c.status !== 'pass')) {
      lines.push(`  [${criterion.status}] ${criterion.id} ${criterion.statement} —— ${criterion.note}`)
    }
    lines.push('</last_verdict>', '')
  }

  if (input.diagnosis !== undefined) {
    lines.push(renderDiagnosticReport(input.diagnosis, input.diagnosis.childId), '')
  }

  lines.push(
    input.directive ?? '完成这一轮能推进目标的**一件事**，然后说明结果。',
    '',
    '结束时报告：做了什么、看到什么、下一步是什么。',
    '</run_round>',
  )
  return lines.join('\n')
}

/**
 * Run one round in a fresh child.
 *
 * The caller (the driver) owns scheduling; this only runs the round and reports
 * what happened. A round that could not start returns `{ started: false }` so
 * the caller can fall back to the same session rather than stalling the run.
 */
export async function runFreshRound(deps) {
  const { subagents, agents, run, root, prompt, signal, provider = 'spawn', agentOptions } = deps
  if (subagents === undefined || agents === undefined) return { started: false, reason: '没有 subagents 服务' }

  const parent = (run.ownerSessionId === undefined ? undefined : agents.get(run.ownerSessionId)) ?? agents.roots()[0]
  if (parent === undefined) return { started: false, reason: '没有活跃的父 Agent' }

  let handle
  try {
    handle = await subagents.start(provider, {
      label: `fresh-${run.id}-r${run.round}`,
      prompt: [{ type: 'text', text: prompt }],
      parent,
      signal,
      agentOptions,
      // A fresh executor works in the same workspace and needs the same tools
      // it would have had in-session; what it is denied is the transcript.
      maxDepth: 1,
    })
  } catch (error) {
    return { started: false, reason: String(error?.message ?? error) }
  }

  try {
    const result = await handle.result
    const text = (result?.output ?? [])
      .map((block) => (block?.type === 'text' ? block.text : ''))
      .join('\n')
      .trim()
    return {
      started: true,
      childId: String(handle.id),
      stopReason: result?.stopReason,
      report: text.slice(0, 4000),
    }
  } catch (error) {
    return { started: true, childId: String(handle.id), stopReason: 'error', report: String(error?.message ?? error) }
  } finally {
    await handle.dispose?.().catch(() => {})
  }
}

/** What a fresh round contributes to the ledger, whatever its outcome. */
export function freshRoundLedgerEntry(run, round, outcome) {
  if (outcome?.started !== true) {
    return { kind: 'round-fresh', runId: run.id, round, started: false, reason: outcome?.reason ?? 'unknown' }
  }
  return {
    kind: 'round-fresh',
    runId: run.id,
    round,
    started: true,
    childId: outcome.childId,
    stopReason: outcome.stopReason,
    reportHead: String(outcome.report ?? '').slice(0, 400),
  }
}
