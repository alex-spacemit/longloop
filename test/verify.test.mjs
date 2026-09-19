/**
 * The verification gate: expectations, verdicts, and the cheap gate that runs
 * before anything is executed.
 *
 * A fake shell stands in for `ctx.shell`, so the whole decision surface is
 * tested without spawning a process — and the interesting cases (timeout,
 * sandbox denial, spawn failure) are ones a real shell will not produce
 * on demand.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_CHECK_TIMEOUT_MS,
  EVALUATOR_PERSONA,
  EVALUATOR_SCHEMA,
  EVALUATOR_TOOL_ALLOW,
  INDEPENDENT_EVALUATOR_IMPLEMENTED,
  evidenceGate,
  independentEvaluate,
  mergeVerdicts,
  parseEvaluatorOutput,
  renderEvaluatorPrompt,
  evaluateExpect,
  parseChecks,
  renderVerdictPrompt,
  runChecks,
  summarizeVerdict,
} from '../src/verify.js'

/* ─────────────────────────── contract parsing ──────────────────────────── */

test('parseChecks numbers criteria, defaults the weight, and keeps only real checks', () => {
  const checks = parseChecks({
    acceptance: [
      { statement: '测试全绿', check: { command: 'pnpm test', expect: { exitCode: 0 } } },
      { statement: '无 TODO 遗留', weight: 'nice-to-have' },
      { statement: '空命令', check: { command: '' } },
    ],
  })
  assert.deepEqual(checks.map((c) => c.id), ['C1', 'C2', 'C3'])
  assert.equal(checks[0].weight, 'required')
  assert.equal(checks[0].check.command, 'pnpm test')
  assert.equal(checks[0].check.timeoutMs, DEFAULT_CHECK_TIMEOUT_MS)
  assert.equal(checks[1].check, undefined, 'a criterion without a check is still a criterion')
  assert.equal(checks[2].check, undefined, 'an empty command is not a check')
})

/* ──────────────────────── one expectation, evaluated ───────────────────── */

const ok = (stdout = '', exitCode = 0) => ({ exitCode, timedOut: false, aborted: false, timeoutMs: 1000, stdout: { text: stdout, truncated: false } })

test('an exit-code expectation passes and fails on the number, not the output', () => {
  assert.equal(evaluateExpect({ exitCode: 0 }, ok('anything')).status, 'pass')
  assert.equal(evaluateExpect({ exitCode: 2 }, ok('', 2)).status, 'pass')
  assert.equal(evaluateExpect({ exitCode: 0 }, ok('', 1)).status, 'fail')
})

test('a stdout expectation matches a regex against the output', () => {
  const expect = { stdoutMatches: '\\d+ passing' }
  assert.equal(evaluateExpect(expect, ok('  12 passing (3s)')).status, 'pass')
  assert.equal(evaluateExpect(expect, ok('  0 failing')).status, 'fail')
  assert.equal(evaluateExpect({ stdoutMatches: '([unclosed' }, ok('x')).status, 'unknown', 'a broken regex is unknown, never a pass')
})

test('a file expectation is decided by the stat, not by a command', () => {
  assert.equal(evaluateExpect({ fileExists: 'dist/app.js' }, { fileExists: true }).status, 'pass')
  assert.equal(evaluateExpect({ fileExists: 'dist/app.js' }, { fileExists: false }).status, 'fail')
  assert.equal(evaluateExpect({ fileExists: 'dist/app.js' }, {}).status, 'fail', 'an unreadable path is not existence')
})

test('an inconclusive run is unknown, never a pass and never a fail', () => {
  assert.equal(evaluateExpect({ exitCode: 0 }, { timedOut: true, timeoutMs: 5000 }).status, 'fail')
  assert.equal(evaluateExpect({ exitCode: 0 }, { aborted: true }).status, 'unknown')
  assert.equal(evaluateExpect({ exitCode: 0 }, { sandbox: { denied: true } }).status, 'unknown')
  assert.equal(evaluateExpect({ exitCode: 0 }, { spawnFailed: true, error: 'ENOENT' }).status, 'unknown')
})

/* ────────────────────────── rolling up a verdict ───────────────────────── */

const criterion = (status, weight = 'required') => ({ id: 'C1', statement: 'x', weight, status })

test('a required failure fails the verdict regardless of the rest', () => {
  const { status } = summarizeVerdict([criterion('pass'), criterion('fail'), criterion('pass', 'nice-to-have')])
  assert.equal(status, 'fail')
})

