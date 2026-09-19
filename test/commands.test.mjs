/**
 * The `/run` command family.
 *
 * The command surface mirrors the console one-for-one, so these tests assert
 * both halves of that promise: every subcommand reaches the right operation,
 * and every rejection comes back as `kind: 'error'` rather than a silent
 * success.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildRunCommands, parseAcceptanceSpec, parseCommand, parseExpectationSpec, parseStartSpec, renderStatusLine } from '../src/commands.js'

/* ──────────────────────────────── parsing ──────────────────────────────── */

test('an empty invocation means status, not an error', () => {
  assert.deepEqual(parseCommand(undefined), { verb: 'status', rest: '' })
  assert.deepEqual(parseCommand('   '), { verb: 'status', rest: '' })
})

test('the verb is case-insensitive and the remainder keeps its text', () => {
  assert.deepEqual(parseCommand('PAUSE'), { verb: 'pause', rest: '' })
  assert.deepEqual(parseCommand('  start   把会话存储迁到 Redis  '), {
    verb: 'start',
    rest: '把会话存储迁到 Redis',
  })
})

test('a multi-word reason survives as the remainder', () => {
  assert.deepEqual(parseCommand('stop 方向错了，先别继续'), { verb: 'stop', rest: '方向错了，先别继续' })
})

/* ──────────────────────────────── status ───────────────────────────────── */

test('the status block reads at a glance and says what to do when there is no run', () => {
  assert.match(renderStatusLine(undefined), /没有运行/)
  assert.match(renderStatusLine(undefined), /\/longloop start/)
})

test('the status block names the mode, the assurance, and the budget', () => {
  const text = renderStatusLine({
    id: 'R-1',
    state: 'armed',
    round: 7,
    maxRounds: 40,
    mode: 'fresh',
    assurance: 'independent',
    objective: '迁移会话存储',
    budget: {
      dimensions: [
        { name: 'rounds', ratio: 0.18 },
        { name: 'wallClockMs', ratio: 0.4 },
      ],
      rung: 'disable-exploration',
    },
    stalledRounds: 2,
    escalation: { action: 'replan' },
    lastVerdict: {
      status: 'fail',
      level: 'executable',
      perCriterion: [{ id: 'C1', status: 'fail', statement: '测试全绿' }],
    },
  })
  assert.match(text, /R-1 · armed · 第 7\/40 轮 · 模式 fresh · 验证 independent/)
  assert.match(text, /目标：迁移会话存储/)
  assert.match(text, /rounds 18% · wallClockMs 40%/)
  assert.match(text, /降级档 disable-exploration/)
  assert.match(text, /停滞：连续 2 轮无进展 · replan/)
  assert.match(text, /最近裁决：fail（executable）/)
  assert.match(text, /\[fail\] C1 测试全绿/)
})

test('a terminal run shows why it stopped', () => {
  const text = renderStatusLine({ id: 'R-2', state: 'blocked', round: 5, maxRounds: 40, objective: 'x', endReason: '连续 5 轮无进展' })
  assert.match(text, /结束原因：连续 5 轮无进展/)
})

/* ────────────────────────────── dispatching ────────────────────────────── */

function harness(overrides = {}) {
  const calls = []
  const ops = {
    status: async () => (calls.push('status'), undefined),
    start: async (objective) => (calls.push(`start:${objective}`), { ok: true, run: { id: 'R-9' } }),
    pause: async () => (calls.push('pause'), { ok: true, run: { id: 'R-9' } }),
    resume: async () => (calls.push('resume'), { ok: true, run: { id: 'R-9' } }),
    stop: async (reason) => (calls.push(`stop:${reason}`), { ok: true, run: { id: 'R-9' } }),
    verify: async () => (calls.push('verify'), { ok: true, verdict: { id: 'V-1', status: 'pass', level: 'executable', perCriterion: [] }, completed: true }),
    handoff: async () => (calls.push('handoff'), '# Run R-9 交接包'),
    ...overrides,
  }
  const [definition] = buildRunCommands(ops)
  return { calls, definition, run: (rawInput) => definition.handler({ rawInput, agent: { id: 'sess-1' }, attachments: [], signal: undefined, commandId: 'c1' }) }
}

