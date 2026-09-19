/**
 * LongLoop context governor — §8.3.
 *
 * Three jobs, and the first one is the important one:
 *
 *   1. **Constraint whitelist.** Lost in Compaction (2608.11242) measured the
 *      existing compactors at **17% retention** of session constraints — "do not
 *      delete any emails until I confirm" is exactly the kind of instruction
 *      that gets summarised away — and found most compactors performed *worse*
 *      than no compaction at all. So a constraint is lifted out of the
 *      transcript and pinned before anything is allowed to summarise it.
 *
 *   2. **Proactive compaction.** Compacting at 70% costs a summary model with
 *      attention to spare; compacting at the automatic threshold means the
 *      context is already full and the summary is at its worst. §8.3 puts it at
 *      0.70 for that reason.
 *
 *   3. **Context health.** A number the escalation ladder can act on, rather
 *      than an impression the model has about its own clarity.
 *
 * The extractor is deliberately rule-based, not model-based. It runs on every
 * incoming human message, and a rule that is occasionally too eager costs a
 * line in the prompt, while a model call on every message costs money on every
 * message. Extraction from a *known* transcript before compaction is the case
 * the design reserves an LLM call for; this is the cheap always-on tier.
 */

/** How much of the window may be full before the governor acts. */
export const PROACTIVE_COMPACT_AT = 0.7

/** Below this, a context is simply not a topic. */
export const CONTEXT_WARM_AT = 0.7
export const CONTEXT_HOT_AT = 0.85

/** At most this many constraints are pinned; beyond it the list stops helping. */
export const MAX_PINNED_CONSTRAINTS = 24

/* ─────────────────────── constraint extraction (pure) ──────────────────── */

/**
 * The three shapes worth pinning, with the wording that gives them away.
 *
 * A constraint is an instruction about the *rest of the session*, not a task.
 * That is the difference between "add a Redis backend" (a task — it belongs in
 * the board) and "do not add dependencies" (a constraint — it belongs pinned,
 * because it stays true after the task that prompted it is finished).
 */