test('an unknown required criterion makes the verdict unknown, not partial', () => {
  assert.equal(summarizeVerdict([criterion('pass'), criterion('unknown')]).status, 'unknown')
  assert.equal(
    summarizeVerdict([criterion('pass'), criterion('unknown', 'nice-to-have')]).status,
    'partial',
    'only a required unknown blocks certification',
  )
})

test('an empty criterion list is unknown, not vacuously passing', () => {
  assert.equal(summarizeVerdict([]).status, 'unknown')
})

/* ─────────────────────── layer 1: the cheap gate ───────────────────────── */

test('the gate challenges a run that has no criteria at all', () => {
  const gate = evidenceGate({ checks: [], claim: 'I have completed the migration', evidenceCount: 0 })
  assert.equal(gate.verdict, 'challenge')
  assert.deepEqual(gate.reasons.map((r) => r.code).sort(), ['bare-claim', 'no-criteria'])
})

test('common completion phrasings are recognised, including the uncontracted form', () => {
  const runnable = [{ id: 'C1', statement: 'a', weight: 'required', check: { command: 'x' } }]
  for (const claim of [
    "I've completed the migration",
    'I have completed the migration',
    'I have finished it',
    'all done',
    'The task is complete',
    'everything passes',
    "it's done",
    '迁移已经完成了',
    '全部搞定了',
    '测试全绿',
  ]) {
    const gate = evidenceGate({ checks: [], claim, evidenceCount: 0 })
    assert.ok(
      gate.reasons.some((r) => r.code === 'bare-claim'),
      `expected ${JSON.stringify(claim)} to register as a completion claim`,
    )
  }

  // And ordinary status prose must not trip it.
  for (const claim of ['继续推进 T2', '接口抽出来了，接下来实现 Redis 后端', 'still working on the parser']) {
    const gate = evidenceGate({ checks: runnable, claim, evidenceCount: 0 })
    assert.equal(gate.verdict, 'proceed', `${JSON.stringify(claim)} must not be treated as a claim of completion`)
  }
})

test('criteria with no runnable check are unverifiable, not challenged forever', () => {
  const gate = evidenceGate({
    checks: [{ id: 'C1', statement: '代码整洁', weight: 'required' }],
    claim: '重构完成',
    evidenceCount: 2,
  })
  assert.equal(gate.verdict, 'unverifiable', 'no amount of asking turns this into a machine verdict')
})

test('a required criterion with no check is named, and nice-to-have ones are not', () => {
  const gate = evidenceGate({
    checks: [
      { id: 'C1', statement: 'a', weight: 'required', check: { command: 'x' } },
      { id: 'C2', statement: 'b', weight: 'required' },
      { id: 'C3', statement: 'c', weight: 'nice-to-have' },
    ],
    claim: 'done',
    evidenceCount: 1,
  })
  assert.equal(gate.verdict, 'unverifiable')
  assert.deepEqual(gate.reasons.map((r) => r.code), ['required-without-check'])
  assert.match(gate.reasons[0].detail, /C2/)
  assert.doesNotMatch(gate.reasons[0].detail, /C3/)
})

test('a bare completion claim is challenged, but a claim with evidence goes to review', () => {
  // Nothing at all behind the claim: worth one round asking for evidence,
  // because evidence may be the only thing a human can then review.
  const bare = evidenceGate({
    checks: [{ id: 'C1', statement: 'a', weight: 'required' }],
    claim: 'I have completed everything, all done',
    evidenceCount: 0,
  })
  assert.equal(bare.verdict, 'challenge')
  assert.deepEqual(bare.reasons.map((r) => r.code).sort(), ['bare-claim', 'no-runnable-check'])

  // The same unverifiable criteria with evidence already registered: no amount
  // of asking turns this into a machine verdict, so it goes to a human.
  const evidenced = evidenceGate({
    checks: [{ id: 'C1', statement: 'a', weight: 'required' }],
    claim: 'I have completed everything, all done',
    evidenceCount: 2,
  })
  assert.equal(evidenced.verdict, 'unverifiable')
  assert.deepEqual(evidenced.reasons.map((r) => r.code), ['no-runnable-check'])
})

test('a completion phrase over runnable checks is left to the checks', () => {
  const gate = evidenceGate({
    checks: [{ id: 'C1', statement: 'a', weight: 'required', check: { command: 'pnpm test' } }],
    claim: 'All done!',
    evidenceCount: 0,
  })
  assert.equal(gate.verdict, 'proceed', 'a challenge round here would only add latency; layer 2 decides it')
})

