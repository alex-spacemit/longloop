/**
 * End-to-end exercise of the LongLoop Console Host half.
 *
 * Drives the registered HTTP handler with synthetic request/response objects
 * against a real temporary workspace, so task CRUD, memory, skills, the agent
 * roster, and the prompt digest are all covered without a browser or a live
 * server. Run with: node --test packages/longloop/test/host.test.mjs
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../src/index.js'

let workspace
let handler
let hooks
let rejection

/**
 * One fake Host context. Everything the plugin reaches for is captured in the
 * returned `hooks` object, so two contexts in one process cannot share state
 * through module-level test variables.
 */
function makeCtx(options = {}) {
  const captured = { promptContext: undefined, contexts: [], handler: undefined, tools: [], commands: [], listeners: new Map(), shellCalls: [] }
  const root = options.root ?? workspace
  const ctx = {
    effect: (fn) => fn(),
    on: (event, listener) => {
      const list = captured.listeners.get(event) ?? []
      list.push(listener)
      captured.listeners.set(event, list)
      return () => {
        const current = captured.listeners.get(event) ?? []
        captured.listeners.set(event, current.filter((entry) => entry !== listener))
      }
    },
    logger: { warn: () => {}, info: () => {} },
    get: (key) => {
      if (key === 'tools') {
        return { register: (definition) => (captured.tools.push(definition), () => {}) }
      }
      if (key === 'commands') {
        return { register: (definition) => (captured.commands.push(definition), () => {}) }
      }
      if (key === 'workspaceRegistry') return { list: () => [{ id: 'w1', path: root, title: 'ws' }] }
      if (key === 'sessions') {
        return {
          list: () => [{ header: { cwd: root } }],
          get: (id) => (id === 'sess-1' ? { header: { cwd: root } } : undefined),
        }
      }
      if (key === 'systemPrompt') {
        return {
          context: (entry) => {
            captured.contexts.push(entry)
            if (entry.name === 'longloop_workspace') captured.promptContext = entry
            return () => {}
          },
        }
      }
      if (key === 'agentTeams' && options.teams === false) return undefined
      if (key === 'agentTeams') {
        return {
          tryMembership: () => ({ teamId: 'team-1' }),
          listMembers: () => [
            { name: 'lead', role: 'lead', status: 'running' },
            { name: 'reviewer', role: 'teammate', status: 'idle' },
          ],
          listTasks: () => [{ id: 'TT1', subject: '审计 diff', status: 'in_progress', ownerName: 'reviewer', ready: true, writeScopes: [], writeScopeWarnings: [] }],
        }
      }
      if (key === 'agents') return { roots: () => [{ id: 'sess-1' }] }
      if (key === 'shell') {
        return {
          resolve: (request) => ({
            ...request,
            workdir: request.workdir ?? root,
            timeoutMs: request.timeoutMs ?? 1000,
            stdoutMaxBytes: 65536,
          }),
          async run(spec) {
            captured.shellCalls.push(spec)
            const canned = (options.shellResults ?? {})[spec.command] ?? { exitCode: 0 }
            return {
              exitCode: canned.exitCode ?? 0,
              timedOut: canned.timedOut ?? false,
              aborted: false,
              timeoutMs: spec.timeoutMs,
              stdout: { text: canned.stdout ?? '', truncated: false },
              sandbox: canned.sandbox,
            }
          },
        }
      }
      if (key === 'subagents' && options.subagents === undefined) return undefined
      if (key === 'subagents') return options.subagents
      if (key === 'fs') {
        return {
          resolve: async (target, opts) => ({ path: target, cwd: opts?.cwd }),
          stat: async (target) => (options.existingFiles ?? []).includes(target.path) ? { size: 1 } : undefined,
        }
      }
      return undefined
    },
    webServer: {
      register: (route) => {
        captured.handler = route.handler
        return () => {}
      },
    },
    connection: { requestRejection: () => rejection },
    logger: { warn: () => {} },
  }
  return { ctx, hooks: captured }
}

/** Minimal ServerResponse stand-in capturing status, headers and body. */
function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    chunks: [],
    setHeader(name, value) {
      res.headers[name] = value
    },
    end(chunk) {
      if (chunk !== undefined) res.chunks.push(Buffer.from(chunk))
      res.body = Buffer.concat(res.chunks).toString('utf8')
      res.done = true
    },
  }
  res.json = () => {
    try {
      return JSON.parse(res.body)
    } catch {
      return undefined
    }
  }
  return res
}

function makeReq(method, path, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = path
  return req
}

/** The round prompt a composition-level context would render. */
async function hookRoundPrompt(hooksOf) {
  const { renderRoundPrompt } = await import('../src/governors.js')
  const run = JSON.parse(await readFile(join(workspace, '.longloop/run.json'), 'utf8'))
  return renderRoundPrompt(run, { worst: 'rounds', worstRatio: 0.1, dimensions: [] }, { level: 0, action: 'continue' })
}

async function call(method, path, body) {
  const res = makeRes()
  await handler(makeReq(method, path, body), res)
  return res
}

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'longloop-test-'))
  const made = makeCtx()
  hooks = made.hooks
  apply(made.ctx, { driver: false })
  handler = hooks.handler
  assert.ok(handler !== undefined, 'apply() must register the /longloop route')
})

after(async () => {
  await rm(workspace, { recursive: true, force: true })
})

/* ─────────────────────────────── the fence ─────────────────────────────── */

test('the trust fence runs before any work', async () => {
  rejection = 401
  const res = await call('GET', '/longloop/state')
  assert.equal(res.statusCode, 401)
  assert.equal(res.body, '')
  rejection = undefined
})

/* ─────────────────────────────── the board ─────────────────────────────── */

