/**
 * LongLoop handoff package — what every termination owes a human.
 *
 * §9.1 is a one-line discipline: **never stop silently.** A run that ends
 * without saying what was achieved, what was not, and what a person should do
 * next has turned its budget into noise. So every terminal state — done,
 * exhausted, blocked, aborted — produces this document, and it is written both
 * into the workspace and onto the console.
 *
 * The risk section is derived, not authored. §9.2 asks for exactly one
 * automatically-extracted signal, and it is the one that matters most: a run
 * that modified its own verification during the run is the audit trail of a
 * possible reward hack, and no agent will volunteer it.
 */

const TERMINAL_LABEL = {
  done: '已完成（验收通过）',
  exhausted: '预算耗尽',
  blocked: '阻塞，需要人类决策',
  aborted: '人手中止',
  suspended: '进程中断，等待重新授权',
}

/** `3h 41m`, `12m 05s` — a human reads durations, not milliseconds. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

/**
 * Risks a reader must know about, derived from what the run recorded.
 *
 * Every entry names the evidence it came from. A risk with no pointer is an
 * opinion, and §8.4's rule about counterexamples applies here too.
 */
export function extractRisks(run, ledger, verdict) {
  const risks = []

  if (verdict?.sideEffects === true) {
    risks.push({
      kind: 'verification-side-effects',
      detail: `验证过程改动了工作区（digest ${verdict.digestBefore} → ${verdict.digestAfter}）。确认这些改动是缓存而不是源码。`,
    })
  }

  for (const criterion of verdict?.perCriterion ?? []) {
    if (criterion.status === 'unknown') {
      risks.push({
        kind: 'unverified-criterion',
        detail: `${criterion.id}「${criterion.statement}」未获验证：${criterion.note}`,
      })
    }
  }

  const deadEnds = ledger.filter((e) => e.kind === 'dead-end')
  if (deadEnds.length > 0) {
    risks.push({
      kind: 'known-dead-ends',
      detail: `${deadEnds.length} 条死胡同已记录，继续这个任务前先读它们：${deadEnds.slice(-3).map((e) => e.detail).join('；')}`,
    })
  }

  if (verdict?.level !== undefined && verdict.level !== 'independent' && (verdict.perCriterion ?? []).some((c) => c.status === 'pass')) {
    risks.push({
      kind: 'weaker-assurance',
      detail: `裁决来自 ${verdict.level} 档，没有独立评估器复核；如需更高保证，重跑时用 assurance: independent。`,
    })
  }

  const degradations = ledger.filter((e) => e.kind === 'verify-degraded')
  for (const entry of degradations.slice(-2)) {
    risks.push({ kind: 'verification-degraded', detail: String(entry.reason ?? '验证降级') })
  }

  return risks
}

/** Group ledger entries into the sections a handoff reads best in. */
function partitionLedger(ledger) {
  const byKind = (kind) => ledger.filter((entry) => entry.kind === kind)
  return {
    claims: byKind('claim'),
    evidence: byKind('evidence'),
    blockers: byKind('blocker'),
    deadEnds: byKind('dead-end'),
    rounds: byKind('round'),
  }
}

/**
 * Build the handoff document.
 *
 * @param run      the durable run record
 * @param ledger   every ledger entry, oldest first
 * @param verdict  the last verdict, when one exists
 * @param tasks    the task board as it stands
 */