test('a quiet claim with runnable checks proceeds straight to execution', () => {
  const gate = evidenceGate({
    checks: [{ id: 'C1', statement: 'a', weight: 'required', check: { command: 'pnpm test' } }],
    claim: '迁移已完成，测试见证据',
    evidenceCount: 1,
  })
  assert.equal(gate.verdict, 'proceed')
  assert.deepEqual(gate.reasons, [])
})

/* ───────────────────── layer 2: running the checks ─────────────────────── */

function fakeShell(responses) {
  const calls = []
  return {
    calls,
    resolve: (request) => ({ ...request, workdir: request.workdir ?? '/ws', timeoutMs: request.timeoutMs ?? 1000, stdoutMaxBytes: 65536 }),
    async run(spec) {
      calls.push(spec)
      const next = responses[spec.command] ?? { exitCode: 0 }
      return {
        exitCode: next.exitCode ?? 0,
        timedOut: next.timedOut ?? false,
        aborted: false,
        timeoutMs: spec.timeoutMs,
        stdout: { text: next.stdout ?? '', truncated: false },
        sandbox: next.sandbox,
      }
    },
  }
}

const runWith = (acceptance) => ({ id: 'R-1', round: 3, contract: { acceptance } })

test('runChecks executes every runnable check and records its evidence', async () => {
  const shell = fakeShell({
    'pnpm test': { exitCode: 0, stdout: '42 passing' },
    'pnpm lint': { exitCode: 1, stdout: '3 problems' },
  })
  const verdict = await runChecks({
    shell,
    root: '/ws',
    digest: () => 'abc123',
    run: runWith([
      { statement: '测试全绿', check: { command: 'pnpm test' } },
      { statement: 'lint 干净', check: { command: 'pnpm lint' } },
    ]),
  })

  assert.equal(verdict.status, 'fail')
  assert.equal(verdict.level, 'executable')
  assert.deepEqual(shell.calls.map((c) => c.command), ['pnpm test', 'pnpm lint'])
  assert.equal(verdict.perCriterion[0].status, 'pass')
  assert.equal(verdict.perCriterion[0].evidence.exitCode, 0)
  assert.equal(verdict.perCriterion[0].evidence.digestBefore, 'abc123', 'evidence is bound to the tree it was produced against')
  assert.equal(verdict.perCriterion[1].status, 'fail')
  assert.equal(verdict.counterexamples.length, 1)
  assert.match(verdict.counterexamples[0], /3 problems/)
})

test('runChecks confines every command to the workspace', async () => {
  const shell = fakeShell({})
  await runChecks({ shell, root: '/ws', run: runWith([{ statement: 'a', check: { command: 'true' } }]) })
  assert.equal(shell.calls[0].workdir, '/ws')
  assert.equal(shell.calls[0].sandboxPolicy.mode, 'workspace-write')
  assert.equal(shell.calls[0].sandboxPolicy.workspaceRoot, '/ws')
})

test('a criterion with no check is reported as unknown rather than skipped', async () => {
  const verdict = await runChecks({
    shell: fakeShell({}),
    root: '/ws',
    run: runWith([{ statement: '代码优雅', weight: 'nice-to-have' }]),
  })
  assert.equal(verdict.perCriterion[0].status, 'unknown')
  assert.equal(verdict.perCriterion[0].method, '未执行')
  assert.equal(verdict.level, 'self', 'nothing runnable means the run is only self-assessed')
})

test('a missing shell service yields unknown, never a silent pass', async () => {
  const verdict = await runChecks({ shell: undefined, root: '/ws', run: runWith([{ statement: 'a', check: { command: 'pnpm test' } }]) })
  assert.equal(verdict.status, 'unknown')
  assert.match(verdict.perCriterion[0].note, /没有装配 shell/)
})

test('a file expectation is decided by stat, and the command is not run', async () => {
  const shell = fakeShell({})
  const verdict = await runChecks({
    shell,
    root: '/ws',
    fs: { resolve: async (p) => p, stat: async () => ({ size: 1 }) },
    run: runWith([{ statement: '产物存在', check: { command: 'unused', expect: { fileExists: 'dist/app.js' } } }]),
  })
  assert.equal(verdict.status, 'pass')
  assert.equal(shell.calls.length, 0, 'file existence is a stat, not a shell round trip')
  assert.match(verdict.perCriterion[0].method, /stat dist\/app\.js/)
})

