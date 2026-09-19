/**
 * LongLoop run store — the durable `Run` entity for one workspace.
 *
 * A run lives in `<cwd>/.longloop/run.json` for the same reason memory does:
 * it is a fact about the project that a human should be able to read, diff, and
 * commit. It carries the objective, the frozen contract, the budget, the round
 * counter, the stall streak, and the ledger.
 *
 * Everything here is workspace-scoped and file-backed, so the console, the
 * model-facing tools, and the prompt all read one truth.
 */

import { createHash } from 'node:crypto'
import { readFile, writeFile, readdir, mkdir, rename, stat } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'

import { budgetReport, escalationFor, stallAssessment, mintRunId, BUDGET_LADDER } from './governors.js'
import { normalizeFrozenPaths } from './frozen.js'

/** Verification may spend up to this share of the execution token budget (§8.4). */
export const VERIFY_TOKEN_RATIO = 0.4

/** Directories that never count as "the workspace changed". */
const DIGEST_SKIP = new Set(['.git', 'node_modules', '.longloop', 'dist', 'build', '.next', 'target', '__pycache__'])

/** A run's defaults, in one place so a restarted process reads the same policy. */
export const RUN_DEFAULTS = Object.freeze({
  maxRounds: 40,
  wallClockLimitMs: 4 * 60 * 60 * 1000,
  tokenLimit: undefined,
  toolCallLimit: undefined,
})

export const runFile = (longloopDir) => join(longloopDir, 'run.json')
export const ledgerFile = (longloopDir) => join(longloopDir, 'ledger.jsonl')

/* ─────────────────────────────── persistence ───────────────────────────── */

export async function readRun(longloopDir, exists) {
  const file = runFile(longloopDir)
  if (!(await exists(file))) return undefined
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && typeof parsed.id === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Atomic write: a human or the console may be reading this file at any moment. */
export async function writeRun(longloopDir, run) {
  await mkdir(longloopDir, { recursive: true })
  const file = runFile(longloopDir)
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(run, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
  return run
}

export async function patchRun(longloopDir, exists, patch) {
  const current = await readRun(longloopDir, exists)
  if (current === undefined) return undefined
  const next = { ...current, ...patch, updatedAt: Date.now() }
  await writeRun(longloopDir, next)
  return next
}

/** Append-only ledger. One JSON object per line, so `tail -f` is a live view. */
export async function appendLedger(longloopDir, entry) {
  await mkdir(longloopDir, { recursive: true })
  const file = ledgerFile(longloopDir)
  let existing = ''
  try {
    existing = await readFile(file, 'utf8')
  } catch {
    existing = ''
  }
  const line = `${JSON.stringify({ at: Date.now(), ...entry })}\n`
  await writeFile(file, existing + line, 'utf8')
}

export async function readLedger(longloopDir, limit = 50) {
  try {
    const text = await readFile(ledgerFile(longloopDir), 'utf8')
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return undefined
        }
      })
      .filter((entry) => entry !== undefined)
  } catch {
    return []
  }
}

/* ──────────────────────────────── the run ──────────────────────────────── */

/**
 * Keep only the expectation shapes the evaluator understands, and **say so**
 * when one is dropped.
 *
 * A live run exposed the cost of the silent version: the evaluator reads
 * `stdoutMatches`, one of the plugin's own parsers wrote `stdout`, and the
 * expectation was quietly replaced by `{exitCode: 0}` — a criterion that looks
 * configured and tests something else. Nothing downstream could tell. So:
 * `stdout` is accepted as an alias (it is the obvious name), and anything else
 * becomes an explicit `{exitCode: 0}` **plus** a warning the contract carries.
 */
function normalizeExpect(expect, warn) {
  if (expect !== null && typeof expect === 'object') {
    if (Number.isInteger(expect.exitCode)) return { exitCode: expect.exitCode }
    const pattern = typeof expect.stdoutMatches === 'string' ? expect.stdoutMatches : typeof expect.stdout === 'string' ? expect.stdout : undefined
    if (pattern !== undefined) return { stdoutMatches: pattern }
    if (typeof expect.fileExists === 'string') return { fileExists: expect.fileExists }
    const keys = Object.keys(expect)
    if (keys.length > 0) {
      warn?.(`期望写法无法识别（${keys.join(', ')}），已降级为「退出码 = 0」`)
    }
  }
  return { exitCode: 0 }
}

