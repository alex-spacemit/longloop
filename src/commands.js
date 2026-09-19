/**
 * LongLoop human commands — §10.1's `/run` family.
 *
 * A console is for looking at; a command is for acting without leaving the
 * conversation. Both matter, because §16.1's tension is that a long-task
 * framework exists so a person does not have to watch, yet must let them take
 * over in seconds when they do look.
 *
 * The command surface deliberately mirrors the console's controls one-for-one,
 * so neither is a second-class way to drive a run.
 */

/** One line of help, shown by `/longloop` with no argument. */
const USAGE = [
  '/longloop                 — 显示当前运行状态',
  '/longloop start <目标>     — 在这个工作区创建运行',
  '/longloop pause           — 暂停（循环不再排下一轮）',
  '/longloop resume          — 重新授权（人工确认后才继续）',
  '/longloop stop [原因]      — 中止并生成交接包',
  '/longloop verify          — 立即执行验收检查',
  '/longloop handoff         — 输出交接包全文',
  '/longloop metrics         — §12 度量：结局、轮次、验证覆盖、漂移、缺口',
].join('\n')

/**
 * The `/longloop start` line, in full.
 *
 * Typing a contract on one line is the only way the composer can express one,
 * and a run created without criteria cannot be verified — so the flags are part
 * of the usage text rather than a hidden extra.
 */
const START_USAGE = [
  '/longloop start <目标> [--accept "陈述 | 命令 | 期望"] [--accept …] [--freeze 路径] [--rounds N] [--deliverable 文字]',
  '',
  '期望写法：退出码 0 / stdout /正则/ / 文件 path（缺省 = 退出码 0）',
  '例：/longloop start 修好登录接口 --accept "测试全绿 | npm test | 退出码 0" --freeze tests/auth.test.ts',
].join('\n')

/** Split `status now` into `{ verb, rest }`, tolerating extra spaces. */
export function parseCommand(rawInput) {
  const text = String(rawInput ?? '').trim()
  if (text.length === 0) return { verb: 'status', rest: '' }
  const [verb, ...remaining] = text.split(/\s+/)
  return { verb: verb.toLowerCase(), rest: remaining.join(' ').trim() }
}

/**
 * One `--accept` value → one contract criterion.
 *
 * Kept in step with the console's parser on purpose: the two entry points must
 * produce the same contract, or a run created from the composer behaves
 * differently from the same run created in the UI. The rules live here as
 * `陈述 | 命令 | 期望`; a line with no command stays a statement only, which the
 * reply calls out because such a criterion cannot be decided.
 */
export function parseAcceptanceSpec(value) {
  const parts = String(value ?? '')
    .split('|')
    .map((part) => part.trim())
  const statement = parts[0] ?? ''
  const command = parts[1] ?? ''
  const criterion = { statement: statement.length > 0 ? statement : command, weight: 'required' }
  if (statement.length === 0 && command.length === 0) return undefined
  if (command.length > 0) {
    criterion.check = { command }
    const expect = parseExpectationSpec(parts[2])
    if (expect !== undefined) criterion.check.expect = expect
  }
  return criterion
}

/** `退出码 0` / `stdout /re/` / `文件 path` → the `expect` object. */
export function parseExpectationSpec(value) {
  const text = String(value ?? '').trim()
  if (text.length === 0) return undefined
  const exit = /^(?:退出码|exit(?:\s*code)?)\s*(-?\d+)$/i.exec(text) ?? /^(-?\d+)$/.exec(text)
  if (exit !== null) return { exitCode: Number(exit[1]) }
  const stdout = /^(?:stdout\s*)?\/(.*)\/$/.exec(text)
  if (stdout !== null) return { stdoutMatches: stdout[1] }
  const file = /^(?:文件|file)\s+(.+)$/i.exec(text)
  if (file !== null) return { fileExists: file[1].trim() }
  return { stdoutMatches: text }
}