test('an empty contract yields an unknown verdict with no criteria', async () => {
  const verdict = await runChecks({ shell: fakeShell({}), root: '/ws', run: runWith([]) })
  assert.equal(verdict.status, 'unknown')
  assert.deepEqual(verdict.perCriterion, [])
})

/* ─────────────────────────── what the model sees ───────────────────────── */

test('the verdict prompt names every non-passing criterion and forbids restating the claim', () => {
  const prompt = renderVerdictPrompt({
    id: 'V-abc123',
    status: 'fail',
    level: 'executable',
    round: 4,
    perCriterion: [
      { id: 'C1', statement: '测试全绿', status: 'pass', note: '退出码 0' },
      { id: 'C2', statement: '重启不丢会话', status: 'fail', note: '退出码 1，期望 0' },
    ],
    counterexamples: ['C2 「重启不丢会话」：退出码 1，期望 0'],
  })
  assert.match(prompt, /<verdict id="V-abc123" status="fail" level="executable" round="4">/)
  assert.match(prompt, /\[fail\] C2 重启不丢会话 —— 退出码 1，期望 0/)
  assert.match(prompt, /\[pass\] C1/, 'passing criteria are still shown, so the model knows what not to touch')
  assert.match(prompt, /不是"失败"，是"还没证明"/)
})

test('no verdict renders nothing at all', () => {
  assert.equal(renderVerdictPrompt(undefined), '')
})

/* ══════════════════════ layer 3: the independent evaluator ═══════════════ */

test('the evaluator policy is built from zero, not inherited', () => {
  assert.deepEqual([...EVALUATOR_TOOL_ALLOW], ['read', 'glob', 'grep'])
  assert.ok(!EVALUATOR_TOOL_ALLOW.includes('bash'), 'layer 2 already ran the commands; layer 3 judges, it does not execute')
  assert.ok(!EVALUATOR_TOOL_ALLOW.includes('write'))
  assert.ok(!EVALUATOR_TOOL_ALLOW.includes('edit'))
  assert.ok(!EVALUATOR_TOOL_ALLOW.includes('web_fetch'), 'no network is part of the contamination control')
})

test('the evaluator is told that unknown is legitimate and that invented gaps cost', () => {
  assert.match(EVALUATOR_PERSONA, /unknown.*legitimate/i)
  assert.match(EVALUATOR_PERSONA, /not a failure/i)
  assert.match(EVALUATOR_PERSONA, /inventing one costs more/)
  assert.match(EVALUATOR_PERSONA, /cannot modify anything/)
  assert.match(EVALUATOR_PERSONA, /will not be shown it/, 'the absence of execution history is stated, not implied')
})

test('the schema requires a reasoning string per criterion', () => {
  assert.deepEqual(EVALUATOR_SCHEMA.required, ['perCriterion', 'summary'])
  const item = EVALUATOR_SCHEMA.properties.perCriterion.items
  assert.deepEqual(item.required, ['id', 'status', 'reasoning'])
  assert.deepEqual(item.properties.status.enum, ['pass', 'fail', 'unknown'])
})

const CHECKS = [
  { id: 'C1', statement: '测试全绿', weight: 'required', check: { command: 'pnpm test', expect: { exitCode: 0 } } },
  { id: 'C2', statement: '重启不丢会话', weight: 'required' },
]

test('the evaluator prompt carries the contract and the recorded evidence, and no history', () => {
  const prompt = renderEvaluatorPrompt({
    contract: { deliverable: 'PR', constraints: ['不得改 public API'] },
    checks: CHECKS,
    root: '/ws',
    deterministic: {
      perCriterion: [
        { id: 'C1', status: 'pass', note: '退出码 0', evidence: { command: 'pnpm test', stdoutHead: '42 passing' } },
        { id: 'C2', status: 'unknown', note: '没有可执行检查' },
      ],
    },
  })
  const text = prompt[0].text

  assert.match(text, /C1 \[required\] 测试全绿/)
  assert.match(text, /recorded check: pnpm test → 退出码 = 0/)
  assert.match(text, /C2 \[required\] 重启不丢会话/)
  assert.match(text, /no recorded check/)
  assert.match(text, /<recorded_evidence/)
  assert.match(text, /\$ pnpm test/)
  assert.match(text, /42 passing/)
  assert.match(text, /不得改 public API/)
  assert.match(text, /Workspace root: \/ws/)

  // The absence of a transcript is the mechanism, so it must be structural.
  assert.doesNotMatch(text, /tool\/result/)
  assert.doesNotMatch(text, /assistant/i)
  assert.doesNotMatch(text, /history/i)
})

