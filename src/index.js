/**
 * LongLoop Console — Host half.
 *
 * Owns the workspace-scoped task board, long-term memory, and skill authoring
 * directory, and exposes them over one authenticated HTTP prefix so the browser
 * console can read and mutate them.
 *
 * Why a workspace directory rather than a storage domain: the user asked for a
 * memory system they can maintain for a long time. Plain files under
 * `<cwd>/.longloop/` are diff-able, git-able, editable in any editor, and
 * readable by the model through its ordinary file tools. A KV domain would be
 * none of those.
 */

import { readFile, writeFile, readdir, mkdir, rm, stat, rename, readlink } from 'node:fs/promises'
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, sep, basename } from 'node:path'

import { budgetReport, escalationFor, renderContractBlock, renderRecoveryBlock, renderRoundPrompt, runSummary } from './governors.js'
import { createRoundDriver, PLUGIN_SOURCE } from './driver.js'
import {
  appendLedger,
  assess,
  createRun,
  digestBoard,
  digestWorkspace,
  patchRun,
  readLedger,
  readRun,
  roundIdFor,
  scoreRound,
  writeRun,
  VERIFY_TOKEN_RATIO,
} from './run.js'
import { buildHandoff, extractRisks } from './handoff.js'
import { extractConstraints, mergeConstraints } from './context.js'
import { installRunCommands } from './commands.js'
import { computeMetrics, renderMetrics } from './metrics.js'
import { runDiagnosis, renderFreshRoundPrompt, freshRoundLedgerEntry, runFreshRound as startFreshRound } from './escalate.js'
import {
  emitLongloop,
  ledgerEventData,
  projectionAvailability,
  readProjections,
  registerLongloopProjections,
  runEventData,
  LONGLOOP_EVENT,
} from './events.js'
import { contextReport, governBeforeRound } from './govern.js'
import { FROZEN_GUARD_STATES, WRITE_TOOLS, frozenViolation } from './frozen.js'
import { scanVerificationEnv, QUARANTINE_NAMES, QUARANTINE_SUFFIXES } from './quarantine.js'
import {
  VERIFY_CHALLENGE_MAX,
  evidenceGate,
  independentEvaluate,
  mergeVerdicts,
  parseChecks,
  renderVerdictPrompt,
  runChecks,
} from './verify.js'

/** Cordis function-plugin name. */
export const name = 'longloop-console'

/** The route carrier, the trust fence guarding every route, and the live-session registry. */
export const inject = ['webServer', 'connection']

const ROUTE_PREFIX = '/longloop'

const MAX_BODY_BYTES = 256 * 1024

const PRIORITIES = new Set([0, 1, 2, 3])
const STATUSES = new Set(['pending', 'in_progress', 'blocked', 'done', 'dropped'])

/** Composition's connection service (typed locally; its package is browser-side). */
const connectionOf = (ctx) => Reflect.get(ctx, 'connection')