export function buildHandoff({ run, ledger = [], verdict, tasks = [], now = Date.now() }) {
  const parts = partitionLedger(ledger)
  const elapsed = formatDuration(Math.max(0, (run.endedAt ?? now) - run.startedAt - (run.pausedMs ?? 0)))
  const risks = extractRisks(run, ledger, verdict)

  const lines = [
    `# Run ${run.id} 交接包`,
    '',
    `**终态**: ${TERMINAL_LABEL[run.state] ?? run.state}${run.endReason === undefined ? '' : ` —— ${run.endReason}`}`,
    `**耗时**: ${elapsed} · ${run.round} 轮`,
    `**验证档**: ${run.assurance ?? 'executable'}`,
    '',
    '## 目标',
    run.objective,
    '',
  ]

  if (run.contract?.deliverable) {
    lines.push('## 交付物', run.contract.deliverable, '')
  }

  // ── acceptance ────────────────────────────────────────────────────────────
  lines.push('## 达成情况', '')
  const acceptance = run.contract?.acceptance ?? []
  if (acceptance.length === 0) {
    lines.push('这条运行没有验收标准，因此无法判定成败。', '')
  } else {
    lines.push('| # | 标准 | 权重 | 状态 | 依据 |', '|---|---|---|---|---|')
    acceptance.forEach((criterion, index) => {
      const id = `C${index + 1}`
      const judged = (verdict?.perCriterion ?? []).find((c) => c.id === id)
      const mark = judged === undefined ? '⚠️ 未验证' : judged.status === 'pass' ? '✅ pass' : judged.status === 'fail' ? '❌ fail' : '⚠️ unknown'
      const why = judged?.counterexample ?? judged?.note ?? '本轮未产生裁决'
      lines.push(`| ${id} | ${criterion.statement} | ${criterion.weight === 'nice-to-have' ? '次要' : '必达'} | ${mark} | ${String(why).replace(/\|/g, '\\|')} |`)
    })
    lines.push('')
  }

  // ── finished / remaining ──────────────────────────────────────────────────
  const done = tasks.filter((t) => t.status === 'done')
  const open = tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress' || t.status === 'blocked')
  if (done.length > 0) {
    lines.push('## 已完成', '')
    for (const task of done) lines.push(`- ${task.id} ${task.title}`)
    lines.push('')
  }
  if (open.length > 0) {
    lines.push('## 未完成 / 下一步', '')
    for (const task of open) lines.push(`- [${task.status === 'in_progress' ? '~' : task.status === 'blocked' ? '!' : ' '}] ${task.id} P${task.priority} ${task.title}${task.note ? ` —— ${task.note}` : ''}`)
    lines.push('')
  }

  // ── evidence ──────────────────────────────────────────────────────────────
  if (parts.evidence.length > 0) {
    lines.push('## 证据', '')
    for (const entry of parts.evidence.slice(-20)) lines.push(`- ${entry.detail}`)
    lines.push('')
  }

  // ── decisions and dead ends ───────────────────────────────────────────────
  if (run.notes?.length > 0 || parts.deadEnds.length > 0) {
    lines.push('## 关键决策（避免重复探索）', '')
    const written = []
    for (const note of (run.notes ?? []).slice(-20)) {
      const line = `- ${note.kind === 'dead-end' ? '❌ 已否决' : `[${note.kind}]`} ${note.detail}`
      lines.push(line)
      written.push(String(note.detail))
    }
    // The ledger carries a `dead-end` entry for every dead-end note, so the two
    // sources overlap by design. Match by containment rather than equality: the
    // note usually carries the "what we did instead" clause the ledger lacks,
    // and printing both reads as two separate rejections.
    for (const entry of parts.deadEnds) {
      const detail = String(entry.detail)
      if (written.some((seen) => seen.includes(detail) || detail.includes(seen))) continue
      lines.push(`- ❌ 已否决 ${detail}`)
      written.push(detail)
    }
    lines.push('')
  }

  if (parts.blockers.length > 0) {
    lines.push('## 阻塞', '')
    for (const entry of parts.blockers) lines.push(`- ${entry.detail}`)
    const last = (run.lastBlockers ?? []).slice(-1)[0]
    if (last !== undefined) lines.push(`  已尝试：${(last.attempted ?? []).join(' · ') || '（未记录）'}`)
    lines.push('')
  }

  // ── risks ─────────────────────────────────────────────────────────────────
  lines.push('## 风险', '')
  if (risks.length === 0) {
    lines.push('未从记录中提取到风险。')
  } else {
    for (const risk of risks) lines.push(`- **${risk.kind}**：${risk.detail}`)
  }
  lines.push('')

  lines.push('---', `由 LongLoop 于 ${new Date(run.endedAt ?? now).toISOString()} 生成。`)
  return lines.join('\n')
}

/**
 * The one-line form the console shows without opening the document.
 * A terminal run must be legible from the panel, not only from a file.
 */
export function summarizeHandoff(handoff) {
  if (handoff === undefined) return undefined
  const risks = (handoff.match(/^- \*\*/gm) ?? []).length
  return { bytes: Buffer.byteLength(handoff, 'utf8'), lines: handoff.split('\n').length, risks }
}