test('without recorded evidence the evaluator is told to read the workspace itself', () => {
  const text = renderEvaluatorPrompt({ contract: {}, checks: CHECKS, root: '/ws' })[0].text
  assert.match(text, /No command decided these criteria/)
})

/* ─────────────────────── parsing the evaluator output ──────────────────── */

test('a well-formed judgement maps onto the criteria', () => {
  const parsed = parseEvaluatorOutput(
    {
      perCriterion: [
        { id: 'c1', status: 'pass', reasoning: '跑了 pnpm test，42 通过' },
        { id: 'C2', status: 'fail', reasoning: 'Redis 未开 AOF', counterexample: 'src/auth/redis.ts:41 未设置 appendonly' },
      ],
    },
    CHECKS,
  )
  assert.equal(parsed[0].status, 'pass', 'the id is matched case-insensitively')
  assert.equal(parsed[1].status, 'fail')
  assert.match(parsed[1].counterexample, /appendonly/)
  assert.equal(parsed[0].method, '独立评估器')
})

test('a criterion the evaluator skipped is unknown, not silently dropped', () => {
  const parsed = parseEvaluatorOutput({ perCriterion: [{ id: 'C1', status: 'pass', reasoning: 'ok' }] }, CHECKS)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[1].status, 'unknown')
  assert.match(parsed[1].note, /没有对这条标准给出判断/)
})

test('a fail with no counterexample is downgraded to unknown', () => {
  const parsed = parseEvaluatorOutput(
    { perCriterion: [{ id: 'C1', status: 'fail', reasoning: '感觉有问题' }] },
    [CHECKS[0]],
  )
  assert.equal(parsed[0].status, 'unknown', 'an assertion without a pointer is not actionable and is not treated as fact')
  assert.match(parsed[0].note, /没有给出具体反例/)
})

test('malformed entries are ignored rather than coerced', () => {
  const parsed = parseEvaluatorOutput(
    { perCriterion: [{ id: 'C1', status: 'probably', reasoning: 'x' }, { status: 'pass' }, null] },
    [CHECKS[0]],
  )
  assert.equal(parsed[0].status, 'unknown')
})

test('a wholly malformed payload yields all-unknown', () => {
  const parsed = parseEvaluatorOutput({ nonsense: true }, CHECKS)
  assert.deepEqual(parsed.map((c) => c.status), ['unknown', 'unknown'])
})

/* ─────────────────────────── merging two layers ────────────────────────── */

const det = (perCriterion, extra = {}) => ({
  level: 'executable',
  perCriterion,
  status: summarizeVerdict(perCriterion).status,
  counts: summarizeVerdict(perCriterion).counts,
  counterexamples: [],
  nextActions: [],
  ...extra,
})

test('a deterministic failure stands regardless of what the evaluator thinks', () => {
  const merged = mergeVerdicts(
    det([{ id: 'C1', statement: 'x', weight: 'required', status: 'fail', note: '退出码 1' }]),
    { perCriterion: [{ id: 'C1', status: 'pass', note: '看起来没问题' }] },
  )
  assert.equal(merged.perCriterion[0].status, 'fail')
  assert.equal(merged.perCriterion[0].note, '退出码 1')
})

test('an evaluator may overturn a passing check — that is why it exists', () => {
  const merged = mergeVerdicts(
    det([{ id: 'C1', statement: '测试覆盖了迁移', weight: 'required', status: 'pass', note: '退出码 0' }]),
    { perCriterion: [{ id: 'C1', status: 'fail', note: '测试只断言了不抛异常', counterexample: 'test/x.ts:12 只有 expect(true)' }] },
  )
  assert.equal(merged.perCriterion[0].status, 'fail')
  assert.match(merged.perCriterion[0].note, /确定性检查通过，但独立评估器不同意/)
  assert.match(merged.counterexamples[0], /只有 expect\(true\)/)
})

test('the evaluator decides a criterion the commands could not', () => {
  const merged = mergeVerdicts(
    det([{ id: 'C2', statement: '重启不丢会话', weight: 'required', status: 'unknown', note: '没有可执行检查' }]),
    { perCriterion: [{ id: 'C2', status: 'pass', note: '读了 redis.ts，确认加了 appendonly yes' }] },
  )
  assert.equal(merged.perCriterion[0].status, 'pass')
  assert.match(merged.perCriterion[0].method, /独立评估器/)
  assert.equal(merged.status, 'pass')
  assert.equal(merged.level, 'independent')
})