/* ────────────────────────────── json helpers ───────────────────────────── */

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function sendMethodNotAllowed(res, method) {
  res.statusCode = 405
  res.setHeader('allow', method)
  res.end()
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.length === 0) return resolvePromise({})
      try {
        const parsed = JSON.parse(text)
        resolvePromise(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

/* ──────────────────────────── workspace resolution ─────────────────────── */

/**
 * Every workspace the Host already knows about: the durable workspace registry
 * plus the cwd of every live Session. The console can only ever address one of
 * these, so a request can never name an arbitrary directory.
 */
function knownWorkspaces(ctx) {
  const out = new Map()
  const registry = ctx.get('workspaceRegistry')
  if (registry !== undefined) {
    try {
      for (const ws of registry.list()) {
        out.set(resolve(ws.path), { path: resolve(ws.path), title: ws.title, source: 'registry' })
      }
    } catch {
      /* a broken registry must not fail the request */
    }
  }
  const sessions = ctx.get('sessions')
  if (sessions !== undefined) {
    try {
      for (const session of sessions.list()) {
        const cwd = session?.header?.cwd ?? session?.meta?.cwd
        if (typeof cwd !== 'string' || cwd.length === 0) continue
        const path = resolve(cwd)
        if (!out.has(path)) out.set(path, { path, title: basename(path), source: 'session' })
      }
    } catch {
      /* as above */
    }
  }
  return [...out.values()]
}

/** The cwd of one live Session, which is the authoritative workspace for its agent. */
function cwdOfSession(ctx, id) {
  const sessions = ctx.get('sessions')
  if (sessions === undefined || id === undefined) return undefined
  try {
    const session = sessions.get(id)
    const cwd = session?.header?.cwd ?? session?.meta?.cwd
    return typeof cwd === 'string' && cwd.length > 0 ? resolve(cwd) : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the workspace a request addresses.
 *
 * A Session is the authority: when the caller names one, its cwd decides. Only
 * with no Session at all does the first known workspace stand in, so a console
 * opened before any Session exists still shows something honest.
 */
function resolveWorkspace(ctx, requested, sessionId) {
  const all = knownWorkspaces(ctx)
  if (typeof requested === 'string' && requested.length > 0) {
    const exact = resolve(requested)
    const hit = all.find((w) => w.path === exact)
    if (hit === undefined) return { error: `unknown workspace: ${requested}`, all }
    return { workspace: hit, all }
  }
  const fromSession = cwdOfSession(ctx, sessionId)
  if (fromSession !== undefined) {
    const hit = all.find((w) => w.path === fromSession)
    return { workspace: hit ?? { path: fromSession, title: basename(fromSession), source: 'session' }, all }
  }
  if (all.length > 0) return { workspace: all[0], all }
  const cwd = resolve(process.cwd())
  return { workspace: { path: cwd, title: basename(cwd), source: 'process' }, all: [] }
}

/** Reject any path that escapes the workspace root. */
function insideWorkspace(root, candidate) {
  const target = resolve(root, candidate)
  return target === root || target.startsWith(root + sep) ? target : undefined
}

/* ─────────────────────────────── the stores ────────────────────────────── */

const longloopDir = (root) => join(root, '.longloop')
const tasksFile = (root) => join(longloopDir(root), 'tasks.json')
const memoryDir = (root) => join(longloopDir(root), 'memory')
const skillsDir = (root) => join(root, '.dsh', 'skills')

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Read `tasks.json`, tolerating absence and repairing nothing silently. */
async function readTasks(root) {
  const file = tasksFile(root)
  if (!(await exists(file))) return { version: 1, tasks: [] }
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (!Array.isArray(parsed?.tasks)) return { version: 1, tasks: [], malformed: true }
    const tasks = parsed.tasks.filter((t) => t !== null && typeof t === 'object' && typeof t.id === 'string')
    return { version: 1, tasks }
  } catch (error) {
    return { version: 1, tasks: [], malformed: true, error: String(error?.message ?? error) }
  }
}

/**
 * Write `tasks.json` atomically. `order` is normalised here, on every write, so
 * the file a human opens is always a faithful picture of the board.
 */
async function writeTasks(root, board) {
  const tasks = board.tasks.map((task, index) => ({ ...task, order: index }))
  const dir = longloopDir(root)
  await mkdir(dir, { recursive: true })
  const file = tasksFile(root)
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify({ version: 1, tasks }, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
  return tasks
}

function nextTaskId(tasks) {
  let n = 1
  const taken = new Set(tasks.map((t) => t.id))
  while (taken.has(`T${n}`)) n += 1
  return `T${n}`
}

/** Front-matter-lite: `# title` plus optional `> ` metadata lines, body below. */
async function readMemory(root) {
  const dir = memoryDir(root)
  if (!(await exists(dir))) return []
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort()
  const out = []
  for (const file of names) {
    const full = join(dir, file)
    let content = ''
    let updatedAt = 0
    try {
      content = await readFile(full, 'utf8')
      updatedAt = (await stat(full)).mtimeMs
    } catch {
      continue
    }
    out.push({
      name: file.slice(0, -3),
      file,
      updatedAt,
      bytes: Buffer.byteLength(content, 'utf8'),
      content,
    })
  }
  return out
}

/** Workspace-scoped skills are the ordinary `.dsh/skills` project root. */
async function readSkills(root) {
  const dir = skillsDir(root)
  if (!(await exists(dir))) return []
  const entries = await readdir(dir, { withFileTypes: true })
  const out = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const file = join(dir, entry.name, 'SKILL.md')
      if (!(await exists(file))) continue
      const content = await readFile(file, 'utf8').catch(() => '')
      out.push({ name: entry.name, kind: 'bundle', path: file, description: frontmatterValue(content, 'description') })
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const file = join(dir, entry.name)
      const content = await readFile(file, 'utf8').catch(() => '')
      out.push({
        name: entry.name.slice(0, -3),
        kind: 'flat',
        path: file,
        description: frontmatterValue(content, 'description'),
      })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function frontmatterValue(content, key) {
  const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(content)
  return match === null ? undefined : match[1].trim().replace(/^["']|["']$/g, '')
}

async function fullState(ctx, requested, sessionId) {
  const resolved = resolveWorkspace(ctx, requested, sessionId)
  if (resolved.error !== undefined) return { ok: false, error: resolved.error, workspaces: resolved.all }
  const root = resolved.workspace.path
  const [board, memory, skills, run] = await Promise.all([
    readTasks(root),
    readMemory(root),
    readSkills(root),
    readRun(longloopDir(root), exists),
  ])
  const ledger = await readLedger(longloopDir(root), 40)
  const measurements = measureSession(ctx, run)
  const governance =
    run === undefined ? undefined : { ...(await assess(longloopDir(root), exists, run, board.tasks, measurements)), run }
  return {
    ok: true,
    workspace: resolved.workspace,
    workspaces: resolved.all,
    tasks: board.tasks,
    tasksMalformed: board.malformed === true ? board.error ?? true : false,
    memory: memory.map(({ content, ...rest }) => ({ ...rest, preview: content.slice(0, 400) })),
    skills,
    priorities: [...PRIORITIES],
    statuses: [...STATUSES],
    paths: {
      tasks: tasksFile(root),
      memory: memoryDir(root),
      skills: skillsDir(root),
      run: join(longloopDir(root), 'run.json'),
      ledger: join(longloopDir(root), 'ledger.jsonl'),
    },
    run:
      governance === undefined
        ? undefined
        : runSummary(governance.run, governance.budget, governance.escalation),
    ledger,
    driverEnabled: driverFor(ctx)?.isEnabled() === true,
    // The resolved governance config, so the console can say what the loop will
    // actually do rather than what the file appears to ask for.
    governance: {
      processVerifyEveryRounds: processVerifyEvery(ctx),
      frozenGuard: true,
      quarantine: { names: QUARANTINE_NAMES.length, suffixes: QUARANTINE_SUFFIXES.length },
    },
    // §10.3's projections, read back through the registry: the console can then
    // show that the durable facts exist in the *log*, not only in the file.
    projections: readProjections(ctx, sessionId ?? run?.ownerSessionId),
    projectionReason: projectionAvailability(ctx, sessionId ?? run?.ownerSessionId),
    // §8.3's health number, measured live rather than inferred from the last round.
    context: run === undefined ? undefined : contextReport(ctx, run).health,
  }
}

/**
 * Token and tool-call usage for the run's owner Session, when the meters are
 * mounted. A missing meter reports nothing at all rather than zero, so an
 * unbudgeted dimension never reads as "plenty left".
 */
function measureSession(ctx, run) {
  if (run === undefined || run.tokenLimit === undefined) return {}
  const meter = ctx.get('tokenMeter')
  const sessions = ctx.get('sessions')
  if (meter === undefined || sessions === undefined || run.ownerSessionId === undefined) return {}
  try {
    const session = sessions.get(run.ownerSessionId)
    if (session === undefined) return {}
    const measured = meter.measure(session)
    return { tokens: measured.totalTokens }
  } catch {
    return {}
  }
}

/* ─────────────────────────── multi-agent status ────────────────────────── */

/**
 * Roster and shared board for every team the Host currently holds. Read through
 * the Host `agentTeams` service, so the browser needs no generated Remote
 * contribution of its own.
 */
function readAgents(ctx) {
  const teams = ctx.get('agentTeams')
  const agents = ctx.get('agents')
  if (teams === undefined || agents === undefined) return { available: false, teams: [] }
  const out = []
  try {
    for (const agent of agents.roots()) {
      const membership = teams.tryMembership(agent)
      if (membership === undefined) continue
      let members = []
      let tasks = []
      try {
        members = teams.listMembers(agent)
      } catch {
        /* a team mid-teardown is simply not reported */
      }
      try {
        tasks = teams.listTasks(agent)
      } catch {
        /* as above */
      }
      out.push({
        teamId: membership.teamId ?? membership.id ?? String(agent.id),
        leadSessionId: String(agent.id),
        members: members.map((m) => ({
          name: m.name,
          role: m.role,
          status: m.status,
          model: m.model ?? m.providerModel,
          diagnostics: m.diagnostics ?? [],
        })),
        tasks: tasks.map((t) => ({
          id: t.id,
          subject: t.subject,
          status: t.status,
          ownerName: t.ownerName,
          ready: t.ready,
          blockedBy: t.blockedBy ?? [],
          writeScopes: t.writeScopes ?? [],
          writeScopeWarnings: t.writeScopeWarnings ?? [],
        })),
      })
    }
  } catch (error) {
    return { available: false, teams: [], error: String(error?.message ?? error) }
  }
  return { available: true, teams: out }
}

/* ────────────────────────────── task mutations ─────────────────────────── */

function clampPriority(value, fallback) {
  const n = Number(value)
  return PRIORITIES.has(n) ? n : fallback
}

async function mutateTask(root, body) {
  const board = await readTasks(root)
  const tasks = board.tasks
  const op = String(body.op ?? '')
  const now = Date.now()

  if (op === 'create') {
    const title = String(body.title ?? '').trim()
    if (title.length === 0) return { ok: false, error: 'title is required' }
    const task = {
      id: typeof body.id === 'string' && body.id.length > 0 ? body.id : nextTaskId(tasks),
      title,
      status: STATUSES.has(body.status) ? body.status : 'pending',
      priority: clampPriority(body.priority, 2),
      owner: typeof body.owner === 'string' && body.owner.length > 0 ? body.owner : undefined,
      scope: Array.isArray(body.scope) ? body.scope.filter((s) => typeof s === 'string') : [],
      note: typeof body.note === 'string' ? body.note : '',
      createdAt: now,
      updatedAt: now,
      revision: 1,
    }
    if (tasks.some((t) => t.id === task.id)) return { ok: false, error: `duplicate task id: ${task.id}` }
    const at = Number.isInteger(body.at) ? Math.max(0, Math.min(body.at, tasks.length)) : tasks.length
    tasks.splice(at, 0, task)
    await writeTasks(root, board)
    return { ok: true }
  }

  const index = tasks.findIndex((t) => t.id === String(body.id ?? ''))
  if (op === 'reorder') {
    if (!Array.isArray(body.ids)) return { ok: false, error: 'ids is required' }
    const byId = new Map(tasks.map((t) => [t.id, t]))
    const next = []
    for (const id of body.ids) {
      const task = byId.get(String(id))
      if (task !== undefined) {
        next.push(task)
        byId.delete(String(id))
      }
    }
    for (const leftover of tasks) if (byId.has(leftover.id)) next.push(leftover)
    board.tasks = next
    await writeTasks(root, board)
    return { ok: true }
  }

  if (index < 0) return { ok: false, error: `unknown task: ${body.id}` }

  if (op === 'delete') {
    tasks.splice(index, 1)
    await writeTasks(root, board)
    return { ok: true }
  }

  if (op === 'move') {
    const delta = Number(body.delta ?? 0)
    const target = Math.max(0, Math.min(index + delta, tasks.length - 1))
    const [task] = tasks.splice(index, 1)
    tasks.splice(target, 0, task)
    await writeTasks(root, board)
    return { ok: true }
  }

  if (op === 'update') {
    const task = tasks[index]
    const patch = body.patch !== null && typeof body.patch === 'object' ? body.patch : {}
    if (typeof patch.title === 'string' && patch.title.trim().length > 0) task.title = patch.title.trim()
    if (STATUSES.has(patch.status)) task.status = patch.status
    if (patch.priority !== undefined) task.priority = clampPriority(patch.priority, task.priority)
    if (patch.owner !== undefined) task.owner = patch.owner === '' ? undefined : String(patch.owner)
    if (typeof patch.note === 'string') task.note = patch.note
    if (Array.isArray(patch.scope)) task.scope = patch.scope.filter((s) => typeof s === 'string')
    task.updatedAt = now
    task.revision = (Number(task.revision) || 0) + 1
    await writeTasks(root, board)
    return { ok: true, task }
  }

  return { ok: false, error: `unknown op: ${op}` }
}

/* ──────────────────────────── memory and skills ────────────────────────── */

/**
 * A slug that can never read as a path: no separator survives the substitution,
 * and leading dots or dashes are stripped so `..` cannot reach the front.
 */
function safeSlug(value) {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
  return /^[a-z0-9][a-z0-9._-]*$/.test(slug) ? slug : undefined
}

async function mutateMemory(root, body) {
  const op = String(body.op ?? '')
  const slug = safeSlug(body.name)
  if (slug === undefined) return { ok: false, error: 'a usable name is required' }
  const dir = memoryDir(root)
  await mkdir(dir, { recursive: true })
  const file = insideWorkspace(dir, `${slug}.md`)
  if (file === undefined) return { ok: false, error: 'name escapes the memory directory' }
  if (op === 'delete') {
    await rm(file, { force: true })
    return { ok: true }
  }
  if (op !== 'write') return { ok: false, error: `unknown op: ${op}` }
  const content = typeof body.content === 'string' ? body.content : ''
  await writeFile(file, content.endsWith('\n') ? content : `${content}\n`, 'utf8')
  return { ok: true }
}

async function mutateSkill(root, body) {
  if (String(body.op ?? '') !== 'create') return { ok: false, error: 'unsupported op' }
  const slug = safeSlug(body.name)
  if (slug === undefined) return { ok: false, error: 'a kebab-case name is required' }
  const description = String(body.description ?? '').trim()
  if (description.length === 0) return { ok: false, error: 'description is required' }
  const whenToUse = String(body.whenToUse ?? '').trim()
  const dir = insideWorkspace(root, join('.dsh', 'skills', slug))
  if (dir === undefined) return { ok: false, error: 'name escapes the workspace' }
  if (await exists(dir)) return { ok: false, error: `skill already exists: ${slug}` }
  await mkdir(dir, { recursive: true })
  const lines = ['---', `name: ${slug}`, `description: ${description}`]
  if (whenToUse.length > 0) lines.push(`whenToUse: ${whenToUse}`)
  lines.push('---', '', `# ${slug}`, '', String(body.body ?? '').trim(), '')
  await writeFile(join(dir, 'SKILL.md'), lines.join('\n'), 'utf8')
  return { ok: true, path: join(dir, 'SKILL.md') }
}

/* ───────────────────────────── prompt injection ────────────────────────── */

/**
 * Tell the agent its workspace carries a board and a memory. Registered on the
 * Host plane, so it applies to every Session; it renders nothing at all for a
 * workspace that has never used the console.
 *
 * The prompt service reads a context's `text` synchronously — it calls the
 * function and passes the value straight to `interpolate`, which calls
 * `String.prototype.indexOf` on it. An async renderer would hand that code a
 * promise and fail every turn, so the prompt path uses the sync readers below.
 */
function registerPromptContext(ctx) {
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt === undefined) return
  ctx.effect(() =>
    systemPrompt.context({
      name: 'longloop_workspace',
      order: 55,
      // `scope` is the assembling agent, so the digest names THAT session's
      // workspace rather than whatever directory the Host happens to run in.
      text: ({ scope }) => renderWorkspaceContext(ctx, scope?.id),
    }),
  )
}

/**
 * The run's **static** half: objective and the frozen contract.
 *
 * Registered as its own context, ahead of the dynamic digest, because it obeys
 * a different lifecycle rule (§7.3): it changes only when the contract does, so
 * it stays prefix-stable, and it must survive compaction by being re-injected
 * rather than summarised.
 */
function registerContractContext(ctx) {
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt === undefined) return
  ctx.effect(() =>
    systemPrompt.context({
      name: 'longloop_contract',
      order: 54,
      text: ({ scope }) => {
        const workspace = resolveWorkspace(ctx, undefined, scope?.id).workspace
        const run = readRunSync(longloopDir(workspace.path))
        if (run === undefined || run.state === 'aborted') return ''
        return renderContractBlock(run)
      },
    }),
  )
}

const digestCache = new Map()

/** How long one rendered workspace digest stays authoritative. */
const DIGEST_TTL_MS = 5000

/** Synchronous counterpart of {@link readTasks} for the prompt path. */
function readTasksSync(root) {
  const file = tasksFile(root)
  if (!existsSync(file)) return { version: 1, tasks: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed?.tasks)) return { version: 1, tasks: [] }
    return {
      version: 1,
      tasks: parsed.tasks.filter((t) => t !== null && typeof t === 'object' && typeof t.id === 'string'),
    }
  } catch {
    return { version: 1, tasks: [] }
  }
}

/** Synchronous counterpart of {@link readMemory} for the prompt path. */
function readMemorySync(root) {
  const dir = memoryDir(root)
  if (!existsSync(dir)) return []
  let names
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
  const out = []
  for (const file of names) {
    try {
      out.push({ name: file.slice(0, -3), content: readFileSync(join(dir, file), 'utf8') })
    } catch {
      /* an unreadable entry contributes nothing */
    }
  }
  return out
}

function renderWorkspaceContext(ctx, sessionId) {
  const root = resolveWorkspace(ctx, undefined, sessionId).workspace.path
  const cacheKey = root
  const cached = digestCache.get(cacheKey)
  if (cached !== undefined && Date.now() - cached.at < DIGEST_TTL_MS) return cached.text

  const board = readTasksSync(root)
  const memory = readMemorySync(root)
  const open = board.tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress' || t.status === 'blocked')
  if (open.length === 0 && memory.length === 0) {
    digestCache.set(cacheKey, { at: Date.now(), text: '' })
    return ''
  }

  const lines = ['<workspace_state>']
  if (open.length > 0) {
    lines.push('  <task_board path=".longloop/tasks.json">')
    for (const task of open.slice(0, 20)) {
      const mark = task.status === 'in_progress' ? '~' : task.status === 'blocked' ? '!' : ' '
      lines.push(`    [${mark}] ${task.id} P${task.priority} ${task.title}${task.owner ? ` @${task.owner}` : ''}`)
    }
    if (open.length > 20) lines.push(`    … 另有 ${open.length - 20} 条`)
    lines.push('  </task_board>')
  }
  if (memory.length > 0) {
    lines.push('  <workspace_memory dir=".longloop/memory">')
    for (const entry of memory.slice(0, 20)) {
      const first = entry.content.split('\n').find((l) => l.trim().length > 0) ?? ''
      lines.push(`    ${entry.name}.md — ${first.replace(/^#+\s*/, '').slice(0, 100)}`)
    }
    lines.push('  </workspace_memory>')
    lines.push('  这些文件是你的长期工作记忆：需要事实时先读它，学到结论后用 write/edit 更新它。')
  }
  lines.push('</workspace_state>')
  const text = lines.join('\n')
  digestCache.set(cacheKey, { at: Date.now(), text })
  return text
}

/* ─────────────────────── constraint pinning (§8.3) ─────────────────────── */

/**
 * Lift constraints out of incoming human messages and pin them.
 *
 * This is the cheap, always-on tier of the constraint whitelist. It runs on the
 * messages *entering* a step — which is exactly the set of things a human said —
 * so a constraint is captured while it is still verbatim, long before anything
 * is allowed to summarise it. Lost in Compaction measured ordinary compactors
 * at 17% retention of exactly these instructions.
 */
function installConstraintPinning(ctx) {
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const workspace = resolveWorkspace(ctx, undefined, payload?.agent?.id).workspace
      const dir = longloopDir(workspace.path)
      const run = await readRun(dir, exists)
      if (run !== undefined && run.state !== 'aborted') {
        const human = (payload?.messages ?? []).filter((message) => message?.source?.kind === 'user')
        const candidates = human.flatMap((message) =>
          extractConstraints(
            (message.content ?? [])
              .filter((block) => block?.type === 'text')
              .map((block) => block.text)
              .join('\n'),
          ),
        )
        if (candidates.length > 0) {
          const { constraints, added } = mergeConstraints(run.constraints ?? [], candidates, { round: run.round })
          if (added.length > 0) {
            await patchRun(dir, exists, { constraints })
            await appendLedger(dir, {
              kind: 'constraint-pinned',
              runId: run.id,
              round: run.round,
              constraints: added.map((c) => c.text),
            })
          }
        }
      }
    } catch (error) {
      // Pinning is best-effort: a failure here must not block the step.
      ctx.logger?.warn?.(`longloop-console: constraint pinning failed: ${error?.message ?? error}`)
    }
    return next()
  })
}