test('task board: create, priority, move, status, delete', async () => {
  const created = await call('POST', '/longloop/task', { op: 'create', title: '接入 Redis 会话存储', priority: 0 })
  assert.equal(created.statusCode, 200)
  assert.deepEqual(created.json(), { ok: true })

  await call('POST', '/longloop/task', { op: 'create', title: '补重启持久化脚本', priority: 2 })
  await call('POST', '/longloop/task', { op: 'create', title: '清理遗留 TODO', priority: 3 })

  let state = (await call('GET', '/longloop/state')).json()
  assert.equal(state.ok, true)
  assert.deepEqual(
    state.tasks.map((t) => [t.id, t.title, t.priority]),
    [
      ['T1', '接入 Redis 会话存储', 0],
      ['T2', '补重启持久化脚本', 2],
      ['T3', '清理遗留 TODO', 3],
    ],
    'ids are minted in order and priority is stored verbatim',
  )

  // Priority is a first-class field the console cycles with one click.
  await call('POST', '/longloop/task', { op: 'update', id: 'T3', patch: { priority: 0 } })
  // Manual reordering is separate from priority.
  await call('POST', '/longloop/task', { op: 'move', id: 'T3', delta: -1 })
  state = (await call('GET', '/longloop/state')).json()
  assert.deepEqual(state.tasks.map((t) => t.id), ['T1', 'T3', 'T2'])

  await call('POST', '/longloop/task', { op: 'update', id: 'T2', patch: { status: 'in_progress', owner: 'reviewer' } })
  state = (await call('GET', '/longloop/state')).json()
  const t2 = state.tasks.find((t) => t.id === 'T2')
  assert.equal(t2.status, 'in_progress')
  assert.equal(t2.owner, 'reviewer')

  await call('POST', '/longloop/task', { op: 'delete', id: 'T1' })
  state = (await call('GET', '/longloop/state')).json()
  assert.deepEqual(state.tasks.map((t) => t.id), ['T3', 'T2'])

  // `order` is normalised on every write, so the file a human opens is faithful.
  const onDisk = JSON.parse(await readFile(join(workspace, '.longloop/tasks.json'), 'utf8'))
  assert.deepEqual(onDisk.tasks.map((t) => t.order), [0, 1])
})

test('an explicit reorder takes the full ordering', async () => {
  await call('POST', '/longloop/task', { op: 'reorder', ids: ['T2', 'T3'] })
  const state = (await call('GET', '/longloop/state')).json()
  assert.deepEqual(state.tasks.map((t) => t.id), ['T2', 'T3'])
})

test('rejections are explicit, never silent', async () => {
  const empty = await call('POST', '/longloop/task', { op: 'create', title: '   ' })
  assert.deepEqual(empty.json(), { ok: false, error: 'title is required' })

  const unknown = await call('POST', '/longloop/task', { op: 'update', id: 'T999', patch: {} })
  assert.equal(unknown.json().ok, false)

  const badOp = await call('POST', '/longloop/task', { op: 'explode' })
  assert.equal(badOp.json().ok, false)

  const badWorkspace = await call('POST', '/longloop/task', { op: 'create', title: 'x', workspace: '/etc' })
  assert.equal(badWorkspace.statusCode, 404)
  assert.equal(badWorkspace.json().ok, false)
})

/* ──────────────────────────────── memory ───────────────────────────────── */

test('memory: write, read back, delete', async () => {
  const written = await call('POST', '/longloop/memory', {
    op: 'write',
    name: 'Redis Migration',
    content: '# Redis 迁移\n\n只用 ioredis，不新增依赖。\n',
  })
  assert.equal(written.json().ok, true, 'the name is slugified rather than rejected')

  let state = (await call('GET', '/longloop/state')).json()
  assert.deepEqual(state.memory.map((m) => m.name), ['redis-migration'])
  assert.match(state.memory[0].preview, /只用 ioredis/)

  const onDisk = await readFile(join(workspace, '.longloop/memory/redis-migration.md'), 'utf8')
  assert.match(onDisk, /^# Redis 迁移/)

  await call('POST', '/longloop/memory', { op: 'delete', name: 'redis-migration' })
  state = (await call('GET', '/longloop/state')).json()
  assert.deepEqual(state.memory, [])
})

test('memory names cannot escape the memory directory', async () => {
  const res = await call('POST', '/longloop/memory', { op: 'write', name: '../../escape', content: 'x' })
  assert.equal(res.json().ok, true)
  const state = (await call('GET', '/longloop/state')).json()
  assert.deepEqual(state.memory.map((m) => m.name), ['escape'], 'the separator is substituted and the leading dots stripped')

  const empty = await call('POST', '/longloop/memory', { op: 'write', name: '...', content: 'x' })
  assert.equal(empty.json().ok, false, 'a name that slugs to nothing is rejected, not guessed at')
})

test('a session id selects that session\u2019s workspace for the digest', async () => {
  const res = await call('GET', '/longloop/state?session=sess-1')
  assert.equal(res.json().workspace.path, workspace)
})

/* ──────────────────────────────── skills ───────────────────────────────── */

test('workspace skills land on the root the DSH provider already scans', async () => {
  const created = await call('POST', '/longloop/skill', {
    op: 'create',
    name: 'redis-migration',
    description: '把内存会话存储迁到 Redis 的固定流程',
    whenToUse: '当任务涉及会话存储迁移时',
    body: '1. 抽接口\n2. 实现 Redis 后端\n3. 跑重启持久化脚本',
  })
  assert.equal(created.json().ok, true)

  const skillFile = join(workspace, '.dsh/skills/redis-migration/SKILL.md')
  const content = await readFile(skillFile, 'utf8')
  assert.match(content, /^---\nname: redis-migration\ndescription: 把内存会话存储迁到 Redis 的固定流程\nwhenToUse: 当任务涉及会话存储迁移时\n---/)

  const state = (await call('GET', '/longloop/state')).json()
  assert.deepEqual(state.skills.map((s) => [s.name, s.kind]), [['redis-migration', 'bundle']])
  assert.equal(state.skills[0].description, '把内存会话存储迁到 Redis 的固定流程')

  const duplicate = await call('POST', '/longloop/skill', { op: 'create', name: 'redis-migration', description: 'x' })
  assert.equal(duplicate.json().ok, false)
})

/* ──────────────────────────── flat skill files ─────────────────────────── */

test('a flat <name>.md skill is discovered too', async () => {
  await mkdir(join(workspace, '.dsh/skills'), { recursive: true })
  await writeFile(join(workspace, '.dsh/skills/quick-note.md'), '---\nname: quick-note\ndescription: 一条扁平 skill\n---\n正文\n')
  const state = (await call('GET', '/longloop/state')).json()
  assert.deepEqual(state.skills.map((s) => s.name).sort(), ['quick-note', 'redis-migration'])
})

/* ─────────────────────────── multi-agent roster ────────────────────────── */

test('the roster and shared board come from the Host agentTeams service', async () => {
  const state = (await call('GET', '/longloop/state')).json()
  assert.equal(state.agents.available, true)
  assert.equal(state.agents.teams.length, 1)
  assert.deepEqual(state.agents.teams[0].members.map((m) => [m.name, m.status]), [
    ['lead', 'running'],
    ['reviewer', 'idle'],
  ])
  assert.deepEqual(state.agents.teams[0].tasks.map((t) => [t.id, t.ready]), [['TT1', true]])
})

test('an absent agentTeams service degrades instead of failing', async () => {
  const isolated = await mkdtemp(join(tmpdir(), 'longloop-solo-'))
  const made = makeCtx({ root: isolated, teams: false })
  apply(made.ctx, { driver: false })
  const res = makeRes()
  await made.hooks.handler(makeReq('GET', '/longloop/state'), res)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.agents.available, false)
  await rm(isolated, { recursive: true, force: true })
})