export function createRun(input) {
  const now = Date.now()
  // Contract problems the caller must be able to see: a dropped expectation is
  // invisible in the stored criterion, so it is collected here instead.
  const contractWarnings = []
  return {
    version: 1,
    id: input.id ?? mintRunId(),
    objective: String(input.objective ?? '').trim(),
    contract: {
      deliverable: String(input.contract?.deliverable ?? '').trim(),
      acceptance: (input.contract?.acceptance ?? []).map((criterion) => {
        const entry = {
          statement: String(criterion.statement ?? '').trim(),
          weight: criterion.weight === 'nice-to-have' ? 'nice-to-have' : 'required',
        }
        // A check is frozen with the contract. ExecCritic's ablation is why: an
        // executor that can author or edit its own acceptance test scores
        // *worse* than one with no test at all, because patch and test share
        // their misconceptions and agree with each other.
        const check = criterion.check
        if (check !== undefined && typeof check.command === 'string' && check.command.trim().length > 0) {
          entry.check = {
            command: check.command.trim(),
            expect: normalizeExpect(check.expect, (warning) => contractWarnings.push(`${entry.statement}：${warning}`)),
            timeoutMs: Number.isInteger(check.timeoutMs) ? check.timeoutMs : undefined,
          }
        } else if (check !== undefined) {
          // A `check` object with no command is the other half of the same
          // failure: it looks like a machine-decidable criterion and is not.
          contractWarnings.push(`${entry.statement}：检查里没有命令，这条标准只能靠声明`)
        }
        return entry
      }),
      constraints: (input.contract?.constraints ?? []).map(String),
      nonGoals: (input.contract?.nonGoals ?? []).map(String),
      // §8.4 契约冻结第 2 条: the files the checks live in. Normalized here, at
      // the only moment a contract may be written, and read by the tools guard
      // for the rest of the run's life.
      frozenPaths: normalizeFrozenPaths(input.contract?.frozenPaths),
    },
    // Contract-time problems that must survive into the console and the prompt
    // (§8.4): a criterion stored without the expectation it was written with is
    // worse than one with no expectation, because it looks decidable.
    contractWarnings,
    // A run with no acceptance criteria can still be started, but the console
    // says so: §13 rule 8 is that an unverifiable long task should not begin.
    state: input.state ?? 'armed',
    // How hard completion must be proven. `self` only records a claim;
    // `executable` runs the frozen checks; `independent` additionally asks a
    // fresh-context evaluator that shares nothing with the executor.
    assurance: ['self', 'executable', 'independent'].includes(input.assurance) ? input.assurance : 'executable',
    // §7.5: `inline` keeps one session, `fresh` runs each round in a new child.
    // The ladder moves a run from the first to the second at L3; nothing moves
    // it back except a failed start.
    mode: input.mode === 'fresh' ? 'fresh' : 'inline',
    round: 0,
    maxRounds: Number.isInteger(input.maxRounds) ? input.maxRounds : RUN_DEFAULTS.maxRounds,
    wallClockLimitMs: Number.isInteger(input.wallClockLimitMs) ? input.wallClockLimitMs : RUN_DEFAULTS.wallClockLimitMs,
    tokenLimit: input.tokenLimit,
    toolCallLimit: input.toolCallLimit,
    ladder: BUDGET_LADDER,
    startedAt: now,
    updatedAt: now,
    pausedMs: 0,
    pausedAt: undefined,
    pausedReason: undefined,
    lastRoundAt: undefined,
    inFlightRound: undefined,
    stalledRounds: 0,
    escalationLevel: 0,
    notes: [],
    lastBlockers: [],
    // Verification state. `challenges` is the escape valve's counter: a gate
    // that can ask forever is a deadlock, so it asks at most twice.
    verdicts: [],
    challenges: 0,
    verifyTokens: 0,
    // Pinned constraints (§8.3) and the latest L4 diagnosis, both carried into
    // every subsequent round prompt.
    constraints: [],
    diagnosis: undefined,
    ownerSessionId: input.ownerSessionId,
    // §6.1 `sessionIds`: every session a round has actually run in. `fresh`
    // rounds (§7.5 L3) run in a child, so the owner alone is not the run's whole
    // history — and the event mirror needs every id it may still find live.
    sessionIds: [...new Set([input.ownerSessionId, ...(input.sessionIds ?? [])].filter((id) => typeof id === 'string' && id.length > 0))],
    // §8.6 idempotency anchor: the round a fact belongs to, stable across a
    // restart, so a resumed run can tell "this round never ran" from "this round
    // ran and its result was lost".
    roundId: input.roundId,
    // §8.4's third verification trigger: the lightest pass, kept separately from
    // `lastVerdict` so a process check can never be mistaken for a completion
    // verdict in the console or the prompt.
    lastProcessVerdict: undefined,
    processVerifyRound: 0,
  }
}