/* ─────────────────── the loop discipline prompt (§10.5) ────────────────── */

/**
 * A few hundred tokens of discipline, and not one rule more.
 *
 * §4.3 is the reason for the size: Claude 5's own engineering note records
 * deleting 80% of Claude Code's system prompt with no measurable regression.
 * Over-constraining costs reasoning. So every line here is one the run has
 * actually needed, and anything expressible as a check lives in the contract
 * instead.
 */
export const DEFAULT_DISCIPLINE = [
  '长任务纪律（仅在有活跃 run 时适用）：',
  '· <run_contract> 是"做完"的唯一判据；<pinned_constraints> 在本轮内一直有效。',
  '· 每轮只推进一件事，并在结束时说明做了什么、看到什么。',
  '· <decisions> 里记过的路径不要重试，已否决的方案不要重提。',
  '· 宣称完成不会结束运行——只有验收检查通过才会。',
  '· 卡住时按顺序换手段：换假设 → 重规划 → 交给全新视角 → 请人决策，最后才上报阻塞。',
].join('\n')

function registerDisciplineContext(ctx, config) {
  if (config?.discipline === false) return
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt === undefined) return
  const text = typeof config?.discipline === 'string' ? config.discipline : DEFAULT_DISCIPLINE
  ctx.effect(() =>
    systemPrompt.context({
      name: 'longloop_discipline',
      order: 56,
      // Disappears entirely when there is no run, so a workspace that never
      // used the console pays nothing for the plugin being installed.
      text: () => text,
    }),
  )
}

/* ─────────────── recovery: suspend instead of resuming (§8.6) ──────────── */

/**
 * A run that was `armed` when the process stopped becomes `suspended`.
 *
 * A6: nothing resumes work on its own. A restart means the world may have
 * changed underneath the run — files edited elsewhere, a service gone — so
 * continuing on the previous world model is exactly the accident this rule
 * exists to prevent. Suspension is *reversible* and costs a human one click;
 * auto-resuming costs a class of incidents that are hard to notice and hard to
 * undo.
 *
 * A run found already `suspended` is left alone: this must be idempotent, since
 * a plugin can be remounted without the process restarting.
 */
async function suspendArmedRuns(ctx) {
  const suspended = []
  for (const workspace of knownWorkspaces(ctx)) {
    const dir = longloopDir(workspace.path)
    try {
      const run = await readRun(dir, exists)
      if (run === undefined || run.state !== 'armed') continue
      // §8.6: a round that was dispatched but whose result never came back is
      // the one case where "did that side effect happen?" is genuinely unknown.
      // Say so explicitly, instead of letting a resumed run assume either way.
      const interrupted = run.inFlightRound ?? run.round
      const lostRoundId = roundIdFor(run, interrupted)
      await patchRun(dir, exists, {
        state: 'suspended',
        suspendedAt: Date.now(),
        suspendReason:
          run.inFlightRound === undefined
            ? '进程中断；重新授权后才会继续'
            : `进程中断，第 ${run.inFlightRound} 轮（${lostRoundId}）结果未知；核对状态后再重新授权`,
        unknownOutcomeRoundId: run.inFlightRound === undefined ? run.unknownOutcomeRoundId : lostRoundId,
      })
      await appendLedger(dir, { kind: 'run-suspended', runId: run.id, round: run.round })
      if (run.inFlightRound !== undefined) {
        await appendLedger(dir, {
          kind: 'round-outcome-unknown',
          runId: run.id,
          round: run.inFlightRound,
          roundId: lostRoundId,
          detail: `第 ${run.inFlightRound} 轮已派发但结果未返回：工具副作用是否发生未知，重新授权前请先核对工作区（§8.6）`,
        })
      }
      suspended.push({ workspace: workspace.path, runId: run.id, interrupted })
    } catch (error) {
      ctx.logger?.warn?.(`longloop-console: could not suspend runs in ${workspace.path}: ${error?.message ?? error}`)
    }
  }
  if (suspended.length > 0) {
    ctx.logger?.info?.(
      `longloop-console: ${suspended.length} 条运行因进程中断被挂起，等待人工重新授权（${suspended.map((s) => s.runId).join(', ')}）`,
    )
  }
  return suspended
}

/* ────────────────────────────── the driver ─────────────────────────────── */

/** One driver per Host context, so a second `apply()` cannot double-drive. */
const drivers = new WeakMap()
const driverFor = (ctx) => drivers.get(ctx)

/**
 * Wire same-session continuation.
 *
 * The driver is **off unless the composition says otherwise**: the patch inserts
 * `driver: false`, and arming a run is a separate, explicit act (A6 — nothing
 * resumes work on its own). Turning it on is one line in the patch.
 */
function installDriver(ctx, config) {
  const workspaceOf = () => resolveWorkspace(ctx, undefined, undefined).workspace.path
  const dirOf = () => longloopDir(workspaceOf())

  const driver = createRoundDriver({
    logger: ctx.logger,
    getRun: () => readRunSync(dirOf()),
    patchRun: (patch) => {
      const current = readRunSync(dirOf())
      if (current === undefined) return undefined
      const next = { ...current, ...patch, updatedAt: Date.now() }
      writeRunSync(dirOf(), next)
      return next
    },
    renderPrompt: (run) => {
      const tasks = readTasksSync(workspaceOf()).tasks
      const budget = budgetReport({
        round: run.round,
        maxRounds: run.maxRounds,
        startedAt: run.startedAt,
        pausedMs: run.pausedMs ?? 0,
        now: Date.now(),
        wallClockLimitMs: run.wallClockLimitMs,
        ladder: run.ladder,
      })
      const escalation = escalationFor(run.stalledRounds ?? 0)
      // §8.6: if a previous dispatch's outcome is unknown, that fact belongs at
      // the top of the round — before the objective, before the tasks.
      const recovery = renderRecoveryBlock(run)
      const body = renderRoundPrompt({ ...run, tasks }, budget, escalation)
      return createRoundMessage(recovery === undefined ? body : `${recovery}\n\n${body}`)
    },
    observeRound: async () => {},
    /**
     * §8.3 at the loop boundary: measure the context at every idle tick, compact
     * proactively when the run is due, and record the pass either way. Running
     * here (before the reservation) is what makes compaction land *before* the
     * round's prompt is assembled — the point of compacting early at all.
     */
    beforeRound: async (agent, run) => {
      try {
        const pass = await governBeforeRound(ctx, agent, run)
        await appendLedger(dirOf(), { kind: 'context', runId: run.id, round: run.round, ...pass })
      } catch (error) {
        ctx.logger?.warn?.(`longloop-console: context governance failed: ${error?.message ?? error}`)
      }
    },
    // §8.6: the dispatch fact. With it, "dispatched but never finished" is a
    // question the ledger answers, and a crash is a fact rather than a guess.
    onAdmit: async (roundId, round) => {
      const run = readRunSync(dirOf())
      if (run === undefined) return
      await appendLedger(dirOf(), { kind: 'round-dispatch', runId: run.id, round, roundId })
    },
    onTerminate: async (run, outcome) => {
      await patchRun(dirOf(), exists, { state: outcome.state, endedAt: Date.now(), endReason: outcome.message })
      await appendLedger(dirOf(), { kind: 'run-end', runId: run.id, ...outcome })
      await writeHandoff(ctx, workspaceOf(), outcome.state)
    },

    /**
     * L3's effect. The seed carries the contract, the pinned constraints, the
     * verdict, and the recorded dead ends — and nothing of the conversation the
     * run is trying to escape.
     */
    runFreshRound: (run, round) => {
      const workspace = workspaceOf()
      const board = readTasksSync(workspace)
      const escalation = escalationFor(run.stalledRounds ?? 0)
      const avoid = [
        ...(run.notes ?? []).filter((n) => n.kind === 'dead-end').map((n) => n.detail),
        ...(run.constraints ?? []).filter((c) => c.kind === 'prohibition').map((c) => c.text),
      ]
      const prompt = renderFreshRoundPrompt({
        run,
        round,
        avoid,
        verdict: run.lastVerdict,
        diagnosis: run.diagnosis,
        directive: escalation.directive,
      })
      return startFreshRound({
        subagents: ctx.get('subagents'),
        agents: ctx.get('agents'),
        run: { ...run, tasks: board.tasks },
        root: workspace,
        prompt,
        signal: undefined,
      })
    },

    recordFreshRound: async (run, round, outcome) => {
      await appendLedger(dirOf(), freshRoundLedgerEntry(run, round, outcome))
      // §6.1: a `fresh` round runs in a child session; that child is part of the
      // run's history and the session-log mirror must be able to reach it.
      const childId = outcome?.sessionId ?? outcome?.childSessionId
      if (typeof childId === 'string' && childId.length > 0) {
        const current = readRunSync(dirOf())
        if (current !== undefined && !(current.sessionIds ?? []).includes(childId)) {
          await patchRun(dirOf(), exists, { sessionIds: [...(current.sessionIds ?? []), childId] })
        }
      }
    },
  })

  driver.setEnabled(config?.driver === true)
  drivers.set(ctx, driver)

  ctx.on('agent/status', (payload) => driver.handleStatus(payload))
  ctx.on('agent/inbox/inserted', (payload) => driver.handleHumanInput(payload))
  ctx.on('agent/pre-step', (payload, next) => driver.handlePreStep(payload, next))

  ctx.logger?.info?.(
    `longloop-console: round driver ${driver.isEnabled() ? 'enabled' : 'disabled (set config.driver: true to enable)'}`,
  )
}