/* ──────────────────────────── prompt injection ─────────────────────────── */

test('the prompt digest lists the open board and the memory index, and is empty when unused', async () => {
  const promptContext = hooks.promptContext
  assert.ok(promptContext !== undefined, 'a prompt context must be registered')
  assert.equal(promptContext.name, 'longloop_workspace')

  // Give the digest something to describe, independently of earlier tests.
  await call('POST', '/longloop/task', { op: 'update', id: 'T2', patch: { status: 'in_progress' } })
  await call('POST', '/longloop/task', { op: 'create', title: '验证重启不丢会话', priority: 1 })
  await call('POST', '/longloop/memory', { op: 'write', name: 'redis-migration', content: '# Redis 迁移\n只用 ioredis。\n' })

  const text = await promptContext.text({ scope: { id: 'sess-1' } })
  assert.match(text, /<workspace_state>/)
  assert.match(text, /T2 P2 补重启持久化脚本/)
  assert.match(text, /\[~\] T2/, 'in-progress tasks are marked')
  assert.match(text, /\[ \] T1/, 'and pending ones are not')
  assert.match(text, /redis-migration\.md/, 'the memory index is named')
  assert.match(text, /长期工作记忆/)

  // With nothing on the board and no memory, the digest contributes no tokens.
  for (const task of (await call('GET', '/longloop/state')).json().tasks) {
    await call('POST', '/longloop/task', { op: 'delete', id: task.id })
  }
  for (const entry of (await call('GET', '/longloop/state')).json().memory) {
    await call('POST', '/longloop/memory', { op: 'delete', name: entry.name })
  }
  await new Promise((r) => setTimeout(r, 5100))
  assert.equal(await promptContext.text({ scope: { id: 'sess-1' } }), '')
})

/* ────────────────────────────── the run ────────────────────────────────── */

test('run: start freezes an objective and its acceptance criteria', async () => {
  const started = await call('POST', '/longloop/run', {
    op: 'start',
    objective: '把 packages/auth 的会话存储从内存改成 Redis',
    contract: {
      deliverable: '可合并的 PR',
      acceptance: [{ statement: 'pnpm test packages/auth 全绿' }, { statement: '无 TODO 遗留', weight: 'nice-to-have' }],
      constraints: ['不得修改 public API'],
      nonGoals: ['不做多实例一致性'],
    },
    maxRounds: 12,
  })
  const payload = started.json()
  assert.equal(payload.ok, true)
  assert.match(payload.run.id, /^R-[0-9a-f]{6}$/)
  assert.equal(payload.run.state, 'armed')
  assert.equal(payload.run.maxRounds, 12)
  assert.equal(payload.run.round, 0)

  const onDisk = JSON.parse(await readFile(join(workspace, '.longloop/run.json'), 'utf8'))
  assert.equal(onDisk.contract.acceptance.length, 2)
  assert.equal(onDisk.contract.acceptance[0].weight, 'required', 'a criterion defaults to required')
  assert.equal(onDisk.contract.acceptance[1].weight, 'nice-to-have')
  assert.deepEqual(onDisk.contract.constraints, ['不得修改 public API'])
})

test('run: a second active run is refused rather than silently replacing the first', async () => {
  const again = await call('POST', '/longloop/run', { op: 'start', objective: '另一个目标' })
  assert.equal(again.json().ok, false)
  assert.match(again.json().error, /已有一个进行中的运行/)
})

test('run: the contract reaches the model and the ledger reaches the console', async () => {
  const contract = hooks.contexts.find((c) => c.name === 'longloop_contract')
  assert.ok(contract !== undefined, 'a contract context must be registered')
  const text = await contract.text({ scope: { id: 'sess-1' } })
  assert.match(text, /<run_contract id="R-[0-9a-f]{6}" state="armed">/)
  assert.match(text, /把 packages\/auth 的会话存储从内存改成 Redis/)
  assert.match(text, /\[required\] pnpm test packages\/auth 全绿/)
  assert.match(text, /不得修改 public API/)

  const state = (await call('GET', '/longloop/state')).json()
  assert.equal(state.run.objective, '把 packages/auth 的会话存储从内存改成 Redis')
  assert.equal(state.run.budget.dimensions[0].name, 'rounds')
  assert.equal(state.run.escalation.level, 0, 'a fresh run is not escalated')
  assert.equal(state.driverEnabled, false, 'the driver stays off unless the composition asks for it')
  assert.ok(state.ledger.some((e) => e.kind === 'run-start'))
})

test('run: pause, arm, and stop are explicit transitions that reach the ledger', async () => {
  const paused = await call('POST', '/longloop/run', { op: 'pause', reason: 'human' })
  assert.equal(paused.json().run.state, 'paused')

  const armed = await call('POST', '/longloop/run', { op: 'arm' })
  assert.equal(armed.json().run.state, 'armed')

  const stopped = await call('POST', '/longloop/run', { op: 'stop', reason: '方向错了' })
  assert.equal(stopped.json().run.state, 'aborted')
  assert.equal(stopped.json().run.endReason, '方向错了')

  const ledger = (await call('GET', '/longloop/state')).json().ledger
  assert.deepEqual(
    ledger.filter((e) => e.kind.startsWith('run-')).map((e) => e.kind),
    ['run-start', 'run-pause', 'run-arm', 'run-stop'],
  )

  // An aborted run stops contributing to the prompt at all.
  const contract = hooks.contexts.find((c) => c.name === 'longloop_contract')
  assert.equal(await contract.text({ scope: { id: 'sess-1' } }), '')
})

/* ─────────────────────────── stall and escalation ──────────────────────── */

test('run: an unchanged workspace scores a stall, and the escalation climbs', async () => {
  await call('POST', '/longloop/run', { op: 'start', objective: '长时间无进展的任务' })

  const assessments = []
  for (let i = 0; i < 6; i += 1) {
    const res = await call('POST', '/longloop/run', { op: 'assess', session: 'sess-1' })
    assessments.push(res.json())
  }

  // The first assess has no previous digest, so it cannot yet claim "unchanged";
  // from the second on, nothing has moved and the stall detects it.
  assert.equal(assessments[0].run.stalledRounds, 0, 'a first round has nothing to compare against')
  assert.equal(assessments[1].run.stalledRounds, 1)
  assert.equal(assessments[2].run.stalledRounds, 2)
  assert.equal(assessments[2].run.escalation.action, 'replan')
  assert.equal(assessments[3].run.escalation.action, 'switch-mode')

  const final = assessments[5].run
  assert.equal(final.stalledRounds, 5)
  assert.equal(final.escalation.action, 'block')
  assert.equal(final.state, 'blocked', 'L5 is terminal and says why')
  assert.match(final.endReason ?? '', /连续 5 轮无进展/)

  const ledger = (await call('GET', '/longloop/state')).json().ledger
  const rounds = ledger.filter((e) => e.kind === 'round')
  assert.ok(rounds.length >= 5)
  assert.ok(rounds.at(-1).signals.includes('workspace-unchanged'))
  assert.ok(rounds.at(-1).signals.includes('board-unchanged'))
})