/**
 * `/longloop start` arguments: an objective plus the contract flags.
 *
 * Everything before the first `--flag` is the objective, so an objective may
 * contain spaces without needing quotes.
 *
 * A flag's value runs **to the next flag**, not to the next space. That is not
 * an aesthetic choice: a live run showed the composer handing us
 * `--accept "README 非空 | test -s …"` with a *curly* closing quote (the input box
 * is a rich-text editor), so a `"[^"]*"` pattern fell through to its `\S+` branch
 * and the criterion became the single word `"README` — a run that looked
 * configured and could never be checked. Value-to-next-flag survives ASCII
 * quotes, curly quotes, and no quotes at all.
 *
 * Unknown flags are collected rather than swallowed, and reported by the caller:
 * silently dropping `--freze` produces exactly the run this framework exists to
 * prevent — one that looks configured and cannot be verified.
 */
export function parseStartSpec(rest) {
  const text = String(rest ?? '').trim()
  const spec = { objective: '', deliverable: '', acceptance: [], frozenPaths: [], maxRounds: undefined, unknown: [] }
  const heads = []
  const headPattern = /(?:^|\s)--([a-z-]+)(?=\s|$)/gi
  let match
  while ((match = headPattern.exec(text)) !== null) {
    heads.push({ name: match[1].toLowerCase(), start: match.index, end: match.index + match[0].length })
  }
  const firstFlag = heads.length === 0 ? text.length : heads[0].start
  spec.objective = text.slice(0, firstFlag).trim()
  for (let index = 0; index < heads.length; index += 1) {
    const head = heads[index]
    const stop = index + 1 < heads.length ? heads[index + 1].start : text.length
    const value = stripQuotes(text.slice(head.end, stop).trim())
    switch (head.name) {
      case 'accept': {
        const criterion = parseAcceptanceSpec(value)
        if (criterion !== undefined) spec.acceptance.push(criterion)
        break
      }
      case 'freeze':
        if (value.length > 0) spec.frozenPaths.push(value)
        break
      case 'deliverable':
        spec.deliverable = value
        break
      case 'rounds': {
        const rounds = Number(value)
        if (Number.isInteger(rounds) && rounds > 0) spec.maxRounds = rounds
        break
      }
      default:
        spec.unknown.push(head.name)
    }
  }
  return spec
}

/** Strip one layer of matching ASCII or typographic quotes. */
function stripQuotes(value) {
  const text = String(value ?? '')
  const pairs = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’'],
  ]
  for (const [open, close] of pairs) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) return text.slice(1, -1).trim()
  }
  return text
}

const ok = (text) => ({ kind: 'success', text })
const failed = (text) => ({ kind: 'error', text })

/** The status block a person reads at a glance. */
export function renderStatusLine(run) {
  if (run === undefined) return '当前工作区没有运行。用 `/longloop start <目标>` 创建。'
  const lines = [
    `运行 ${run.id} · ${run.state} · 第 ${run.round}/${run.maxRounds} 轮 · 模式 ${run.mode ?? 'inline'} · 验证 ${run.assurance}`,
    `目标：${run.objective}`,
  ]
  if (run.budget !== undefined && run.budget.dimensions.length > 0) {
    lines.push(
      '预算：' +
        run.budget.dimensions
          .map((d) => `${d.name} ${(d.ratio * 100).toFixed(0)}%`)
          .join(' · ') +
        (run.budget.rung === undefined ? '' : `（降级档 ${run.budget.rung}）`),
    )
  }
  if (run.stalledRounds > 0) lines.push(`停滞：连续 ${run.stalledRounds} 轮无进展 · ${run.escalation?.action ?? '—'}`)
  if (run.diagnosis !== undefined) lines.push(`诊断：${run.diagnosis.blocker} —— 下一步 ${run.diagnosis.nextAction}`)
  if (run.lastVerdict !== undefined) {
    lines.push(`最近裁决：${run.lastVerdict.status}（${run.lastVerdict.level}）`)
    for (const criterion of run.lastVerdict.perCriterion ?? []) lines.push(`  [${criterion.status}] ${criterion.id} ${criterion.statement}`)
  }
  if (run.endReason !== undefined) lines.push(`结束原因：${run.endReason}`)
  return lines.join('\n')
}

/**
 * The command definitions.
 *
 * @param deps.setStatusOutput - the caller's `handleRun`-equivalent, one op at
 *   a time; injected so this module owns phrasing, not policy.
 */