/** The round message, stamped so the driver can recognise its own work. */
function createRoundMessage(text) {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { ...PLUGIN_SOURCE },
    id: `longloop-round-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  }
}

/* ───────────────────────────── run operations ──────────────────────────── */

/** Synchronous run read for the driver and the prompt path. */
function readRunSync(longloopDir) {
  const file = join(longloopDir, 'run.json')
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && typeof parsed.id === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

function writeRunSync(longloopDir, run) {
  try {
    if (!existsSync(longloopDir)) mkdirSync(longloopDir, { recursive: true })
    writeFileSync(join(longloopDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`, 'utf8')
  } catch {
    /* best effort on the synchronous path; the route path reports errors */
  }
}

/** Per-workspace memory of the previous round's digests and counters. */
const roundMemory = new Map()

/**
 * Finish the round a Session just ran: measure it, score it, escalate, and
 * record it. This is the OBSERVE + DECIDE half of the five-beat protocol.
 */
async function finishRound(ctx, root, sessionId) {
  const dir = longloopDir(root)
  const run = await readRun(dir, exists)
  if (run === undefined) return undefined

  const board = await readTasks(root)
  const [digest, ledger] = await Promise.all([digestWorkspace(root), readLedger(dir, 500)])
  const boardDigest = digestBoard(board.tasks)
  const key = root
  const previous = roundMemory.get(key)

  const toolEntries = ledger.filter((entry) => entry.kind === 'tool')
  const readOnly = toolEntries.filter((entry) => entry.kind === 'tool' && entry.readOnly === true).length
  const observation = {
    workspaceUnchanged: previous !== undefined && previous.digest === digest.digest,
    boardUnchanged: previous !== undefined && previous.boardDigest === boardDigest,
    blockerRepeated: (run.lastBlockers ?? []).length > 0 && (run.lastBlockers ?? []).slice(-1)[0]?.repeated === true,
    testsUnchanged: false,
    toolCalls: toolEntries.length,
    readOnlyRatio: toolEntries.length === 0 ? 0 : readOnly / toolEntries.length,
  }
  roundMemory.set(key, { digest: digest.digest, boardDigest, at: Date.now() })

  // The light pass runs *before* scoring, because its result is a stall signal:
  // a frozen check that stopped passing is drift, and drift is what the ladder
  // exists to catch (§8.4 trigger 3 → §8.2 signals).
  await processVerify(ctx, root, run, observation).catch((error) =>
    ctx.logger?.warn?.(`longloop-console: process verification failed: ${error?.message ?? error}`),
  )

  const stall = scoreRound(run, observation)
  const escalation = escalationFor(stall.stalledRounds)
  const measurements = measureSession(ctx, run)
  const budget = budgetReport({
    round: run.round,
    maxRounds: run.maxRounds,
    startedAt: run.startedAt,
    pausedMs: run.pausedMs ?? 0,
    now: Date.now(),
    wallClockLimitMs: run.wallClockLimitMs,
    tokens: measurements.tokens,
    tokenLimit: run.tokenLimit,
    verifyTokens: run.verifyTokens,
    verifyTokenLimit: run.tokenLimit === undefined ? undefined : Math.round(run.tokenLimit * VERIFY_TOKEN_RATIO),
    ladder: run.ladder,
  })

  await patchRun(dir, exists, {
    stalledRounds: stall.stalledRounds,
    escalationLevel: escalation.level,
    lastObservation: observation,
    lastStallScore: stall.score,
  })
  await recordLedger(ctx, dir, run, {
    kind: 'round',
    runId: run.id,
    round: run.round,
    roundId: run.roundId ?? roundIdFor(run, run.round),
    stallScore: stall.score,
    signals: stall.signals.map((s) => s.signal),
    escalation: escalation.action,
    workspaceDigest: digest.digest,
    files: digest.files,
  })
  // §7.2's OBSERVE beat, as a durable fact: what the round did, whether it
  // stalled, and how much context room the next round has.
  const health = contextReport(ctx, run).health
  // §8.6: the round that was unknown has now been followed by a completed one, so
  // the state it warned about has been reconciled. Clearing it here (rather than
  // on resume) keeps the warning in front of the model for exactly one round.
  if (run.unknownOutcomeRoundId !== undefined && run.unknownOutcomeRoundId !== run.roundId) {
    await patchRun(dir, exists, { unknownOutcomeRoundId: undefined })
  }
  const roundEvent = {
    runId: run.id,
    round: run.round,
    roundId: run.roundId ?? roundIdFor(run, run.round),
    maxRounds: run.maxRounds,
    stallScore: stall.score,
    stalledRounds: stall.stalledRounds,
    signals: stall.signals.map((s) => s.signal),
    escalation: { level: escalation.level, action: escalation.action, directive: escalation.directive },
    context: { band: health.band, ratio: health.ratio, health: health.health, measured: health.measured === true },
    tasks: board.tasks.length,
  }
  // No `undefined` keys: `session.append` rejects a non-lossless payload, and a
  // dropped field must never cost the whole event.
  if (run.lastProcessVerdict?.round === run.round) {
    roundEvent.processVerify = { status: String(run.lastProcessVerdict.status ?? '') }
  }
  emitLongloop(ctx, run, LONGLOOP_EVENT.round, roundEvent)
  if (escalation.level > 0 && escalation.level !== (run.escalationLevel ?? 0)) {
    emitLongloop(ctx, run, LONGLOOP_EVENT.escalation, {
      runId: run.id,
      round: run.round,
      level: escalation.level,
      action: escalation.action,
      directive: String(escalation.directive ?? ''),
      stalledRounds: stall.stalledRounds,
    })
  }

  // L5 and budget exhaustion are terminal, and both produce a reason a human
  // can act on rather than a silent stop (§9.1).
  if (escalation.action === 'block') {
    await patchRun(dir, exists, {
      state: 'blocked',
      endedAt: Date.now(),
      endReason: `连续 ${stall.stalledRounds} 轮无进展`,
    })
    await writeHandoff(ctx, root, 'blocked')
    return { terminated: 'blocked', stall, escalation, budget }
  }
  if (budget.exhausted) {
    await patchRun(dir, exists, { state: 'exhausted', endedAt: Date.now(), endReason: `${budget.worst} 预算耗尽` })
    await writeHandoff(ctx, root, 'exhausted')
    return { terminated: 'exhausted', stall, escalation, budget }
  }

  // ── L3: change the means ────────────────────────────────────────────────
  // The escalation ladder names the action; this is where a run actually
  // changes how it works rather than how hard it tries. Switching to `fresh`
  // hands the next round to a child that never saw the polluted context, which
  // is the single most valuable rung (§8.2).
  if (escalation.action === 'switch-mode' && (run.mode ?? 'inline') !== 'fresh') {
    await patchRun(dir, exists, { mode: 'fresh', modeSwitchedAtRound: run.round })
    await appendLedger(dir, {
      kind: 'escalation',
      runId: run.id,
      round: run.round,
      action: 'switch-mode',
      detail: '连续无进展，下一轮交给全新会话执行',
    })
  }

  // ── L4: ask why ─────────────────────────────────────────────────────────
  // One diagnosis per stall streak: a diagnostician asked the same question
  // twice returns the same answer, and the answer is only useful once.
  if (escalation.action === 'diagnose' && (run.diagnosis?.round ?? -1) !== run.round) {
    const report = await deps_runDiagnosis(ctx, root, run, board.tasks, run.lastVerdict)
    if (report !== undefined) {
      await patchRun(dir, exists, { diagnosis: report })
      await appendLedger(dir, { kind: 'diagnosis', runId: run.id, round: run.round, blocker: report.blocker, nextAction: report.nextAction })
    } else {
      await appendLedger(dir, { kind: 'diagnosis-unavailable', runId: run.id, round: run.round })
    }
  }

  return { stall, escalation, budget }
}

/**
 * Add the evaluator's spend to the verification budget.
 *
 * Verification is measured against its own ceiling so the degradation ladder
 * cannot pay for execution by cutting the only thing that stands between the
 * run and a false claim (§8.4).
 */
async function chargeVerification(ctx, dir, run, childSessionId) {
  const meter = ctx.get('tokenMeter')
  const sessions = ctx.get('sessions')
  if (meter === undefined || sessions === undefined || childSessionId === undefined) return
  try {
    const session = sessions.get(childSessionId)
    if (session === undefined) return
    const spent = meter.measure(session).totalTokens
    if (!Number.isFinite(spent)) return
    const current = await readRun(dir, exists)
    if (current === undefined) return
    await patchRun(dir, exists, { verifyTokens: (current.verifyTokens ?? 0) + spent })
  } catch (error) {
    ctx.logger?.warn?.(`longloop-console: could not price verification: ${error?.message ?? error}`)
  }
}

/** Ask a read-only child why the run is stuck. Absent service ⇒ no diagnosis. */
async function deps_runDiagnosis(ctx, root, run, tasks, verdict) {
  return runDiagnosis({
    subagents: ctx.get('subagents'),
    agents: ctx.get('agents'),
    run,
    root,
    tasks,
    verdict,
    blockers: run.lastBlockers ?? [],
    signal: run.signal,
  })
}

/**
 * Write the handoff package for a terminal run.
 *
 * §9.1: never stop silently. This runs on every terminal transition, and a
 * failure to write it is logged rather than swallowed — a run that ended
 * without a handoff is exactly the outcome the rule forbids.
 */