test('a missing evaluator leaves the deterministic result untouched', () => {
  const base = det([{ id: 'C1', statement: 'x', weight: 'required', status: 'pass', note: '退出码 0' }])
  assert.equal(mergeVerdicts(base, undefined), base)
  assert.equal(mergeVerdicts(base, undefined).level, 'executable')
})

test('a criterion the evaluator raised but the contract does not have is not invented', () => {
  const merged = mergeVerdicts(
    det([{ id: 'C1', statement: 'x', weight: 'required', status: 'pass', note: 'ok' }]),
    { perCriterion: [{ id: 'C9', status: 'fail', note: 'invented' }] },
  )
  assert.deepEqual(merged.perCriterion.map((c) => c.id), ['C1'])
})

/* ──────────────────────── running the evaluator ────────────────────────── */

function fakeSubagents(overrides = {}) {
  const started = []
  return {
    started,
    getProvider: () => ({ name: 'spawn' }),
    async start(name, request) {
      started.push({ name, request })
      return {
        id: 'child-session-1',
        result: Promise.resolve(
          overrides.result ?? {
            stopReason: 'completed',
            output: [],
            structured: overrides.structured ?? {
              perCriterion: [
                { id: 'C1', status: 'pass', reasoning: 'ran it myself' },
                { id: 'C2', status: 'fail', reasoning: 'no AOF', counterexample: 'redis.ts:41' },
              ],
              summary: '迁移基本完成，持久化未配置',
              confidence: 0.7,
            },
          },
        ),
        dispose: async () => {},
      }
    },
  }
}

const evalDeps = (subagents) => ({
  subagents,
  agents: { get: () => ({ id: 'sess-1' }), roots: () => [{ id: 'sess-1' }] },
  run: { id: 'R-1', round: 2, contract: {}, ownerSessionId: 'sess-1' },
  root: '/ws',
  checks: CHECKS,
  deterministic: det([{ id: 'C1', statement: 'x', weight: 'required', status: 'pass', note: '退出码 0' }]),
})

test('the evaluator is started with its own policy, not the caller\u2019s', async () => {
  const subagents = fakeSubagents()
  await independentEvaluate(evalDeps(subagents))
  const request = subagents.started[0].request

  assert.deepEqual(request.toolFilter, { allow: ['read', 'glob', 'grep'] })
  assert.equal(request.persona, EVALUATOR_PERSONA)
  assert.equal(request.outputSchema, EVALUATOR_SCHEMA)
  assert.equal(request.maxDepth, 1, 'an evaluator that can spawn evaluators is a fork bomb with a budget')
  assert.equal(subagents.started[0].name, 'spawn')
  assert.match(request.label, /^verify-R-1/)
})

test('a completed evaluator produces an independent-level verdict', async () => {
  const verdict = await independentEvaluate(evalDeps(fakeSubagents()))
  assert.equal(verdict.level, 'independent')
  assert.equal(verdict.perCriterion[0].status, 'pass')
  assert.equal(verdict.perCriterion[1].status, 'fail')
  assert.equal(verdict.summary, '迁移基本完成，持久化未配置')
  assert.ok(verdict.confidence >= 0)
})

test('an evaluator that did not complete is treated as absent', async () => {
  const aborted = fakeSubagents({ result: { stopReason: 'aborted', output: [] } })
  assert.equal(await independentEvaluate(evalDeps(aborted)), undefined)
})

test('a missing subagents or agents service degrades to no layer 3', async () => {
  const deps = evalDeps(fakeSubagents())
  assert.equal(await independentEvaluate({ ...deps, subagents: undefined }), undefined)
  assert.equal(await independentEvaluate({ ...deps, agents: undefined }), undefined)
  assert.equal(await independentEvaluate({ ...deps, agents: { get: () => undefined, roots: () => [] } }), undefined)
})

test('a provider that is not registered is not attempted', async () => {
  const subagents = fakeSubagents()
  subagents.getProvider = () => undefined
  assert.equal(await independentEvaluate(evalDeps(subagents)), undefined)
  assert.equal(subagents.started.length, 0)
})

test('a start failure degrades instead of failing the verification', async () => {
  const subagents = {
    getProvider: () => ({ name: 'spawn' }),
    start: async () => {
      throw new Error('no capacity')
    },
  }
  assert.equal(await independentEvaluate(evalDeps(subagents)), undefined)
})

test('layer 3 is now advertised as implemented', () => {
  assert.equal(INDEPENDENT_EVALUATOR_IMPLEMENTED, true)
})
