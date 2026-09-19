/**
 * Contract freeze, enforced at the tool boundary (§8.4).
 *
 * ExecCritic's result is the reason this exists: with the same repair agent, an
 * executor allowed to author its own acceptance test scores **worse** than one
 * with no test at all (61.2% → 57.3%), because patch and test share their
 * misconceptions and agree with each other. Freezing the checks at `armed` is
 * necessary but not sufficient — the *files* those checks live in must also be
 * out of the executor's reach, or "take the test" is one edit away.
 *
 * So: `Contract.frozenPaths` names them, and this module decides — purely, from
 * one call's tool name and arguments — whether that call is a write into a
 * frozen path. `index.js` turns it into a `tools.guard`.
 */

/** The write-capable first-party tools and the argument that names their target. */
export const WRITE_TOOLS = Object.freeze({
  write: 'file_path',
  edit: 'file_path',
  str_replace_editor: 'path',
})

/**
 * Shell shapes that mutate a file. Deliberately a deny-list on *shape*, not a
 * shell parser: this guard exists to stop an opportunistic test edit, and every
 * pattern below is something a check-running command has no reason to look like.
 *
 * The redirect pattern is the part that needs care, and two shapes found in the
 * wild by a live run are why it is written this way:
 *   - `=>` inside `node -e "console.log('a => b')"` is not a redirect;
 *   - `2>/dev/null` on a read-only command is not a write.
 * A guard that denies honest work costs rounds, so the redirect must name a real
 * file: preceded by whitespace/`;`/`&`/`|`/`(`/a file descriptor, and not
 * pointed at a file descriptor or `/dev/null`.
 */
const MUTATING_SHELL = new RegExp(
  [
    String.raw`(?:^|[\s;&|(]|\d)>{1,2}(?!\s*(?:&|/dev/null))`,
    String.raw`\btee\b`,
    String.raw`\bsed\s+-i`,
    String.raw`\b(?:rm|mv|cp|truncate|patch|chmod|chown|dd)\b`,
    String.raw`\bgit\s+(?:checkout|restore|apply|stash)\b`,
    String.raw`open\s*\([^)]*['"][wa]`,
    String.raw`\b(?:writeFile|appendFile|unlink|rename|rmdir|mkdir)\w*\s*\(`,
  ].join('|'),
)

/** Run states in which the executor must not touch a frozen path. */
export const FROZEN_GUARD_STATES = Object.freeze(['armed', 'running', 'paused', 'suspended'])

/** Normalize one contract path to a workspace-relative POSIX path. */
export function normalizeFrozenPath(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    // `a//b` and `a/b` are the same file, and a model that writes the first one
    // must not slip past a freeze written as the second.
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
}

/** The frozen list as the contract carries it: relative, deduped, no escapes. */
export function normalizeFrozenPaths(values) {
  const out = []
  for (const value of values ?? []) {
    const path = normalizeFrozenPath(value)
    if (path.length === 0 || path.startsWith('/') || path.split('/').includes('..')) continue
    if (!out.includes(path)) out.push(path)
  }
  return out
}

/**
 * Whether a workspace-relative path is frozen.
 *
 * Exact matches, directory entries (`tests/` or `tests`), and `*`/`**` globs are
 * all accepted, because a contract written by a human uses all three. A glob is
 * anchored at the workspace root — the same rule the path normalization applies.
 */
export function isFrozenPath(target, frozen) {
  const path = normalizeFrozenPath(target)
  if (path.length === 0) return false
  for (const entry of frozen ?? []) {
    if (path === entry) return true
    // A directory entry freezes everything beneath it.
    if (path.startsWith(`${entry}/`)) return true
    if (entry.includes('*') && globMatches(entry, path)) return true
  }
  return false
}

/** One `*`/`**` glob, anchored at both ends, compiled without a dependency. */
function globMatches(pattern, path) {
  const escaped = pattern
    .split('/')
    .map((segment) =>
      segment === '**'
        ? '.*'
        : segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'),
    )
    .join('/')
  try {
    return new RegExp(`^${escaped}$`).test(path)
  } catch {
    return false
  }
}

/**
 * The path a write-capable tool call targets, in the form `frozenPaths` uses.
 *
 * Models write absolute paths as readily as relative ones, so comparing the two
 * forms literally is how a frozen file gets written anyway — a live run proved
 * exactly that (a `write` to `/workspace/notes.md` sailed past a freeze on
 * `notes.md`). Everything is therefore reduced to root-relative form first.
 */
export function writeTarget(toolName, args, root) {
  const field = WRITE_TOOLS[toolName]
  if (field === undefined) return undefined
  const value = args?.[field]
  if (typeof value !== 'string' || value.length === 0) return undefined
  return root === undefined ? value : relativizeToRoot(value, root)
}

/** Root-relative form of a path that may be absolute, `./`-prefixed, or nested. */
export function relativizeToRoot(target, root) {
  const normalized = normalizeFrozenPath(target)
  const base = normalizeFrozenPath(root).replace(/\/+$/, '')
  if (base.length === 0 || base === '.') return normalized
  if (normalized === base) return ''
  if (normalized.startsWith(`${base}/`)) return normalized.slice(base.length + 1)
  return normalized
}

/** Whether a shell command both names a frozen path and could write to it. */
export function shellViolation(command, frozen) {
  if (typeof command !== 'string' || command.length === 0) return undefined
  if (!MUTATING_SHELL.test(command)) return undefined
  return (frozen ?? []).find((entry) => command.includes(entry))
}

/**
 * The denial reason for one tool call, or `undefined` to allow it.
 *
 * Pure. `root`, when given, is what makes an absolute target comparable to a
 * relative `frozenPaths` entry.
 */
export function frozenViolation(toolName, args, frozen, root) {
  if (toolName === 'bash') {
    const named = shellViolation(args?.command, frozen)
    return named === undefined
      ? undefined
      : `契约冻结（§8.4）：${named} 是验收检查的一部分，执行者不能用 shell 改写它。如果这个检查本身有问题，请用 run_block 上报，由人决定是改契约还是改实现。`
  }
  const target = writeTarget(toolName, args, root)
  if (target === undefined) return undefined
  const matched = (frozen ?? []).find((entry) => isFrozenPath(target, [entry]))
  return matched === undefined
    ? undefined
    : `契约冻结（§8.4）：${args?.[WRITE_TOOLS[toolName]] ?? target} 在 Contract.frozenPaths（${matched}）里，验收检查不能由执行者修改。要实现通过它，或者用 run_block 上报。`
}