async function writeHandoff(ctx, root, reason) {
  try {
    const dir = longloopDir(root)
    const run = await readRun(dir, exists)
    if (run === undefined) return undefined
    const [board, ledger] = await Promise.all([readTasks(root), readLedger(dir, 500)])
    const document = buildHandoff({ run, ledger, verdict: run.lastVerdict, tasks: board.tasks })
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${run.id}-handoff.md`), document, 'utf8')
    await patchRun(dir, exists, { handoff: { at: Date.now(), reason, path: join('.longloop', `${run.id}-handoff.md`) } })
    await appendLedger(dir, { kind: 'handoff', runId: run.id, reason, bytes: Buffer.byteLength(document, 'utf8') })
    emitLongloop(ctx, run, LONGLOOP_EVENT.handoff, {
      runId: run.id,
      state: String(run.state ?? ''),
      reason: String(reason ?? ''),
      bytes: Buffer.byteLength(document, 'utf8'),
      lines: document.split('\n').length,
      risks: (document.match(/^- \*\*/gm) ?? []).length,
      path: `.longloop/${run.id}-handoff.md`,
    })
    return document
  } catch (error) {
    ctx.logger?.warn?.(`longloop-console: could not write handoff: ${error?.message ?? error}`)
    return undefined
  }
}

/** The workspace a bare (agent-less) caller addresses. */
const workspaceOf = (ctx) => resolveWorkspace(ctx, undefined, undefined).workspace.path

/* ─────────────────────── durable facts live in two homes ───────────────── */

/**
 * Append one ledger fact to the file store **and** to the session log.
 *
 * §4 A1 makes the log the source of truth and `.longloop/ledger.jsonl` the
 * working copy: the file is what the model and the console read (and what `git`
 * can diff), the event is what an auditor can replay without trusting a file the
 * model may rewrite. `emitLongloop` never throws, so telemetry can cost a run
 * nothing.
 */
async function recordLedger(ctx, dir, run, entry) {
  await appendLedger(dir, entry)
  emitLongloop(ctx, run, LONGLOOP_EVENT.ledger, ledgerEventData(run, entry))
}

/** Mirror one run state change into the session log. */
function emitRunState(ctx, run, extra = {}) {
  emitLongloop(ctx, run, LONGLOOP_EVENT.run, runEventData(run, extra))
}

/* ───────────────── §8.4 契约冻结：the guard at the tool boundary ─────────── */

/** The frozen paths a run carries, from the contract or the summary shape. */
function readFrozen(run) {
  const list = run?.contract?.frozenPaths ?? run?.frozenPaths ?? []
  return Array.isArray(list)
    ? list.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    : []
}

/**
 * The executor may not edit the files that decide whether it is done.
 *
 * ExecCritic's ablation is the whole argument: the same repair agent scores
 * 61.2% with no test, 57.3% when it *writes its own test* — patch and test share
 * their misconceptions and agree with each other. Freezing the checks in the
 * contract is half the constraint; this guard is the other half, because a
 * frozen check whose file the executor can rewrite is not frozen.
 *
 * Registered globally but keyed on the calling agent's workspace, so one
 * deployment can hold a frozen run in one workspace and normal work in another.
 * Fails **open** on its own errors: a guard that throws denies every tool call
 * in the process; a missed freeze costs one run, a broken guard costs the
 * session.
 */
function installFrozenGuard(ctx) {
  const tools = ctx.get('tools')
  if (tools === undefined || typeof tools.guard !== 'function') return
  ctx.effect(() =>
    tools.guard((exec) => {
      try {
        const name = String(exec?.name ?? '')
        if (name !== 'bash' && WRITE_TOOLS[name] === undefined) return undefined
        const root = cwdOfSession(ctx, exec?.agent?.id)
        if (root === undefined) return undefined
        const run = readRunSync(longloopDir(root))
        if (run === undefined || !FROZEN_GUARD_STATES.includes(run.state)) return undefined
        const frozen = readFrozen(run)
        if (frozen.length === 0) return undefined
        return frozenViolation(exec.name, exec.arguments, frozen, root)
      } catch {
        return undefined
      }
    }),
  )
}

/* ─────────────────────────── the verification gate ─────────────────────── */

/** Per-context configuration, so a second `apply()` cannot read the first's. */
const runConfigs = new WeakMap()

/** §8.4's third trigger: rounds between process verifications (0 disables). */
const DEFAULT_PROCESS_VERIFY_EVERY = 10

function processVerifyEvery(ctx) {
  const value = runConfigs.get(ctx)?.processVerifyEveryRounds
  if (value === 0) return 0
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_PROCESS_VERIFY_EVERY
}

/** A `stat` is cheaper than a command; §8.4 says to verify the *easiest* ones. */
function checkCost(criterion) {
  return criterion.check?.expect?.fileExists !== undefined ? 0 : 1
}

/**
 * File access for the quarantine scan: Node's own, deliberately.
 *
 * The host's `fs` service (`ctx.get('fs')`) is a *sandbox-aware, session-scoped
 * view* — it exposes `resolve`/`stat` over a session's workspace, and it hides
 * the very entries this scan must detect. The quarantine question is about the
 * real directory on disk ("is there a `.git` here? does this symlink leave the
 * root?"), so it is asked of Node directly.
 */
const SCAN_FS = Object.freeze({ readdir, readlink })

/**
 * §8.4's third trigger: a light process pass every K rounds.
 *
 * The expensive failure in a long task is not "it never finished" — it is
 * "it ran 30 rounds before anyone noticed round 3's assumption was wrong".
 * Verifying the one or two cheapest frozen checks every K rounds moves the
 * correction point earlier, and its result feeds the stall score, so a check
 * that quietly stopped passing becomes an escalation rather than a surprise at
 * the end.
 *
 * Scope is deliberately narrow: this is *not* a verdict. It never completes a
 * run, and it is stored separately (`lastProcessVerdict`) so it can never be
 * mistaken for one in the console, the prompt, or the handoff.
 */
async function processVerify(ctx, root, run, observation) {
  const every = processVerifyEvery(ctx)
  if (every === 0 || run.round === 0 || run.round % every !== 0) return undefined

  const checkable = parseChecks(run.contract).filter((criterion) => criterion.check !== undefined)
  if (checkable.length === 0) return undefined
  const cheapest = [...checkable]
    .sort((left, right) => checkCost(left) - checkCost(right))
    .slice(0, 2)
    .map((criterion) => criterion.id)

  const dir = longloopDir(root)
  const quarantine = await scanVerificationEnv({ fs: SCAN_FS, root }).catch(() => undefined)
  if (quarantine !== undefined && quarantine.escapingSymlinks.length > 0) {
    await recordLedger(ctx, dir, run, {
      kind: 'process-verify-refused',
      runId: run.id,
      round: run.round,
      detail: '工作区含指向外部的 symlink，过程抽查被拒绝（§8.4）',
    })
    return undefined
  }

  const before = await digestWorkspace(root)
  let verdict
  try {
    verdict = await runChecks({
      shell: ctx.get('shell'),
      // The host service, not `SCAN_FS`: `fileExists` expectations go through the
      // sandbox-aware `resolve`/`stat` pair, exactly as a full verdict does.
      fs: ctx.get('fs'),
      root,
      run,
      scope: 'process',
      only: cheapest,
      quarantine,
      digest: () => before.digest,
    })
  } catch (error) {
    await recordLedger(ctx, dir, run, {
      kind: 'process-verify-failed',
      runId: run.id,
      round: run.round,
      detail: String(error?.message ?? error).slice(0, 200),
    })
    return undefined
  }

  await patchRun(dir, exists, { lastProcessVerdict: verdict, processVerifyRound: run.round })
  await recordLedger(ctx, dir, run, {
    kind: 'process-verify',
    runId: run.id,
    round: run.round,
    status: verdict.status,
    criteria: cheapest.join(','),
    counts: verdict.counts,
  })
  emitLongloop(ctx, run, LONGLOOP_EVENT.verdict, {
    runId: run.id,
    round: run.round,
    id: String(verdict.id ?? ''),
    status: String(verdict.status ?? ''),
    level: 'process',
    merged: '',
    counts: verdict.counts ?? {},
    completed: false,
    counterexamples: verdict.counterexamples.length,
    perCriterion: verdict.perCriterion.map((criterion) => ({
      id: String(criterion.id ?? ''),
      status: String(criterion.status ?? ''),
    })),
  })
  if (observation !== undefined) observation.processVerifyFailing = verdict.status !== 'pass'
  return verdict
}

/**
 * Submit a completion claim to the gate and record what came back.
 *
 * The order matters and mirrors §8.4: the cheap non-LLM gate runs first and may
 * hand the claim back to the model with a reason, before a single command is
 * executed. Only when the claim is auditable do the frozen checks run.
 *
 * `by: 'human'` is the escape hatch for criteria that no command can decide.
 * A person is a legitimate verifier — the gate exists to stop the *executor*
 * from certifying itself, not to pretend every criterion is mechanisable.
 */
async function verifyRun(ctx, root, options = {}) {
  const dir = longloopDir(root)
  const run = await readRun(dir, exists)
  if (run === undefined) return { ok: false, error: 'no run in this workspace' }

  const checks = parseChecks(run.contract)
  const verdicts = run.verdicts ?? []

  if (options.by === 'human') {
    const verdict = {
      id: `V-h${(verdicts.length + 1).toString(36)}`,
      at: Date.now(),
      round: run.round,
      level: 'human',
      status: 'pass',
      counts: { pass: checks.length, fail: 0, unknown: 0, requiredUnknown: 0 },
      perCriterion: checks.map((c) => ({ ...c, status: 'pass', method: '人工复核', note: `由 ${options.who ?? '人类'} 确认` })),
      counterexamples: [],
      nextActions: [],
      digestBefore: (await digestWorkspace(root)).digest,
    }
    await patchRun(dir, exists, { verdicts: [...verdicts, verdict].slice(-50), state: 'done', endedAt: Date.now(), endReason: '人工确认完成' })
    await recordLedger(ctx, dir, run, { kind: 'verdict', runId: run.id, round: run.round, status: 'pass', level: 'human' })
    emitLongloop(ctx, run, LONGLOOP_EVENT.verdict, {
      runId: run.id,
      round: run.round,
      id: '',
      status: 'pass',
      level: 'human',
      merged: '',
      counts: {},
      completed: true,
      counterexamples: 0,
      perCriterion: [],
    })
    await writeHandoff(ctx, root, 'done')
    return { ok: true, verdict, completed: true }
  }

  const claim = String(options.claim ?? '')
  const evidenceCount = Number(options.evidenceCount ?? 0)
  const challenges = run.challenges ?? 0
  const gate = evidenceGate({ checks, claim, evidenceCount })

  // The challenge is an escape-valved gate: after VERIFY_CHALLENGE_MAX the gate
  // stops asking and returns what it can actually determine.
  if (gate.verdict === 'challenge' && challenges < VERIFY_CHALLENGE_MAX) {
    await patchRun(dir, exists, { challenges: challenges + 1 })
    await appendLedger(dir, { kind: 'verify-challenged', runId: run.id, round: run.round, reasons: gate.reasons.map((r) => r.code) })
    return { ok: true, challenged: true, attempt: challenges + 1, max: VERIFY_CHALLENGE_MAX, reasons: gate.reasons }
  }

  const shell = ctx.get('shell')
  // Two filesystems, on purpose: the frozen checks and `fileExists` run through
  // the sandbox-aware host service, while the quarantine scan asks Node about
  // the real directory (see `SCAN_FS`).
  const checkFs = ctx.get('fs')
  // §10.2 `run_verify` may ask about a subset. A subset answer is a *statement
  // about those criteria only*: it can never be a completion verdict, so the
  // narrowed pass is routed to the process scope and cannot end the run.
  const only = Array.isArray(options.only) && options.only.length > 0 ? options.only.map(String) : undefined
  const scoped = only === undefined ? undefined : parseChecks(run.contract).filter((check) => only.includes(check.id))
  if (only !== undefined && (scoped === undefined || scoped.length === 0)) {
    return { ok: false, error: `run_verify 的 criteria 没匹配到任何标准：${only.join(', ')}` }
  }
  // Fingerprint the tree before and after: not to fail a check that writes cache
  // files, but to bind the evidence to the exact tree it was produced against.
  const before = await digestWorkspace(root)
  // §8.4 contamination control, before a single command runs: a tree that
  // escapes itself (or carries the answer in `.git`) is not a verification
  // environment, and pretending otherwise is how a run "passes".
  const quarantine = await scanVerificationEnv({ fs: SCAN_FS, root })
  if (quarantine.escapingSymlinks.length > 0) {
    const detail = quarantine.escapingSymlinks.map((entry) => `${entry.path} -> ${entry.target}`).join(' · ')
    await recordLedger(ctx, dir, run, {
      kind: 'verify-refused',
      runId: run.id,
      round: run.round,
      detail: `工作区含指向外部的 symlink：${detail}`,
    })
    return {
      ok: false,
      error: `验证被拒绝：工作区里有指向外部的 symlink（${detail}）。沙箱拷贝会跟随它逃逸，所以先处理它再验证（§8.4）。`,
    }
  }
  const verdict = await runChecks({
    shell,
    fs: checkFs,
    root,
    run,
    signal: options.signal,
    quarantine,
    digest: () => before.digest,
    ...(only === undefined ? {} : { only, scope: 'requested' }),
  })
  const after = await digestWorkspace(root)
  verdict.digestAfter = after.digest
  verdict.sideEffects = before.digest !== after.digest
  verdict.workspaceFiles = after.files

  // Layer 3 runs only when the contract asked for it, and only after layer 2
  // has produced something for it to judge. It returns `undefined` whenever it
  // cannot run — a missing evaluator must mean "less verification", never
  // "verified".
  let finalVerdict = verdict
  if (run.assurance === 'independent') {
    const independent = await independentEvaluate({
      subagents: ctx.get('subagents'),
      agents: ctx.get('agents'),
      run,
      root,
      checks,
      deterministic: verdict,
      signal: options.signal,
    })
    if (independent !== undefined) {
      finalVerdict = mergeVerdicts(verdict, independent)
      await chargeVerification(ctx, dir, run, independent.childSessionId)
    }
    else {
      await appendLedger(dir, {
        kind: 'verify-degraded',
        runId: run.id,
        round: run.round,
        reason: '独立评估器不可用，按确定性结果裁决',
      })
    }
  }

  // `partial` means every *required* criterion passed and only nice-to-have
  // ones are unresolved — which is what the contract asked for, so it completes.
  // `unknown` and `fail` do not. A narrowed request (`only`) completes nothing:
  // it never claimed to be about the whole contract.
  const completed = only === undefined && (finalVerdict.status === 'pass' || finalVerdict.status === 'partial')
  const settled = await patchRun(dir, exists, {
    verdicts: [...verdicts, finalVerdict].slice(-50),
    challenges: 0,
    ...(only === undefined ? { lastVerdict: finalVerdict } : { lastRequestedVerdict: finalVerdict }),
    ...(completed ? { state: 'done', endedAt: Date.now(), endReason: '验收标准全部通过' } : {}),
  })
  await recordLedger(ctx, dir, run, {
    kind: 'verdict',
    runId: run.id,
    round: run.round,
    status: finalVerdict.status,
    level: finalVerdict.level,
    counts: finalVerdict.counts,
  })
  emitLongloop(ctx, run, LONGLOOP_EVENT.verdict, {
    runId: run.id,
    round: run.round,
    id: String(finalVerdict.id ?? ''),
    status: String(finalVerdict.status ?? ''),
    level: String(finalVerdict.level ?? ''),
    merged: String(finalVerdict.merged ?? ''),
    counts: finalVerdict.counts ?? {},
    completed,
    counterexamples: (finalVerdict.counterexamples ?? []).length,
    perCriterion: (finalVerdict.perCriterion ?? []).map((criterion) => ({
      id: String(criterion.id ?? ''),
      status: String(criterion.status ?? ''),
    })),
  })
  if (completed) {
    emitRunState(ctx, settled, { reason: 'verified' })
    await writeHandoff(ctx, root, 'done')
  }
  return { ok: true, verdict: finalVerdict, completed }
}

/* ────────────────────────── run route handling ─────────────────────────── */

async function handleRun(ctx, root, body) {
  const dir = longloopDir(root)
  const op = String(body.op ?? 'status')

  if (op === 'status') {
    const run = await readRun(dir, exists)
    if (run === undefined) return { ok: true, run: undefined }
    const board = await readTasks(root)
    const { budget, escalation } = await assess(dir, exists, run, board.tasks, measureSession(ctx, run))
    return { ok: true, run: runSummary(run, budget, escalation), ledger: await readLedger(dir, 40) }
  }

  if (op === 'start') {
    const existing = await readRun(dir, exists)
    if (existing !== undefined && existing.state === 'armed') {
      return { ok: false, error: `已有一个进行中的运行：${existing.id}` }
    }
    const objective = String(body.objective ?? '').trim()
    if (objective.length === 0) return { ok: false, error: 'objective is required' }
    const run = createRun({
      objective,
      contract: body.contract,
      assurance: body.assurance,
      maxRounds: body.maxRounds,
      wallClockLimitMs: body.wallClockLimitMs,
      tokenLimit: body.tokenLimit,
      ownerSessionId: body.session,
      state: 'armed',
    })
    await writeRun(dir, run)
    // The contract's *shape* is recorded with the run: §12 needs to know how many
    // runs began with machine-decidable criteria, and that is not recoverable
    // from run.json once the run is gone.
    await recordLedger(ctx, dir, run, {
      kind: 'run-start',
      runId: run.id,
      objective: run.objective,
      acceptance: run.contract.acceptance.length,
      checkable: run.contract.acceptance.filter((criterion) => criterion.check !== undefined).length,
      frozen: run.contract.frozenPaths.length,
      contractWarnings: run.contractWarnings.length,
    })
    emitRunState(ctx, run, { reason: 'created' })
    roundMemory.delete(root)
    return { ok: true, run }
  }

  const run = await readRun(dir, exists)
  if (run === undefined) return { ok: false, error: 'no run in this workspace' }

  if (op === 'arm') {
    const next = await patchRun(dir, exists, {
      state: 'armed',
      // Resuming restarts the clock from now rather than replaying the pause:
      // the wall-clock budget measures work, not existence.
      startedAt: run.round === 0 ? Date.now() : run.startedAt,
      pausedMs: run.pausedMs ?? 0,
      pausedReason: undefined,
    })
    await recordLedger(ctx, dir, run, { kind: 'run-arm', runId: run.id, round: run.round })
    emitRunState(ctx, next, { reason: 'armed' })
    return { ok: true, run: next }
  }
  if (op === 'pause') {
    const next = await patchRun(dir, exists, { state: 'paused', pausedAt: Date.now(), pausedReason: body.reason ?? 'human' })
    await recordLedger(ctx, dir, run, { kind: 'run-pause', runId: run.id, round: run.round })
    emitRunState(ctx, next, { reason: 'paused' })
    return { ok: true, run: next }
  }
  if (op === 'stop') {
    const next = await patchRun(dir, exists, {
      state: 'aborted',
      endedAt: Date.now(),
      endReason: String(body.reason ?? '人手中止'),
    })
    await recordLedger(ctx, dir, run, { kind: 'run-stop', runId: run.id, round: run.round })
    emitRunState(ctx, next, { reason: 'aborted' })
    await writeHandoff(ctx, root, 'aborted')
    return { ok: true, run: next }
  }
  if (op === 'note') {
    const detail = String(body.detail ?? '').trim()
    if (detail.length === 0) return { ok: false, error: 'detail is required' }
    const notes = [...(run.notes ?? []), { at: Date.now(), round: run.round, kind: body.kind ?? 'note', detail }]
    const next = await patchRun(dir, exists, { notes: notes.slice(-100) })
    await recordLedger(ctx, dir, run, {
      kind: body.kind === 'dead-end' ? 'dead-end' : 'note',
      runId: run.id,
      round: run.round,
      detail,
    })
    return { ok: true, run: next }
  }
  if (op === 'handoff') {
    const file = join(dir, `${run.id}-handoff.md`)
    try {
      return { ok: true, document: await readFile(file, 'utf8') }
    } catch {
      return { ok: true, document: undefined }
    }
  }
  if (op === 'verify') {
    return verifyRun(ctx, root, { claim: body.claim, evidenceCount: body.evidenceCount, by: body.by, who: body.who })
  }
  if (op === 'assess') {
    const board = await readTasks(root)
    const finished = await finishRound(ctx, root, body.session)
    const refreshed = await readRun(dir, exists)
    const { budget, escalation } = await assess(dir, exists, refreshed, board.tasks, measureSession(ctx, refreshed))
    return { ok: true, run: runSummary(refreshed, budget, escalation), finished }
  }
  return { ok: false, error: `unknown op: ${op}` }
}

/* ─────────────────────────────── the tools ─────────────────────────────── */

/**
 * Compile one tool's authoring parameter map into the raw JSON Schema the tool
 * registry stores and forwards to the model provider verbatim.
 *
 * The registry asserts `output.schema` only; `parameters` rides
 * `tools[].function.parameters` untouched, so every shorthand still present in
 * the authoring map is a provider-level rejection of the WHOLE request. Both
 * ways it has bitten here:
 *
 *   Invalid schema for function 'run_block': schema must be a JSON Schema of
 *   'type: "object"', got 'type: null'.
 *     ← the root was still a bare property map, with no `type`.
 *   Invalid schema for function 'run_start': {"type":"object",…,"properties":
 *   {"statement":{"type":"string","required":true,…}}} is not valid under any of
 *   the schemas listed in the 'anyOf' keyword
 *     ← a NESTED map kept the per-property `required: true` marker, which the
 *       provider's validator reads as a leaf schema with `required: true`.
 *
 * The tool list rides every request, so one malformed schema fails every turn in
 * the session — not merely a call to that one tool. Hence: compile the shorthand
 * at every depth — `required: true` is hoisted into the enclosing object's
 * `required` array, and `properties`, `items`, `oneOf` arms, and an
 * object-valued `additionalProperties` are walked — and assert the result is raw
 * in the registration loop, where the failure costs one tool instead of a turn.
 *
 * An explicit `required: [...]` array is honoured as written and merged with the
 * hoisted markers, so an already-raw node can be mixed in freely.
 */
function objectSchema(properties) {
  return { type: 'object', ...compilePropertyMap(properties, undefined) }
}

/** One property map → `{ properties, required? }`, hoisting shorthand markers. */
function compilePropertyMap(map, declared) {
  const properties = {}
  const required = Array.isArray(declared) ? [...declared] : []
  for (const [name, spec] of Object.entries(map ?? {})) {
    const { required: isRequired, ...node } = spec ?? {}
    if (isRequired === true && !required.includes(name)) required.push(name)
    properties[name] = compileSchemaNode(node)
  }
  return required.length === 0 ? { properties } : { properties, required }
}

/** One schema node → the same node with every nested shorthand compiled. */
function compileSchemaNode(node) {
  if (Array.isArray(node)) return node.map(compileSchemaNode)
  if (node === null || typeof node !== 'object') return node
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    switch (key) {
      case 'required':
        // Only a property INSIDE a properties map may say `required: true`; a
        // boolean on a node itself is the mistake that reaches the provider.
        if (typeof value === 'boolean') {
          throw new Error('`required: true` belongs on a property inside a properties map, not on a schema node')
        }
        out.required = value
        break
      case 'properties': {
        const compiled = compilePropertyMap(value, node.required)
        out.properties = compiled.properties
        if (compiled.required !== undefined) out.required = compiled.required
        break
      }
      case 'items':
        out.items = compileSchemaNode(value)
        break
      case 'oneOf':
        out.oneOf = Array.isArray(value) ? value.map(compileSchemaNode) : value
        break
      case 'additionalProperties':
        out.additionalProperties = value !== null && typeof value === 'object' ? compileSchemaNode(value) : value
        break
      default:
        out[key] = value
    }
  }
  return out
}

/** Path of the first authoring shorthand left in a compiled schema, if any. */
function findParameterShorthand(node, path = 'parameters') {
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      const found = findParameterShorthand(node[index], `${path}[${index}]`)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (node === null || typeof node !== 'object') return undefined
  for (const [key, value] of Object.entries(node)) {
    if (key === 'required' && typeof value === 'boolean') return `${path}.required`
    const found = findParameterShorthand(value, `${path}.${key}`)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Snapshot one tool result as lossless JSON.
 *
 * dsh validates every tool result with `snapshotJsonValue` and fails the call
 * with `INVALID_TOOL_OUTPUT` — "value is not lossless JSON" — when anything in
 * it is not lossless JSON. A single `undefined` object field is enough, and these
 * run summaries carry plenty of legitimately-absent ones (`endedAt`, `endReason`,
 * `lastVerdict`, `diagnosis`, `escalation`, …), so a run that exists at all makes
 * `run_status` fail instead of answering. Round-tripping through JSON drops
 * exactly the values JSON cannot carry — the same view the session log stores —
 * rather than failing the whole call.
 */
function lossless(value) {
  if (value === undefined) return undefined
  const text = JSON.stringify(value)
  return text === undefined ? undefined : JSON.parse(text)
}

/**
 * Model-facing run controls.
 *
 * Registered from the Host plane, which puts them in the global tool layer and
 * makes them visible to every Session. A production deployment that wants them
 * for one preset only should move these rows into that preset — the two-plane
 * rule in `docs/longloop-framework-design.md` §10.5 — but a workspace console
 * with no way for the model to drive it would only be a viewer.
 *
 * Every registration is guarded: a tool-shape mismatch must cost the tools, not
 * the console.
 */
function registerRunTools(ctx) {
  const tools = ctx.get('tools')
  if (tools === undefined) return

  const rootFor = (exec) => resolveWorkspace(ctx, undefined, exec?.agent?.id).workspace.path

  /** Turn one tool-supplied acceptance entry into the frozen contract shape. */
  const toCriterion = (entry) => {
    const criterion = { statement: String(entry?.statement ?? '').trim(), weight: entry?.weight }
    if (typeof entry?.command === 'string' && entry.command.trim().length > 0) {
      let expect = { exitCode: 0 }
      if (Number.isInteger(entry.expect_exit_code)) expect = { exitCode: entry.expect_exit_code }
      else if (typeof entry.expect_stdout === 'string') expect = { stdoutMatches: entry.expect_stdout }
      else if (typeof entry.expect_file === 'string') expect = { fileExists: entry.expect_file }
      criterion.check = { command: entry.command.trim(), expect }
    }
    return criterion
  }
  const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

  const definitions = [
    {
      name: 'run_start',
      description:
        'Start a long-running run in this workspace: an objective plus the acceptance criteria that will decide whether it is done. Use it when a task will outlive one turn and needs budget, progress tracking, and verification. Only one run may be active per workspace.',
      parameters: objectSchema({
        objective: { type: 'string', required: true, description: 'What this run must achieve, in one sentence.' },
        deliverable: { type: 'string', description: 'The artifact a human will receive.' },
        acceptance: {
          type: 'array',
          description:
            'Statements that decide completion. Give each one a `command` when a command can decide it — only criteria with a command can be machine-verified, and the executor may never add or edit one afterwards.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              statement: { type: 'string', required: true, description: 'What must hold, in one sentence.' },
              command: { type: 'string', description: 'Command run in the workspace to decide this criterion.' },
              expect_exit_code: { type: 'number', description: 'Expected exit code. Defaults to 0.' },
              expect_stdout: { type: 'string', description: 'Regex the command output must match.' },
              expect_file: { type: 'string', description: 'Path that must exist after the run.' },
              weight: { type: 'string', enum: ['required', 'nice-to-have'], description: 'Defaults to required.' },
            },
          },
        },
        constraints: { type: 'array', items: { type: 'string' }, description: 'Hard rules that must not be broken.' },
        non_goals: { type: 'array', items: { type: 'string' }, description: 'What this run explicitly will not do.' },
        frozen_paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Workspace-relative files the acceptance checks live in (test files, fixtures). Freezing them here is what stops the run from rewriting its own judge: while the run is active, write/edit/bash may not touch them. Directories and globs are accepted.',
        },
        max_rounds: { type: 'number', description: 'Round cap. Defaults to 40.' },
        assurance: {
          type: 'string',
          enum: ['self', 'executable', 'independent'],
          description:
            'How hard completion must be proven. executable (default) runs the frozen checks; independent additionally asks a fresh-context evaluator that shares nothing with you.',
        },
      }),
      output: {
        schema: { type: 'object', properties: { run: { type: 'object' }, note: { type: 'string' } } },
        render: (_args, value) => text(value.note ?? value),
      },
      async execute(args, exec) {
        const root = rootFor(exec)
        const result = await handleRun(ctx, root, {
          op: 'start',
          objective: args.objective,
          contract: {
            deliverable: args.deliverable,
            acceptance: (args.acceptance ?? []).map((entry) =>
              typeof entry === 'string' ? { statement: entry } : toCriterion(entry),
            ),
            constraints: args.constraints,
            nonGoals: args.non_goals,
            frozenPaths: args.frozen_paths,
          },
          maxRounds: args.max_rounds,
          assurance: args.assurance,
          session: exec?.agent?.id,
        })
        if (result.ok === false) throw new Error(result.error)
        return { run: result.run, note: `已创建运行 ${result.run.id}，轮数上限 ${result.run.maxRounds}。` }
      },
    },
    {
      name: 'run_status',
      description:
        'Read the current run: objective, contract, round, budget pressure, stall streak, and the escalation level. Call it before deciding to keep going, and always before claiming completion.',
      parameters: objectSchema({}),
      output: {
        schema: { type: 'object', properties: { run: { type: 'object' }, budget: { type: 'object' } } },
        render: (_args, value) => text(value.summary ?? value),
      },
      async execute(_args, exec) {
        const result = await handleRun(ctx, rootFor(exec), { op: 'status' })
        if (result.run === undefined) return { summary: '当前工作区没有运行。用 run_start 创建一个。' }
        return { run: result.run, budget: result.run.budget, summary: renderStatusText(result.run) }
      },
    },
    {
      name: 'run_note',
      description:
        'Record a decision, an assumption, or a dead end in the run ledger. Dead ends matter most: they are what stops a later round from re-trying a rejected approach.',
      parameters: objectSchema({
        kind: { type: 'string', enum: ['decision', 'assumption', 'dead-end', 'note'], required: true },
        detail: { type: 'string', required: true, description: 'One sentence. For a dead end, say what was tried and why it failed.' },
      }),
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        render: (_args, value) => text(value.ok ? '已记录。' : '记录失败。'),
      },
      async execute(args, exec) {
        const result = await handleRun(ctx, rootFor(exec), { op: 'note', kind: args.kind, detail: args.detail })
        if (result.ok === false) throw new Error(result.error)
        return { ok: true }
      },
    },
    {
      name: 'run_finish',
      description:
        'Claim the run is complete. This does NOT end the run: it submits the claim for verification against the frozen acceptance criteria. Stating completion is never what completes it.',
      parameters: objectSchema({
        summary: { type: 'string', required: true, description: 'What was achieved and how you verified it.' },
        evidence: { type: 'array', items: { type: 'string' }, description: 'Paths or commands that demonstrate it.' },
      }),
      output: {
        schema: { type: 'object', properties: { submitted: { type: 'boolean' }, note: { type: 'string' } } },
        render: (_args, value) => text(value.note),
      },
      async execute(args, exec) {
        const root = rootFor(exec)
        const evidence = args.evidence ?? []
        await handleRun(ctx, root, { op: 'note', kind: 'claim', detail: args.summary })
        for (const item of evidence) {
          await handleRun(ctx, root, { op: 'note', kind: 'evidence', detail: String(item) })
        }
        exec?.concludeTurn?.()

        const result = await verifyRun(ctx, root, {
          claim: args.summary,
          evidenceCount: evidence.length,
        })
        if (result.ok === false) throw new Error(result.error)

        if (result.challenged === true) {
          return {
            submitted: false,
            challenged: true,
            note:
              `这份声明目前无法被审计（第 ${result.attempt}/${result.max} 次）：\n` +
              result.reasons.map((r) => `· ${r.detail}`).join('\n') +
              '\n请在下一轮补上可执行的检查或具体证据，再重新提交。',
          }
        }

        const verdict = result.verdict
        const lines = [
          `裁决 ${verdict.id} · ${verdict.status} · ${verdict.level}`,
          ...verdict.perCriterion.map((c) => `[${c.status}] ${c.id} ${c.statement} —— ${c.note}`),
        ]
        if (verdict.counterexamples.length > 0) {
          lines.push('反例：', ...verdict.counterexamples.map((e) => `· ${e}`))
        }
        return {
          submitted: true,
          completed: result.completed === true,
          verdict,
          note:
            lines.join('\n') +
            (result.completed === true
              ? '\n\n全部必达标准已通过，运行结束。'
              : '\n\n裁决不是"失败"，是"还没证明"。下一轮针对未通过项动手，不要重述结论。'),
        }
      },
    },
    {
      name: 'run_block',
      description:
        'Report that the run cannot proceed without a human decision. List the approaches already tried — a blocker without attempts is not a blocker, it is an early exit.',
      parameters: objectSchema({
        blocker: { type: 'string', required: true, description: 'The concrete condition blocking progress.' },
        attempted: { type: 'array', items: { type: 'string' }, description: 'Approaches already tried, in order.' },
      }),
      output: {
        schema: { type: 'object', properties: { reported: { type: 'boolean' }, note: { type: 'string' } } },
        render: (_args, value) => text(value.note),
      },
      async execute(args, exec) {
        const attempted = args.attempted ?? []
        if (attempted.length === 0) {
          throw new Error('run_block 需要列出已经尝试过的手段；尚未尝试就不能上报阻塞。')
        }
        const root = rootFor(exec)
        await handleRun(ctx, root, { op: 'note', kind: 'blocker', detail: args.blocker })
        const blocked = await patchRun(longloopDir(root), exists, {
          state: 'blocked',
          endedAt: Date.now(),
          endReason: args.blocker,
          lastBlockers: [...(readRunSync(longloopDir(root))?.lastBlockers ?? []), { at: Date.now(), blocker: args.blocker, attempted }],
        })
        emitRunState(ctx, blocked, { reason: 'blocked' })
        exec?.concludeTurn?.()
        return { reported: true, note: `已上报阻塞：${args.blocker}。运行已转入 blocked，等待人工处理。` }
      },
    },
    {
      name: 'run_plan',
      description:
        'Replace the run plan. Each task must say which acceptance criterion it addresses — a plan whose tasks address nothing is a list of intentions, and the run will be graded by the contract, not by the list.',
      parameters: objectSchema({
        tasks: {
          type: 'array',
          required: true,
          description: 'The whole plan, in order: passing it replaces the previous one.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable id (T1, T2…). Omit to have one minted.' },
              title: { type: 'string', required: true, description: 'One line: what this task finishes.' },
              addresses: {
                type: 'array',
                items: { type: 'string' },
                description: 'Criterion ids from the contract (C1, C2…) this task contributes to. At least one.',
              },
              priority: { type: 'number', description: 'P0 (highest) to P3. Defaults to P2.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'blocked', 'done'], description: 'Defaults to pending.' },
              note: { type: 'string', description: 'Anything the next round needs to know about this task.' },
            },
          },
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            planned: { type: 'number' },
            tasks: { type: 'array', items: { type: 'object' } },
            uncovered: { type: 'array', items: { type: 'string' } },
            note: { type: 'string' },
          },
        },
        render: (_args, value) => text(value.note),
      },
      async execute(args) {
        const root = workspaceOf(ctx)
        const dir = longloopDir(root)
        const run = readRunSync(dir)
        if (run === undefined) throw new Error('这个工作区还没有运行，先 run_start。')
        const requested = Array.isArray(args.tasks) ? args.tasks : []
        if (requested.length === 0) throw new Error('run_plan 需要一个非空的 tasks 数组；要清空计划请说明原因。')

        const criteria = parseChecks(run.contract)
        const ids = new Set(criteria.map((criterion) => criterion.id))
        const board = await readTasks(root)
        const tasks = []
        for (const entry of requested) {
          const title = String(entry?.title ?? '').trim()
          if (title.length === 0) throw new Error('每个 task 都需要 title。')
          const addresses = (Array.isArray(entry.addresses) ? entry.addresses : []).map(String)
          if (addresses.length === 0) {
            throw new Error(`任务「${title}」没有 addresses：每个任务至少要对应一条验收标准（${[...ids].join(', ') || '本运行没有可判定的标准'}）。`)
          }
          const unknown = addresses.filter((id) => !ids.has(id))
          if (unknown.length > 0) {
            throw new Error(`任务「${title}」引用了契约里不存在的标准：${unknown.join(', ')}。契约开工即冻结，标准不能新增。`)
          }
          const existing = tasks.find((task) => task.id === String(entry.id ?? '')) ?? board.tasks.find((task) => task.id === String(entry.id ?? ''))
          tasks.push({
            id: existing?.id ?? nextTaskId([...board.tasks, ...tasks]),
            title,
            status: STATUSES.has(entry.status) ? entry.status : 'pending',
            priority: clampPriority(entry.priority, 2),
            scope: addresses,
            note: typeof entry.note === 'string' ? entry.note : '',
            createdAt: existing?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
            revision: (existing?.revision ?? 0) + 1,
          })
        }
        await writeTasks(root, { version: 1, tasks })

        const covered = new Set(tasks.flatMap((task) => task.scope))
        const uncovered = criteria.filter((criterion) => !covered.has(criterion.id)).map((criterion) => criterion.id)
        await recordLedger(ctx, dir, run, {
          kind: 'plan',
          runId: run.id,
          round: run.round,
          tasks: tasks.length,
          covered: covered.size,
          uncovered: uncovered.length,
        })
        emitLongloop(ctx, run, LONGLOOP_EVENT.run, runEventData(run, { reason: 'plan-replaced', tasks: tasks.length }))
        return {
          planned: tasks.length,
          tasks: tasks.map((task) => ({ id: task.id, title: task.title, addresses: task.scope, priority: task.priority, status: task.status })),
          uncovered,
          note:
            `计划已替换：${tasks.length} 个任务，覆盖 ${covered.size}/${criteria.length} 条标准。` +
            (uncovered.length === 0
              ? '每条标准都有任务对应。'
              : `注意：${uncovered.join(', ')} 还没有任何任务对应 —— 验收时它们不会因为你做了别的而通过。`),
        }
      },
    },
    {
      name: 'run_verify',
      description:
        'Run the verification gate now. Without `criteria` it is the real gate: if every required criterion passes, the run completes. With `criteria` it validates only those ids and cannot complete the run — use it mid-flight to check one thing before building on it.',
      parameters: objectSchema({
        criteria: {
          type: 'array',
          items: { type: 'string' },
          description: 'Criterion ids to verify (C1, C2…). Omit to run the whole contract.',
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            level: { type: 'string' },
            completed: { type: 'boolean' },
            perCriterion: { type: 'array', items: { type: 'object' } },
            nextActions: { type: 'array', items: { type: 'string' } },
            note: { type: 'string' },
          },
        },
        render: (_args, value) => text(value.note),
      },
      async execute(args, exec) {
        const root = rootFor(exec)
        const result = await verifyRun(ctx, root, {
          only: Array.isArray(args.criteria) ? args.criteria : undefined,
          claim: 'run_verify 主动请求',
        })
        if (result.ok === false) throw new Error(result.error)
        if (result.challenged === true) {
          return {
            status: 'challenged',
            level: 'gate',
            completed: false,
            perCriterion: [],
            nextActions: result.reasons.map((reason) => reason.detail ?? reason.code),
            note: `验证门要求先补齐证据（第 ${result.attempt}/${result.max} 次）：\n` + result.reasons.map((reason) => `· ${reason.detail ?? reason.code}`).join('\n'),
          }
        }
        const verdict = result.verdict
        const lines = (verdict.perCriterion ?? []).map(
          (criterion) => `[${criterion.status}] ${criterion.id} ${criterion.statement} —— ${criterion.note}`,
        )
        return {
          status: String(verdict.status ?? 'unknown'),
          level: String(verdict.level ?? 'executable'),
          completed: result.completed === true,
          perCriterion: (verdict.perCriterion ?? []).map((criterion) => ({
            id: String(criterion.id ?? ''),
            status: String(criterion.status ?? ''),
            statement: String(criterion.statement ?? ''),
            note: String(criterion.note ?? ''),
          })),
          nextActions: (verdict.nextActions ?? []).map(String),
          note:
            `${verdict.id} · ${verdict.status} · ${verdict.level}\n${lines.join('\n')}\n` +
            (result.completed === true
              ? '全部必达标准通过，运行结束。'
              : '这不是完成：按上面的失败项继续，不要重述结论。'),
        }
      },
    },
    {
      name: 'run_handoff',
      description:
        'Write the handoff package for this run: objective, contract, what was verified, what was tried and rejected, open risks, and where things stand. Use it when you are about to stop — or when a human asks where the run stands.',
      parameters: objectSchema({}),
      output: {
        schema: { type: 'object', properties: { path: { type: 'string' }, bytes: { type: 'number' }, document: { type: 'string' } } },
        render: (_args, value) => text(value.document),
      },
      async execute(_args, exec) {
        const root = rootFor(exec)
        const document = await writeHandoff(ctx, root, 'on-demand')
        if (document === undefined) {
          throw new Error('写不出交接包：这个工作区没有运行，或者写入失败（见 host 日志）。')
        }
        const run = readRunSync(longloopDir(root))
        exec?.concludeTurn?.()
        return {
          path: join('.longloop', `${run?.id ?? 'run'}-handoff.md`),
          bytes: Buffer.byteLength(document, 'utf8'),
          document,
        }
      },
    },
  ]

  for (const definition of definitions) {
    try {
      // The registry validates `output.schema` but not `parameters`, and the
      // provider rejects the whole request over one malformed parameter schema.
      // Fail here instead, where the tool is the only thing lost.
      if (definition.parameters?.type !== 'object') {
        throw new Error(`parameters must be compiled to an object-rooted JSON Schema (see objectSchema)`)
      }
      const shorthand = findParameterShorthand(definition.parameters)
      if (shorthand !== undefined) {
        throw new Error(`parameters still carry authoring shorthand at ${shorthand}; compile them with objectSchema`)
      }
      // Results are snapshotted once, centrally: a run summary with an absent
      // optional field must not cost the call (see `lossless`).
      const execute = definition.execute
      ctx.effect(() =>
        tools.register({
          ...definition,
          execute: async (args, exec) => lossless(await execute(args, exec)),
        }),
      )
    } catch (error) {
      ctx.logger?.warn?.(`longloop-console: could not register ${definition.name}: ${error?.message ?? error}`)
    }
  }
}

/** One-line status for the model, cheap enough to call every round. */
function renderStatusText(run) {
  const lines = [
    `运行 ${run.id} · ${run.state} · 第 ${run.round}/${run.maxRounds} 轮 · 停滞 ${run.stalledRounds}`,
    `目标：${run.objective}`,
  ]
  if (run.budget !== undefined) {
    lines.push(
      `预算：${run.budget.dimensions.map((d) => `${d.name} ${(d.ratio * 100).toFixed(0)}%`).join(' · ')}` +
        (run.budget.rung === undefined ? '' : `（已进入 ${run.budget.rung} 档）`),
    )
  }
  if (run.escalation !== undefined && run.escalation.level > 0) {
    lines.push(`升级：L${run.escalation.level} ${run.escalation.action} —— ${run.escalation.directive}`)
  }
  return lines.join('\n')
}

/* ──────────────────────────────── the routes ───────────────────────────── */

export function apply(ctx, config) {
  runConfigs.set(ctx, config ?? {})
  // Projections first: a fact appended before the units exist folds lazily on
  // first read, but registering up front keeps the console's read path simple.
  registerLongloopProjections(ctx)
  registerPromptContext(ctx)
  registerContractContext(ctx)
  registerDisciplineContext(ctx, config)
  installConstraintPinning(ctx)
  installFrozenGuard(ctx)
  // Suspend before the driver exists: a run must never be observable as `armed`
  // by a driver that has not yet been told whether it may continue.
  void suspendArmedRuns(ctx)
  installDriver(ctx, config)
  registerRunTools(ctx)
  installRunCommands(ctx, {
    status: () => handleRun(ctx, workspaceOf(ctx), { op: 'status' }),
    // §12: computed from the ledger, so it describes what happened rather than
    // what the current state file happens to say.
    metrics: async () => {
      const ledger = await readLedger(longloopDir(workspaceOf(ctx)), 5000)
      return ledger.length === 0 ? undefined : renderMetrics(computeMetrics(ledger))
    },
    start: (objective, spec = {}) =>
      handleRun(ctx, workspaceOf(ctx), {
        op: 'start',
        objective,
        // The composer can express a real contract now (see `parseStartSpec`), so
        // a run created from the input box is the same run the console creates.
        contract: {
          deliverable: spec.deliverable,
          acceptance: spec.acceptance ?? [],
          frozenPaths: spec.frozenPaths ?? [],
        },
        maxRounds: spec.maxRounds,
      }),
    pause: () => handleRun(ctx, workspaceOf(ctx), { op: 'pause' }),
    resume: () => handleRun(ctx, workspaceOf(ctx), { op: 'arm' }),
    stop: (reason) => handleRun(ctx, workspaceOf(ctx), { op: 'stop', reason }),
    verify: () => handleRun(ctx, workspaceOf(ctx), { op: 'verify' }),
    handoff: async () => (await handleRun(ctx, workspaceOf(ctx), { op: 'handoff' })).document,
  })

  const guard = (req, res) => {
    const rejection = connectionOf(ctx)?.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          if (guard(req, res)) return
          const url = new URL(String(req.url), 'http://localhost')
          const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'
          try {
            if (route === '/state') {
              if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET')
              const state = await fullState(ctx, url.searchParams.get('workspace'), url.searchParams.get('session'))
              return sendJson(res, 200, { ...state, agents: readAgents(ctx) })
            }
            if (route === '/metrics') {
              if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET')
              const resolved = resolveWorkspace(ctx, url.searchParams.get('workspace'), url.searchParams.get('session'))
              if (resolved.error !== undefined) return sendJson(res, 404, { ok: false, error: resolved.error })
              const ledger = await readLedger(longloopDir(resolved.workspace.path), 5000)
              const report = computeMetrics(ledger)
              return sendJson(res, 200, { ok: true, report, text: renderMetrics(report) })
            }
            if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST')
            const body = await readBody(req)
            const resolved = resolveWorkspace(ctx, body.workspace, body.session)
            if (resolved.error !== undefined) {
              return sendJson(res, 404, { ok: false, error: resolved.error })
            }
            const root = resolved.workspace.path
            if (route === '/task') return sendJson(res, 200, await mutateTask(root, body))
            if (route === '/memory') {
              const result = await mutateMemory(root, body)
              return sendJson(res, result.ok ? 200 : 400, result)
            }
            if (route === '/skill') {
              const result = await mutateSkill(root, body)
              return sendJson(res, result.ok ? 200 : 400, result)
            }
            if (route === '/run') {
              const result = await handleRun(ctx, root, body)
              return sendJson(res, result.ok ? 200 : 400, result)
            }
            return sendJson(res, 404, { ok: false, error: `unknown route: ${route}` })
          } catch (error) {
            ctx.logger?.warn?.(`longloop-console: ${route} failed: ${error?.stack ?? error}`)
            return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      }),
    `longloop-console: ${ROUTE_PREFIX}`,
  )
}