/* ──────────────────────────── the run tools ────────────────────────────── */

test('the run tools are registered, and a tool-shape change cannot kill the console', async () => {
  const names = hooks.tools.map((t) => t.name).sort()
  assert.deepEqual(names, ['run_block', 'run_evidence', 'run_finish', 'run_handoff', 'run_note', 'run_plan', 'run_start', 'run_status', 'run_verify'])

  for (const tool of hooks.tools) {
    assert.ok(tool.description.length > 40, `${tool.name} needs a description the model can act on`)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
  }
})

test('run_start through the tool surface lands in the same store as the console', async () => {
  await call('POST', '/longloop/run', { op: 'stop' })
  await rm(join(workspace, '.longloop/run.json'), { force: true })

  const tool = hooks.tools.find((t) => t.name === 'run_start')
  const value = await tool.execute(
    { objective: '由模型启动的运行', acceptance: ['测试全绿'], max_rounds: 9 },
    { agent: { id: 'sess-1' }, concludeTurn: () => {} },
  )
  assert.match(value.note, /已创建运行/)

  const state = (await call('GET', '/longloop/state')).json()
  assert.equal(state.run.objective, '由模型启动的运行')
  assert.equal(state.run.maxRounds, 9)
  assert.equal(state.run.contract.acceptance[0].statement, '测试全绿')
})

test('run_finish verifies, and an unverifiable claim certifies nothing', async () => {
  const tool = hooks.tools.find((t) => t.name === 'run_finish')
  let concluded = false
  const value = await tool.execute(
    { summary: '接口抽好了', evidence: ['src/auth/store.ts'] },
    { agent: { id: 'sess-1' }, concludeTurn: () => (concluded = true) },
  )
  assert.equal(concluded, true, 'the turn ends at this step rather than running on')
  assert.equal(value.submitted, true)
  assert.equal(value.completed, false)
  assert.equal(value.verdict.status, 'unknown', 'a criterion with no check cannot be certified')
  assert.match(value.note, /还没证明/)

  const state = (await call('GET', '/longloop/state')).json()
  assert.equal(state.run.state, 'armed', 'a claim is not a completion')
  assert.ok(state.run.notes.some((n) => n.kind === 'claim'))
})

/* ──────────────────────── the verification gate ────────────────────────── */

test('a run whose checks pass reaches done, and the verdict is durable', async () => {
  await call('POST', '/longloop/run', { op: 'stop' })
  await rm(join(workspace, '.longloop/run.json'), { force: true })

  const started = await call('POST', '/longloop/run', {
    op: 'start',
    objective: '让测试全绿',
    contract: {
      acceptance: [
        { statement: '单元测试全绿', check: { command: 'pnpm test', expect: { exitCode: 0 } } },
        { statement: '代码整洁', weight: 'nice-to-have' },
      ],
    },
  })
  assert.equal(started.json().ok, true)
  const onDisk = JSON.parse(await readFile(join(workspace, '.longloop/run.json'), 'utf8'))
  assert.equal(onDisk.contract.acceptance[0].check.command, 'pnpm test', 'the check is frozen with the contract')
  assert.equal(onDisk.contract.acceptance[1].check, undefined)

  const verified = await call('POST', '/longloop/run', { op: 'verify', claim: '测试通过', evidenceCount: 1 })
  const payload = verified.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.completed, true)
  assert.equal(payload.verdict.status, 'partial', 'the nice-to-have criterion is unknown, so it is not a clean pass')
  assert.equal(payload.verdict.perCriterion[0].status, 'pass')

  assert.deepEqual(hooks.shellCalls.map((c) => c.command), ['pnpm test'])
  assert.equal(hooks.shellCalls[0].sandboxPolicy.mode, 'workspace-write', 'checks are confined to the workspace')

  const state = (await call('GET', '/longloop/state')).json()
  assert.equal(state.run.lastVerdict.status, 'partial')
  assert.ok(state.run.lastVerdict.digestBefore, 'evidence is bound to the tree it was produced against')
  assert.ok(state.ledger.some((e) => e.kind === 'verdict' && e.status === 'partial'))
})

test('a failing check keeps the run armed and hands the gap to the next round', async () => {
  const failing = makeCtx({ shellResults: { 'pnpm test': { exitCode: 1, stdout: '3 failing' } } })
  apply(failing.ctx, { driver: false })
  const res = makeRes()
  await failing.hooks.handler(
    makeReq('POST', '/longloop/run', {
      op: 'verify',
      claim: '都好了',
      evidenceCount: 1,
      workspace: workspace,
    }),
    res,
  )
  const payload = JSON.parse(res.body)
  assert.equal(payload.verdict.status, 'fail')
  assert.equal(payload.completed, false)
  assert.match(payload.verdict.counterexamples[0], /3 failing/)

  // The gap reaches the next round as a first-class prompt section.
  const roundPrompt = await hookRoundPrompt(failing)
  assert.match(roundPrompt, /<last_verdict id="V-[^"]+" status="fail">/)
  assert.match(roundPrompt, /针对以上未通过项动手/)
})

test('the gate challenges a bare claim, then stops asking after the escape valve', async () => {
  await call('POST', '/longloop/run', { op: 'stop' })
  await rm(join(workspace, '.longloop/run.json'), { force: true })
  await call('POST', '/longloop/run', { op: 'start', objective: '没有检查的任务', contract: { acceptance: [{ statement: '看起来对' }] } })

  const first = (await call('POST', '/longloop/run', { op: 'verify', claim: 'I have completed everything', evidenceCount: 0 })).json()
  assert.equal(first.challenged, true)
  assert.equal(first.attempt, 1)
  assert.ok(first.reasons.some((r) => r.code === 'bare-claim'))

  const second = (await call('POST', '/longloop/run', { op: 'verify', claim: 'I have completed everything', evidenceCount: 0 })).json()
  assert.equal(second.challenged, true)
  assert.equal(second.attempt, 2)

  // The valve: a gate that can ask forever is a deadlock, so the third attempt
  // returns what can actually be determined.
  const third = (await call('POST', '/longloop/run', { op: 'verify', claim: 'I have completed everything', evidenceCount: 0 })).json()
  assert.equal(third.challenged, undefined)
  assert.equal(third.verdict.status, 'unknown')
  assert.equal(third.completed, false)
})

