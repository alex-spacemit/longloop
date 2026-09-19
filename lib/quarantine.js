/**
 * Verification-environment quarantine (§8.4's contamination control).
 *
 * The audit behind this module: on SWE-bench Pro, **63% of "successful fixes"
 * were the model retrieving the answer** — 57% by finding the merged PR, 9% by
 * reading `.git` history (`git show <future commit> -p`, then cherry-pick).
 * Blocking git history and network dropped Opus 4.8 Max from 87.1% to 73.0%.
 *
 * LongLoop verifies in the live workspace rather than in a sandbox copy, so the
 * two protections that matter here are:
 *
 *   1. a **check command may not read quarantined material** (`.git`, `.env*`,
 *      keys). A check that greps history is not a verification, it is an answer
 *      with a pass verdict attached.
 *   2. a workspace whose tree contains a **symlink escaping the root** is
 *      refused outright — the same escape `copytree` would have followed, one
 *      step later.
 *
 * The name and suffix lists are the design's, verbatim, so an external audit can
 * check them against the doc instead of against prose.
 */

/** Names that never belong in a verification environment, at any depth. */
export const QUARANTINE_NAMES = Object.freeze([
  '.git',
  '.env',
  '.env.local',
  '.ssh',
  '.aws',
  '.gnupg',
  '.netrc',
  'credentials',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
])

/** Suffixes that never belong in a verification environment. */
export const QUARANTINE_SUFFIXES = Object.freeze(['.pem', '.key', '.p12', '.pfx'])

/** Whether one entry name is quarantined — case-insensitive, like the design's. */
export function isQuarantined(name) {
  const lower = String(name ?? '').toLowerCase()
  if (lower.length === 0) return false
  if (QUARANTINE_NAMES.includes(lower)) return true
  return QUARANTINE_SUFFIXES.some((suffix) => lower.endsWith(suffix))
}

/**
 * The `copytree`-style ignore callback: which of `names` a directory must not
 * carry into a verification environment. Kept because the semantics (per level,
 * case-insensitive, name-or-suffix) are the part worth reusing.
 */
export function quarantineIgnore(names) {
  return [...names].filter((name) => isQuarantined(name))
}

/** Directories the walk does not descend into: quarantined, or noise. */
const PRUNE = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.cache'])

/**
 * Walk a workspace once and report what a verification run must not see.
 *
 * Bounded on purpose: a verification gate that takes a minute to scan the tree
 * is a gate someone turns off. `limit` caps the entries inspected, and the
 * report says so (`truncated`) rather than pretending it saw everything.
 *
 * @param options.fs - `node:fs/promises`-shaped module (injected for tests).
 * @param options.root - absolute workspace root.
 * @param options.limit - maximum entries inspected.
 * @returns `{ quarantined, escapingSymlinks, symlinks, inspected, truncated }`.
 */
export async function scanVerificationEnv({ fs, root, limit = 4000 } = {}) {
  const quarantined = []
  const symlinks = []
  const escapingSymlinks = []
  let inspected = 0
  let errors = 0
  const errorSamples = []
  let truncated = false

  const queue = ['']
  while (queue.length > 0) {
    const relative = queue.shift()
    if (inspected >= limit) {
      truncated = true
      break
    }
    let entries
    try {
      entries = await fs.readdir(relative.length === 0 ? root : `${root}/${relative}`, { withFileTypes: true })
    } catch (error) {
      // A directory we cannot read is a fact about the scan, not a clean bill of
      // health: the report counts it so "nothing found" cannot mean "nothing read",
      // and keeps the first few reasons so the cause is diagnosable.
      errors += 1
      if (errorSamples.length < 3) {
        errorSamples.push(`${relative.length === 0 ? '.' : relative}: ${String(error?.code ?? error?.message ?? error).slice(0, 120)}`)
      }
      continue
    }
    for (const entry of entries) {
      inspected += 1
      const child = relative.length === 0 ? entry.name : `${relative}/${entry.name}`
      if (isQuarantined(entry.name)) {
        quarantined.push({ path: child, kind: entry.isDirectory() ? 'dir' : 'file' })
        // `.git` alone can hold 10⁵ files; its presence is the finding.
        continue
      }
      if (entry.isSymbolicLink?.() === true) {
        const target = await readLink(fs, `${root}/${child}`)
        const escapes = escapesRoot(root, child, target)
        symlinks.push({ path: child, target: target ?? '' })
        if (escapes) escapingSymlinks.push({ path: child, target: target ?? '' })
        continue
      }
      if (entry.isDirectory() && !PRUNE.has(entry.name)) queue.push(child)
      if (inspected >= limit) {
        truncated = true
        break
      }
    }
  }

  return { quarantined, escapingSymlinks, symlinks, inspected, errors, errorSamples, truncated }
}