export function buildRunCommands(deps) {
  const { status, start, pause, resume, stop, verify, handoff, metrics } = deps

  return [
    {
      name: 'longloop',
      description: '长任务运行控制：状态、启动、暂停、中止、验证、交接包。',
      input: {
        hint: 'start <目标> [--accept "陈述 | 命令 | 期望"] [--freeze 路径] [--rounds N] [--deliverable 文字] | status | pause | resume | stop | verify | handoff | metrics',
      },
      async handler(invocation) {
        const { verb, rest } = parseCommand(invocation.rawInput)

        switch (verb) {
          case 'status': {
            const run = await status()
            return ok(run === undefined ? renderStatusLine(undefined) : renderStatusLine(run))
          }
          case 'start': {
            const spec = parseStartSpec(rest)
            if (spec.objective.length === 0) return failed('用法：`/longloop start <目标> [--accept …]`\n\n' + START_USAGE)
            const result = await start(spec.objective, spec)
            if (result.ok === false) return failed(result.error)
            const checkable = spec.acceptance.filter((criterion) => criterion.check !== undefined).length
            const unknown =
              spec.unknown.length === 0
                ? ''
                : `\n⚠ 不认识的参数：${spec.unknown.map((name) => `--${name}`).join('、')}（已忽略，它们没有写进契约）`
            return ok(
              `已创建运行 ${result.run.id}。\n` +
                (spec.acceptance.length === 0
                  ? '注意：这条运行还没有验收标准，因此无法被机器验证。\n' +
                    '补一份带检查的契约：`/longloop start <目标> --accept "陈述 | 命令 | 退出码 0"`。'
                  : `${spec.acceptance.length} 条验收标准，其中 ${checkable} 条可机器判定。\n` +
                    (spec.frozenPaths.length === 0
                      ? '提示：没有冻结任何文件，这个运行改得动自己的判卷（--freeze 路径）。'
                      : `已冻结 ${spec.frozenPaths.length} 个文件，执行者不能改。`)) +
                unknown,
            )
          }
          case 'pause': {
            const result = await pause()
            if (result.ok === false) return failed(result.error)
            return ok(`运行 ${result.run.id} 已暂停。循环不会再排下一轮。`)
          }
          case 'resume': {
            const result = await resume()
            if (result.ok === false) return failed(result.error)
            return ok(`运行 ${result.run.id} 已重新授权。`)
          }
          case 'stop': {
            const result = await stop(rest.length === 0 ? '人手中止' : rest)
            if (result.ok === false) return failed(result.error)
            return ok(`运行 ${result.run.id} 已中止，交接包已生成。`)
          }
          case 'verify': {
            const result = await verify()
            if (result.ok === false) return failed(result.error)
            if (result.challenged === true) {
              return failed(
                `完成声明被退回（第 ${result.attempt}/${result.max} 次）：\n` +
                  result.reasons.map((r) => `· ${r.detail}`).join('\n'),
              )
            }
            const verdict = result.verdict
            const lines = [`裁决 ${verdict.id} · ${verdict.status} · ${verdict.level}`]
            for (const criterion of verdict.perCriterion) lines.push(`[${criterion.status}] ${criterion.id} ${criterion.statement} —— ${criterion.note}`)
            return result.completed === true ? ok(lines.join('\n') + '\n\n全部必达标准通过，运行结束。') : ok(lines.join('\n'))
          }
          case 'handoff': {
            const document = await handoff()
            if (document === undefined) return failed('这条运行还没有交接包（它可能仍在进行中）。')
            return ok(document)
          }
          case 'metrics': {
            // §12. The numbers the ledger can prove, plus what it cannot.
            const report = await metrics()
            return ok(report === undefined ? '还没有任何运行记录。' : report)
          }
          default:
            return failed(`未知子命令：${verb}\n\n${USAGE}`)
        }
      },
    },
  ]
}

/** Register the family, one definition at a time, guarded. */
export function installRunCommands(ctx, deps) {
  const commands = ctx.get('commands')
  if (commands === undefined) return
  for (const definition of buildRunCommands(deps)) {
    try {
      ctx.effect(() => commands.register(definition))
    } catch (error) {
      ctx.logger?.warn?.(`longloop-console: could not register /${definition.name}: ${error?.message ?? error}`)
    }
  }
}