test('a human verdict is a legitimate certification for criteria no command can decide', async () => {
  const res = await call('POST', '/longloop/run', { op: 'verify', by: 'human', who: '控制台' })
  const payload = res.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.completed, true)
  assert.equal(payload.verdict.level, 'human')
  assert.equal(payload.verdict.perCriterion[0].status, 'pass')

  const state = (await call('GET', '/longloop/state')).json()
  assert.equal(state.run.state, 'done')
  assert.equal(state.run.endReason, '人工确认完成')
})

test('a criterion whose command fails to spawn is unknown, not failed', async () => {
  await call('POST', '/longloop/run', { op: 'stop' })
  await rm(join(workspace, '.longloop/run.json'), { force: true })
  await call('POST', '/longloop/run', {
    op: 'start',
    objective: '会崩的检查',
    contract: { acceptance: [{ statement: '跑得起来', check: { command: 'pnpm test' } }] },
  })

  const broken = makeCtx()
  broken.ctx.get = ((original) => (key) => {
    if (key !== 'shell') return original(key)
    return {
      resolve: (request) => ({ ...request, workdir: workspace, timeoutMs: 1000, stdoutMaxBytes: 1024 }),
      run: async () => {
        throw new Error('ENOENT: bash not found')
      },
    }
  })(broken.ctx.get)
  apply(broken.ctx, { driver: false })
  const res = makeRes()
  await broken.hooks.handler(makeReq('POST', '/longloop/run', { op: 'verify', workspace }), res)
  const payload = JSON.parse(res.body)
  assert.equal(payload.verdict.perCriterion[0].status, 'unknown')
  assert.match(payload.verdict.perCriterion[0].note, /无法执行/)
})

test('run_block refuses an empty attempt list and reports the blockers', async () => {
  const tool = hooks.tools.find((t) => t.name === 'run_block')
  await assert.rejects(
    () => tool.execute({ blocker: '缺 Redis 实例' }, { agent: { id: 'sess-1' } }),
    /已经尝试过的手段/,
  )

  const value = await tool.execute(
    { blocker: '缺 Redis 实例', attempted: ['本地起容器失败', '改连测试环境也没有权限'] },
    { agent: { id: 'sess-1' }, concludeTurn: () => {} },
  )
  assert.equal(value.reported, true)

  const state = (await call('GET', '/longloop/state')).json()
  assert.equal(state.run.state, 'blocked')
  assert.equal(state.run.lastBlockers.at(-1).attempted.length, 2)
})

test('run_note records a dead end that a later round can read', async () => {
  const tool = hooks.tools.find((t) => t.name === 'run_note')
  await tool.execute(
    { kind: 'dead-end', detail: '试过 msgpack 序列化：处理不了循环引用，放弃' },
    { agent: { id: 'sess-1' } },
  )
  const ledger = (await call('GET', '/longloop/state')).json().ledger
  assert.ok(ledger.some((e) => e.kind === 'dead-end' && /msgpack/.test(e.detail)))
})

/* ══════════════════════ layer 3 through the whole flow ═══════════════════ */

/** A subagents service whose evaluator returns whatever the test dictates. */
function stubEvaluator(judgement) {
  const started = []
  return {
    started,
    getProvider: () => ({ name: 'spawn' }),
    async start(name, request) {
      started.push({ name, request })
      return {
        id: 'eval-child-1',
        result: Promise.resolve({ stopReason: 'completed', output: [], structured: judgement }),
        dispose: async () => {},
      }
    },
  }
}

async function startIndependentRun(extra = {}) {
  await call('POST', '/longloop/run', { op: 'stop' })
  await rm(join(workspace, '.longloop/run.json'), { force: true })
  return call('POST', '/longloop/run', {
    op: 'start',
    objective: '三层验证的任务',
    assurance: 'independent',
    contract: {
      acceptance: [
        { statement: '单元测试全绿', check: { command: 'pnpm test', expect: { exitCode: 0 } } },
        { statement: '重启不丢会话' },
      ],
    },
    ...extra,
  })
}

test('an independent run asks a fresh-context evaluator and merges the two layers', async () => {
  const subagents = stubEvaluator({
    perCriterion: [
      { id: 'C1', status: 'pass', reasoning: '我自己跑了 pnpm test' },
      { id: 'C2', status: 'pass', reasoning: '读了 redis.ts，确认开了 AOF' },
    ],
    summary: '两条标准都核实过',
    confidence: 0.8,
  })
  const ctx = makeCtx({ subagents })
  apply(ctx.ctx, { driver: false })

  const started = await startIndependentRun()
  assert.equal(started.json().ok, true)

  const res = makeRes()
  await ctx.hooks.handler(makeReq('POST', '/longloop/run', { op: 'verify', workspace, claim: '迁移完成', evidenceCount: 1 }), res)
  const payload = JSON.parse(res.body)

  assert.equal(payload.verdict.level, 'independent')
  assert.equal(payload.verdict.merged, 'two-layer')
  assert.equal(payload.completed, true, 'C2 was unknown after layer 2 and the evaluator decided it')
  assert.deepEqual(payload.verdict.perCriterion.map((c) => c.status), ['pass', 'pass'])

  // The child got its own policy, never the caller's.
  const request = subagents.started[0].request
  assert.deepEqual(request.toolFilter, { allow: ['read', 'glob', 'grep'] })
  assert.equal(request.maxDepth, 1)
  assert.equal(typeof request.persona, 'string')
})

test('an evaluator that disputes a passing check overturns it, with the counterexample', async () => {
  const subagents = stubEvaluator({
    perCriterion: [
      { id: 'C1', status: 'fail', reasoning: '测试没有覆盖迁移路径', counterexample: 'test/auth.test.ts:12 只断言不抛异常' },
      { id: 'C2', status: 'unknown', reasoning: '缺少运行中的 Redis，无法确认' },
    ],
    summary: '证据不足',
  })
  const ctx = makeCtx({ subagents })
  apply(ctx.ctx, { driver: false })
  await startIndependentRun()

  const res = makeRes()
  await ctx.hooks.handler(makeReq('POST', '/longloop/run', { op: 'verify', workspace, claim: '做完了', evidenceCount: 1 }), res)
  const payload = JSON.parse(res.body)

  assert.equal(payload.verdict.perCriterion[0].status, 'fail')
  assert.match(payload.verdict.perCriterion[0].note, /独立评估器不同意/)
  assert.equal(payload.completed, false)
  assert.ok(payload.verdict.counterexamples.some((c) => /只断言不抛异常/.test(c)))
})