async function readLink(fs, path) {
  try {
    return typeof fs.readlink === 'function' ? String(await fs.readlink(path)) : undefined
  } catch {
    return undefined
  }
}

/** Whether a symlink's target leaves the workspace (absolute and relative both). */
export function escapesRoot(root, linkPath, target) {
  if (typeof target !== 'string' || target.length === 0) return false
  const normalizedRoot = String(root ?? '').replace(/\/+$/, '')
  if (target.startsWith('/')) {
    const normalized = target.replace(/\/+$/, '')
    return !(normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`))
  }
  const base = linkPath.includes('/') ? linkPath.slice(0, linkPath.lastIndexOf('/')) : ''
  const resolved = resolveRelative(base, target)
  return resolved === undefined || resolved.startsWith('..')
}

/** Resolve a possibly-relative link target against its containing directory. */
function resolveRelative(base, target) {
  const parts = target.startsWith('/') ? [] : base.split('/').filter((part) => part.length > 0)
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length === 0) return undefined // already above the root
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return parts.join('/')
}

/**
 * History-reading git verbs.
 *
 * `git show HEAD~1 -p` never names `.git`, and on SWE-bench Pro exactly that
 * shape was 9% of all "successful" fixes — the model reads the future commit
 * that fixed the bug. So the command is matched on what it *does*, not only on
 * the paths it mentions. `git diff` is deliberately absent: a check that diffs
 * the working tree is doing ordinary verification.
 */
const GIT_HISTORY = /\bgit\s+(?:show|log|blame|reflog|rev-list|cat-file|archive|cherry-pick|fsck)\b/

/**
 * Whether a check command reaches for quarantined material.
 *
 * Text matching, not shell parsing — the command is a string the model wrote,
 * and the names below are exactly the ones the model must not be rewarded for
 * reading. Returns the offending name so the verdict can say why.
 */
export function commandTouchesQuarantine(command) {
  const text = String(command ?? '')
  if (text.length === 0) return undefined
  if (GIT_HISTORY.test(text)) return 'git-history'
  for (const name of QUARANTINE_NAMES) {
    const pattern = new RegExp(`(^|[\\s/'"\`=])${name.replace('.', '\\.')}([\\s/'"\`:.,)]|$)`, 'i')
    if (pattern.test(text)) return name
  }
  for (const suffix of QUARANTINE_SUFFIXES) {
    if (new RegExp(`[\\w.-]${suffix.replace('.', '\\.')}([\\s'"\`:.,)]|$)`, 'i').test(text)) return suffix
  }
  return undefined
}

/** The compact, lossless summary a verdict and the ledger can carry. */
export function quarantineSummary(report) {
  if (report === undefined) return { available: false }
  return {
    available: true,
    quarantined: report.quarantined.slice(0, 20).map((entry) => entry.path),
    quarantinedCount: report.quarantined.length,
    escapingSymlinks: report.escapingSymlinks.slice(0, 20).map((entry) => `${entry.path} -> ${entry.target}`),
    escapingCount: report.escapingSymlinks.length,
    inspected: report.inspected,
    errors: report.errors ?? 0,
    errorSamples: (report.errorSamples ?? []).slice(0, 3),
    truncated: report.truncated === true,
  }
}