test('every subcommand reaches its operation', async () => {
  const h = harness()
  assert.equal((await h.run('status')).kind, 'success')
  assert.equal((await h.run('pause')).kind, 'success')
  assert.equal((await h.run('resume')).kind, 'success')
  assert.equal((await h.run('verify')).kind, 'success')
  assert.equal((await h.run('handoff')).kind, 'success')
  await h.run('start 迁移会话存储')
  await h.run('stop 方向错了')
  assert.deepEqual(h.calls, ['status', 'pause', 'resume', 'verify', 'handoff', 'start:迁移会话存储', 'stop:方向错了'])
})

test('a bare stop supplies a default reason rather than an empty one', async () => {
  const h = harness()
  await h.run('stop')
  assert.deepEqual(h.calls, ['stop:人手中止'])
})

test('an unknown subcommand is an error that shows the usage', async () => {
  const h = harness()
  const result = await h.run('frobnicate')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /未知子命令：frobnicate/)
  assert.match(result.text, /\/longloop start <目标>/)
})

test('start with no objective is refused before it reaches the run store', async () => {
  const h = harness()
  const result = await h.run('start')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /用法/)
  assert.deepEqual(h.calls, [], 'a malformed command must not touch state')
})

test('a start that warns about a missing contract does not pretend otherwise', async () => {
  const h = harness()
  const result = await h.run('start 随便做点什么')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已创建运行 R-9/)
  assert.match(result.text, /还没有验收标准/)
  assert.match(result.text, /无法被机器验证/)
})

test('a rejected operation surfaces the store error verbatim', async () => {
  const h = harness({ pause: async () => ({ ok: false, error: 'no run in this workspace' }) })
  const result = await h.run('pause')
  assert.equal(result.kind, 'error')
  assert.equal(result.text, 'no run in this workspace')
})

test('a challenged claim is reported as an error with its reasons', async () => {
  const h = harness({
    verify: async () => ({
      ok: true,
      challenged: true,
      attempt: 1,
      max: 2,
      reasons: [{ code: 'bare-claim', detail: '声明里用了完成措辞，但既没有登记证据，也没有可执行检查。' }],
    }),
  })
  const result = await h.run('verify')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /退回（第 1\/2 次）/)
  assert.match(result.text, /完成措辞/)
})

test('a completed verification says so; an incomplete one does not', async () => {
  const passed = harness()
  assert.match((await passed.run('verify')).text, /全部必达标准通过，运行结束/)

  const failed = harness({
    verify: async () => ({
      ok: true,
      completed: false,
      verdict: { id: 'V-2', status: 'fail', level: 'executable', perCriterion: [{ id: 'C1', status: 'fail', statement: '测试全绿', note: '退出码 1' }] },
    }),
  })
  const text = (await failed.run('verify')).text
  assert.match(text, /裁决 V-2 · fail · executable/)
  assert.doesNotMatch(text, /运行结束/)
})

test('handing off a run that has none is an error, not an empty document', async () => {
  const h = harness({ handoff: async () => undefined })
  const result = await h.run('handoff')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /还没有交接包/)
})

test('the command declares an input hint so the composer can guide the user', () => {
  const [definition] = buildRunCommands({})
  assert.equal(definition.name, 'longloop')
  assert.match(definition.input.hint, /start <目标>/)
  assert.ok(definition.description.length > 10)
})

test('parseStartSpec reads the whole contract off one command line', () => {
  const spec = parseStartSpec(
    '修好登录接口 --accept "测试全绿 | npm test | 退出码 0" --accept "README 有说明 |  | 文件 README.md" --freeze tests/auth.test.ts --freeze src/auth --rounds 25 --deliverable 补丁',
  )
  assert.equal(spec.objective, '修好登录接口')
  assert.equal(spec.deliverable, '补丁')
  assert.equal(spec.maxRounds, 25)
  assert.deepEqual(spec.frozenPaths, ['tests/auth.test.ts', 'src/auth'])
  assert.equal(spec.acceptance.length, 2)
  assert.equal(spec.acceptance[0].statement, '测试全绿')
  assert.deepEqual(spec.acceptance[0].check, { command: 'npm test', expect: { exitCode: 0 } })
  // A criterion with no command is kept, but carries no check — the reply says so.
  assert.equal(spec.acceptance[1].check, undefined)
  assert.deepEqual(spec.unknown, [])
})

