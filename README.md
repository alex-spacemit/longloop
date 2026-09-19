# LongLoop Console

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin for
**long-horizon agent work that has to prove it finished**.

The harness already runs an agent loop. LongLoop adds the part that a long task needs and a
short one does not: a contract that is frozen before work starts, a verification gate that
runs the contract instead of asking the model whether it is done, a governance loop that
notices drift while there is still budget left, and a ledger that survives the process.

Everything lives under `<workspace>/.longloop/`, so a workspace carries its own run.

- Design document: [`docs/longloop-framework-design.md`](docs/longloop-framework-design.md)
- Package manifest: `package.json` (`dsh.bundle.patch`, `dsh.client`)
- Source: `src/` — runtime artifacts: `lib/` (identical files, see *Build* below)

## What it does

| Piece | What it buys |
| --- | --- |
| **Run + contract** | One objective, a deliverable, acceptance criteria, hard constraints, frozen test files. The contract is written once and cannot be edited afterwards — by the model or by the run. |
| **Verification gate** | Every criterion becomes a shell check (`退出码 0` / `stdout /re/` / `文件 path`). A verdict is `executable` (checks ran) or `independent` (a fresh-context evaluator that shares nothing with the executor). A `self` verdict is recorded as a *claim*, never counted as evidence. |
| **Contract freeze** | `tools.guard` denies any write to a frozen path for as long as the run is live (`armed`/`running`/`paused`/`suspended`). An executor that can rewrite its own acceptance test converges on editing the test. |
| **Contamination control** | A check command may not read the answer: git history, `.git`, `.env`, keys and credential stores are refused before execution, and a tree that escapes itself through a symlink refuses to verify at all. |
| **Governance loop** | Stall scoring over eight signals (workspace unchanged, board unchanged, repeated blocker, read-only round, …) drives a ladder: nudge → replan → switch mode (fresh-context round) → diagnosis → report; plus a budget ladder that narrows scope as the ceiling approaches. |
| **Context governance** | Measures the same pressure the harness compacts on, and compacts proactively at an idle boundary before a round's prompt is assembled. |
| **Process verification** | Every K rounds the cheapest frozen checks run even without a completion claim, and a check that stopped passing becomes a stall signal — so a wrong assumption is caught in round 3 instead of at the ceiling. |
| **Recovery** | Every round carries a durable id; a dispatch without a completion is recorded as an *unknown outcome*, the run suspends instead of resuming by itself, and the next round is told to reconcile state before redoing side effects. |
| **Ledger + session events** | One append-only fact per line (`<workspace>/.longloop/ledger.jsonl`) and the same facts mirrored into the session log as `longloop/*` events, with three projections so the console can read them back. |
| **Console** | A drawer over the workspace: run page (contract, budget, stall, context, verdict, handoff, metrics), task board, long-term memory, workspace skills, multi-agent roster. |
| **Metrics (§12)** | Completion rate, distinct-round counts, verification coverage and executable pass rate, contract quality, drift, dead ends, unknown outcomes — plus an explicit list of what the ledger cannot prove. |

## Install

Into a `dsh` profile, from GitHub:

```bash
dsh plugin --profile web add github:alex-spacemit/longloop
```

That is the same path any other plugin takes: it adds the package to the profile's
`package.json` dependencies and to `dsh.profile.bundles`. If you are installing from a local
checkout instead:

```bash
dsh plugin --profile web add link:/path/to/longloop
```

Then start the profile and look for **任务台** in the sidebar (or the same button in the
session header). Nothing else is needed: the host half arrives through the patch layer the
plugin ships (`cordis.patch.yml`), and the browser half is declared in `package.json` under
`dsh.client`.

## Use

From the console, or from the composer:

```
/longloop start 修好登录接口 --accept "测试全绿 | npm test | 退出码 0" --freeze tests/auth.test.ts
/longloop status | pause | resume | stop [原因] | verify | handoff | metrics
```

`/longloop start` takes a whole contract on one line:

- `--accept "陈述 | 命令 | 期望"`, repeatable. The expectation is `退出码 0`, `stdout /正则/`,
  or `文件 path`; omitting it means exit code 0. A line with no command is accepted and
  reported as *not machine-decidable*, because a criterion nobody can decide is the failure
  this plugin exists to prevent.
- `--freeze 路径`, repeatable: the files the checks live in. Without it the run can edit its
  own judge, and the console says so.
- `--rounds N`, `--deliverable 文字`.

The model drives the same lifecycle through the design's nine tools:
`run_start`, `run_plan`, `run_note`, `run_evidence`, `run_status`, `run_verify`, `run_finish`,
`run_block`, `run_handoff`.

Two of them are worth knowing about:

- **`run_plan(tasks[])`** replaces the plan, and every task must name the criterion it addresses
  (`addresses: ["C1"]`). A task that addresses nothing is rejected, ids the contract does not
  have are rejected, and the reply names the criteria no task covers — a plan is graded by the
  contract, not by itself.
- **`run_evidence(kind, pointer, addresses)`** registers what a claim rests on — a file, a command,
  a URL, a commit, an observation — with the criteria it speaks to. The framework hashes the
  artifact (a file by content, anything else by pointer, and the record says which), and the reply
  names the criteria that still have no evidence. `run_finish` then cites evidence by id, and an id
  that was never registered is reported rather than counted.
- **`run_verify(criteria?)`** runs the gate on demand. Without arguments it is the real gate: if
  every required criterion passes, the run completes. With `criteria` it validates only those and
  *cannot* complete the run, which is the point — a subset answer is not a completion.

## Configuration

The plugin has exactly one row, with one meaningful option:

```yaml
- id: longloop-console
  config:
    driver: false              # true = the loop queues its own rounds; false = a human clicks
    processVerifyEveryRounds: 10
```

`driver: false` is the shipped default on purpose: a restart must not resume work nobody
re-authorised.

## Build

`src/` is the source; `lib/` is what `dsh` loads, committed so a git install works without a
build step.

```bash
npm run build      # src/ → lib/ (byte for byte)
npm run check      # verify lib/ is in sync, then run the test suite
npm test           # 263 tests, no dependencies beyond Node's test runner
```

The plugin is **dependency-free** ESM JavaScript: it uses only Node built-ins and the
capabilities the host hands it through `ctx` (tools, guards, routes, prompt contexts, session
projections, commands, subagents). That is also why there are no `dependencies` or
`peerDependencies` — nothing is imported from the harness packages at runtime.

## Status

Implemented and exercised against a live `dsh web` on macOS: run/contract, verification gate
(including the independent evaluator), contract freeze at the tool gate, quarantine, the
governance and budget ladders, context governance, process verification, ledger + session
events + projections, the console, and metrics.

Known gaps, kept visible rather than implied by the absence of a note:

- The verification sandbox is in-place with quarantine rules, not a copied workspace.
- No control group. The metrics describe the system as it is; they do not measure what the
  governance adds (§12 says so in the report itself).
- The verification sandbox is in-place with quarantine rules, not a copied workspace.
- The design's multi-package/multi-plane split is delivered as one package
  (design §11.7 records this as the deliberate M0 convergence).

## License

MIT — see [LICENSE](LICENSE).