test('without a subagents service the run degrades to layer 2 and says so in the ledger', async () => {
  const ctx = makeCtx({ subagents: undefined })
  apply(ctx.ctx, { driver: false })
  await startIndependentRun()

  const res = makeRes()
  await ctx.hooks.handler(makeReq('POST', '/longloop/run', { op: 'verify', workspace, claim: '做完了', evidenceCount: 1 }), res)
  const payload = JSON.parse(res.body)

  assert.equal(payload.verdict.level, 'executable', 'a missing evaluator means less verification, never "verified"')
  assert.equal(payload.verdict.merged, undefined)

  const state = (await call('GET', '/longloop/state')).json()
  assert.ok(
    state.ledger.some((e) => e.kind === 'verify-degraded'),
    'the degradation is recorded rather than silent',
  )
})

test('assurance is stored on the run and defaults to executable', async () => {
  const independent = JSON.parse(await readFile(join(workspace, '.longloop/run.json'), 'utf8'))
  assert.equal(independent.assurance, 'independent')

  await call('POST', '/longloop/run', { op: 'stop' })
  await rm(join(workspace, '.longloop/run.json'), { force: true })
  await call('POST', '/longloop/run', { op: 'start', objective: '默认档' })
  const plain = JSON.parse(await readFile(join(workspace, '.longloop/run.json'), 'utf8'))
  assert.equal(plain.assurance, 'executable')
})


/* ═════════════════════ 模块补全：命令 / 恢复 / 交接 / 钉住 ═══════════════ */

test('/longloop is registered as a human command with a usage hint', () => {
  const names = hooks.commands.map((c) => c.name)
  assert.ok(names.includes('longloop'), `expected the run command, saw ${names.join(', ')}`)
  const runCommand = hooks.commands.find((c) => c.name === 'longloop')
  assert.match(runCommand.input.hint, /start <目标>/)
  assert.equal(typeof runCommand.handler, 'function')
})

test('a run left armed by a dead process is suspended, not resumed', async () => {
  // A second composition over the same workspace stands in for a restart.
  await call('POST', '/longloop/run', { op: 'stop' })
  await rm(join(workspace, '.longloop/run.json'), { force: true })
  await call('POST', '/longloop/run', { op: 'start', objective: '重启前正在跑的任务' })
  assert.equal((await call('GET', '/longloop/state')).json().run.state, 'armed')

  const revived = makeCtx()
  apply(revived.ctx, { driver: true })
  await new Promise((resolve) => setTimeout(resolve, 30))

  const state = (await call('GET', '/longloop/state')).json()
  assert.equal(state.run.state, 'suspended', 'A6: nothing resumes work on its own')
  assert.match(state.run.suspendReason, /进程中断/)
  assert.ok(state.ledger.some((e) => e.kind === 'run-suspended'))

  // And the human can put it back.
  const armed = await call('POST', '/longloop/run', { op: 'arm' })
  assert.equal(armed.json().run.state, 'armed')
})

test('stopping a run writes the handoff package', async () => {
  await call('POST', '/longloop/task', { op: 'create', title: '已完成的活', priority: 1 })
  const board = (await call('GET', '/longloop/state')).json()
  await call('POST', '/longloop/task', { op: 'update', id: board.tasks[0].id, patch: { status: 'done' } })

  await call('POST', '/longloop/run', { op: 'stop', reason: '方向错了' })

  const file = join(workspace, '.longloop', `${(await call('GET', '/longloop/state')).json().run.id}-handoff.md`)
  const document = await readFile(file, 'utf8')
  assert.match(document, /^# Run R-[0-9a-f]{6} 交接包/)
  assert.match(document, /\*\*终态\*\*: 人手中止 —— 方向错了/)
  assert.match(document, /重启前正在跑的任务/)
  assert.match(document, /## 已完成/)
  assert.match(document, /## 风险/)

  const state = (await call('GET', '/longloop/state')).json()
  assert.equal(state.run.handoff.reason, 'aborted')
  assert.ok(state.ledger.some((e) => e.kind === 'handoff'))
})

test('the handoff is readable through the command surface too', async () => {
  const runCommand = hooks.commands.find((c) => c.name === 'longloop')
  const result = await runCommand.handler({ rawInput: 'handoff', agent: { id: 'sess-1' }, attachments: [], signal: undefined })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /交接包/)
})

test('a human message pins the constraints it states, and pinning is idempotent', async () => {
  await call('POST', '/longloop/run', { op: 'stop' })
  await rm(join(workspace, '.longloop/run.json'), { force: true })
  await call('POST', '/longloop/run', { op: 'start', objective: '会收到中途约束的任务' })

  const preStep = hooks.listeners.get('agent/pre-step') ?? []
  assert.ok(preStep.length >= 1)
  const message = {
    role: 'user',
    id: 'm1',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '继续做。不要动 public API。改动 schema 之前先备份。' }],
  }
  const payload = { agent: { id: 'sess-1' }, messages: [message], turn: 1, step: 1, signal: undefined }
  const next = async () => ({ kind: 'enter', messages: [message] })

  for (const listener of preStep) await listener(payload, next)

  const state = (await call('GET', '/longloop/state')).json()
  const pinned = JSON.parse(await readFile(join(workspace, '.longloop/run.json'), 'utf8'))
  assert.ok(pinned.constraints.length >= 1, 'a constraint stated mid-run must be pinned while still verbatim')
  assert.ok(pinned.constraints.some((c) => /public API/.test(c.text)))

  const before = pinned.constraints.length
  for (const listener of preStep) await listener(payload, next)
  const again = JSON.parse(await readFile(join(workspace, '.longloop/run.json'), 'utf8'))
  assert.equal(again.constraints.length, before, 're-reading the same transcript must not grow the list')
  assert.ok(state.run !== undefined)
})

test('the discipline prompt is registered and disappears when no run is active', async () => {
  const discipline = hooks.contexts.find((c) => c.name === 'longloop_discipline')
  assert.ok(discipline !== undefined, 'a long task needs a few lines of discipline')
  const text = discipline.text({ scope: { id: 'sess-1' } })
  assert.match(text, /长任务纪律/)
  assert.match(text, /宣称完成不会结束运行/)
  assert.ok(text.length < 600, 'A8: the discipline is a few hundred tokens, not a rule book')
})

test('the discipline prompt can be switched off by configuration', async () => {
  const quiet = makeCtx()
  apply(quiet.ctx, { discipline: false })
  assert.equal(quiet.hooks.contexts.find((c) => c.name === 'longloop_discipline'), undefined)
})