test('parseStartSpec tolerates quoted, curly-quoted and bare multi-word values', () => {
  // A live run sent curly quotes (the composer is a rich-text editor): the old
  // pattern degraded the whole criterion to the single word `"README`.
  const curly = parseStartSpec(
    '把 README 补成使用说明 --accept “README 非空 | test -s packages/x/README.md | 退出码 0” --freeze packages/x/README.md',
  )
  assert.equal(curly.objective, '把 README 补成使用说明')
  assert.deepEqual(curly.acceptance[0].check, { command: 'test -s packages/x/README.md', expect: { exitCode: 0 } })
  assert.equal(curly.acceptance[0].statement, 'README 非空')
  assert.deepEqual(curly.frozenPaths, ['packages/x/README.md'])

  // No quotes at all: the value runs to the next flag.
  const bare = parseStartSpec('目标 --accept 测试全绿 | npm test | 退出码 0 --rounds 9')
  assert.equal(bare.acceptance.length, 1)
  assert.deepEqual(bare.acceptance[0].check, { command: 'npm test', expect: { exitCode: 0 } })
  assert.equal(bare.maxRounds, 9)
  assert.equal(bare.objective, '目标')
})

test('parseStartSpec keeps an objective that contains spaces, and flags typos', () => {
  const plain = parseStartSpec('把 packages/api 的登录接口修好')
  assert.equal(plain.objective, '把 packages/api 的登录接口修好')
  assert.deepEqual(plain.acceptance, [])
  assert.equal(plain.maxRounds, undefined)

  const typo = parseStartSpec('做点什么 --freze tests/a.test.ts --rounds 0')
  assert.equal(typo.objective, '做点什么')
  assert.deepEqual(typo.unknown, ['freze'])
  assert.deepEqual(typo.frozenPaths, [])
  // A nonsensical round count falls back to the default rather than to 0 rounds.
  assert.equal(typo.maxRounds, undefined)
})

test('parseExpectationSpec covers the three expectation forms', () => {
  assert.deepEqual(parseExpectationSpec('退出码 2'), { exitCode: 2 })
  assert.deepEqual(parseExpectationSpec('3'), { exitCode: 3 })
  // The canonical name the evaluator reads: `stdout` is accepted as an alias on
  // the way in, but what this parser writes is `stdoutMatches`.
  assert.deepEqual(parseExpectationSpec('stdout /ok$/'), { stdoutMatches: 'ok$' })
  assert.deepEqual(parseExpectationSpec('文件 dist/index.js'), { fileExists: 'dist/index.js' })
  // Free text is a stdout match: the reading a shell user already expects.
  assert.deepEqual(parseExpectationSpec('PASS'), { stdoutMatches: 'PASS' })
  assert.equal(parseExpectationSpec(''), undefined)
})

test('/longloop metrics asks the host for the §12 report', async () => {
  let called = 0
  const [definition] = buildRunCommands({
    metrics: async () => {
      called += 1
      return '运行 2 条 · 台账 12 条\n缺什么：没有对照组'
    },
  })
  const result = await definition.handler({ rawInput: 'metrics' })
  assert.equal(called, 1)
  assert.match(result.text, /运行 2 条/)
  // No facts at all: say that, rather than printing an empty report.
  const [empty] = buildRunCommands({ metrics: async () => undefined })
  assert.match((await empty.handler({ rawInput: 'metrics' })).text, /还没有任何运行记录/)
})

test('/longloop start report says which parts of the contract are missing', async () => {
  const [definition] = buildRunCommands({
    start: async () => ({ ok: true, run: { id: 'R-abc123' } }),
  })
  const bare = await definition.handler({ rawInput: 'start 只写目标' })
  assert.match(bare.text, /还没有验收标准/)

  const full = await definition.handler({
    rawInput: 'start 目标 --accept "测试全绿 | npm test" --freeze tests/a.ts',
  })
  assert.match(full.text, /1 条验收标准，其中 1 条可机器判定/)
  assert.match(full.text, /已冻结 1 个文件/)

  const typo = await definition.handler({ rawInput: 'start 目标 --accpet "x | y"' })
  assert.match(typo.text, /不认识的参数：--accpet/)
})