/** The stable round id a fact from round N carries (§8.6 idempotency anchor). */
export function roundIdFor(run, round = run?.round ?? 0) {
  return run?.id === undefined ? undefined : `${run.id}-r${round}`
}

/* ──────────────────────────── observation (I/O) ────────────────────────── */

/**
 * A cheap, content-addressed-enough fingerprint of the workspace tree.
 *
 * `path + size + mtime` rather than file contents: hashing a whole repository
 * every round would cost more than the round. It still catches every way a file
 * can actually change, and it is computed fresh each time — the bounded-loops
 * incident (§8.2) was a *stale* snapshot, not a cheap one.
 */
export async function digestWorkspace(root, maxEntries = 20000) {
  const hash = createHash('sha256')
  let count = 0
  async function walk(dir) {
    if (count >= maxEntries) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (count >= maxEntries) return
      if (DIGEST_SKIP.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        try {
          const info = await stat(full)
          hash.update(`${relative(root, full)}:${info.size}:${Math.floor(info.mtimeMs)}`)
          count += 1
        } catch {
          /* a vanished file simply contributes nothing */
        }
      }
    }
  }
  await walk(root)
  return { digest: hash.digest('hex').slice(0, 16), files: count }
}

/** Reads the board digest the same way, so both halves of a stall agree. */
export function digestBoard(tasks) {
  const shape = tasks.map((t) => `${t.id}:${t.status}:${t.priority}:${t.updatedAt ?? 0}`).join('|')
  return createHash('sha256').update(shape).digest('hex').slice(0, 16)
}

/* ───────────────────────────── governance ──────────────────────────────── */

/**
 * Recompute the whole governance picture for one run and patch what changed.
 *
 * @returns `{ run, budget, escalation, stall }` — the same values the console,
 *   the prompt, and `/longloop status` render, computed once.
 */
export async function assess(longloopDir, exists, run, tasks, measurements = {}) {
  const now = measurements.now ?? Date.now()
  const budget = budgetReport({
    round: run.round,
    maxRounds: run.maxRounds,
    startedAt: run.startedAt,
    pausedMs: run.pausedMs ?? 0,
    now,
    wallClockLimitMs: run.wallClockLimitMs,
    tokens: measurements.tokens,
    tokenLimit: run.tokenLimit,
    toolCalls: measurements.toolCalls,
    toolCallLimit: run.toolCallLimit,
    // Verification carries its own ceiling (§8.4). It is computed here as well
    // as in `finishRound` — two call sites deriving one budget is exactly how
    // the dimension went missing from the console.
    verifyTokens: run.verifyTokens,
    verifyTokenLimit: run.tokenLimit === undefined ? undefined : Math.round(run.tokenLimit * VERIFY_TOKEN_RATIO),
    ladder: run.ladder,
  })
  const escalation = escalationFor(run.stalledRounds ?? 0)
  return { budget, escalation }
}

/**
 * Score the round that just finished, using only observable facts.
 *
 * `workspaceChanged` and `boardChanged` are supplied by the caller, which holds
 * the previous digests; everything else is derived here.
 */
export function scoreRound(run, observation) {
  return stallAssessment(observation, run.stalledRounds ?? 0)
}

export { resolve }