const CONSTRAINT_PATTERNS = [
  // ── prohibitions ──────────────────────────────────────────────────────────
  { kind: 'prohibition', pattern: /(?:不要|不得|不能|不许|禁止|别再|别去|无需|无需再)\s*([^\n。；;！!？?]{2,60})/g },
  { kind: 'prohibition', pattern: /\b(?:do not|don'?t|never|must not|mustn'?t|should not|shouldn'?t|avoid)\s+([^.;\n]{4,90})/gi },
  // ── boundaries ────────────────────────────────────────────────────────────
  { kind: 'boundary', pattern: /(?:只能|只允许|必须|务必|一定要|仅能|仅限于|不得超出)\s*([^\n。；;！!？?]{2,60})/g },
  { kind: 'boundary', pattern: /\b(?:must|always|only|required to|make sure(?: to)?|ensure(?: that)?)\s+([^.;\n]{4,90})/gi },
  // ── preconditions ─────────────────────────────────────────────────────────
  { kind: 'precondition', pattern: /([^\n。；;]{2,40}(?:之前|以前|之后|以后再|先)[^\n。；;]{2,60})/g },
  { kind: 'precondition', pattern: /\b(before|after|once)\s+([^.;\n]{4,50},\s*[^.;\n]{4,90})/gi },
]

/** A statement that is really a question is not a constraint. */
const QUESTION_MARKERS = /[？?]|(?:吗|呢)[。！!]?\s*$|\b(?:should i|can you|could you|what|which|how)\b/i

/**
 * The shortest capture worth pinning.
 *
 * Three, not four: Chinese packs a complete instruction into very few
 * characters — "删数据" is the whole of "do not delete data" once the negation
 * is in the pattern — and a length floor tuned for English silently drops
 * exactly the constraints a Chinese speaker states most tersely.
 */
const MIN_CONSTRAINT_LENGTH = 3

/** Normalise for comparison: case, whitespace, and trailing punctuation. */
function normalize(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[\s，,、:：-]+|[\s，,、。；;:：-]+$/g, '')
    .trim()
}

/**
 * Pull constraint candidates out of one piece of prose.
 *
 * Returns `{kind, text}` entries, deduplicated within the call and capped. The
 * cap is per message, not global — a long instruction may legitimately state
 * several, and the global cap lives on the run.
 */
export function extractConstraints(text, limit = 8) {
  const source = String(text ?? '')
  if (source.trim().length === 0) return []

  const found = []
  const seen = new Set()

  for (const { kind, pattern } of CONSTRAINT_PATTERNS) {
    // `matchAll` needs the global flag; the patterns above all carry one.
    for (const match of source.matchAll(pattern)) {
      // Patterns with one group keep it in [1]; the two-group precondition
      // pattern reconstructs the phrase from the whole match.
      const captured = match.length > 2 ? match[0] : match[1] ?? match[0]
      const phrase = normalize(captured)
      if (phrase.length < MIN_CONSTRAINT_LENGTH || phrase.length > 120) continue
      if (QUESTION_MARKERS.test(phrase)) continue
      // A "precondition" with no verb-ish content is usually a stray sentence.
      const key = phrase.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      found.push({ kind, text: phrase })
      if (found.length >= limit) return found
    }
  }
  return found
}

/**
 * Merge new candidates into the pinned set.
 *
 * Idempotent by text, so re-scanning the same transcript grows nothing; and
 * capped, because a pinned list longer than the prompt it lives in is worse
 * than no list.
 */
export function mergeConstraints(existing, candidates, { round, max = MAX_PINNED_CONSTRAINTS } = {}) {
  const seen = new Set((existing ?? []).map((c) => String(c.text).toLowerCase()))
  const added = []
  for (const candidate of candidates ?? []) {
    const key = String(candidate.text).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    added.push({ kind: candidate.kind, text: candidate.text, pinnedAtRound: round ?? 0 })
  }
  const next = [...(existing ?? []), ...added]
  // Keep the newest when over the cap: a constraint stated five minutes ago is
  // more likely to still be live than one from fifty rounds back.
  return { constraints: next.slice(-max), added }
}

/** Render the pinned list for the prompt. Empty input adds no tokens. */
export function renderConstraints(constraints) {
  if ((constraints ?? []).length === 0) return ''
  const lines = ['<pinned_constraints note="stated during this run; they stay true until withdrawn">']
  for (const constraint of constraints) {
    lines.push(`  [${constraint.kind}] ${constraint.text}`)
  }
  lines.push('</pinned_constraints>')
  return lines.join('\n')
}

/* ─────────────────────────── context health (pure) ─────────────────────── */

/**
 * The health number §8.3 asks for, as a value the ladder can branch on.
 *
 * It is a *budget* statement, not a quality judgement: how much room is left,
 * discounted by the things that make a full context worse — a long history and
 * a pile of unresolved questions both mean the next prompt has more to lose.
 */
export function contextHealth(input) {
  const pressure = Number(input.pressureTokens)
  const window = Number(input.contextWindow)
  if (!Number.isFinite(pressure) || !Number.isFinite(window) || window <= 0) {
    return { measured: false, ratio: 0, health: 1, band: 'unknown', reasons: ['没有可用的上下文计量'] }
  }

  const ratio = Math.min(1, Math.max(0, pressure / window))
  const reasons = []

  // A long history is a penalty even at low pressure: context rot is about
  // position and dilution, not only about hitting a ceiling.
  const roundPenalty = Math.min(0.15, (input.rounds ?? 0) * 0.005)
  if (roundPenalty > 0.03) reasons.push(`已进行 ${input.rounds} 轮，长历史本身在稀释注意力`)

  const openPenalty = Math.min(0.15, (input.openQuestions ?? 0) * 0.03)
  if (openPenalty > 0) reasons.push(`${input.openQuestions} 个未决问题还挂在上下文里`)

  const health = Math.max(0, Math.min(1, 1 - ratio - roundPenalty - openPenalty))
  const band = ratio >= CONTEXT_HOT_AT ? 'hot' : ratio >= CONTEXT_WARM_AT ? 'warm' : 'ok'

  return {
    measured: true,
    ratio,
    health,
    band,
    reasons,
    pressureTokens: pressure,
    contextWindow: window,
  }
}

/**
 * Whether to compact now rather than wait for the automatic trigger.
 *
 * §8.3's argument: at the automatic threshold the window is already full and
 * the summary model has the least attention to spare for deciding what
 * mattered. Compacting early is not just cheaper, it is *better*.
 */
export function proactiveCompactDue(health, threshold = PROACTIVE_COMPACT_AT) {
  if (health?.measured !== true) return { due: false, reason: '上下文压力未测量' }
  if (health.ratio < threshold) return { due: false, reason: `压力 ${(health.ratio * 100).toFixed(0)}% 未达 ${(threshold * 100).toFixed(0)}%` }
  return {
    due: true,
    reason: `压力 ${(health.ratio * 100).toFixed(0)}% 已达主动压缩阈值，现在压缩比等自动触发保留得更好`,
  }
}

/**
 * The context directive for the budget ladder's `disable-exploration` rung.
 * A rung that only changes a number changes nothing; it has to change what the
 * model is allowed to spend the next round on.
 */
export function explorationDirective(active) {
  if (!active) return ''
  return [
    '<exploration_disabled>',
    '  预算已进入降级档：本轮禁止探索性阅读与搜索。',
    '  只允许读取你已经知道路径的文件，且一次只读一个。',
    '</exploration_disabled>',
  ].join('\n')
}
