/**
 * §10.2 `run_evidence`: the evidence registry behind a completion claim.
 *
 * The design's table gives this tool one job — record `kind`, `pointer`, and the
 * criteria the evidence addresses, with the framework computing the hash — and it
 * exists because of a specific failure: a claim that cites "I tested it" cannot be
 * checked, while a claim that cites *registered* evidence can be asked "which
 * criterion does this address, and does the artifact still hash to what you
 * registered?".
 *
 * Two decisions worth stating:
 *
 *   - The hash is of the **artifact**, not of the pointer string. A file's content
 *     is hashed; anything else (a command, a URL, an observation) hashes its
 *     pointer, and the record says which of the two happened (`hashOf`). Calling
 *     both cases "a hash" would make the field look stronger than it is.
 *   - Coverage is computed against the frozen contract, not against what the model
 *     says it addressed: an evidence record that addresses nothing is accepted and
 *     reported, because a claim with no criterion behind it is exactly the thing a
 *     human needs to see.
 */

/** What a pointer can point at. Kept small on purpose: each value hints at how it
 * should be verified, and a value nobody can verify is worse than no value. */
export const EVIDENCE_KINDS = Object.freeze(['file', 'command', 'url', 'commit', 'observation'])

/** How many records a run keeps. Old evidence is not deleted, only not carried. */
export const MAX_EVIDENCE = 200

/** `E1`, `E2`, … — stable within a run, and cheap to say out loud. */
export function nextEvidenceId(records) {
  let highest = 0
  for (const record of records ?? []) {
    const match = /^E(\d+)$/.exec(String(record?.id ?? ''))
    if (match !== null) highest = Math.max(highest, Number(match[1]))
  }
  return `E${highest + 1}`
}

/**
 * One record, or the reason it cannot be recorded.
 *
 * Pure: the caller supplies `hash` (already computed, with its `hashOf`) so this
 * module stays testable without touching the filesystem.
 */
export function buildEvidence(records, input, context = {}) {
  const kind = String(input?.kind ?? '').trim().toLowerCase()
  const pointer = String(input?.pointer ?? '').trim()
  if (!EVIDENCE_KINDS.includes(kind)) {
    return { error: `kind 只能是 ${EVIDENCE_KINDS.join(' / ')}；收到的是「${input?.kind ?? ''}」。` }
  }
  if (pointer.length === 0) return { error: 'pointer 不能为空：证据要指向某个具体的产物。' }

  const criterionIds = new Set((context.criteria ?? []).map((criterion) => String(criterion.id ?? '')))
  const addresses = (Array.isArray(input?.addresses) ? input.addresses : []).map(String)
  const unknown = addresses.filter((id) => !criterionIds.has(id))
  if (unknown.length > 0) {
    return { error: `引用了契约里不存在的标准：${unknown.join(', ')}。契约开工即冻结，标准不能新增。` }
  }

  return {
    record: {
      id: nextEvidenceId(records),
      kind,
      pointer: pointer.slice(0, 500),
      addresses,
      hash: String(context.hash?.hash ?? ''),
      hashOf: String(context.hash?.hashOf ?? 'pointer'),
      round: Number(context.round ?? 0),
      at: Number(context.at ?? 0),
      note: typeof input?.note === 'string' ? input.note.slice(0, 300) : '',
    },
  }
}

/**
 * Which criteria have evidence behind them, and which do not.
 *
 * The second half is the useful one: a criterion with no evidence is not a
 * failure (the checks may still decide it), but it is the gap a human should see
 * before accepting a claim.
 */
export function evidenceCoverage(records, criteria) {
  const covered = new Set()
  for (const record of records ?? []) {
    for (const id of record?.addresses ?? []) covered.add(String(id))
  }
  const ids = (criteria ?? []).map((criterion) => String(criterion.id ?? ''))
  return {
    covered: ids.filter((id) => covered.has(id)),
    missing: ids.filter((id) => !covered.has(id)),
    records: (records ?? []).length,
  }
}

/**
 * Resolve the ids a completion claim cites.
 *
 * A claim citing ids that were never registered is not a claim with evidence —
 * it is a claim with a typo, and it must be reported rather than counted.
 */
export function resolveCitedIds(records, cited) {
  const known = new Map((records ?? []).map((record) => [String(record.id), record]))
  const found = []
  const missing = []
  for (const id of cited ?? []) {
    const record = known.get(String(id))
    if (record === undefined) missing.push(String(id))
    else found.push(record)
  }
  return { found, missing }
}

/** The one-line digest for a tool result and the console. */
export function renderEvidenceSummary(record, coverage) {
  const addresses = (record?.addresses ?? []).length === 0 ? '（没有指出对应哪条标准）' : `对应 ${record.addresses.join(', ')}`
  return (
    `已登记证据 ${record?.id} · ${record?.kind} · ${record?.pointer} ${addresses} · ${record?.hashOf === 'file' ? '文件内容' : '指针'}哈希 ${String(record?.hash ?? '').slice(0, 12)}…\n` +
    `证据覆盖：${coverage.covered.length}/${coverage.covered.length + coverage.missing.length} 条标准` +
    (coverage.missing.length === 0 ? '（全部有证据）' : `，还没有证据的是 ${coverage.missing.join(', ')}`)
  )
}