test('verification gets its own budget dimension when tokens are budgeted', async () => {
  await call('POST', '/longloop/run', { op: 'stop' })
  await rm(join(workspace, '.longloop/run.json'), { force: true })
  await call('POST', '/longloop/run', { op: 'start', objective: '带 token 预算', tokenLimit: 100000 })
  const state = (await call('GET', '/longloop/state')).json()
  const names = state.run.budget.dimensions.map((d) => d.name)
  assert.ok(names.includes('verifyTokens'), `verification must not share the execution budget, saw ${names.join(', ')}`)
  const dimension = state.run.budget.dimensions.find((d) => d.name === 'verifyTokens')
  assert.equal(dimension.limit, 40000, '§8.4: verification may spend up to 40% of the execution budget')
})

/* ───────────────── §10.2: the three tools beyond the first five ─────────── */

/**
 * A second, local host: these tests need a shell fixture whose exit codes they
 * choose (`shellResults`), and they must not disturb the shared `hooks` other
 * tests use.
 */
/** A run of one's own: these tests share a workspace, so none may inherit state. */
async function startRun(byName, exec, overrides = {}) {
  await call('POST', '/longloop/run', { op: 'stop' }).catch(() => {})
  await rm(join(workspace, '.longloop/run.json'), { force: true })
  await byName('run_start').execute(
    {
      objective: overrides.objective ?? '把报告写出来',
      acceptance: overrides.acceptance ?? [
        { statement: '报告存在', command: 'test -f report.md' },
        { statement: '有摘要', command: 'grep -q 摘要 report.md' },
      ],
    },
    exec(),
  )
}

async function withTools(shellResults = {}) {
  const { ctx, hooks: local } = makeCtx({ root: workspace, shellResults })
  apply(ctx, { driver: false })
  const byName = (name) => {
    const found = local.tools.find((definition) => definition.name === name)
    assert.ok(found, `${name} is registered`)
    return found
  }
  return { hooks: local, byName, exec: (overrides = {}) => ({ agent: { id: 'sess-1' }, concludeTurn: () => {}, ...overrides }) }
}

test('run_plan replaces the plan and refuses tasks that address nothing', async () => {
  await call('POST', '/longloop/run', { op: 'stop' })
  await rm(join(workspace, '.longloop/run.json'), { force: true })
  await rm(join(workspace, '.longloop/tasks.json'), { force: true })
  const { byName, exec } = await withTools()
  await byName('run_start').execute(
    {
      objective: '把报告写出来',
      acceptance: [
        { statement: '报告存在', command: 'test -f report.md' },
        { statement: '有摘要', command: 'grep -q 摘要 report.md' },
      ],
      frozen_paths: ['report.md'],
      max_rounds: 6,
    },
    exec(),
  )

  const planned = await byName('run_plan').execute(
    {
      tasks: [
        { id: 'T1', title: '写报告', addresses: ['C1'], priority: 0 },
        { title: '写摘要', addresses: ['C2'], note: '两段就够' },
      ],
    },
    exec(),
  )
  assert.equal(planned.planned, 2)
  assert.deepEqual(planned.uncovered, [])
  assert.match(planned.note, /覆盖 2\/2 条标准/)

  await assert.rejects(() => byName('run_plan').execute({ tasks: [{ title: '随便做点什么' }] }, exec()), /没有 addresses/)
  await assert.rejects(
    () => byName('run_plan').execute({ tasks: [{ title: '多做一件事', addresses: ['C9'] }] }, exec()),
    /不存在的标准/,
  )

  // The board is the plan, criterion ids kept in `scope`, order normalised.
  const board = JSON.parse(await readFile(join(workspace, '.longloop/tasks.json'), 'utf8'))
  assert.equal(board.tasks.length, 2)
  assert.deepEqual(board.tasks[0].scope, ['C1'])
  assert.equal(board.tasks[1].note, '两段就够')

  const partial = await byName('run_plan').execute({ tasks: [{ id: 'T1', title: '只写报告', addresses: ['C1'] }] }, exec())
  assert.deepEqual(partial.uncovered, ['C2'])
  assert.match(partial.note, /C2 还没有任何任务对应/)
})

test('run_verify with criteria checks the subset and cannot complete the run', async () => {
  const { byName, exec, hooks: local } = await withTools({ 'test -f report.md': { exitCode: 1, stdout: 'missing' } })
  // A fresh mount suspends armed runs (§4.2 A6), so the run is created *after*
  // the mount, which is also how a real session gets one.
  await startRun(byName, exec)
  const value = await byName('run_verify').execute({ criteria: ['C1'] }, exec())
  assert.equal(value.status, 'fail', 'the fixture command exits 1')
  assert.equal(value.completed, false, 'a subset answer is never a completion')
  assert.deepEqual(value.perCriterion.map((criterion) => criterion.id), ['C1'])
  assert.equal(local.shellCalls.at(-1).command, 'test -f report.md')
  assert.match(value.note, /这不是完成/)

  const state = JSON.parse(await readFile(join(workspace, '.longloop/run.json'), 'utf8'))
  assert.equal(state.state, 'armed', 'a subset check leaves the run alone')
  assert.equal(state.lastVerdict, undefined, 'and does not touch the completion verdict')
  assert.equal(state.lastRequestedVerdict.status, 'fail')

  await assert.rejects(() => byName('run_verify').execute({ criteria: ['C7'] }, exec()), /没匹配到任何标准/)
})

test('a full run_verify runs every frozen check and may complete the run', async () => {
  const { byName, exec, hooks: local } = await withTools()
  await startRun(byName, exec)
  const value = await byName('run_verify').execute({}, exec())
  assert.equal(local.shellCalls.length, 2, 'both frozen checks ran')
  assert.equal(value.perCriterion.length, 2)
  assert.equal(value.completed, true, 'the fixture shell exits 0 for both')
  assert.match(value.note, /运行结束/)
  const state = JSON.parse(await readFile(join(workspace, '.longloop/run.json'), 'utf8'))
  assert.equal(state.state, 'done')
  assert.equal(state.lastVerdict.status, 'pass')
})

test('run_handoff writes the package, returns it, and concludes the turn', async () => {
  const { byName, exec } = await withTools()
  await startRun(byName, exec)
  let concluded = false
  const value = await byName('run_handoff').execute({}, exec({ concludeTurn: () => (concluded = true) }))
  assert.equal(concluded, true, 'the design marks run_handoff as concluding')
  assert.match(value.path, /\.longloop\/R-[0-9a-f]{6}-handoff\.md/)
  assert.ok(value.bytes > 100)
  const onDisk = await readFile(join(workspace, value.path), 'utf8')
  assert.equal(onDisk, value.document, 'the returned document is the file on disk')
  const current = JSON.parse(await readFile(join(workspace, '.longloop/run.json'), 'utf8'))
  assert.ok(
    onDisk.includes(current.objective),
    `the run's own objective (${current.objective}) travels into the handoff`,
  )
  assert.ok(onDisk.includes(current.id), 'and so does the run id')

  const state = JSON.parse(await readFile(join(workspace, '.longloop/run.json'), 'utf8'))
  assert.equal(state.handoff.reason, 'on-demand')
})

test('a run inherited from a dead process is suspended the first time anyone looks', async () => {
  // The mount-time scan only sees workspaces the host already knows, and at boot
  // that can be none of them; this is the lazy half of the same rule (§8.6/A6).
  //
  // Its own workspace on purpose: the other tests share one, and their
  // fire-and-forget mount passes would race this run's file.
  const own = await mkdtemp(join(tmpdir(), 'longloop-stale-'))
  try {
    const { ctx, hooks: local } = makeCtx({ root: own })
    apply(ctx, { driver: false })
    const runStart = local.tools.find((definition) => definition.name === 'run_start')
    await runStart.execute({ objective: '上一个进程留下的运行', acceptance: ['随便一条'] }, { agent: { id: 'sess-1' } })

    const file = join(own, '.longloop/run.json')
    const fresh = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(fresh.state, 'armed')
    // Backdate it: a run is inherited only when its last write predates this process.
    await writeFile(file, `${JSON.stringify({ ...fresh, updatedAt: 1000, startedAt: 1000 }, null, 2)}\n`, 'utf8')

    const res = makeRes()
    await local.handler({ method: 'GET', url: `http://x/longloop/state?workspace=${encodeURIComponent(own)}` }, res)
    const state = res.json()
    assert.equal(state.run.state, 'suspended')
    assert.match(state.run.suspendReason, /上一个进程|重新授权/)
    const ledger = await readFile(join(own, '.longloop/ledger.jsonl'), 'utf8')
    assert.match(ledger, /run-suspended/)
    // And it stays suspended: looking twice must not resurrect it.
    const again = makeRes()
    await local.handler({ method: 'GET', url: `http://x/longloop/state?workspace=${encodeURIComponent(own)}` }, again)
    assert.equal(again.json().run.state, 'suspended')
  } finally {
    await rm(own, { recursive: true, force: true })
  }
})

test('a handoff carries the latest verdict, including a requested one', async () => {
  // A run whose only evidence is a subset verdict must not hand off as
  // "no verdict this round": that would hide the check that just failed.
  const { byName, exec } = await withTools({ 'test -f report.md': { exitCode: 1, stdout: 'missing' } })
  await startRun(byName, exec)
  const run = JSON.parse(await readFile(join(workspace, '.longloop/run.json'), 'utf8'))
  await writeFile(
    join(workspace, '.longloop/run.json'),
    `${JSON.stringify(
      { ...run, state: 'armed', endedAt: undefined, endReason: undefined, lastVerdict: undefined, lastRequestedVerdict: undefined },
      null,
      2,
    )}\n`,
    'utf8',
  )
  await byName('run_verify').execute({ criteria: ['C1'] }, exec())
  const value = await byName('run_handoff').execute({}, exec())
  // The criterion that was checked carries its failure...
  assert.match(value.document, /\| C1 \| 报告存在 \| 必达 \| ❌ fail \| 退出码 1，期望 0 \|/)
  // ...and the one that was not checked says so rather than borrowing the news.
  assert.match(value.document, /\| C2 \| 有摘要 \| 必达 \| ⚠️ 未验证 \|/)
  assert.match(value.document, /\*\*终态\*\*: armed(?! —— 验收标准全部通过)/)
})

/* ────────────────────────── §10.2: the evidence registry ────────────────── */

test('run_evidence registers a hashed artifact and reports coverage', async () => {
  const { byName, exec } = await withTools()
  await startRun(byName, exec)
  await writeFile(join(workspace, 'report.md'), '结果表\n', 'utf8')

  const first = await byName('run_evidence').execute(
    { kind: 'file', pointer: 'report.md', addresses: ['C1'], note: '结果表就在这里' },
    exec(),
  )
  assert.equal(first.id, 'E1')
  assert.equal(first.hashOf, 'file', 'a real file is hashed by content')
  assert.deepEqual(first.coverage.covered, ['C1'])
  assert.deepEqual(first.coverage.missing, ['C2'])
  assert.match(first.note, /已登记证据 E1 · file · report\.md/)

  // The hash is of the content: same pointer, changed content, different hash.
  const record = JSON.parse(await readFile(join(workspace, '.longloop/run.json'), 'utf8')).evidence[0]
  await writeFile(join(workspace, 'report.md'), '结果表（改过）\n', 'utf8')
  const second = await byName('run_evidence').execute({ kind: 'file', pointer: 'report.md', addresses: ['C1'] }, exec())
  const records = JSON.parse(await readFile(join(workspace, '.longloop/run.json'), 'utf8')).evidence
  assert.equal(second.id, 'E2')
  assert.notEqual(records[1].hash, record.hash, 'the content digest follows the content')

  // A non-file pointer hashes the pointer, and says so.
  const third = await byName('run_evidence').execute({ kind: 'command', pointer: 'node --test', addresses: ['C2'] }, exec())
  assert.equal(third.hashOf, 'pointer')
  assert.deepEqual(third.coverage.missing, [])
})

test('run_evidence refuses unknown criteria and missing kinds', async () => {
  const { byName, exec } = await withTools()
  await startRun(byName, exec)
  await assert.rejects(() => byName('run_evidence').execute({ kind: 'file', pointer: 'x', addresses: ['C9'] }, exec()), /C9/)
  await assert.rejects(() => byName('run_evidence').execute({ kind: 'vibe', pointer: 'x' }, exec()), /kind/)
})

test('run_finish counts registered evidence and names ids it never saw', async () => {
  const { byName, exec, hooks: local } = await withTools()
  await startRun(byName, exec)
  await byName('run_evidence').execute({ kind: 'observation', pointer: '手工核对了输出', addresses: ['C1'] }, exec())
  const value = await byName('run_finish').execute(
    { summary: '写完了', evidence: ['E1', 'E7', 'src/auth/store.ts'] },
    exec(),
  )
  assert.equal(value.submitted, true)
  assert.match(value.note, /E7/)
  assert.match(value.note, /没有登记过/)

  const notes = JSON.parse(await readFile(join(workspace, '.longloop/run.json'), 'utf8')).notes ?? []
  assert.ok(notes.some((note) => note.detail.startsWith('E1 ')), 'the cited id travels into the claim notes')
  assert.ok(notes.some((note) => note.detail === 'src/auth/store.ts'), 'free text is still recorded')
  const ledger = await readFile(join(workspace, '.longloop/ledger.jsonl'), 'utf8')
  assert.match(ledger, /"kind":"evidence-missing"/)
  assert.ok(local.tools.some((definition) => definition.name === 'run_evidence'))
})
