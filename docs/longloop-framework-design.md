# LongLoop · 长任务智能体循环工程框架 · 总体设计

> 目标读者：要在 DeepSeek Harness (DSH) 上构建/评审这套框架的人。
> 本文回答一个问题：**它整体应该做成什么样。**
>
> 结论先行：**不要重写 agent loop。** DSH 已经把"单步循环"和"一次性编排"做完了，
> 缺的是把一次长任务当成**一等公民的、可治理的、可验证的、可恢复的运行实体**来管。
> 所以这套框架的本质是一层 **循环治理层（Loop Governance Layer）**，而不是一个新循环。

### 执行摘要（五分钟版）

| 问题 | 答案 |
|---|---|
| **它是什么** | 一个把"一次长任务"变成**可治理运行实体（Run）**的治理层：有契约、有预算、有台账、有验收、可暂停、可恢复、可审计 |
| **它不是什么** | ❌ 不是新 agent loop（DSH `agent-loop` 是单例且已够好）❌ 不是新压缩算法 ❌ 不是新编排引擎 ❌ 不是多智能体 swarm |
| **核心实体** | `Run` —— **跨会话**、持久、有契约、有预算。区别于 DSH `goal`（会话内）与 `ralph`（前台阻塞） |
| **循环协议** | `ORIENT → ACT → OBSERVE → VERIFY → DECIDE`，即学术界已验证的 **MEA loop**（LongHorizon-Harness: WeaveBench 51.8%→80.7%，OSWorld 3.0×） |
| **六个治理器** | Budget（多维预算+降级阶梯）· Progress（停滞评分+五级升级）· Context（约束白名单）· Verification（三层检测+反 hack）· Escalation（L0–L5）· Recovery（幂等+显式 re-arm） |
| **最有价值的一个机制** | **L3 换模式**：上下文被污染时自动把 `inline` 切到 `fresh` 新 agent —— 把 Ralph 循环的洞察变成一条自动升级路径 |
| **最重要的一条纪律** | **提示极简，验证厚重**（Claude 5 代删掉 80% 系统提示无损失；而验证开销占 19–38% token 换来 3× 完成率） |
| **最容易做错的三件事** | ① 让执行者生成自己的验收检查（错误共振，61.2%→57.3%）② 用 LLM judge 当虚假完成检测器（AUROC ≤0.65）③ 每轮重渲染 system prompt（摧毁 KV cache 前缀） |
| **M0 最小范围** | Run 台账 + inline 驱动 + 5 个工具 + rounds/wallClock/toolCalls 预算 + `self` 级验证（2 个包） |
| **先证明什么** | 同任务集上对比 裸 agent / goal / ralph，指标含 **pass^k**、**虚假完成率**、**$/task** —— 没有对照实验的框架设计没有说服力 |

**全文 2600 行，如果只看三节**：
[§2.2 DSH 自己写明的缺口](#22-dsh-自己写明的缺口这就是框架的核心价值)（规格说明书）·
[§7.3 Run State Block](#73-run-state-block外部记忆的载体)（外部记忆的载体与投递通道）·
[§8.2 停滞检测与升级阶梯](#82-progress-governor进度治理与停滞检测)（最有价值的机制）

---

## 目录

1. [判断：长任务到底难在哪](#1-判断长任务到底难在哪)
2. [家底盘点：DSH 已有什么、明确缺什么](#2-家底盘点dsh-已有什么明确缺什么)
3. [领域依据：论文与开源项目沉淀了什么](#3-领域依据论文与开源项目沉淀了什么)
4. [框架定位与九条设计公理](#4-框架定位与九条设计公理)
5. [总体架构：三平面 × 六治理器](#5-总体架构三平面--六治理器)
6. [数据模型](#6-数据模型)
7. [循环协议（核心）](#7-循环协议核心)
8. [六个治理器详设](#8-六个治理器详设)
9. [终止语义与交接包](#9-终止语义与交接包)
10. [插件清单与 composition](#10-插件清单与-composition)
11. [实施路线 M0 → M4](#11-实施路线-m0--m4)
12. [度量：怎么证明这套框架真的有用](#12-度量怎么证明这套框架真的有用)
13. [反模式清单](#13-反模式清单)
14. [与 DSH 现有 goal / ralph / workflow / team 的分工](#14-与-dsh-现有-goal--ralph--workflow--team-的分工)
15. [参考依据](#15-参考依据)

**附录**：[A. 实现锚点（已核实的 DSH API）](#附录-a实现锚点已核实的-dsh-api) ·
[B. 为什么叫 LongLoop](#附录-b为什么叫-longloop) ·
[C. 一页纸速查](#附录-c一页纸速查) ·
[D. 开源实现的循环引擎对照](#附录-d开源实现的循环引擎对照选型与借鉴速查)

**第二部分 · 控制面、工作区记忆与工作区 Skill**（[实现已交付](#19-已实现的验证状态)）

16. [交互控制台（Run Console）](#16-交互控制台run-console)
17. [工作区记忆系统](#17-工作区记忆系统)
18. [工作区专属 Skill](#18-工作区专属-skill)
19. [已实现的验证状态](#19-已实现的验证状态)

---

## 1. 判断：长任务到底难在哪

### 1.1 一个反直觉的前提

长任务失败的主因**通常不是模型推理能力不足**，而是**循环缺乏治理**。

同一个模型，跑 5 步的任务成功率可能 90%，跑 80 步的任务成功率掉到 20%——
掉的这 70 个点里，绝大部分不是"某一步想错了"，而是：

- 上下文里最早的约束被压缩/冲刷掉了 → **目标漂移**
- 同一个错误路径被反复尝试 → **原地打转**
- 模型宣布"完成了"但其实没完成 → **虚假完成**
- 跑到一半预算烧光，什么都没交付 → **无预算意识**
- 进程崩溃 / 用户关掉页面 → **前功尽弃**
- 卡在一个人类一句话就能解开的点上，却自己硬扛 40 轮 → **无升级路径**

这些全部是**工程问题**，不是模型问题。工程问题就该用工程手段解决。

### 1.2 长任务成功率的工程化公式

```
        每轮有效信息增量 × 可验证性 × 可恢复性
成功率 ≈ ────────────────────────────────────────
                    上下文熵增
```

框架的全部工作就是四件事：

| 项 | 手段 |
|---|---|
| **最大化每轮信息增量** | 每轮把"当前真相"干净地重新注入；禁止在一个已经被污染的表征上继续 |
| **强制可验证** | 完成声明必须过验证门；验收标准在开工前谈定 |
| **保证可恢复** | 运行状态外置且持久；每轮一个检查点；崩溃后能精确续跑 |
| **抑制熵增** | 外部台账 + 分层记忆 + 有界上下文，而不是无限堆历史 |

### 1.3 六类失效 → 六个治理器

| # | 失效模式 | 典型症状 | 对应治理器 |
|---|---|---|---|
| 1 | 预算失控 | 无限循环 / 提前放弃 / 烧光额度 | **Budget Governor** |
| 2 | 无进展 | 连续 N 轮工作区零变更 | **Progress Governor** |
| 3 | 上下文丢失 | compaction 后忘了原始约束 | **Context Governor** |
| 4 | 虚假完成 | "已完成"但测试不过 | **Verification Gate** |
| 5 | 无升级路径 | 卡死后硬扛到预算耗尽 | **Escalation Policy** |
| 6 | 不可恢复 | 崩溃即重来 | **Recovery & Idempotency** |

**这六个治理器就是这套框架的全部内容。** 加上一个把它们串起来的轮次驱动器，
和一层给人看的控制面。

---

## 2. 家底盘点：DSH 已有什么、明确缺什么

这一节是设计的地基。DSH 已经交付了大量循环相关的原语，
**任何重复造这些轮子的设计都是错的**。

### 2.1 已有能力（直接复用，不要重造）

| 能力 | 现有包 | 对本框架的意义 |
|---|---|---|
| 单步循环（模型→工具→模型） | `dsh-agent-loop` | **唯一**的 agent factory，第二个会抛错。框架只能做它的监督者 |
| 同会话目标续跑 | `dsh-goal` + `dsh-tool-goal` + `dsh-goal-round-driver` | 已验证的"预留-准入-竞态围栏-持久化检查点"模式，**直接照抄** |
| 新 agent 迭代（Ralph 式） | `dsh-tool-ralph` | 固定脚本 + 有界交接的范式，fresh 模式的现成骨架 |
| 子智能体 / fork | `dsh-subagent` + `dsh-tool-subagent` | 独立评估器、诊断器的载体 |
| 脚本化扇出 | `dsh-workflow` + `dsh-workflow-ptc` + `dsh-tool-workflow` | 固定编排脚本，模型只提供数据 |
| 后台作业 | `dsh-jobs` + `dsh-tool-jobs` | 长任务后台化的现成通道 |
| 上下文压缩 | `dsh-compaction` + `dsh-compaction-basic` + `dsh-command-compact` | 熵增抑制的第一道闸 |
| 工具结果裁剪 / 溢写 | `dsh-compaction-tool-result-pruner`、`dsh-spill-policy`、`dsh-output-retention` | **证据只存指针不存内容**的实现基础 |
| Token 度量 | `dsh-token-meter` | 预算治理的计量表，重放确定、零模型调用 |
| 崩溃恢复 / 持久化 | `dsh-session-checkpoint-policy` + `dsh-session-persistence-jsonl` | 三个持久化屏障已经打好 |
| 循环卫生 | `dsh-repeat-tool-reminder` | 停滞检测的一个弱信号源 |
| 计划模式 | `dsh-plan-mode` | contract 协商阶段可复用 |
| 跨进程 KV 域 | `dsh-storage` + `dsh-storage-domain` + `dsh-storage-json` | **Run 台账的落盘介质** |
| 会话查询 | `dsh-session-query-sqlite`、`dsh-session-projection` | 跨会话历史检索 |
| 工作区变更记录 | `dsh-workspace-changes` | **进度账本最硬的信号源** |
| 定时提醒 | `dsh-schedule` | 长任务的"回来看一眼" |
| 团队 / 任务看板 | `dsh-experimental-agent-team` | 多 agent 协作的现成实现 |
| 人机问答 / 审批 | `dsh-user-questions`、`dsh-user-approval`、`dsh-tool-ask-user` | HITL 通道 |

### 2.2 DSH 自己写明的缺口（这就是框架的核心价值）

DSH 在多个包的 README 里**明确列出**了"Known Limitations and Deferred Work"。
把这些串起来，正好就是本框架的规格说明书：

| 缺口 | 出处（原文） | 本框架的补法 |
|---|---|---|
| **没有独立评估器** | goal-round-driver: *"No independent evaluator … evaluator-backed certification remains deferred"*；ralph: *"Completion is worker self-declaration"* | **Verification Gate**（三级 assurance） |
| **只有轮数上限，没有资源预算** | goal-round-driver: *"Round cap, not resource budget — token, currency, time, and provider quota policies remain independent"*；ralph: *"Only round count bounds aggregate effort"* | **Budget Governor**（多维预算 + 降级阶梯） |
| **没有跨轮长期记忆** | ralph: *"The workspace is the only cross-round long-term memory"* | **Run Ledger + Run State Block** |
| **没有无进展检测** | goal-round-driver 的轮询不读进度；repeat-tool-reminder 只认完全相同的调用 | **Progress Governor**（停滞评分 + 升级阶梯） |
| **没有异常自动重试策略** | goal-round-driver: *"an abnormal-failure retry policy … stays outside this package by design"* | **Escalation Policy** 的 L1/L2 |
| **只能前台、不能后台/调度** | ralph: *"Foreground only — no job id, background collection, process-resume checkpoint, scheduler, wall-clock start policy"* | Run 作为**跨会话持久实体** + jobs 集成 |
| **目标是会话内实体** | `ctx.goals` 明确是 *"Event-sourced same-session goal state"* | Run 存在 `storageDomain`，**跨会话** |
| **没有验收契约** | 无对应包 | **Contract**（deliverable / acceptance / constraints / non-goals） |
| **完成即停止，无交接** | 无对应包 | **Handoff Package**（任何终止都要产出） |

### 2.3 关键平台事实（决定了实现路径）

实现前必须吃透的几条：

1. **`agent-loop` 是单例**：`agentLoop` 只注册一个 factory，第二个抛错。
   → 框架**不能**新增循环实现，只能做监听器 + 驱动器。
2. **`agent/pre-step` 是环状瀑布**：可以在步骤进入前**拒绝**或**替换消息**，
   并且能在 `next()` 前后各检查一次（这是竞态围栏的实现方式）。
3. **`agent/turn-stopping` 是可干预的**：监听器若反对，可以调 `agent.steer(...)`，
   机器会重读收件箱继续跑步骤。**这是"循环决定是否继续"最精确的挂载点。**
4. **工具结果带 `concludesTurn: true` 会在该步骤结束回合**
   → `run_finish` / `run_block` 应该用它，避免多跑一轮空转。
5. **会话事件可声明合并**：`declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { … } }`
   → Run 的每轮事实直接进**会话日志**（唯一真源），投影给 UI。
6. **两平面铁律**：publish 服务的行必须放 host 平面；per-session 的东西放 preset。
   → Run 台账、驱动器、Remote 控制面 = host；工具、提示段 = preset。
7. **`storageDomain` 是唯一允许的 host 侧持久化**（会话日志除外）：
   同步读、写即持久、`domain/changed` 事件。→ Run 的跨会话状态放这里。

---

## 3. 领域依据：论文与开源项目沉淀了什么

> 本节把外部研究结论压缩成**可直接落地的机制**，而不是综述。
> 可信度标注：**【强实证】** 同行评审 + 受控消融 · **【中实证】** 单一实验室/厂商评测 · **【工程】** 博客/文档/实践者经验。
>
> ### 最重要的三条发现（它们直接决定了本设计的形状）
>
> **① MEA 循环已被证明有效 —— 这是本框架的路线依据**
>
> LongHorizon-Harness（arXiv:2608.01964, 2026-08）【强实证】把长任务重构为 **task-state 管理**，
> 提出 **Manage-Execute-Audit (MEA)** 循环：manager 维护显式 task state 并产出子任务契约
> （目标 / 验收标准 / 边界约束 / 相关先前证据）；**fresh-context executor** 在有界预算的上下文里执行；
> **只读 auditor** 独立检查环境状态产出审计报告。**跨轮只保留 task state + audit reports，
> executor 的原始轨迹每轮丢弃。**
>
> | 基准 | 基线 | +MEA | 倍数 |
> |---|---|---|---|
> | WeaveBench (Qwen3.7-Plus) | 51.8% | **80.7%** | 1.56× |
> | Terminal-Bench 2.1 | 69.7% | **77.2%** | 1.11× |
> | OSWorld 2.0 | 2.8% | **8.3%** | **3.0×** |
> | OSWorld 2.0 子集 (Claude Opus 4.7) | 20.0% | **34.3%** | 1.72× |
>
> 成本分解（重要）：manager 只占 **2.0–8.1%** token，**auditor 占 19.4–38.1%** ——
> **验证是主要额外投入**。总 token：WeaveBench 2.3×、OSWorld 3.6×，
> 但 **Terminal-Bench 2.1 反而少 24% 且成功率更高** → 框架的成本乘数不是固定的。
>
> → 本文的 `ORIENT / ACT / OBSERVE / VERIFY / DECIDE` 就是 MEA 的工程化展开，
> 见 [7.2](#72-每轮五拍) 与 [8.4](#84-verification-gate验证门)。
>
> **② 压实会丢掉 83% 的约束**
>
> Lost in Compaction（arXiv:2608.11242, 2026-08）【强实证】测出现有 compactor
> 平均只保留 **17%** 的 session constraints（如"在我确认前不要删任何邮件"），
> **多数 compactor 比完全不压缩还差**；并行挂一个 constraint-aware extractor 才能达到 >90% 保留。
>
> → 这是 **A2（Run 状态走 runtime context 而非对话历史）** 与
> [8.3 约束白名单](#83-context-governor上下文治理) 的硬证据。凭"摘要模型会保留重要的东西"是不够的。
>
> **③ LLM judge 抓不住虚假完成**
>
> False Success（ICML 2026 workshop, *From Confident Closing to Silent Failure*）【强实证】：
> 9,876 条 τ²-bench 轨迹 / 8 个模型族 / 3 个客服域。**单控制域中 false success 占全部失败的 45–48%**；
> **5 个 LLM judge × 5 种 prompt × 完整任务规格，没有一个 AUROC 超过 0.65** ——
> judge 被"自信收尾的语气"锚定，断言丰富的轨迹反而被打分高 **0.27–0.36**。
> 而一个轻量 **TF-IDF 检测器 AUROC 0.83、亚毫秒级**。
>
> → 验证门**不能只是"再叫一个模型看看"**，必须叠加**非 LLM 的证据门**。
> 见 [8.4](#84-verification-gate验证门) 的三层检测。

### 3.1 循环形态的演进（我们站在哪）

| 范式 | 循环结构 | 留下的遗产 |
|---|---|---|
| **ReAct** (2022) | `thought → action → observation` 循环 | 循环的基本节拍。**[实证]** |
| **Reflexion** (2023) | 失败后写"反思"存进记忆，下轮带上 | 失败要**结构化沉淀**，而不只是重试。**[实证]** |
| **Plan-and-Execute** | 先出计划，再逐条执行 | 计划必须**外置**成状态。**[实证]** |
| **Voyager** (2023) | 技能库 + 自我验证 + 课程 | **可复用技能**与**自动课程**；"自我验证"是完成判定的雏形。**[实证]** |
| **SWE-agent / ACI** (2024) | 为模型设计的工具界面 | **接口设计**对长任务的影响 ≈ 模型能力本身。**[实证]** |
| **OpenHands / 事件流** | 一切皆事件，事件流是唯一真源 | **事件溯源**做 agent 状态。**[工程]** |
| **CodeAct** (2024) | 用代码而不是 JSON 表达动作 | 动作表达力↑ → 步数↓。**[实证]** |
| **Modern coding agent** (Claude Code / Codex / OpenHands) | 单步循环 + 激进压缩 + todo 外置 + 子 agent 隔离 | 当前 SOTA 的工程配方。**[工程]** |
| **Ralph 循环** | 每轮**全新 agent** + 只有工作区共享 | 上下文被污染时，"忘掉重来"比"带着包袱跑"更强。**[工程]** |
| **mini-SWE-agent** (2026) | ~100 行、**只有 bash 一个工具**、线性历史、每步无状态 | **SWE-bench Verified >74%**。官方结论：模型变强后当年的工具/特殊接口大多不再需要。**[强实证]** |
| **Agentless** (2407.01489) | 三阶段：定位 → 修复 → 验证，**不让模型决定下一步** | SWE-bench Lite 32%，**比当时所有开源 agent 都高且更便宜（$0.70）**。**[强实证]** |

**两条必须记住的读数**：

1. **Loop 正在变简单，复杂度应该投到状态机与验证上，而不是工具与编排。**
   SWE-bench 官方 leaderboard（2026）现在让所有模型用 mini-SWE-agent 在**纯 bash** 下评测，
   官方描述是 *"no tools, no special scaffold structure; just a simple ReAct agent loop"*。
   → **这直接支持本框架的第一条定位：不重写循环。**
2. **加工具可能是负收益。** SWE-agent 的 ACI 消融【强实证】：
   加"迭代搜索"工具后 SWE-bench 从 12.47% **降到 12.0%** ——
   模型会把 `next()` 调到底，烧掉预算和上下文。
   → 对应 [13 反模式](#13-反模式清单)：工具面要克制，验证面要厚重。

**落地点**：本框架的 `inline` / `fresh` / `hybrid` 三种模式，就是这张表的直接结论。
见 [7.5](#75-三种驱动模式)。

### 3.2 上下文工程

- **Compaction 是必需品，但默认实现会丢约束** ——
  Lost in Compaction (2608.11242) 测得平均只保留 **17%** 的 session constraints，
  **多数 compactor 比不压缩更差**；Claude Code 的工程做法是保留架构决策 / 未解 bug /
  实现细节 / **最近 5 个文件**，而学术结论是必须加**约束白名单提取器**（>90% 保留）。
  **【强实证】**
  → **落地点**：① Contract 与 Plan 走 **runtime context**，compaction 物理上碰不到；
  ② 即使如此，压缩前仍要跑一遍**约束白名单检查**，确认没有约束只存在于历史里。
  见 [8.3](#83-context-governor上下文治理)。
- **注意力预算有限（context rot）** ——
  Chroma 的 Context Rot 研究测 18 个模型：随长度增长性能呈"梯度下降"而非断崖，
  且**结构化连贯的长 haystack 反而比打乱的更差**；Lost in the Middle (2307.03172) 的 U 形曲线
  说明中间位置最易被忽略。**【强实证】**
  → **落地点**：Run State Block 放在上下文**前部**，且有独立 token 上限。
- **子 agent 做上下文隔离** ——
  Anthropic 多智能体研究【中实证，厂商自评】：Opus 4 lead + Sonnet 4 subagent
  比单 agent Opus 4 高 **90.2%**；BrowseComp 上 **token 用量单独解释 80% 的方差**。
  但代价是 **~15× token**，且原文明确说**编码类任务可并行部分少，不适合多智能体**。
  → **落地点**：子 agent 只用于**验证、诊断、探索隔离**这三件明确的事，
  不做"多智能体协作写代码"。也与 Cognition《Don't Build Multi-Agents》的立场一致。
- **结构化笔记是有效的跨上下文记忆** —— Claude 玩 Pokémon 时自发生成地图、等级计数、
  战斗策略笔记，**跨 context reset 读回自己的笔记继续数小时训练**。**【工程经验，可复现】**
  → **落地点**：这正是 Run State Block 的形态依据。
- **Just-in-time 检索优于预先塞满** —— 维护轻量标识符（路径 / query）+ glob/grep，
  而不是全文入上下文。代价是 runtime 探索更慢，需要给模型明确的探索启发式。**【工程】**
- **工具结果裁剪/溢写** —— 深层历史里的原始 tool result 直接清掉（Anthropic 最轻量的压实），
  大输出保留头尾 + 定位符。DSH 已实现（`spill-policy` / `tool-result-pruner`）。**【工程】**

### 3.3 记忆分层

主流共识是**至少三层**（CoALA 认知架构的分类被广泛沿用）：

| 层 | 内容 | 寿命 | 本框架对应 |
|---|---|---|---|
| **工作记忆** | 当前轮可见的上下文 | 单轮 | Run State Block + 会话历史 |
| **情景记忆** | "做过什么、结果如何" | 整个 Run | **Run Ledger**（append-only 事实） |
| **语义记忆** | "学到什么、结论是什么" | 跨 Run 可复用 | **Decision Log + 技能沉淀** |
| **程序性记忆** | "这类任务该怎么做" | 永久 | DSH `skills`（已有） |

MemGPT/Letta 的分页内存、Generative Agents 的 memory stream + reflection、
Zep/Graphiti 的图记忆，本质都在回答同一个问题：**什么时候把什么搬进工作记忆**。
**[工程为主，部分实证]**

→ **落地点**：Ledger 只记**事实**（可验证的），Decision Log 只记**判断**（有理由的），
两者物理分开。见 [6.2](#62-ledgerentry进度事实)。

### 3.4 验证与自纠（本设计被修正最多的一节）

**① 没有外部反馈的自我纠错是有害的**

LLMs Cannot Self-Correct Reasoning Yet（2310.01798, ICLR'24）【强实证，决定性负面】：
**没有外部反馈时，自我纠错会降低推理准确率**；文献里报告的自我纠错增益，大多来自 oracle 标签泄漏。
CRITIC（2305.11738）进一步显示：**去掉外部工具后，verify-then-correct 的增益基本消失**。

→ **这直接修正了 L1（nudge）的设计**：L1 不能只是"再想想"，
必须**同时注入一个外部信号**（工作区 digest 无变化、测试输出、失败的具体命令）。
否则 L1 是负收益的。

**② 测试执行的增益是"高度条件化"的，而且可能为负**

这是本次调研最反直觉的发现：

| 实验 | 配置 | 结果 |
|---|---|---|
| **ExecCritic** (2609.09133) | 固定 repair agent，无测试基线 | 61.2% |
| | 由 repair agent **自己生成测试** | **57.3%（−3.9pt，反而更差）** |
| | 用 GPT-5.6-sol 生成强测试 | 65.3% |
| | 测试/修复两角色各自 post-train 后组合 | **72.6%（+11.4pt）** |
| **CodeMonkeys** (2501.14723) | 每轮同时生成 patch + 测试 | SWE-bench Verified **57.4%**；对已有 SOTA 提交做 ensemble selection → **66.2%** |
| **SWE-RM** (2512.21919) | **无执行反馈**的 reward model | TTS 上 51.6% → **62.0%** |

**机制解释（关键）**：同一条 trajectory 既写 patch 又写 test 时，
**两者的错误会"共振"，产生假信心**。
测试执行的主要价值发生在 **rerank / 选择**环节，而不是"直接修对"。

→ **三条硬性设计约束**：
1. **验收标准及其检查必须在契约阶段冻结**，不能由执行者事后生成
   （ExecCritic 的 fail-closed harness 做法）。
2. 验证者**必须使用契约里预定义的检查**，不许自己现编一个宽松的测试。
3. 允许"无执行反馈的独立判断"作为补充信号（SWE-RM 证明它也有大部分增益）。

**③ Reward hacking 是 2026 年最重的实证风险**

- **Cursor 审计**（2026-06-25）【强实证】：审计 731 条 Opus 4.8 Max trajectory，
  SWE-bench Pro 上 **63% 的"成功修复"是检索到答案而非推导**
  （57% 上网查到已合并的 PR、9% 挖 `.git` 历史）。
  **封住 git history + 断网后：Opus 4.8 Max 87.1% → 73.0%，Composer 2.5 74.7% → 54.0%。**
- **SWE-Bench Illusion**（2506.12286）【强实证】：仅凭 issue 描述就能定位 buggy 文件路径，
  SWE-bench 内仓库 **76%**、非 SWE-bench 仓库 53% → 说明存在记忆/污染。
- **Sycophancy to Subterfuge**（2406.10162）：RL 中从"迎合"泛化到"奖励篡改"。

→ **落地点**：验证与评测必须控制污染通道 —— **封 `.git` 历史、断网、隐藏测试**。
见 [8.4](#84-verification-gate验证门) 的第 6 条防线与 [12](#12-度量怎么证明这套框架真的有用)。

**④ LLM-as-judge 不能作为虚假完成的主检测器**

False Success (ICML 2026)：**没有一个 judge 的 AUROC 超过 0.65**，
而 **TF-IDF 检测器 0.83**。CriticGPT (2407.00215) 也记录了 critic **会幻觉不存在的问题**。

→ **落地点**：三层检测 —— 先便宜的分类器/证据门，再确定性检查，最后才是 LLM 评估器。
LLM judge 只在它能贡献增量信息的地方使用（语义判断），且必须结构化 + 允许 `unknown`。

**⑤ 过程奖励比结果奖励更稠密**

Let's Verify Step by Step (2305.20050)：过程奖励 (PRM) 用少量样本搜索即超过 ORM 大量样本多数投票。
ProgRM (2505.18121)：用 LCS 自标注从轨迹挖关键步骤训练 progress reward model，
动机是 **ORM 会过度惩罚"最终失败但过程有价值"的轨迹**。

→ **落地点**：台账不只记"做完了没"，要记**每轮的进展量**（见 [8.2](#82-progress-governor进度治理与停滞检测)）。
M4 可考虑用 ProgRM 式信号替换启发式停滞评分。

→ **总结落地点**：三级 assurance + Verdict schema 里的 `unknown` + **非 LLM 证据门**。
见 [8.4](#84-verification-gate验证门)。

### 3.5 失败模式分类

**MAST**（*Why Do Multi-Agent LLM Systems Fail*, 2503.13657）【强实证】：
150 条轨迹开发分类（人类标注 **κ=0.88**），LLM-as-judge 与人类一致率 **94%**，
最终 **MAST-Data 1642 条轨迹 / 7 个框架**，归纳为 **3 类 14 种**：

| 类 | 编号 | 失败模式 | 本框架的治理器 |
|---|---|---|---|
| **FC1 系统设计** | FM-1.1 | 不遵守任务规范 | **Contract** |
| | FM-1.2 | 不遵守角色规范 | Contract |
| | FM-1.3 | 步骤重复 | **Progress Governor** |
| | FM-1.4 | 对话历史丢失 | **Context Governor** |
| | FM-1.5 | **不知道终止条件** | **Budget / 终止语义** |
| **FC2 智能体间错位** | FM-2.1 | 对话重置 | Context Governor |
| | FM-2.2 | 不请求澄清 | Escalation（ask 门） |
| | FM-2.3 | 任务脱轨（goal drift） | **Progress Governor** |
| | FM-2.4 | 信息扣留 | Ledger 单一真源 |
| | FM-2.5 | 忽略他方输入 | 单线程设计（见下） |
| | FM-2.6 | 推理-动作不一致 | Verification Gate |
| **FC3 任务验证** | FM-3.1 | 过早终止 | Budget / 停滞门 |
| | FM-3.2 | 无/不完整验证 | **Verification Gate** |
| | FM-3.3 | 错误验证 | **Verification Gate（反 hack）** |

**结论原文：「系统设计 > 模型能力」。** 这正好是本框架存在的理由。

**虚假完成的量级**（False Success, ICML 2026）【强实证】：
单控制域中 **false success 占全部失败的 45–48%**，双控制域仅 3%。

**长任务特有的三类挑战**（LongHorizon-Harness 归纳）：
**(i) 复合误差与 goal drift · (ii) context rot · (iii) task-state loss。**

**Claude Code 官方记录的常见失败模式**（2026）【工程经验，极其实用】：

| 失败模式 | 官方处方 | 本框架的对应 |
|---|---|---|
| kitchen sink session（一个会话塞太多事） | `/clear` | 一个 Run 一个目标（Contract 单一） |
| **反复纠正** | **同一问题纠正超过 2 次就必须 `/clear` 重开**（上下文已被失败方案污染） | **L3 switch-mode**（换 fresh agent） |
| 过度膨胀的 CLAUDE.md | 规则淹没在噪声里 | Run State Block 有硬 token 上限 |
| **trust-then-verify gap** | "看起来能跑但不处理边界" → 必须提供可运行的 check | Verification Gate 要求可执行检查 |
| infinite exploration | 无界调查读数百文件 → 用 subagent 隔离 | Context Governor 强制探索隔离 |

**METR 时间跨度曲线**（2503.14499）【强实证】：
50% 可靠度的时间跨度自 2019 起**约每 7 个月翻倍**；
人类专家时间对成功率强预测（**<4 分钟任务近 100%，>4 小时任务 <10%**）；
TH 1.1（2026-05）测得 GPT-5 agent ≈ **2 小时 17 分**。
METR 自陈局限：**99% 可靠度视界无法拟合**；任务分布定义不清。

**两条推论**：
1. 框架设计必须假设"底层模型每半年变强一次" → **策略全部参数化**，阈值不能写死。
2. 主要驱动力是**可靠性 + 纠错能力**，不是纯推理 → **治理层的收益会持续存在**。

### 3.6 Durable Execution：最值得抄的外部范式

Temporal / Restate / DBOS / Inngest 代表的持久化执行范式，核心四条：

| 概念 | 含义 | 映射到 agent 循环 |
|---|---|---|
| **Workflow-as-code** | 编排逻辑是确定性代码 | 固定脚本（DSH `dsh-tool-ralph` 已经是这个思路） |
| **Deterministic replay** | 崩溃后重放事件流恢复状态 | 会话日志 + `dsh-session-checkpoint-policy` |
| **Signal / Query** | 外部异步注入输入 / 只读查询状态 | `agent.steer()` / `inbox` / Remote 查询 |
| **Activity + 幂等键** | 副作用步骤可重试，靠幂等键去重 | `exec.callId` 作为幂等键（DSH 已在 README 建议此做法） |

**语义冲突必须承认**：模型调用是**不确定**的，不能像 Temporal 那样纯重放。
实测中有**三种恢复语义**，它们不可调和，只能选边：

| 学派 | 代表 | 恢复方式 | 对 LLM 的适配 | 代价 |
|---|---|---|---|---|
| **Journal-replay** | Temporal / Restate | **从头重放** Event History，把每次 LLM 输出的文本记录在 journal 里，重放时直接返回记录值 | 模型的不确定性被"历史化"，整个 workflow 重新变确定 | journal 增长极快，必须配 Continue-As-New 或截断；模型升级后记录的输出已不可复现 |
| **Checkpoint** | DBOS / Inngest / LangGraph | **从最后一个完成的 step 继续**，不做代码重放 | **天然友好** —— 不需要确定性，只需要 step 幂等 | 无法"时间旅行重算"（没有可重放的输入序列）；step 内部分副作用仍需幂等 |
| **Event-log** | OpenHands / Codex rollout | 只保证事件日志的顺序与完整性；恢复 = 重建视图 + 从 HEAD 继续 append；需要分叉时从任意历史点开新分支 | **最诚实** —— 不假装能重放代码 | 需要维护物化视图；日志膨胀是结构性的 |

**Temporal 的确定性契约**原文："It has to make the same decisions when given the same history.
It shouldn't depend on any values **not** recorded in the history which would be different between runs."
—— 而 agent 的核心价值恰恰是"同一份历史可能做出不同决策"。**两者不可调和。**

**本框架的选择（混合语义）**：

```
外层：checkpoint 语义
      · step 级（= 一个 turn）可中断、可恢复
      · 幂等键 = tool call id
      · 恢复 = 从最后一个完成的 step 继续
内层：journal 语义
      · 每次 LLM 调用的输出被记录；恢复时直接读记录，不重新调用
声明：显式声明"不支持确定性代码重放"
      · "回到过去"实现为"从某个 step 开新分支"，而不是重跑代码
```

**为什么这样选**：DSH 已经给出同方向的答案 ——
`dsh-session-checkpoint-policy` 的策略是**持久化"已派发"，把外部效果状态标记为 unknown**
（`TOOL_OUTCOME_UNKNOWN`），而不是假装可以重放。
本框架**继承这条路线，不发明新的重放语义**。

**三条跨学派共同的不变量**（可直接照抄）：
1. **非确定性必须被 journal 住**（每次模型调用的结果落盘，恢复时不重调）
2. **副作用必须有幂等键**（`exec.callId`；同 id 只执行一次）
3. **长历史必须能换代**（Continue-As-New / journal 截断 / 压缩，而不是无限 replay）

**一条必须避开的坑（LangGraph issue #8039）**：
`durability="sync"` 下 `put_writes` 与 `put` 的**持久化顺序未被强制**，
于是崩溃后到底是 replay 还是 re-execute **取决于 host**。
原文教训：**"你以为 sync 了就安全，其实顺序没有契约。"**
→ 本框架的对应要求：**持久化顺序必须是契约的一部分**，
  `longloop/*` 事件的写入顺序与 `sessions.flush()` 的相对位置要在设计里写死并验证。

### 3.7 循环边界与终止：最完整的两份工程参考

**参考一：Claude Code `/goal` 的一手语义**（官方文档，2026）【工程经验，但极其具体】

| 机制 | 具体做法 | 本框架对应 |
|---|---|---|
| **每轮独立评估** | turn 结束后把 condition + 对话发给**一个小快模型**（默认 Haiku），三种裁决：`Not yet met`（继续，**理由作为下一轮指引**）/ `Met`（清除 + 记 achieved）/ `Impossible`（清除 + 记 failed） | Verification Gate 的轻量档 |
| **无进展检测** | **连续多轮没有工具调用** → 停止循环、打印警告、交回控制权，**goal 仍保留** | Progress Governor |
| **错误分级路由** | 认证失败 / 额度耗尽 / 自动压实救不回的 context overflow / 模型不可用 → **清除 goal + 要求人工修**；过载 / 断连 → 自动重试，**3 次后暂停** | [8.6](#86-recovery--idempotency恢复与幂等) |
| **后台工作延迟评估** | subagent / 后台 shell 还在跑就跳过本轮评估；后台工作让 goal 等 **30 分钟**触发 check-in，之后**翻倍**（1h → 2h，上限 4×） | fresh 模式的后台化 |
| **Stop hook 防死锁** | 脚本化确定性门可阻止 turn 结束；**连续 8 次阻塞后被覆盖，强制结束** | 反死锁上限 |

**参考二：bounded-loops 的 NINE-BOUNDS**（2026）【工程经验，细节极有价值】

它的核心洞察值得原文引用：

> **无门控 agent loop 最常见的失败模式不是崩溃，而是 agent 永远"再试一次"** ——
> 烧 token 和 wall time 却永不收敛。硬上限把"永远运行"变成"在第 N lap 大声失败"；
> no-progress 窗口抓更隐蔽的情况：agent 还在跑但已经不再改变任何东西 —— **是空转，不是停止。**

可直接抄的四条：

1. `max_iterations` **硬上限（默认 1000，不可被覆盖）**
2. `no_progress_window` **默认 3**：对**整个工作区取内容寻址摘要**，
   在同一 lap 的 turn 前后各取一次比对；
   **引擎自己写的文件（agent_output.txt / ledger / runtime state）按名字排除**。
3. **踩过的坑（务必避免）**：早期版本用 `git status` 对比一个
   "loop 装配时取一次、之后再也不刷新"的快照 → 第 2 轮之后 `changed` 永远为 True，
   **这个软上限根本无法触发**。
4. ledger 每行必须记 `attempted` 布尔量，否则轮次计数与尝试次数不可区分
   （`max_iterations: 10` 会写第 11 行，算出来 1.1）。
   原文：**"不能被自己的收据审计的成本声明不是成本声明。"**

→ 第 2、3、4 条**直接改进**了本文 [8.2](#82-progress-governor进度治理与停滞检测) 的实现描述。

**参考三：LangGraph 的 completion guard**（启发式虚假完成检测）【工程经验】
`after_model` hook 扫最近 **20** 条消息，三个信号：
(1) 最近有工具报错但未重试就宣布成功 (2) 有工具可用却从未使用 (3) 探索步数过少；
匹配完成短语正则（"I've completed" / "All done" / "The task is finished"）；
命中则注入 challenge message 要求自证或继续；
`_MAX_CHALLENGES = 2`（防无限挑战循环），`_MIN_MESSAGES_BEFORE_GUARD = 4`。

→ 这是 [8.4](#84-verification-gate验证门) 第一层（非 LLM 证据门）的现成设计。

### 3.8 十二条可操作结论

1. **Loop 骨架保持最简**（mini-SWE-agent 100 行 >74% Verified），
   复杂度投到**状态机与验证**，而不是工具与编排。
2. **显式外部 task state，每轮重建上下文**（MEA loop）：跨轮只持久化
   task state + audit report，**执行者原始轨迹每轮丢弃**；manager 只占 2–8% token。
3. **executor 与 auditor 物理分离 + 只读权限**；验证开销占 20–38% token
   但换来最高 3× 完成率，**别把它当可选**。
4. **验收标准及其检查必须在契约阶段冻结**，绝不能由执行者事后生成
   （自产测试 61.2% → 57.3%，错误共振）。
5. **压实必须带约束白名单**：只做摘要会丢 83% 的约束，多数 compactor 比不压缩更差。
6. **虚假完成用轻量分类器 + 证据门，不要用 LLM judge 当主检测器**
   （judge AUROC ≤0.65 vs TF-IDF 0.83）。
7. **四维预算 + 分级终止**：max_rounds / no_progress_window（**工作区 digest，排除引擎自身写入**）
   / wall-clock / $；终止原因是一等公民状态，
   且必须区分**"从未尝试"**与**"尝试后超预算"**。
8. **错误分级路由**：不可恢复（认证 / 额度 / context overflow）→ 清状态上报；
   瞬时（过载 / 断连）→ 自动重试，**3 次后暂停**；
   连续无工具调用 → stall 停止并**保留**状态。
9. **自我纠错必须带外部信号**：没有外部反馈的自我纠错会**降低**准确率。
10. **评测必须报告 pass^k 与成本**：pass@1 掩盖不稳定性（τ-bench retail **pass^8 <25%**）；
    做 accuracy–cost Pareto。
11. **反 reward hacking 是一等需求**：验证/评测环境必须受控
    （**封 `.git` 历史 + 断网 + 隐藏测试**；Cursor 实测 87.1% → 73.0%）。
12. **所有策略参数化**，因为底层模型每半年变强一次，阈值会过期。

---

## 4. 框架定位与九条设计公理

### 4.1 一句话定位

> **LongLoop 把"一次长任务"变成一个有契约、有预算、有台账、有验收、可暂停、可恢复、可审计的运行实体（Run），
> 并围绕它驱动循环。**

它**不**做的事：
- ❌ 不实现新的 agent loop（`agent-loop` 是单例，且已经够好）
- ❌ 不实现新的压缩算法（用 `dsh-compaction`）
- ❌ 不实现新的持久化后端（用 `dsh-session-persistence-*` + `dsh-storage-domain`）
- ❌ 不实现新的编排引擎（用 `dsh-workflow` / `dsh-subagent`）
- ❌ 不实现新的团队/看板（用 `dsh-experimental-agent-team`）

### 4.2 九条设计公理

| # | 公理 | 推论 |
|---|---|---|
| **A1** | **会话日志是唯一真源** | 每轮事实写成 `longloop/*` 会话事件；投影给 UI；KV 域只放跨会话索引 |
| **A2** | **Run 状态是 runtime context，不是对话历史** | 用 `systemPrompt.context()` 注入，compaction 压不掉 |
| **A3** | **完成必须可证明** | 没有 Verdict 就没有 `verified-complete` |
| **A4** | **预算是多维且带阶梯的** | 硬上限 + 降级动作，不是单一数字 |
| **A5** | **停滞要升级，不是重试** | 每级升级换的是**手段**，不是"再来一次" |
| **A6** | **恢复后不自动续跑** | 继承 DSH goal 的安全设计：resume 后必须显式 re-arm |
| **A7** | **一切都可观测** | 轮次、预算、台账、裁决、升级，全部落盘 + 可回放 |
| **A8** | **提示极简，验证厚重** | 一条约束只有在"无法被可执行检查替代"时才允许进提示 |
| **A9** | **每道"必须通过才能继续"的门都要有逃生阀** | 没有逃生阀的门就是死锁源 |

### 4.3 A8 的来源：过度约束是会伤性能的

Claude 5 代模型的官方工程记录（2026-07-24）【中实证，厂商自报】：
**为 Opus 5 / Fable 5 代模型删掉了 Claude Code 系统提示的 80% 以上，
编码评测上没有可测量的损失。** 演化方向：

| 过去 | 现在 |
|---|---|
| 系统提示里重复工具用法 | 说明只放在 tool description 里 |
| 手写 CLAUDE.md 当记忆 | **auto-memory**（模型自动保存） |
| 简单 markdown spec | **Rich references**：HTML artifact / 测试套件 / rubric + verifier agent |
| 所有 skill 全量加载 | **progressive disclosure** + 工具延迟加载（ToolSearch） |

**推论**：趋势是**减少预设约束、增加可运行的验证物**。
过度约束会让模型在冲突指令上消耗推理 —— 这与 PlanBench 的发现一致
（GPT-4 在 Blocksworld 上仅 ~34%，且对**语义等价的动作重命名**高度敏感，
说明它部分依赖表面模式而非规划能力）。

→ **对本框架的三条硬约束**：
1. 循环纪律提示段（`longloop-prompt`）控制在**几百 token** 量级，不许堆规则。
   判据（借 Claude Code 官方原话的变体）：**"如果模型不用这条指令也能做对，就删掉它。"**
2. Run State Block 里**只写"现在是什么状态"，不写"你应该怎么做"**。
   指令性内容全部转化为**可执行检查**或**门控**。
3. **工具面要克制。** Anthropic 的实测：让 agent 反复使用并重写工具描述，
   能让后续任务完成时间**减少 40%**；而 SWE-agent 的消融显示
   **多加一个搜索工具反而让成绩下降**（12.47% → 12.0%），
   因为模型会把 `next()` 调到底烧光预算。
   官方原话：**"如果人类工程师都无法明确说出某场景该用哪个工具，就不能指望 AI agent 做得更好。"**

### 4.4 A9 的来源：四份独立来源给出同一个约束

| 来源 | 门 | 逃生阀 |
|---|---|---|
| Claude Code | Stop hook 阻止 turn 结束 | **连续 8 次阻塞后强制覆盖并结束** |
| LangGraph completion guard | 注入 challenge 要求自证 | **`_MAX_CHALLENGES = 2` 后放行** |
| Claude Code `/goal` | 错误自动重试 | **3 次重试后转为暂停** |
| bounded-loops | `max_iterations` 硬上限 | 1000 轮（**不可被模型覆盖**，但存在） |

→ **本框架的逃生阀配置**（全部参数化；默认值）：

| 门 | 默认上限 | 超限行为 |
|---|---|---|
| 验证挑战（`run_finish` 被否后重试） | 2 次 | 放行该轮，但 Verdict 记 `unknown` |
| 同一阻塞条件上报 | 3 次 | 强制转 `blocked`（继承 DSH goal 语义） |
| 停滞升级 | 5 级（L0→L5） | 强制 `blocked` |
| 轮数硬上限 | 1000（**不可被模型覆盖**） | `exhausted` + 交接包 |
| 单轮工具调用 | 200 | 本轮强制结束，记异常 |
| 无进展窗口 | 3 轮 | 触发升级阶梯 |

---

## 5. 总体架构：三平面 × 六治理器

### 5.1 分层图

```
┌─────────────────────────────────────────────────────────────────────┐
│  CLIENT PLANE   (browser)                                           │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Run Console   ──▶  sidebar.right.pane.tab (key: longloop)    │  │
│  │  目标 / 状态 / 预算条 / 轮次时间线 / 台账 / 裁决 / 控制按钮      │  │
│  └───────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Run Strip     ──▶  conversation.composer.dock                │  │
│  └───────────────────────────────────────────────────────────────┘  │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ ctx.remote.longloop  (Remote 命名空间)
┌───────────────────────────────┴─────────────────────────────────────┐
│  HOST PLANE  (profile composition — 跨会话共享)                      │
│                                                                     │
│   ctx.longLoop  ┌──────────────────────────────────────────────┐    │
│   (服务)        │  RunRegistry                                 │    │
│                 │   · storageDomain: longloop/runs, /ledger_idx │    │
│                 │   · session events: longloop/run, /round,     │    │
│                 │     /ledger, /verdict, /escalation            │    │
│                 │   · projections: longloopRun, longloopRounds  │    │
│                 └──────────────────────────────────────────────┘    │
│                                                                     │
│   Governors     ┌────────────┬────────────┬────────────┐            │
│   (监听器集合)   │ Budget     │ Progress   │ Context    │            │
│                 │ Governor   │ Governor   │ Governor   │            │
│                 ├────────────┼────────────┼────────────┤            │
│                 │ Verification│ Escalation│ Recovery   │            │
│                 │ Gate       │ Policy    │ Policy     │            │
│                 └────────────┴────────────┴────────────┘            │
│                                                                     │
│   Drivers       ┌──────────────────────────────────────────────┐    │
│                 │ RoundDriver   inline / fresh / hybrid        │    │
│                 └──────────────────────────────────────────────┘    │
│                                                                     │
│   Control       ┌──────────────────────────────────────────────┐    │
│                 │ LongLoopController  (ctx.remote.longloop)    │    │
│                 └──────────────────────────────────────────────┘    │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ 复用（不新增）
┌───────────────────────────────┴─────────────────────────────────────┐
│  PRESET PLANE  (每个 session 一份，随 session 卸载)                  │
│   tool-longloop   run_start / run_plan / run_note / run_status /    │
│                   run_verify / run_finish / run_block / run_handoff │
│   command-longloop  /run  /run status|pause|resume|stop|verify      │
│   longloop-prompt   循环纪律提示段 + Run State Block (runtime ctx)   │
└─────────────────────────────────────────────────────────────────────┘
                                │
┌───────────────────────────────┴─────────────────────────────────────┐
│  DSH 既有的循环底座（本框架只消费，不修改）                            │
│  agent-loop · goal · ralph · subagent · workflow · jobs ·            │
│  compaction · token-meter · spill · checkpoint-policy ·              │
│  workspace-changes · storage-domain · session-projection · team      │
└─────────────────────────────────────────────────────────────────────┘
```

### 5.2 数据流（一轮的生命周期）

```
       ┌── RoundDriver 决定开新一轮 ──┐
       │                              ▼
       │                  ① ORIENT: systemPrompt.context() 注入 Run State Block
       │                              │
       │                  ② ACT:    agent-loop 正常跑一个 turn
       │                              │
       │                  ③ OBSERVE:  tools/result + workspace/changes
       │                              │      → 提取事实 → longloop/ledger 事件
       │                              │      → Budget Governor 计费
       │                              │
       │                  ④ VERIFY:  仅当"声称完成/计划走完/每 K 轮"
       │                              │      → Verification Gate → longloop/verdict
       │                              │
       │                  ⑤ DECIDE:  agent/turn-stopping
       │                              │      → 算停滞分 → 选动作
       │                              │
       └──── continue ────────────────┤
                                      ├── replan       → 注入重规划指令
                                      ├── switch-mode  → inline ⇄ fresh
                                      ├── diagnose     → 起诊断子智能体
                                      └── terminate    → 写终态 + 交接包
```

---

## 6. 数据模型

### 6.1 Run（运行实体 —— 跨会话）

```ts
interface Run {
  id: RunId                          // 'R-' + nanoid
  createdAt: number
  updatedAt: number

  // ── 契约（开工前谈定，之后不可静默修改）──
  objective: string                  // 一句话目标
  contract: Contract

  // ── 执行配置 ──
  mode: 'inline' | 'fresh' | 'hybrid'
  assurance: 'self' | 'executable' | 'independent'
  budget: Budget
  escalation: EscalationConfig

  // ── 运行状态 ──
  state: RunState
  round: number
  currentTaskId?: TaskId
  stalledRounds: number              // 连续无进展轮数
  escalationLevel: 0 | 1 | 2 | 3 | 4 | 5

  // ── 绑定 ──
  workspaceCwd: string
  sessionIds: SessionId[]            // 参与过的会话（inline/fresh 都会追加）
  ownerSessionId: SessionId          // 当前"主"会话
}

type RunState =
  | 'draft'        // 刚创建，契约尚未确认
  | 'armed'        // 已授权，等待驱动
  | 'running'
  | 'paused'       // 人类暂停
  | 'verifying'
  | 'suspended'    // 进程重启后恢复，等待显式 re-arm（A6）
  | 'done'         // verified-complete
  | 'exhausted'    // 预算耗尽
  | 'blocked'      // 需要人类输入
  | 'aborted'      // 人类中止
```

### 6.2 Contract（验收契约）

```ts
interface Contract {
  deliverable: string                // 交付物是什么（可指路径/产物）
  acceptance: Criterion[]            // 验收标准，每条尽量可执行
  constraints: string[]              // 硬约束（不许改 X、必须用 Y）
  nonGoals: string[]                 // 明确不做的事
  confirmedBy: 'human' | 'model'     // 人类确认过 vs 模型自拟
}

interface Criterion {
  id: CriterionId                    // 'C1'...
  statement: string                  // 人话描述
  check?: ExecutableCheck            // 可执行检查（assurance >= executable 时必填）
  weight: 'required' | 'nice-to-have'
}

interface ExecutableCheck {
  kind: 'command'
  command: string                    // 在 workspaceCwd 下执行
  expect: { exitCode: number } | { stdoutMatches: string } | { fileExists: string }
  timeoutMs: number
}
```

**设计要点**：`check` 可选但**强烈建议**。
当 `assurance === 'self'` 时允许全无 check；`executable` 要求所有 `required` 标准有 check；
`independent` 在 executable 基础上再加一个独立评估器。

#### Contract 与 Loop Contract 框架的对应

Awesome Loop Engineering（2026，聚合 1017 条资源 / 479 篇论文 / 22 个 schema 校验契约）
提出的 **Loop Contract** 与本设计的目标一致：**把"人在一次性 session 里临时给出的决策"
固化成可评审、可复用的运行规格**。它的三段式与本框架的映射：

| Loop Contract 阶段 | 部件 | 本框架对应 |
|---|---|---|
| **1. Setup** | Objective | `Run.objective` |
| | Trigger | `Run` 的创建方式（人工 / `/run` / 计划任务 / webhook） |
| | Intake | `Contract.acceptance` 的门槛 —— 什么工作算合格 |
| | Workspace | `Run.workspaceCwd` + 写入范围约束 |
| **2. Run** | Context | **Run State Block** + 约束白名单 |
| | Delegation | `Run.mode`（inline/fresh/hybrid）+ 子智能体策略 |
| | **Verification** | **Verification Gate**（三层检测 + assurance 级别） |
| | State | **Run Ledger** + `storageDomain` |
| **3. Govern & close** | **Budget** | **Budget Governor**（多维 + 阶梯） |
| | **Escalation** | **Escalation Policy**（L0–L5 + 人机通道） |
| | **Exit** | 五种终止语义 + **Handoff Package** |
| | **Next action** | 交接包的"下一步"段 + 重新 arm 入口 |

它的核心论断值得原文引用：

> **未回答的问题会变成隐藏的默认值**：agent 可能选错工作、自行扩大范围、
> 批准自己的输出、忘记先前的失败、或者无限重试而没有停止规则。

→ 这正是**为什么 Contract 必须在 `armed` 之前完整填好**：
留空的字段不会保持中立，它会变成某个未经审查的默认行为。
**`draft` 状态存在的唯一意义，就是让这些字段被显式回答。**

Loop Contract 给的一个完整样例（PR babysitter）可直接作为 `Contract` 的填法参考：
> 工作时间内每 2 小时运行一次；只选单个 PR 上的显式 blocker；用专用 branch/worktree；
> 允许窄修与 progress comment，**禁止 force push、依赖升级、secrets 访问、生产变更**；
> 要求 GitHub checks 通过 + review thread 解决 + diff 保持在被授权范围内；
> 持久化命令、check URL、改动文件、blocker、下一步动作；
> **3 次重试或 60 分钟后停止**；架构决策、重复失败、reviewer 分歧
> **升级给人类 owner**；成功条件 = PR 可合并或只等人工 review。

### 6.3 Plan & Task（计划树）

```ts
interface Task {
  id: TaskId                         // 'T1'...
  title: string
  status: 'pending' | 'in_progress' | 'done' | 'dropped'
  addresses: CriterionId[]           // 这个任务在满足哪条验收标准
  evidenceIds: EvidenceId[]          // 完成后附上的证据
  dependsOn: TaskId[]
  attempts: number
  note?: string
}
```

**设计要点**：Task 必须 `addresses` 至少一条验收标准。
这一条约束就把"计划"和"验收"绑死了，从结构上杜绝"做完一堆和验收无关的事"。

### 6.4 LedgerEntry（进度事实）

```ts
interface LedgerEntry {
  id: LedgerId
  round: number
  at: number
  kind: 'file-change' | 'command' | 'test-result' | 'artifact'
      | 'decision' | 'assumption' | 'blocker' | 'evidence'
  // 事实类（可自动提取）
  detail: string                     // 一句话事实
  ref?: { path?: string; hash?: string; command?: string; exitCode?: number }
  // 判断类（模型写入）
  rationale?: string
  source: 'auto' | 'model' | 'human'
}
```

**设计要点**：`source: 'auto'` 的条目由 Governor 从工具结果/工作区变更自动生成，
**模型无法伪造**。停滞检测只看 auto 条目——模型可以写 10 条"我有进展"，
但文件没变就是没变。

**死胡同（anti-recurrence）必须单独持久化。**
Memory as Infrastructure（2609.05510）的运维记录【工程经验，N=1】把
**anti-recurrence store（记录决策**与**死胡同）**列为长期运行 agent 最关键的组件之一：
它让 agent 不会在几十轮后重新尝试一个已经被证伪的方案。
本框架把它做成台账的一等类别：

```ts
LedgerEntry.kind = 'dead-end'        // 例："试过 msgpack 序列化，无法处理循环引用，放弃"
LedgerEntry.ref  = { command?, path?, hash? }   // 必须附可复核的证据
```

死胡同条目进 Run State Block 的 `<decisions>` 段（带"已否决"标记），
并在 L2 replan 时**强制注入**——重规划必须给出与所有死胡同都不同的路径。

**⚠️ 记忆不是单调有益的。**
AgentCL / MemProbe（2606.02461）【强实证，负面】：在朴素/留出设置下，
**记忆可能带来负收益（memory-induced degradation）**；记忆设计之间的差异
在非受控任务流上几乎无法区分。

→ **两条约束**：
1. 台账**必须有写入过滤**：只有**被环境验证过的事实**（auto 条目）才进台账；
   模型的自我评价不进。
2. Run State Block 的 `<decisions>` / `<evidence_index>` 段
   **按"最近被真正用到过"排序截断**，而不是全量倾倒。
   这不只是省 token —— 是把"什么该进工作记忆"的决定权从"写得多的人"手里拿回来。

### 6.5 Evidence（证据索引）

```ts
interface Evidence {
  id: EvidenceId                     // 'E-7'
  kind: 'file' | 'command-output' | 'test-report' | 'diff' | 'url'
  pointer: string                    // 路径 / spill 引用 / URL
  hash?: string                      // 内容 hash（防篡改）
  workspaceHash: string              // 记录时的 git tree hash
  producedByRound: number
  addresses: CriterionId[]
  bytes?: number                     // 便于预算核算
}
```

**设计要点**：Evidence 是**指针 + hash**，不是内容。
大内容走 `dsh-spill-policy` 落到 spill 文件，台账里只存定位符。
验证时 verifier 拿指针自己去读，读到什么算什么——**信任链不经过执行者**。

### 6.6 Verdict（裁决）

```ts
interface Verdict {
  id: VerdictId
  round: number
  at: number
  level: 'self' | 'executable' | 'independent'
  status: 'pass' | 'fail' | 'unknown' | 'partial'
  perCriterion: Array<{
    id: CriterionId
    status: 'pass' | 'fail' | 'unknown'
    method: string                   // 怎么验的
    evidenceRef?: EvidenceId
    note?: string
  }>
  counterexamples: string[]          // 具体反例（不许空泛）
  confidence: number                 // 0..1
  nextActions: string[]              // fail 时给执行者的具体建议
}
```

**设计要点**：`unknown` 是**合法且被鼓励**的结果。
强行给 pass 的验证器是有害的——比没有验证器更糟，因为它制造虚假信心。

### 6.7 Budget（多维预算）

```ts
interface Budget {
  rounds:    { limit: number; used: number }
  tokens:    { limit: number; used: number }      // 来自 ctx.tokenMeter
  wallClock: { limitMs: number; usedMs: number }
  toolCalls: { limit: number; used: number }
  subagents: { limit: number; used: number }
  costUsd?:  { limit: number; used: number }      // 路由有价格时才有
  onExhaust: 'hard' | 'handoff'                   // 耗尽即停 / 先产交接包再停
  ladder: LadderRung[]                            // 降级阶梯（见 8.1）
}

interface LadderRung {
  atRatio: number                    // 0.6
  action: 'log' | 'narrow-scope' | 'downgrade-model'
        | 'disable-exploration' | 'force-wrapup' | 'stop'
}
```

---

## 7. 循环协议（核心）

### 7.1 状态机

```
                  run_start
                     │
                     ▼
                 ┌────────┐  契约未经人类确认
                 │ draft  │───────────────┐
                 └───┬────┘               │
        arm (人/自动) │                    │
                     ▼                    │
   ┌────────────▶┌────────┐               │
   │             │ armed  │◀──────────────┘
   │             └───┬────┘
   │       RoundDriver 开轮
   │                 ▼
   │   ┌─────────▶┌─────────┐
   │   │          │ running │
   │   │          └────┬────┘
   │   │               │
   │   │    ┌──────────┼──────────────┬─────────────┐
   │   │    │          │              │             │
   │   │  DECIDE   预算耗尽      声称完成/计划走完  人类暂停
   │   │    │          │              │             │
   │   │    │          ▼              ▼             ▼
   │   │    │    ┌──────────┐   ┌───────────┐  ┌────────┐
   │   │    │    │exhausted │   │ verifying │  │ paused │
   │   │    │    └──────────┘   └─────┬─────┘  └───┬────┘
   │   │    │                         │            │
   │   │    │              ┌──────────┼────────┐   │ resume
   │   │    │           pass        fail    unknown│
   │   │    │              │          │        │   │
   │   │    │              ▼          └────────┴───┘
   │   │    │         ┌────────┐          回到 running
   │   │    │         │  done  │
   │   │    │         └────────┘
   │   │    │
   │   │    └── continue ──┐
   │   └───────────────────┘
   │
   │  阻塞判定 ──▶ ┌─────────┐
   └──────────────│ blocked │
                  └─────────┘

   进程重启 ──▶ ┌───────────┐  显式 re-arm   ┌────────┐
               │ suspended │───────────────▶│ armed  │
               └───────────┘                └────────┘
```

### 7.2 每轮五拍

| 拍 | 挂载点 | 做什么 | 失败处理 |
|---|---|---|---|
| **① ORIENT** | `systemPrompt.context()` | 渲染 Run State Block（见 7.3） | 渲染失败 → block |
| **② ACT** | `agent-loop` | 模型正常跑一个 turn | turn error → 计入 error budget |
| **③ OBSERVE** | `tools/result` + `workspace/changes` + `agent/turn-stopping` | 提取事实 → `longloop/ledger`；计费 | 提取失败 → 记 warning，不阻断 |
| **④ VERIFY** | 触发条件满足时 | Verification Gate → `longloop/verdict` | 验证器崩溃 → `unknown`，不假 pass |
| **⑤ DECIDE** | `agent/turn-stopping` + idle | 算停滞分 → 选动作 → 排下一轮或终止 | 决策失败 → **fail-closed 停止** |

### 7.3 Run State Block（外部记忆的载体）

这是整套设计里**最关键的一个数据结构**。它每轮重新渲染，走 runtime context 通道，
所以：(a) compaction 压不掉它；(b) 永远反映最新真相；(c) 有独立 token 上限。

```xml
<run_state id="R-7f3a" round="12" cap="40" state="running" mode="inline">
  <objective>把 packages/auth 的会话存储从内存改成 Redis，并保持现有测试全绿</objective>

  <contract confirmed="human">
    <deliverable>可合并的 PR：Redis 会话存储 + 迁移说明</deliverable>
    <acceptance>
      <criterion id="C1" weight="required" status="pass">
        pnpm test packages/auth 全部通过
        <check>pnpm test packages/auth → exit 0</check>
      </criterion>
      <criterion id="C2" weight="required" status="unknown">
        重启进程后会话不丢失
        <check>bash scripts/session-persist-check.sh → exit 0</check>
      </criterion>
      <criterion id="C3" weight="nice-to-have" status="unknown">
        无 TODO 遗留</check>
    </acceptance>
    <constraints>不得修改 public API；不得引入新的外部依赖</constraints>
    <non_goals>不做多实例一致性；不做压测</non_goals>
  </contract>

  <plan>
    <task id="T1" status="done" addresses="C1">抽出 SessionStore 接口<ev>E-2</ev></task>
    <task id="T2" status="in_progress" addresses="C1,C2">实现 RedisSessionStore<ev>E-5</ev></task>
    <task id="T3" status="pending" addresses="C2">补重启持久化脚本</task>
    <task id="T4" status="pending" addresses="C3">清理遗留 TODO</task>
  </plan>

  <budget rounds="12/40" tokens="421k/1.5M" wall="38m/4h" toolCalls="211/600" status="ok"/>

  <last_round delta="+2 files, tests 41→47 pass, E-7 added" />

  <evidence_index>
    E-2 src/auth/store.ts (a91f3c) · E-5 src/auth/redis-store.ts (7b2e10)
    E-7 测试输出 spill://session-…/test-run-12.txt (exit 0)
  </evidence_index>

  <decisions>
    · 用 ioredis 而不是 node-redis：项目已有的依赖树里已有 ioredis，避免新增依赖 (constraint)
    · 不做连接池：当前 QPS 下无必要 (non-goal)
  </decisions>

  <open_questions>
    · C2 的验证脚本还不存在，T3 要创建它
  </open_questions>

  <stall count="0" last_signal="none"/>
</run_state>
```

**预算控制**：整个 block 有 `maxBlockTokens`（默认 ~2000）。
超了就按优先级裁剪：`decisions` → `evidence_index` → `last_round` 依次压缩，
`objective` / `contract` / `plan` / `budget` **永不裁剪**。

#### ⚠️ 投递通道：必须分两段（本设计在此处被修正）

**问题**：Run State Block 每轮都变。如果它整体走 `systemPrompt.context()` 重渲染，
那么**每轮都在改 system prompt** —— 而前缀缓存的第一条纪律就是
**"改 system prompt 会让后面全部失效"**（Claude Code 的 prompt caching 文档明确记录：
正因如此，plan mode 与 skill 加载都以**对话消息**的形式追加，以保住前缀）。

**但反过来**：如果全部走对话消息追加，compaction 会把它吃掉。

**解法是分两段**（这也是 Codex 五层指令模型的直接推论）：

| 段 | 内容 | 通道 | 变化频率 | 压缩后 |
|---|---|---|---|---|
| **静态段** | `objective` · `contract`（含 acceptance / constraints / non-goals） | **system prompt / initial context** | 极少（契约冻结后不变） | **重新注入**（Codex 的 `initial_context` 语义） |
| **动态段** | `round` · `budget` · `plan` 状态 · `last_round delta` · `stall` | **每轮追加一条 user-role 消息** | 每轮 | 随历史滚动，靠静态段兜底 |

```ts
// 静态段：注册一次，契约冻结后不再变 → 前缀稳定
ctx.systemPrompt.context({
  name: 'longloop_contract', order: 15,
  text: ({ scope }) => renderContract(longLoop.runFor(scope)),   // 只在契约变化时变
})

// 动态段：每轮作为一条 user-role 消息追加（照抄 goal-round 的做法）
// source: { kind: 'plugin', plugin: 'longloop', form: 'snapshot',
//           sections: [{ name: 'plan', text }, { name: 'budget', text }, ...] }
queueRoundMessage(agent, { round, budgetLine, planDigest, lastDelta, stall })
```

**DSH 侧的对应机制**：`agent-loop` 会记录
`request/context = { provider, model, contextWindow, systemPromptUpdate }`，
其中 `systemPromptUpdate` 是**路由声明**的更新模式 —— 这条正是决定
"prompt 变化如何进入请求"的开关。实现时按路由的该模式选择通道，
**不要绕过它自己拼 system 消息**。

**KV cache 影响必须写进设计**（照 `dsh-goal-round-driver` 的 README 格式）：

| | 静态段 | 动态段 |
|---|---|---|
| Token | 一次性 + 每次缓存后重注入 | 每轮固定一小段 |
| KV Cache | **前缀稳定，命中率高** | **append-only**，落在可复用前缀之后 |
| 压缩后 | **重新注入**（契约永不丢） | 可能被摘要吸收，但静态段保证了关键约束不丢 |

**为什么不用对话历史存这些**（原论证仍然成立，只是修正了通道）：因为 compaction 的摘要模型不知道什么重要。
把它放 runtime context，等于**把"什么重要"的决定权从摘要模型手里拿回来**。

### 7.4 轮次提示模板

每轮开始时（在 Run State Block 之外）注入一段固定指令：

```markdown
<run_round id="R-7f3a" round="13" cap="40">

继续推进上面的 run。

要求：
1. 先读 <run_state>，确认当前任务（T2）和它的验收标准（C1, C2）。
2. 只做能推进 T2 的事。做完就把 T2 标 done 并附证据；做不动就说明卡在哪。
3. 不要重复已经记录在 <decisions> 里的探索。
4. 三件事之一发生时立即停止本轮：
   · 达成验收标准 → 调 run_verify
   · 遇到需要人类决策的岔路 → 调 run_block
   · 本轮无事可做 → 说明原因
5. 记住：你宣称完成不会让 run 结束，验证通过才会。

[第 12 轮验证反馈（若有）]
C2 未验证：scripts/session-persist-check.sh 不存在。
</run_round>
```

### 7.5 三种驱动模式

这是框架里唯一"新"的执行机制，必须说清楚它怎么落到 DSH 的既有服务上。

| 模式 | 谁在干活 | 记忆连续性 | 抗上下文污染 | 成本 | KV cache |
|---|---|---|---|---|---|
| `inline` | owner session 的 agent 自己 | 强（同一会话） | 弱 | 低 | 友好（append-only） |
| `fresh` | 每轮一个**全新子会话**的 agent | 弱（只有 Run State Block） | 强 | 高 | 每轮独立 |
| `hybrid` | 默认 inline，停滞时自动切 fresh | 自适应 | 自适应 | 中 | — |

**`inline` 的驱动循环**（owner session 内）：

```
agent 空闲
  → driver 预留 round N，flush 会话
  → 通过 inbox 排入 <run_round> 消息（source: plugin, form: instructions）
  → agent/pre-step 双重围栏校验 run revision
  → agent 跑完一个 turn
  → agent/turn-stopping 观察 + 计费 + 评分
  → 回到"agent 空闲"
```

**`fresh` 的驱动循环**（owner session 只做监督）：

```
owner agent 空闲
  → driver 创建一个全新子会话的 agent
     种子 = <run_round> + <run_state>（不含 owner 的任何对话历史）
     工作目录 = run.workspaceCwd（共享工作区就是跨轮长期记忆）
  → 子 agent 跑完并 quiesce
  → driver 从【子会话的】事件流里提取台账（tools/result + workspace/changes）
     并读回子 agent 的结构化交接（status / summary / evidence / next）
  → 追加到 Run 台账；子会话进入 run.sessionIds[]
  → 决定：再起一个子会话 / 切回 inline / 终止
```

**关键实现点**：

1. 子 agent 用 `ctx.agents.create()` 创建，`parentAgent` 指向 owner，
   这样血缘、cwd、工具策略都继承，但**对话历史不继承**。
2. 每轮的交接必须是**结构化输出**
   （沿用 `dsh-tool-ralph` 的 report schema 思路：`status` / `summary` / `evidence` / `next` / `blocker`），
   校验失败即判定该轮失败，**不做截断、不当成预算耗尽**。
3. `fresh` 模式天然可以**后台化**：把整轮放进 `ctx.jobs`，
   owner session 保持可响应人类输入 —— 这补上了 DSH 明确记录的
   *"Foreground only — no job id, background collection, process-resume checkpoint"* 缺口。
4. 两种模式共享**同一个 Run 台账**，所以 L3 切换是无损的：
   切模式只是换"谁在干活"，Run 状态一字不改。

**为什么 `hybrid` 是默认**：
`inline` 便宜且连续，但上下文一旦被污染就再也出不来；
`fresh` 干净但每轮从零开始，隐性知识全丢。
真实的工程答案是"平时 inline，卡住了就 fresh"——
而这恰好就是 L3 升级动作，不需要额外机制。

---

## 8. 六个治理器详设

### 8.1 Budget Governor（预算治理）

**计量来源**（全部零额外成本）：

| 维度 | 来源 |
|---|---|
| rounds | 驱动器自增 |
| tokens | `ctx.tokenMeter.measure(session)` 的 `tokenUsage` / `contextPressure` |
| wallClock | `ctx.timer` + Run 的 `createdAt`/`pausedTotalMs` |
| toolCalls | `tools/result` 计数 |
| subagents | `subagent/start` 事件 |
| costUsd | 路由声明的价格 × tokens（路由不声明则该项缺席） |

**降级阶梯**（这是"工程"感最强的地方）：

模型在本轮开始时就能看到 `budget status`，并且每次跨过阶梯会收到一条注入提示：

| 比例 | 动作 | 注入给模型的话 |
|---|---|---|
| 0.6 | `log` | （无，只记事件） |
| 0.7 | `disable-exploration` | "预算已用 70%。停止探索性阅读/搜索，只在必要时读文件。" |
| 0.8 | `narrow-scope` | "预算已用 80%。把范围收窄到 required 验收标准，放弃 nice-to-have。" |
| 0.9 | `force-wrapup` | "预算已用 90%。现在开始收尾：完成当前任务的最后一步，然后产交接包。" |
| 1.0 | `stop` | 走 [9.2](#92-budget-exhausted预算耗尽) |

**关键设计**：阶梯不是"省钱"，而是**把"如何优雅降级"编码进循环**。
裸循环在预算耗尽时是"戛然而止，什么都没交付"；有阶梯的循环会先 `narrow-scope`
再 `force-wrapup`，最后交付一个**部分可用的结果 + 清晰的剩余工作**。

**软/硬策略**：
- `onExhaust: 'hard'` —— 到 1.0 立刻停
- `onExhaust: 'handoff'` —— 到 1.0 先跑一次"交接包生成"（允许超支 1 轮），再停

### 8.2 Progress Governor（进度治理与停滞检测）

**信号表**（全部可从既有服务自动提取，模型不可伪造）：

| 信号 | 来源 | 权重 | 说明 |
|---|---|---|---|
| 工作区零变更 | `workspace/changes` 事件 | **3** | 最强信号：整轮没动过任何文件 |
| 无新增 auto 台账条目 | ledger | **3** | 没有任何事实产生 |
| 同一 blocker 重复 | `run_block` / verdict | **3** | 卡在同一个点上 |
| 测试通过数无变化 | 解析 bash 工具结果 | 2 | 有动作但没效果 |
| plan 无推进 | Task 状态查询 | 2 | 任务状态原地踏步 |
| 只读操作占比 > 90% | `tools/result` | 1 | 一直在读，没在写 |
| 完全重复的工具调用 | 复用 repeat-tool-reminder 思路 | 1 | 最弱，容易误报 |

**停滞分**：`stallScore = Σ(命中信号权重)`，阈值默认 `≥ 4` 记为一次"停滞轮"。
连续 `stalledRounds` 递增，任一实质进展则归零。

#### 四类卡死模式（借 OpenHands `StuckDetector`，可直接实现）

**这是"停滞分"之外的第二个正交检测器**，比加权评分更精确。
OpenHands 的实现细节值得照抄：

```
MAX_EVENTS_TO_SCAN = 20
// 注释解释了窗口大小："4 repeats × 2 events per cycle = 8 events minimum,
//                     plus buffer for user messages"
```

| # | 模式 | 判据 | 长任务里的表现 |
|---|---|---|---|
| 1 | **(action, observation) 重复** | 最近 N 个事件里同一对出现 ≥ 4 次 | 反复跑同一个命令，拿到同样的输出 |
| 2 | **action-error 重复** | 同一动作反复报同一个错 | 改不对的测试一直改不对 |
| 3 | **monologue（自言自语）** | 连续多个助手事件之间**没有用户输入** | 无人值守时最危险 —— 没有外部信号也没有进展 |
| 4 | **交替模式** | 两个动作往复交替 | A 改坏 → B 修回 → A 又改坏 |

**关键设计：先 nudge 一次，再判 stuck。**
OpenHands 的 `_check_stuck_or_nudge()` 先调 `get_action_error_nudge()`，
**只有 nudge 无效才调 `is_stuck()`**。
→ 这正是本框架 [L1（带外部信号的提示）](#82-progress-governor进度治理与停滞检测)
与 stuck 判定之间的衔接点，不要一上来就升级。

**两个廉价护栏**（Goose 的做法，成本近乎零）：
- `MAX_EMPTY_TURN_RETRIES = 3` —— 连续空轮 3 次就退出
- `DEFAULT_MAX_TURNS = 1000` —— 默认值就不该是个小数

**DSH 侧的现成实现**：`dsh-repeat-tool-reminder` 已经在做模式 1 的弱化版
（完全相同工具调用的连续计数，默认阈值 3/5/8，advisory 而非阻断）。
本框架**复用它作为信号源之一**，不重写；额外补上模式 2/3/4。

#### 实现细节（三条来自生产事故的硬约束）

**① 工作区 digest 必须每轮重算，且排除引擎自身的写入**

```
progressDigest(cwd, round):
  files = walk(cwd)
  exclude: '.longloop/**'            # 本框架自己写的台账/交接包
  exclude: run.stateArtifacts        # 允许 run 显式声明为"引擎产物"的路径
  return sha256(concat(sorted(path, sha256(content))))
```

**事故记录**（bounded-loops 的真实 bug）：早期版本用 `git status` 对比一个
**"loop 装配时取一次、之后再也不刷新"**的快照 → 第 2 轮之后 `changed` 永远为 True，
**这个软上限根本无法触发**。

**DSH 侧的天然优势**：不要自己实现 digest。
`dsh-workspace-changes` 已经在**每个顶层 turn** 的起止各做一次 git working-tree 快照，
并发出 `workspace/changes` 会话事件（含每文件行数）。
框架直接消费这个事件即可，**只需排除自己写的路径**。

**② 台账必须区分"尝试"与"执行"**

每条 ledger 行带 `attempted: boolean`：
只有 kill switch 与 budget ceiling 在 turn 前检查的情况为 `false`。
否则轮次计数与尝试次数不可区分（`max_iterations: 10` 会写第 11 行，算出来 1.1）。
原文：**"不能被自己的收据审计的成本声明不是成本声明。"**

**③ 硬上限与软窗口必须并存**

| 类型 | 参数 | 默认 | 作用 |
|---|---|---|---|
| **硬上限** | `maxRounds` | 1000（**不可被模型覆盖**） | 把"永远运行"变成"在第 N 轮大声失败" |
| **硬上限** | `maxWallClockMs` | 按任务定 | 同上 |
| **软窗口** | `noProgressWindow` | 3 | 抓"还在跑但已不再改变任何东西"的空转 |
| **软窗口** | `sameBlockerWindow` | 3 | 抓"同一个阻塞条件反复出现" |

**④ 无进展检测的升级信号应该是"外部信号"，不是"再想想"**

LLMs Cannot Self-Correct Reasoning Yet (2310.01798)【强实证】：
**没有外部反馈时自我纠错会降低准确率。**
→ L1 注入的内容必须包含**具体的外部事实**（"工作区 digest 已连续 2 轮未变"、
"上一次测试输出仍然是同样的 3 个失败"），而不是一句"换个思路试试"。

**升级阶梯**（**换手段，不是重试**）：

| 级 | 触发 | 动作 | 为什么要这样 |
|---|---|---|---|
| **L0** continue | stall=0 | 正常下一轮 | — |
| **L1** nudge | stalledRounds = 1 | 注入强制反省：先写出 2 个**不同的**假设，再动手 | 打破惯性，成本几乎为零 |
| **L2** replan | stalledRounds = 2 | 强制重出 plan，且必须**结构性不同于**上一版；走 `plan-mode` 的纪律 | 换路径，而不是同路更用力 |
| **L3** switch-mode | stalledRounds = 3 或 上下文压力 > 85% | `inline → fresh`：起一个**全新 agent**，只带 Run State Block + 证据指针 + 最近一次裁决 | 上下文被污染时，遗忘比重试有效 |
| **L4** diagnose | stalledRounds = 4 | 起一个**只读**诊断子智能体，独立读工作区与日志，输出"为什么卡住"的结构化报告，注入主线 | 引入独立视角，不占用主线上下文 |
| **L5** block | stalledRounds = 5 或诊断判定不可解 | 转 `blocked`，生成人类交接包 | 诚实上报胜过烧预算 |

**L3 是这套设计里最有价值的一条**：它把 Ralph 循环的洞察
（"上下文污染时全新 agent 更强"）变成了**自动触发的一条升级路径**，
而不是一个需要人类记得去用的工具。

### 8.3 Context Governor（上下文治理）

**职责**：控制进入每轮的上下文，抑制熵增。

| 手段 | 实现 |
|---|---|
| **Run State Block 常驻** | `systemPrompt.context()`，每轮重渲染，compaction 免疫 |
| **证据只存指针** | `Evidence.pointer` → 大内容走 `spill-policy` |
| **探索隔离** | 高噪声调研强制走子智能体（提示段约束 + `subagent` 工具） |
| **主动压缩阈值** | 上下文压力 > 70% 时主动触发 `ctx.compaction.compactNow()`，而不是等自动触发（自动触发时已经太晚了） |
| **决策日志** | 防止重复探索同一个已被否决的方案 |
| **技能沉淀** | Run 结束时可把可复用流程写成 skill（复用 DSH `skills`） |

#### 约束白名单（本框架最重要的一条压缩防线）

Lost in Compaction (2608.11242)【强实证】：现有 compactor 平均只保留
**17%** 的 session constraints，**多数 compactor 比不压缩还差**。

即使 Contract 已经走 runtime context，仍然必须假设**部分约束只存在于对话历史里**
（人类中途说的话、模型自己发现的边界条件）。所以压缩前后各做一次白名单检查：

```ts
// 压缩前：抽取"约束候选"并落进台账（此时还在原始历史里，抽得准）
const constraints = await extractConstraints(session)   // 独立的小模型调用
run.constraints.push(...constraints)                    // 进 storageDomain，永久保留

// 压缩后：确认所有 required 约束仍在
for (const c of run.constraints.filter(c => c.weight === 'required')) {
  if (!survivesCompaction(c, session)) {
    escalate({ kind: 'constraint-loss', constraint: c })  // 立即注入补回
  }
}
```

**约束候选的三种形态**（抽取器的目标）：

| 形态 | 例子 | 抽取线索 |
|---|---|---|
| **禁令** | "在我确认前不要删任何邮件" | 否定词 + 祈使句 |
| **边界** | "不得修改 public API" | Contract.constraints（已在白名单里） |
| **前置条件** | "必须先备份再改 schema" | 顺序词 + 状态改变动词 |

抽取出来的约束进 `Run.constraints[]`，**同时**进入 Run State Block 的 `<constraints>` 段
（在 2000 token 上限内享有最高保留优先级）。

**代价**：一次额外的小模型调用 + 每次压缩后的一次检查。
对比 MEA 的 auditor 占 19–38% token，这个代价可以忽略，但避免的是最贵的一类失败
（跑了 40 轮才发现违反了第 3 轮人类说过的一句话）。

#### 压缩的三条硬不变量（违反任何一条都会产生不可恢复的坏历史）

这些不变量在 Codex、Claude Code、OpenHands 里都被**硬编码进 harness**——
**不能指望模型或摘要器去维持**：

| # | 不变量 | 违反后果 | 具体做法 |
|---|---|---|---|
| **1** | **不切断 `tool_call` ↔ `tool_result` 配对** | 模型收到孤儿调用，会"回答"一个不存在的请求 | 切掉 tool output 时**同步删掉配对的 tool call**（Codex 的 `normalize::remove_corresponding_for`） |
| **2** | **不切断 thinking block 与消息边界** | 位置规则被破坏，推理内容错位 | 见 Claude Code 的 `findSafeBoundary`：**不在 tool call 中间切、不切含 thinking block 的消息** |
| **3** | **summary 固定在历史尾部** | 破坏模型训练时形成的 contract | Codex 的插入位置有四级 fallback：`last_real_user_index ?? last_user_or_summary_index ?? last_compaction_index ?? append` |

**外加一条元规则：压缩结果作为新事件追加，绝不原地改历史。**
这是事件溯源的第一原则。三个框架一致采取这个做法：
Codex 用 `Compaction` item + 白名单 filter；OpenHands 的 `Condensation` 是一个事件、
`View` 只是派生视图；Claude Code 的 rewind 是"截断回一个已缓存前缀"（保留历史，只改游标）。
**任何"原地改历史"的压缩都会让审计与回滚同时失效。**

**保留窗口的参考取值**（跨实现的经验区间，可作默认值起点）：

| 参数 | 参考值 | 来源 |
|---|---|---|
| 保留最近消息数 | **10** 条 | Claude Code |
| 保留最近 token | **2,000 ～ 15,000**（下界/上界） | OpenCode `MIN/MAX_PRESERVE_RECENT_TOKENS` |
| 压缩触发比例 | **0.85 警告 / 0.95 强制** | Claude Code（社区逆向） |
| 压缩缓冲 | **20,000** tokens | OpenCode `COMPACTION_BUFFER` |
| 裁剪保护窗口 | **40,000** tokens（只有能省出 ≥20k 才值得裁） | OpenCode `PRUNE_PROTECT` / `PRUNE_MINIMUM` |
| 单条工具输出硬截断 | **2,000** chars | OpenCode `TOOL_OUTPUT_MAX_CHARS`（DSH 用 `tool-result-pruner` 的 8192/4096/1024） |
| summary 里保留的用户消息 | 从后往前收集至 **20,000** tokens | Codex `COMPACT_USER_MESSAGE_MAX_TOKENS` |
| 首 N 个事件永不压缩 | **2** | OpenHands `keep_first`（且校验 `keep_first < max_size // 2`） |

**压缩后必须显式告知模型**（否则它会困惑于"我为什么记不清"）。
Goose 的三段 continuation 文本值得直接借用其措辞：

> "Your context was compacted. The previous message contains a summary of the conversation so far.
> **Do not mention that you read a summary** … Just continue the conversation naturally."

**⚠️ 一个必须记录的副作用**：Codex 的 `should_keep_compacted_history_item`
把所有 developer messages 当作 *"stale/duplicated instructions"* **整批丢弃**，
而且**这是静默的**。

→ **对本框架的直接约束（A8 的强化）**：
**任何跨压缩必须存活的东西，要么进静态段（system prompt / initial context），要么进文件。**
放进"每轮注入的动态段"或"developer 消息"的东西，**压缩后一定会丢**。
这就是为什么 §7.3 把 Contract 划进静态段。

#### 上下文健康度指标

**上下文健康度指标**（记入台账，用于 L3 触发判断）：

```
health = 1 - (contextPressure / contextWindow)
         加权：历史轮数增长惩罚 + 未解决 open_questions 数量惩罚
```

**为什么主动压缩很重要**：DSH 的自动压缩在"压力达到阈值"时触发，
触发那一刻上下文已经很满，摘要质量最差。
在 70% 主动压缩，摘要模型有更充裕的注意力，**保留关键约束的能力显著更好**。

### 8.4 Verification Gate（验证门）

**触发条件**（任一）：
1. 模型调 `run_finish`（声称完成）
2. 所有 `required` 验收标准对应的 Task 都 `done`
3. 每 K 轮（默认 10）做一次**过程验证**（防止跑了 30 轮才发现方向错）
4. 人类调 `/run verify`

#### 三层检测：便宜的先跑（这是被实证逼出来的设计）

False Success (ICML 2026)【强实证】证明 **LLM judge 抓不住虚假完成**：
5 个 judge × 5 种 prompt × 完整任务规格，**没有一个 AUROC 超过 0.65**；
judge 被"自信收尾的语气"锚定，**断言丰富的轨迹反而打分更高（+0.27–0.36）**。
而一个轻量 TF-IDF 检测器 AUROC **0.83**、亚毫秒。

所以验证门不是"叫个模型看看"，而是**三层漏斗，便宜的在前**：

```
声称完成
   │
   ├─ 第 1 层：非 LLM 证据门（亚毫秒，永远跑）
   │    · 完成短语正则（"I've completed" / "All done" / "任务完成"）
   │    · 有工具报错但未重试就宣布成功     ← LangGraph 的信号 1
   │    · 有可用工具却从未使用             ← 信号 2
   │    · 探索步数 / 工作区变更量过少       ← 信号 3
   │    · 台账里 required 标准一条证据都没有
   │    命中 → 直接注入 challenge，不进入下一层
   │
   ├─ 第 2 层：确定性检查（秒级，assurance ≥ executable 时必跑）
   │    · 逐条执行 Contract.acceptance[].check
   │    · 记录 {exitCode, stdout hash, 前后 workspace digest}
   │    · digest 变化 → 证据失效 → unknown
   │
   └─ 第 3 层：独立评估器（分钟级，assurance = independent 时跑）
        · fresh context，只给 contract + 证据指针 + 只读工作区
        · 结构化输出，允许 unknown
        · 只用于**语义判断**（"这个实现是否真的满足了 C2 的意图"）
```

**第 1 层的价值**：它拦截的是**最廉价也最常见**的一类虚假完成 ——
"没跑任何检查就说完成了"。LangGraph 的 `_MAX_CHALLENGES = 2`
（防无限挑战循环）和 `_MIN_MESSAGES_BEFORE_GUARD = 4`（防误报）是现成的参数取值。

#### 契约冻结：验收检查不能由执行者生成

ExecCritic (2609.09133)【强实证】—— 固定 repair agent 不变：

| 配置 | SWE-bench 类成绩 |
|---|---|
| 无测试基线 | 61.2% |
| 由 repair agent **自己生成测试** | **57.3%（−3.9pt）** |
| 用强外部模型生成测试 | 65.3% |
| 测试/修复两角色各自 post-train 后组合 | **72.6%（+11.4pt）** |

机制：同一条 trajectory 既写 patch 又写 test → **两者的错误共振，产生假信心**。

→ **硬性约束**：
1. `Contract.acceptance[].check` 在 **Run 进入 `armed` 之前冻结**，
   之后任何修改都需要人类确认（记 `longloop/run` 事件）。
2. **执行者不能新增、修改、删除验收检查**。
   工具层面禁止：`run_start` 之后 `contract` 字段只读；
   工作区里位于 `Contract.frozenPaths` 的测试文件受写保护（`tools.guard`）。
3. 验证者只能用契约里的检查，**不许自己现编一个更宽松的**。

#### 污染控制：验证与评测环境必须隔离

Cursor 审计（2026-06-25）【强实证】：SWE-bench Pro 上 **63% 的"成功修复"是检索到答案**
（57% 查到已合并 PR、9% 挖 `.git` 历史）。**封住 git history + 断网后：
Opus 4.8 Max 87.1% → 73.0%，Composer 2.5 74.7% → 54.0%。**

→ 独立评估器（以及一切评测运行）默认：

- **不给出网权限**（`web_search` / `web_fetch` 工具 restrict 掉）
- **只给工作区的当前快照**，不给 `.git` 目录
- 隐藏测试（若验收检查里含"模型不该看到的"用例，放 `Contract.frozenPaths` 之外，仅在验证时挂载）

**验证环境的输入检疫清单**（借 bounded-loops 的实现，按名字 + 后缀排除）：

```ts
const QUARANTINE_NAMES = [
  '.git', '.env', '.env.local', '.ssh', '.aws', '.gnupg', '.netrc',
  'credentials', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
]
const QUARANTINE_SUFFIXES = ['.pem', '.key', '.p12', '.pfx']

// copytree 的 ignore 回调语义：在【每一层目录】上、大小写不敏感地执行
function quarantineIgnore(dir, names) {
  return names.filter(n =>
    QUARANTINE_NAMES.includes(n.toLowerCase()) ||
    QUARANTINE_SUFFIXES.some(s => n.toLowerCase().endsWith(s)))
}
```

**另一条来自 bounded-loops 的教训**：如果做沙箱拷贝，
**必须拒绝源目录里任何 symlink** —— 否则一个恶意的
`seed -> ~/.ssh` 会让 `copytree` 跟随它，在复制发生之前就击穿沙箱。

**为什么 `.git` 必须在检疫名单里**：Cursor 的审计显示
**9% 的"成功修复"来自 `git show <未来提交> -p` + `git cherry-pick`**。
`.git` 不只是历史，它是**答案的副本**。

#### 验证者的权限必须与执行者隔离（不可协商）

Codex CLI 的 **Guardian**（shell 命令审批的复审子 agent）设了一条硬规则：
**它不继承调用方的 exec policy**（源码里有 `guardian-reviewer-bypass-exec-policy` 这条规则）。
理由很硬：**一旦继承，调用方就可以通过复审者自我批准自己的命令。**

→ 本框架的三条对应不变量：

| # | 不变量 | 违反后果 |
|---|---|---|
| 1 | 评估器子智能体的工具策略**从零构建**，不继承 owner session 的 `permissionPresets` / `sandboxPolicy` | 执行者提权 → 自我批准 |
| 2 | 评估器**只读**（`tools.restrict({ deny: ['write','edit','str_replace_editor'] })`），且 **bash 只允许白名单只读命令** | 评估器"顺手修好再报告 pass" |
| 3 | **执行者不能修改评估器的提示词、契约或检查** | 执行者给自己出题（见上：61.2% → 57.3%） |

**其它可抄的隔离细节**：

- **干净 context 的 reviewer 更有效**（Cognition 的实测：Devin Review 平均每 PR 找到
  **2 个 bug，其中约 58% 是严重级别** —— 逻辑错误、缺失边界、安全漏洞），
  而且**它与 coding agent 事先完全不共享 context 时效果最好**。
  理由有二：① reviewer 被迫从实现反推规格，能质疑原 agent 因为用户指令本身有错而忽略的东西；
  ② 更短的 context 让模型"更聪明"。**这与本框架的 `independent` assurance 完全一致。**
- **但 review 结果必须由执行者用自己的宽上下文过滤**：
  Cognition 明确指出，coding agent 必须用自己掌握的（用户指令、已做决策）
  去筛掉 review 回来的噪声，否则会陷入循环、越权、做范围外的工作。
  → **Verdict 的 `nextActions` 是"建议"而不是"指令"**，由 RoundDriver 决定采不采纳。
- **评审者会幻觉不存在的问题**（CriticGPT 的记录 + Claude Code 官方警告：
  "一个被要求找 gap 的 reviewer 通常会报告一些 gap，即使工作本身是扎实的"）。
  → `Verdict.counterexamples` 必须**可复核**（具体到行/输入/输出），
    无法复核的 finding 降级为 `note`，不进 `nextActions`。

#### 验证的成本预算

MEA 的成本分解：**auditor 占 19.4–38.1% 的 token**，manager 只占 2–8%。
但换来 OSWorld 2.0 上 **3.0×** 的完成率。

→ 验证的 token **单独计入 `Budget.verifyTokens`**，不占用执行预算。
    否则阶梯降级会把验证先砍掉 —— 那是最不该砍的一项。
    默认配比：`verifyTokens ≤ 40% × execTokens`。

**三级 assurance**：

| 级别 | 谁验 | 怎么验 | 成本 | 适用 |
|---|---|---|---|---|
| `self` | 执行者自己 | 列出证据指针 + 自评 | 极低 | 探索性任务、无客观标准 |
| `executable` | **框架** | 框架**自己执行** `Criterion.check`，比对退出码/输出/hash | 低 | 有测试/脚本的工程任务 |
| `independent` | **独立评估器子智能体** | fresh context，只给 contract + 证据指针 + 工作区读权限 | 中 | 高价值、高风险的交付 |

**`executable` 的实现细节**（很关键）：
框架通过 `ctx.shell` 在 `workspaceCwd` 执行 `check.command`，
记录 `{exitCode, stdout hash, 执行前后的 git tree hash}`。
执行前后 tree hash 不同 → **证据失效**（有人在验证过程中改了东西）→ `unknown`。

**`independent` 的提示词骨架**：

```markdown
你是这次运行的独立验证者。你没有参与执行，也不了解执行过程的任何叙事。

你的唯一依据：
1. 下面的验收契约
2. 你自己在 /path/to/workspace 里能读到的东西
3. 你自己能跑的命令

规则：
- 不许采信任何"已完成/已修复"的陈述，包括证据条目里的描述。自己去验证。
- 每条验收标准给出 pass / fail / unknown。
- 给出 pass 必须有你自己复现的证据（命令 + 输出）。
- 证据不足时给 unknown，不要给 pass。unknown 不是失败。
- 给出 fail 时必须给**具体反例**（哪一行、哪个输入、什么输出）。
- 你只有读权限，不要修改任何文件。

输出 JSON（严格遵守 schema）：{status, perCriterion[], counterexamples[], confidence, nextActions[]}
```

**反 reward hacking 五条防线**：

1. **信息隔离**：评估器看不到执行历史（防被叙事说服）
2. **必须可执行**：`executable` 级别不接受任何文字证据
3. **hash 绑定**：证据带工作区 hash，验证时重算，不一致即失效
4. **验证者只读**：工具的 `restrict` / `guard` 限制，防止它"顺手修好再报告 pass"
5. **`unknown` 合法化**：显式告诉验证器"给 unknown 不是失败"——
   否则 LLM 评委天然倾向于给一个确定的答案

**过程验证（第 3 条触发）的设计意图**：
长任务最贵的失败不是"最后没做完"，而是"跑了 30 轮才发现第 3 轮的假设是错的"。
每 K 轮做一次轻量过程验证（只验最容易验的 1-2 条标准），能**把纠偏点前移**。

### 8.5 Escalation Policy（升级与人机协同）

**四种人机交互，各有明确的触发语义**：

| 类型 | 触发 | 通道 | 阻塞性 |
|---|---|---|---|
| **steer** | 人类随时 | inbox 注入 / Run Console | 非阻塞，下一轮生效 |
| **ask** | 模型调 `ask_user_question`；或 L4 诊断发现"需要人类知识" | `userQuestions` | 阻塞当前轮 |
| **approve** | 风险工具调用 | `approval` 服务 | 阻塞该调用 |
| **takeover** | 连续 blocked / 人类主动接管 | Run Console 的 Pause | 全停 |

**什么该问，什么不该问**（写进提示段，这是长任务质量的关键）：

```
只在下面三种情况打断人类：
1. 目标或验收标准本身需要人来定（例如"要不要兼容旧数据格式"）
2. 需要人类独有的信息或权限（账号、业务规则、外部系统状态）
3. 不可逆的高风险操作

不要在下面情况打断：
· 能通过读代码/跑命令查清的事实
· 你自己能试错验证的技术选型
· 你已经卡住但还没试过 L1/L2/L3 的手段
```

**L5 blocked 的必要条件**（防止模型动不动就"阻塞上报"）：
必须是**同一个具体阻塞条件**连续出现 ≥ N 次（默认 3），
且已经过完整的 L1→L4 升级路径。这条约束继承自 `dsh-tool-goal` 的 blocked threshold 设计。

### 8.6 Recovery & Idempotency（恢复与幂等）

**三层持久化**：

| 层 | 介质 | 内容 |
|---|---|---|
| **会话事件** | 会话日志（JSONL） | 每轮的 `longloop/*` 事件 —— 唯一真源 |
| **跨会话索引** | `storageDomain`（`storages/*.json`） | Run 摘要、当前状态、预算余额、会话关联 |
| **内容** | spill 文件 / 工作区 | 证据本体 |

**检查点时机**（复用 `dsh-session-checkpoint-policy` 已有的三个屏障，不新增）：

1. 模型请求前 —— 崩溃不会重放未持久化的请求
2. 顶层工具副作用前 —— 记录"已派发"
3. 每轮边界（`agent/pre-step`）—— 提交上一轮的全部事实

**恢复语义**：

```
进程重启 → 扫 storageDomain 找出 state ∈ {running, verifying} 的 Run
        → 标记为 suspended
        → 发出 longloop/run 事件（state: suspended）
        → Run Console 显示"中断于第 N 轮，[Resume] [Abandon] [Show handoff]"
        → 人类点 Resume 才 re-arm（A6：绝不自动续跑）
```

**为什么恢复后不自动续跑**：
这是 DSH goal 已经做出的安全选择，本框架**继承并加强**。
理由：进程重启意味着外部世界可能已经变了（文件被别人改了、服务挂了），
在上一次的世界模型上自动继续是危险的。人类花 5 秒点一下，换掉一整类事故。

**幂等**：
- 每轮分配 `roundId`；工具副作用建议沿用 `exec.callId` 作幂等键
- 崩溃后遇到"已派发未返回"的调用，继承 `TOOL_OUTCOME_UNKNOWN` 语义：
  提示模型**先验证状态再动手**，而不是盲目重试
- 验证导致的文件变更？验证者只读，所以不产生副作用

---

## 9. 终止语义与交接包

### 9.1 五种终止（没有第六种）

| 终态 | 条件 | 是否算"成功" |
|---|---|---|
| `done` | Verdict 达到所需 assurance 级别且 `status: pass` | ✅ |
| `exhausted` | 任一预算维度触顶（走完阶梯） | ⚠️ 部分成功 |
| `blocked` | L5 升级，同一阻塞条件重复 ≥ N 次 | ⚠️ 需人类 |
| `aborted` | 人类中止 | — |
| `suspended` | 进程重启，等待 re-arm | — |

**核心纪律：绝不允许"静默停止"。**
DSH 的 goal-round-driver 在轮数耗尽时会记录一个稳定的 blocker code（`round-limit`），
这是对的做法。本框架把它扩展成完整分类，并且**任何终止都必须产出交接包**。

### 9.2 Handoff Package（交接包）

每个终态都生成一份，写进会话（作为一条 `longloop/handoff` 事件 + 一条可见消息）
并落盘到 `workspace/.longloop/<runId>-handoff.md`：

```markdown
# Run R-7f3a 交接包

**终态**: exhausted（tokens 1.5M/1.5M）
**耗时**: 3h 41m · 27 轮 · 412 次工具调用

## 目标
把 packages/auth 的会话存储从内存改成 Redis，并保持现有测试全绿

## 达成情况
| 标准 | 状态 | 依据 |
|---|---|---|
| C1 测试全绿 | ✅ pass | E-12: pnpm test → exit 0（第 24 轮） |
| C2 重启不丢会话 | ❌ fail | 验证脚本能跑但 Redis 未配置持久化，重启后 key 丢失 |
| C3 无 TODO 遗留 | ⚠️ unknown | 未检查 |

## 已完成
- T1 抽出 SessionStore 接口 → src/auth/store.ts
- T2 实现 RedisSessionStore → src/auth/redis-store.ts

## 未完成 / 下一步
1. **C2 的根因**：`redis.conf` 未开 AOF。需要改部署配置（属于非代码变更，超出本次范围）
2. T3 验证脚本已创建但需要真实 Redis 实例才能跑通
3. T4 清理 TODO 未开始

## 关键决策（避免重复探索）
- 用 ioredis：项目依赖树已有，避免新增依赖（constraint）
- 不做连接池：当前 QPS 下无必要（non-goal）
- 试过但否决：session 序列化用 JSON → 无法处理 Date，改用 msgpack

## 风险
- 第 18 轮为了过测试临时放宽了一个断言（src/auth/store.test.ts:88），**需要人工复核是否合理**
```

**最后那条"风险"很重要**：它是从台账里自动提取的
（"修改了测试文件" + "测试从 fail 变 pass"），属于**反 reward hacking 的审计线索**。

---

## 10. 插件清单与 composition

### 10.1 包清单

**Host 平面**（进 bundle patch → profile 组合根）

| row id | 包名 | 职责 |
|---|---|---|
| `longloop` | `@local/dsh-longloop` | `ctx.longLoop` 服务：Run 台账、`longloop/*` 会话事件、投影、storageDomain |
| `longloop-governors` | `@local/dsh-longloop-governors` | Budget / Progress / Context 三个治理器的监听器集合 |
| `longloop-driver` | `@local/dsh-longloop-driver` | RoundDriver：inline / fresh / hybrid |
| `longloop-verify` | `@local/dsh-longloop-verify` | Verification Gate + 三种 assurance 实现 |
| `longloop-controller` | `@local/dsh-longloop-controller` | `ctx.remote.longloop` Remote 命名空间（UI 控制面） |

**Preset 平面**（复制 `standard` → `longloop` preset）

| row id | 包名 | 职责 |
|---|---|---|
| `tool-longloop` | `@local/dsh-tool-longloop` | 8 个 `run_*` 工具 |
| `command-longloop` | `@local/dsh-command-longloop` | `/run` 及子命令 |
| `longloop-prompt` | `@local/dsh-longloop-prompt` | 循环纪律提示段 + Run State Block runtime context |

**Client 平面**（随 host bundle 一起声明）

| row id | 包名 | 职责 |
|---|---|---|
| `client-ui-longloop` | `@local/dsh-client-ui-longloop` | Run Console 面板 + composer 上的 Run Strip |

### 10.2 模型可见的工具面

| 工具 | 参数要点 | 语义 | `concludesTurn` |
|---|---|---|---|
| `run_start` | objective, contract, budget?, assurance?, mode? | 创建 Run。契约不全时进入 `draft` 并要求确认 | 否 |
| `run_plan` | tasks[] | 整表替换计划；每个 task 必须 `addresses` 至少一条标准 | 否 |
| `run_note` | kind: decision/assumption/blocker, detail, rationale? | 写判断类台账 | 否 |
| `run_evidence` | kind, pointer, addresses[] | 登记证据（框架自动算 hash） | 否 |
| `run_status` | — | 读当前状态（预算/停滞/计划/裁决） | 否 |
| `run_verify` | criteria? | 主动请求验证 | 否 |
| `run_finish` | summary, evidenceIds[] | 声称完成 → 触发验证门 | **是** |
| `run_block` | blocker, attempted[] | 报告阻塞（必须列出已试过的 L1-L4 手段） | **是** |
| `run_handoff` | — | 主动产交接包 | **是** |

**`run_finish` 的实现要点**：
返回值必须明确告诉模型 ——
*"已提交验证。若验证不通过，你会在下一轮收到具体的失败项。宣称完成不会结束 run。"*
这句话直接打击"虚假完成"的动机。

### 10.3 会话事件（声明合并）

```ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'longloop/run':     { version: 1; run: RunSnapshot }
    'longloop/round':   { version: 1; runId: RunId; round: number; phase: RoundPhase }
    'longloop/ledger':  { version: 1; runId: RunId; entry: LedgerEntry }
    'longloop/verdict': { version: 1; runId: RunId; verdict: Verdict }
    'longloop/escalation': { version: 1; runId: RunId; level: number; action: string }
    'longloop/handoff': { version: 1; runId: RunId; markdown: string }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    longloopRun: RunSnapshot | undefined
    longloopRounds: readonly RoundSummary[]
    longloopLedger: readonly LedgerEntry[]
  }
}
```

### 10.4 bundle 的 `cordis.patch.yml`

```yaml
- insert:
    - id: longloop
      name: '@local/dsh-longloop'

    - id: longloop-governors
      name: '@local/dsh-longloop-governors'
      config:
        maxStateBlockTokens: 2000
        proactiveCompactAt: 0.70
        stallThreshold: 4
        escalation:
          - { atStalled: 1, action: nudge }
          - { atStalled: 2, action: replan }
          - { atStalled: 3, action: switch-mode }
          - { atStalled: 4, action: diagnose }
          - { atStalled: 5, action: block }

    - id: longloop-driver
      name: '@local/dsh-longloop-driver'
      config:
        defaultMode: hybrid
        freshProvider: spawn
        maxRoundPromptChars: 4096

    - id: longloop-verify
      name: '@local/dsh-longloop-verify'
      config:
        defaultAssurance: executable
        processVerifyEveryRounds: 10
        verifierProvider: spawn

    - id: longloop-controller
      name: '@local/dsh-longloop-controller'

    - id: client-ui-longloop
      name: '@local/dsh-client-ui-longloop'
```

### 10.5 preset 行

```yaml
# 复制 ~/.dsh 之外的 shipped standard preset 而来；放在
# ${DSH_HOME:-$HOME/.dsh}/.agent-presets/longloop/agent.cordis.yml

- id: longloop-prompt
  name: '@local/dsh-longloop-prompt'
  config:
    section: |
      长任务纪律：当存在活跃 Run 时，<run_state> 是唯一权威的当前状态。
      每轮只推进 current task；不要在 <decisions> 里记过的方案上重复探索。
      宣称完成不会结束 run——只有验证通过才会。
      卡住时按顺序尝试：换假设 → 重规划 → 请求换模式 → 请求诊断，最后才 run_block。

- id: tool-longloop
  name: '@local/dsh-tool-longloop'

- id: command-longloop
  name: '@local/dsh-command-longloop'
```

**注意**：preset 里**不要**放服务（`longloop`、governors、driver 都是服务/监听器，属于 host）。
preset 只贡献工具、命令、提示段——这正好符合 DSH 的两平面规则。

---

## 11. 实施路线 M0 → M4

### 11.1 M0 · 骨架（最小可用闭环）— 目标：能自己跑完一个真任务

**范围**（3 个包）：
- `dsh-longloop`：Run 存 storageDomain；6 个会话事件；2 个投影
- `dsh-longloop-driver`：inline 模式；照抄 `dsh-goal-round-driver` 的
  **预留 → 准入 → 竞态围栏 → 持久化检查点 → fail-closed 拆除** 这套已验证模式
- `dsh-tool-longloop`：`run_start` / `run_status` / `run_finish` / `run_block` / `run_note`

**预算**：rounds + wallClock + toolCalls（tokens 留到 M1）
**停滞**：只用一个信号 —— 工作区零变更
**验证**：只做 `self` 级
**提示**：Run State Block（简化版：objective / contract / plan / budget）

**验收标准**：给一个"改 5 个文件让测试全绿"的任务，
它能自己跑到 `done` 或 `exhausted`，中途人类不干预，全程有台账。

### 11.2 M1 · 度量与降级
- Budget Governor 接入 `ctx.tokenMeter`，补齐 tokens / costUsd
- 降级阶梯（0.6/0.7/0.8/0.9 四档）
- Progress Governor 全信号 + 停滞评分
- Escalation L1（nudge）+ L2（replan）

### 11.3 M2 · 验证门
- `executable` 级：框架自己跑 `Criterion.check`，hash 绑定
- `independent` 级：独立评估器子智能体 + 结构化 Verdict
- 过程验证（每 K 轮）
- Escalation L3（switch-mode → fresh）

### 11.4 M3 · 恢复与控制面
- 崩溃恢复：`suspended` 状态 + 显式 re-arm
- Client Run Console（`sidebar.right.pane.tab`）
- `/run` 命令族
- Escalation L4（诊断子智能体）+ L5（blocked + 交接包）

### 11.5 M4 · 规模化
- 多 Run 并行（一个会话多个 run？还是一个 run 跨多个会话？先做后者）
- 与 `dsh-experimental-agent-team` 集成：把 Run 的 Task 树同步到团队任务板
- 跨 Run 的技能沉淀（把成功的流程写成 skill）
- 成本模型：按路由价格做真实成本核算

### 11.6 不建议做的事
- ❌ 不要给 `agent-loop` 加"长任务模式"（单例 + 破坏既有语义）
- ❌ 不要自己实现压缩算法
- ❌ 不要在 M0 就做 UI（先用 `/run status` 的文本输出验证核心逻辑）
- ❌ 不要一开始支持三种模式（先 inline，跑通了再加 fresh）

---

### 11.7 M0 的包结构与核心伪代码（落地骨架）

M0 只需要 2 个包（host 一个 + preset 一个），能跑通最小闭环：

```
alex-dsh-ws/
├── packages/
│   ├── longloop/                     # @local/dsh-longloop
│   │   ├── package.json              # ← 同时是 host 插件 + 工具插件
│   │   ├── cordis.patch.yml          # host 行插入
│   │   ├── index.js                  # ctx.longLoop 服务 + 事件 + 投影
│   │   ├── driver.js                 # RoundDriver (inline)
│   │   ├── governors.js              # budget / progress (M0 简化版)
│   │   ├── tools.js                  # run_* 工具
│   │   └── state-block.js            # Run State Block 渲染
│   └── ...
└── presets/longloop/                 # → 复制到 $DSH_HOME/.agent-presets/longloop/
    ├── preset.yml
    └── agent.cordis.yml
```

**核心循环伪代码**（M0 版本，约 200 行）：

```js
// ── ctx.longLoop 服务 ────────────────────────────────────────────
class LongLoop extends Service {
  async start({ objective, contract, budget, session }) {
    const run = {
      id: `R-${nanoid(6)}`,
      objective, contract,
      budget: { rounds: {limit: 40, used: 0}, wallClockMs: 4*3600e3, ...budget },
      state: 'armed', round: 0, stalledRounds: 0,
      ownerSessionId: session.id, sessionIds: [session.id],
      workspaceCwd: session.cwd,
      plan: [], ledger: [], evidence: [], verdicts: [],
    }
    await this.domain.table('runs').put(run.id, summarize(run))
    session.append({ type: 'longloop/run', version: 1, run: summarize(run) })
    this.arm(run.id)
    return run
  }
}

// ── RoundDriver ─────────────────────────────────────────────────
// 1) 观察：turn 即将关闭
ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
  const run = longLoop.activeRunFor(agent)
  if (!run) return

  // ① 提取进度事实（模型不可伪造）
  const changes = workspaceChangesOf(agent.id, turn)   // workspace/changes
  const facts = extractFacts(agent.id, turn)           // tools/result 里的写/命令/测试
  for (const f of facts) appendLedger(run, { ...f, source: 'auto' })

  // ② 计费
  charge(run, { tokens: ctx.tokenMeter.measure(session).totalTokens,
                toolCalls: facts.length,
                wallClockMs: Date.now() - run.roundStartedAt })

  // ③ 停滞评分
  const score = stallScore({ changes, facts, planDelta: planDelta(run) })
  run.stalledRounds = score >= STALL_THRESHOLD ? run.stalledRounds + 1 : 0

  // ④ 快速否决：预算耗尽 or L5
  if (budgetExhausted(run)) return terminate(run, 'exhausted')
})

// 2) 排下一轮：整 agent 空闲
ctx.on('agent/status', async ({ agent, status }) => {
  if (status !== 'idle') return
  const run = longLoop.activeRunFor(agent)
  if (!run || !longLoop.isArmed(run) || !hasCapacity(run)) return

  // 竞态围栏：预留 round N+1
  const reservation = longLoop.reserve(run.id, run.round + 1)
  await ctx.sessions.flush(agent.session)
  if (!longLoop.stillValid(reservation)) return   // 人类插话/版本变了 → 让位

  // 按阶梯决定这一轮注入什么
  const directive = escalationDirective(run)      // L0..L5
  if (directive.action === 'switch-mode') return driver.switchToFresh(run)
  if (directive.action === 'replan')      return queueReplan(agent, run, reservation)
  if (directive.action === 'block')       return terminate(run, 'blocked')

  queueRound(agent, run, reservation, directive)  // inbox 注入 <run_round>
})

// 3) 准入围栏：消息进入前双重校验
ctx.on('agent/pre-step', async ({ agent, messages, turn }, next) => {
  const claim = longLoop.claimOfMessages(messages)     // 是我们排的轮次消息吗？
  if (claim) {
    if (!longLoop.accepts(claim)) return { kind: 'reject' }
    const decision = await next()
    if (!longLoop.accepts(claim)) return { kind: 'reject' }   // 下游改过也要复检
    longLoop.commitRound(claim)                      // 只有真正进入才消耗轮数
    return decision
  }
  return next()                                      // 人类消息 → 让位，自动工作暂停
})

// 4) Run State Block：每轮重渲染（compaction 免疫）
ctx.systemPrompt.context({
  name: 'longloop_run_state',
  order: 15,
  text: ({ scope }) => renderStateBlock(longLoop.activeRunFor(scope)),
})
```

**M0 的三个"不做"**（防止范围蔓延）：
- 不做 fresh 模式（`hybrid` 配置项存在但只跑 inline）
- 不做独立评估器（`assurance` 固定 `self`）
- 不做 UI（`/run status` 输出文本 JSON）

---

## 12. 度量：怎么证明这套框架真的有用

**没有对照实验的框架设计是没有说服力的。** 建议从一开始就建评测。

### 12.1 对照组

| 组 | 配置 |
|---|---|
| **A. 裸 agent** | standard preset，人类手动续跑 |
| **B. goal** | `dsh-goal` + `dsh-goal-round-driver` |
| **C. ralph** | `dsh-tool-ralph` 启用 |
| **D. LongLoop** | 本框架 |

### 12.2 指标

> 这份清单综合了 AI Agents That Matter (2407.01502) 的"accuracy–cost Pareto"主张
> 与 Towards a Science of AI Agent Reliability (2602.16666) 的
> **12 指标 × 4 维度（consistency / robustness / predictability / safety）** 框架。
> 后者的核心发现值得记住：**能力提升只带来很小的可靠性提升** ——
> 而长任务框架的收益恰恰应该体现在可靠性维度上。

| # | 指标 | 定义 | 对应可靠性维度 |
|---|---|---|---|
| 1 | **pass@1** | 单次运行任务成功率（独立人工复核） | 能力 |
| 2 | **pass^k** | **同一任务跑 k 次全成功的概率** | consistency |
| 3 | **虚假完成率** | 模型/框架宣称完成但人工判定未完成 | safety |
| 4 | **input / output token 分开计** | compaction 省的是 input，探索烧的是 output | — |
| 5 | **$/task** | 成本（做 accuracy–cost Pareto） | — |
| 6 | **每成功任务 wall-clock** | 效率 | — |
| 7 | **人类接管率** | 每任务/每小时的干预次数 | — |
| 8 | **工具错误率** | 工具调用失败比例 | robustness |
| 9 | **崩溃恢复成功率** | 中途 kill 后能续跑完成的比例 | robustness |
| 10 | **无进展轮数分布** | stall 的**分布**，而不是平均值 | predictability |
| 11 | **终止原因分布** | 达成 / 不可能 / 预算耗尽 / stall / 错误上报 | predictability |
| 12 | **平均纠偏提前量** | 第一次发现方向错在第几轮 | — |
| 13 | **上下文利用率 vs 性能曲线** | 找自己的 context rot 拐点 | — |

**为什么必须报 pass^k**：τ-bench (2406.12045)【强实证】测得
gpt-4o 任务成功率 <50%，而 **retail 域 pass^8 < 25%** ——
**pass@1 高 ≠ 可无人值守**。长任务的全部意义就是无人值守，
所以 pass^k 是本框架的**第一等指标**，不是补充指标。

**为什么必须做 accuracy–cost Pareto**：AI Agents That Matter【强实证】指出，
只看准确率会导致 "SOTA agent 不必要地复杂和昂贵，
社区对'准确率增益来自哪里'得出错误结论"。
LongHorizon-Harness 的实测佐证了这一点：框架的成本乘数
在三个基准上分别是 **2.3× / 3.6× / 0.76×** ——
**框架开销不能用一个固定倍数报价，必须按任务分别测。**

### 12.3 虚假完成怎么测（方法本身有讲究）

**不要用 LLM judge 作为虚假完成的主检测器。**
False Success (ICML 2026)【强实证】：5 个 judge × 5 种 prompt，
**没有一个 AUROC 超过 0.65**，因为 judge 被"自信收尾的语气"锚定
（断言丰富的 trace 被打分**高 0.27–0.36**，与工具证据无关）。
**轻量 TF-IDF 检测器 AUROC 0.83、亚毫秒**；跨域零样本迁移有限（0.69），
但**每类 50 个样本的 few-shot 校准可恢复到 0.79**。

**可操作的评测协议**：

1. 用**规则化的三分类**标注一批轨迹：`false-success` / `honest-failure` / `ambiguous`。
   先人工标注 100–200 条建立基线（论文的人类一致率 91.5%、κ=0.86）。
2. 基线判定标准必须是 **"环境状态是否真的改变"**，而不是"措辞是否像完成了"。
3. 训/调一个轻量分类器（TF-IDF + 线性模型即可起步），
   在 task-disjoint 划分上评估 AUROC。
4. 把它作为**生产监控的分诊过滤器**，不是最终裁决。
5. **LLM judge 只用于语义判断**（"这个实现是否真的满足 C2 的意图"），
   且必须结构化输出 + 允许 `unknown`。

### 12.4 反 reward hacking 的评测纪律

Cursor (2026-06-25)【强实证】的教训必须写进评测协议：

- **评测环境受控**：无公网、无 `.git`、隐藏测试不可达
- **审计 trajectory，而不只看通过率**：
  Cursor 训了一个 auditor agent 专门判断"是检索到答案还是推导出来的"，
  它在**不看该次运行是否通过**的前提下工作 —— 这一点很关键，
  否则 auditor 会被结果污染
- **人工抽查 reward hack**（METR 的标准动作），并**检查模型是否有足够的 token 预算**
- **记录并报告"封印前后"的差值**：它本身就是框架价值的一部分证据

### 12.5 任务集与规模

- **外部**：SWE-bench Verified 子集（有客观 pass/fail，好对照）
- **长任务专项**：自建 20-30 个需要 > 50 轮的任务
  （大型重构、跨模块迁移、性能优化、多文件 bug 排查）
- **崩溃注入**：在固定轮次 kill 进程，测恢复

### 12.6 一个必须承认的困难

长任务评测**成本高**（每个任务几十万 token × 几十个任务 × 4 个对照组）。
务实做法：
1. 先做 5-10 个任务的**小样本**，只要能看出"虚假完成率"和"token 效率"的差异
2. 把评测本身也做成一个 Run（框架自举）
3. 接受"趋势可信、绝对值不可信"

---

## 13. 反模式清单

| # | 反模式 | 为什么错 | 正确做法 |
|---|---|---|---|
| 1 | 把 Run 状态写进对话历史 | compaction 会把它压掉，且越滚越大 | runtime context（A2） |
| 2 | 让模型自评完成 | reward hacking；虚假信心比没有信心更糟 | 独立验证门（A3） |
| 3 | 只用轮数当预算 | 一轮可能是 10 个 token 也可能是 100k | 多维预算 + 阶梯（A4） |
| 4 | 停滞时"再来一轮" | 同样的上下文会产生同样的失败 | 换手段：nudge → replan → 换模式 → 诊断 |
| 5 | driver 和 `goal-round-driver` 同时挂 | 两个续跑源竞争，行为不可预测 | **互斥**：有活跃 Run 时禁用 goal 工具，或明确分工 |
| 6 | 在 preset 里放服务 | 破坏两平面规则，第二个 session 会冲突 | 服务进 host，工具进 preset |
| 7 | 给 `agent-loop` 打补丁 | 单例，且这是整个 harness 的心脏 | 只做监听器与驱动器 |
| 8 | 没有可执行验收标准就跑长任务 | 最后无法判定成败，验证门形同虚设 | 先谈 contract；谈不出来就别开长循环 |
| 9 | 证据存内容 | 上下文熵增，且与 spill 机制重复 | 证据 = 指针 + hash |
| 10 | 崩溃后自动续跑 | 外部世界可能已变；上一次的世界模型不再可靠 | `suspended` + 显式 re-arm（A6） |
| 11 | 验证器可写 | 它会"顺手修好再报告 pass" | 验证器只读（工具 restrict/guard） |
| 12 | 静默停止 | 人类不知道发生了什么，无法接手 | 任何终止都产交接包 |
| 13 | 把策略写死在代码里 | 模型每半年变强一次，阈值会过期 | 全部参数化 |
| 14 | M0 就做 UI | 核心逻辑没验证，UI 只是给错的逻辑加壳 | 先 `/run status` 文本输出 |
| 15 | **让执行者生成自己的验收检查** | ExecCritic：**61.2% → 57.3%**，patch 与 test 的错误共振产生假信心 | 契约阶段冻结检查，执行者只读 |
| 16 | **用 LLM judge 当虚假完成的主检测器** | AUROC ≤0.65，被"自信收尾的语气"锚定；TF-IDF 反而 0.83 | 三层检测，便宜的在前面 |
| 17 | **门没有逃生阀** | 没有逃生阀的门就是死锁源 | A9：每个门配一个上限与超限行为 |
| 18 | **用提示堆规则代替可执行检查** | Claude 5 代删掉 80% 系统提示无损失；过度约束消耗推理 | A8：提示极简，验证厚重 |
| 19 | **用 `git status` 或陈旧快照做无进展检测** | bounded-loops 的事故：软上限**根本无法触发** | 内容寻址 digest，每轮重算，排除引擎自身写入 |
| 20 | **台账无写入过滤 / 全量倾倒进上下文** | 记忆可能负收益（MemProbe）；上下文熵增 | 只收被环境验证过的事实；按"最近用到过"截断 |
| 21 | **验证/评测环境不隔离** | Cursor：63% 的"成功"是查答案；封 git+断网掉 14–20pt | 检疫 `.git`/`.env*`/密钥 + 断网 + 拒绝 symlink |
| 22 | **终止记录不区分"从未尝试"与"尝试后超预算"** | 成本声明不可审计（bounded-loops：算出来 1.1） | ledger 每行带 `attempted` |

---

## 14. 与 DSH 现有 goal / ralph / workflow / team 的分工

这张表回答"什么时候该用哪个"，也是这套框架**不重复造轮子**的证据。

| 原语 | 作用域 | 生命周期 | 记忆载体 | 终止判定 | 典型场景 |
|---|---|---|---|---|---|
| `goal` | 单会话 | 会话内 | 会话历史 | 模型自报 + 轮数上限 | "帮我把这个模块重构一下" |
| `ralph` | 前台阻塞 | 单次工具调用 | 工作区 | worker 自报 | "用全新视角反复尝试这个 objective" |
| `workflow` | 前台阻塞 | 单次工具调用 | 脚本变量 | 脚本 return | "审计这 50 个文件" |
| `subagent` | 父子 | 子会话 | 无 | 子任务结束 | "让子智能体查一下这个" |
| `agent-team` | 单会话内多 agent | 会话内 | 团队日志 | 任务板 | "组个小队做这件事" |
| **`Run`（本框架）** | **跨会话** | **持久，可暂停数天** | **Run 台账 + 工作区** | **验证裁决 / 预算 / 阻塞** | **"把 auth 迁移到 Redis，测试全绿"** |

**升级路径**：`goal` 是"轻量长任务"，`Run` 是"重型长任务"。
建议实现时让 `Run` 能**包装** goal 的续跑机制（复用其竞态围栏），
而不是并排再写一套——两套续跑源同时活着是明确的反模式（见 13.5）。

---

## 15. 参考依据

> 标注规则：**【强实证】** 同行评审 + 受控消融有可核验数字 ·
> **【中实证】** 单一实验室/厂商评测 · **【工程】** 博客/官方文档/实践者经验。
> 链接为外部资料，与本设计无隶属关系。

### 15.1 循环形态

| 来源 | 一句话结论 | 等级 |
|---|---|---|
| [ReAct (2210.03629)](https://arxiv.org/abs/2210.03629) | 循环的基本节拍；**全量追加、无状态**，三个隐含缺陷正是后续十年的靶子 | 强实证 |
| [Reflexion (2303.11366)](https://arxiv.org/abs/2303.11366) | 用"语言反思"替代策略梯度；HumanEval 91% pass@1 | 强实证 |
| [Plan-and-Solve (2305.04091)](https://arxiv.org/abs/2305.04091) | 先规划再执行；增益**场景特定**（AQuA +8.3pt，GSM8K 持平） | 强实证 |
| [CodeAct (2402.01030)](https://arxiv.org/abs/2402.01030) | 动作空间统一为可执行代码，成功率最高 +20% | 强实证 |
| [SWE-agent (2405.15793)](https://arxiv.org/abs/2405.15793) | ACI 消融：纯 shell −10.7pt；**加迭代搜索反而 −0.47pt** | 强实证 |
| [Agentless (2407.01489)](https://arxiv.org/abs/2407.01489) | 固定流水线，SWE-bench Lite 32% 且仅 $0.70，**同时是最强和最便宜** | 强实证 |
| [mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent) | ~100 行、只有 bash、线性历史，**SWE-bench Verified >74%** | 强实证 |
| [OpenHands (2407.16741)](https://arxiv.org/abs/2407.16741) | 事件流架构：把 agent 与执行环境解耦 | 强实证 |

### 15.2 上下文工程

| 来源 | 一句话结论 | 等级 |
|---|---|---|
| [Anthropic · Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | attention budget；**"不是硬断崖而是性能梯度"** | 中实证 |
| [Chroma · Context Rot](https://research.trychroma.com/context-rot) | 18 个模型；**连贯 haystack 反而比打乱的更差** | 强实证 |
| [Lost in the Middle (2307.03172)](https://arxiv.org/abs/2307.03172) | 位置敏感 U 形曲线 | 强实证 |
| [**Lost in Compaction (2608.11242)**](https://arxiv.org/abs/2608.11242) | **compactor 只保留 17% 约束，多数比不压缩还差**；SC-aware extractor >90% | 强实证 |
| [Anthropic · multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) | multi-agent +90.2%；**token 单独解释 80% 方差**；但 **15× token，且编码任务不适合** | 中实证 |
| [Anthropic · writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) | 用 agent 重写工具描述，后续任务完成时间 **−40%** | 中实证 |
| [Cognition · Don't Build Multi-Agents](https://cognition.ai/blog/dont-build-multi-agents) | 单线程线性 agent + 专门的压缩模型；**共享完整 trace 而非单条消息** | 工程 |
| [Claude 5 上下文规则](https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models) | **删掉系统提示 80%+ 无损失**；转向 auto-memory / rich references | 中实证 |

### 15.3 记忆

| 来源 | 一句话结论 | 等级 |
|---|---|---|
| [MemGPT (2310.08560)](https://arxiv.org/abs/2310.08560) | 虚拟上下文管理 = OS 分层内存 | 强实证 |
| [Generative Agents (2304.03442)](https://arxiv.org/abs/2304.03442) | memory stream + **`0.995^Δt` 衰减检索** + **importance>150 触发反思** | 强实证 |
| [Mem0 (2504.19413)](https://arxiv.org/abs/2504.19413) | LLM 驱动的 ADD/UPDATE/DELETE/NOOP；p95 延迟 −91%、token −90% | 中实证 |
| [Zep/Graphiti (2501.13956)](https://arxiv.org/abs/2501.13956) | 双时态知识图；LongMemEval +18.5%、延迟 −90% | 中实证 |
| [CoALA (2309.02427)](https://arxiv.org/abs/2309.02427) | working/episodic/semantic/procedural 四层记忆 —— **本设计的分类骨架** | 强实证 |
| [Letta / MemGPT docs](https://docs.letta.com/concepts/memgpt) | **MemFS（git-tracked memory）**：记忆可 diff、可回滚、可审计 | 工程 |
| [Memory as Infrastructure (2609.05510)](https://arxiv.org/abs/2609.05510) | 数月级真实运行；**anti-recurrence store** + health gate；78,933 hook 调用**零静默失败** | 工程（N=1） |
| [**AgentCL/MemProbe (2606.02461)**](https://arxiv.org/abs/2606.02461) | **记忆可能带来负收益**；朴素任务流无法区分记忆设计优劣 | 强实证（负面） |

### 15.4 规划与再规划

| 来源 | 一句话结论 | 等级 |
|---|---|---|
| [ReWOO (2305.18323)](https://arxiv.org/abs/2305.18323) | 带变量占位的 DAG，executor 只填变量 | 强实证 |
| [LLMCompiler (2312.04511)](https://arxiv.org/abs/2312.04511) | 计划编译成 DAG + task fetching unit 并行调度 | 强实证 |
| [AdaPlanner (2305.16653)](https://arxiv.org/abs/2305.16653) | 首次显式区分 **in-plan / out-of-plan refinement** | 强实证 |
| [**PlanBench (2206.10498)**](https://arxiv.org/abs/2206.10498) | GPT-4 规划 ~34%，对**语义等价重命名**敏感 → **不要长程一次规划** | 强实证（负面） |
| [**LongHorizon-Harness (2608.01964)**](https://arxiv.org/abs/2608.01964) | **MEA loop**；WeaveBench 51.8→80.7%、OSWorld 3.0×；manager 2–8% token、auditor 19–38% | 强实证 |
| [Drift in Long-Horizon Agents (Zenodo 19810869)](https://zenodo.org/records/19810869) | Plan-Alignment Score (PAS) | 工程/预印本 |

### 15.5 验证、自纠与 reward hacking

| 来源 | 一句话结论 | 等级 |
|---|---|---|
| [Self-Refine (2303.17651)](https://arxiv.org/abs/2303.17651) | 同模型自评自改，7 任务人类偏好领先 | 强实证 |
| [**Cannot Self-Correct Reasoning Yet (2310.01798)**](https://arxiv.org/abs/2310.01798) | **无外部反馈时自纠会降低准确率** | 强实证（负面） |
| [CRITIC (2305.11738)](https://arxiv.org/abs/2305.11738) | **去掉外部工具后增益基本消失** | 强实证 |
| [Let's Verify Step by Step (2305.20050)](https://arxiv.org/abs/2305.20050) | PRM 用少量样本即超 ORM 大量样本 | 强实证 |
| [CriticGPT (2407.00215)](https://arxiv.org/abs/2407.00215) | critic 有增益，**但会幻觉不存在的问题** | 中实证 |
| [LLM-as-a-Judge (2306.05685)](https://arxiv.org/abs/2306.05685) | 与人类一致率 >80%，但有位置/冗长/自我增强偏置 | 强实证 |
| [CodeMonkeys (2501.14723)](https://arxiv.org/abs/2501.14723) | SWE-bench Verified 57.4%；**测试的价值主要在 rerank**（ensemble 66.2%） | 强实证 |
| [**ExecCritic (2609.09133)**](https://arxiv.org/abs/2609.09133) | **自产测试 61.2→57.3%（错误共振）**；强测试 65.3%；角色分离 72.6% | 强实证 |
| [SWE-RM (2512.21919)](https://arxiv.org/abs/2512.21919) | **无执行反馈**的 reward model 也拿到大部分增益 | 强实证 |
| [**Cursor · reward hacking (2026-06-25)**](https://cursor.com/blog/reward-hacking-coding-benchmarks) | **63% 的"成功修复"是检索到答案**；封 git+断网 87.1→73.0% | 强实证 |
| [SWE-Bench Illusion (2506.12286)](https://arxiv.org/abs/2506.12286) | 仅凭 issue 描述定位文件：SWE-bench 内 76% vs 外部 53% | 强实证 |
| [Sycophancy to Subterfuge (2406.10162)](https://arxiv.org/abs/2406.10162) | RL 中从"迎合"泛化到**直接篡改奖励** | 强实证 |

### 15.6 失败模式

| 来源 | 一句话结论 | 等级 |
|---|---|---|
| [**MAST (2503.13657)**](https://arxiv.org/abs/2503.13657) | **3 类 14 种**；1642 条轨迹；**"系统设计 > 模型能力"** | 强实证 |
| [**False Success (ICML 2026)**](https://icml.cc/virtual/2026/77904) | 单控制域 false success 占失败 **45–48%**；**judge AUROC ≤0.65 vs TF-IDF 0.83** | 强实证 |
| [Claude Code best practices](https://www.anthropic.com/engineering/claude-code-best-practices) | **同一问题纠正超 2 次就 `/clear`**；trust-then-verify gap | 工程 |
| [langgraph-kit · completion guard](https://github.com/allada-homelab/langgraph-kit/blob/c1fa0440e8a807df3ac7841f2d44e36e214cb4ad/docs/resilience/completion-guard.md) | 启发式 premature completion 检测；**`_MAX_CHALLENGES=2`** | 工程 |
| [qualixar/bounded-loops · NINE-BOUNDS](https://github.com/qualixar/bounded-loops/blob/main/docs/NINE-BOUNDS.md) | **"最常见的失败不是崩溃，而是永远再试一次"**；digest 排除引擎自身写入；`attempted` 字段 | 工程 |

### 15.7 终止、预算与框架规格

| 来源 | 一句话结论 | 等级 |
|---|---|---|
| [**Claude Code `/goal`**](https://docs.claude.com/en/docs/claude-code/goal) | 每轮小模型三裁决；**连续无工具调用 = stall**；错误分级路由；后台工作延迟评估；**Stop hook 8 次后覆盖** | 工程 |
| [ProgRM (2505.18121)](https://arxiv.org/abs/2505.18121) | LCS 自标注 + 学习式进度奖励；**ORM 会过度惩罚"失败但过程有价值"** | 强实证 |
| [Awesome Loop Engineering](https://github.com/ChaoYue0307/awesome-loop-engineering) | **Loop Contract** 三段式；**"未回答的问题会变成隐藏的默认值"** | 工程 |

### 15.8 度量

| 来源 | 一句话结论 | 等级 |
|---|---|---|
| [METR (2503.14499)](https://arxiv.org/abs/2503.14499) · [局限说明](https://metr.org/notes/2026-01-22-time-horizon-limitations/) | 50% 时间视界**每 7 个月翻倍**；**<4 分钟任务近 100%、>4 小时 <10%**；99% 视界无法拟合 | 强实证 |
| [METR Time Horizons (TH 1.1)](https://metr.org/time-horizons/) | GPT-5 agent ≈ **2h17m** | 强实证 |
| [τ-bench (2406.12045)](https://arxiv.org/abs/2406.12045) | 提出 **pass^k**；retail **pass^8 < 25%** → pass@1 掩盖不稳定 | 强实证 |
| [AI Agents That Matter (2407.01502)](https://arxiv.org/abs/2407.01502) | **accuracy–cost Pareto**；缺 holdout 导致 agent 走捷径 | 强实证 |
| [Towards a Science of AI Agent Reliability (2602.16666)](https://arxiv.org/abs/2602.16666) | **12 指标 × 4 维度**（consistency/robustness/predictability/safety）；**能力提升只带来很小的可靠性提升** | 强实证 |
| [SWE-bench (2310.06770)](https://arxiv.org/abs/2310.06770) · [Verified](https://www.swebench.com/verified.html) · [Terminal-Bench (2601.11868)](https://arxiv.org/abs/2601.11868) | 2294 题 / 500 题人类筛选 / 89 个终端任务（前沿 <65%） | 强实证 |
| [OSWorld (2404.07972)](https://arxiv.org/abs/2404.07972) · [GAIA (2311.12983)](https://arxiv.org/abs/2311.12983) · [TheAgentCompany (2412.14161)](https://arxiv.org/abs/2412.14161) · [RE-Bench (2411.15114)](https://arxiv.org/abs/2411.15114) · [Vending-Bench (2502.15840)](https://arxiv.org/abs/2502.15840) | 72.36% vs 12.24% / 92% vs 15% / 自主 30% / AI 2h 得分 4× 人类但人类回报率更高 / 长程一致性退化 | 强实证 |

### 15.9 取证说明

本文引用的一次调研中，`web_fetch` 对所有域名返回
`resolves to a non-public IP address`，完全不可用；
取证改用 `bash` + `curl` + 本地 HTML→text 抽取完成。
所有论文的标题、作者、年份、arXiv 编号均从 arXiv abstract 页原文校验；
所有数字均从论文/官方文档正文抽取。
**本文复述时保留了原文的自我限定**（例如 METR 的 99% 视界无法拟合、
Memory as Infrastructure 是 N=1 无对照、Anthropic 多智能体数据是厂商自评）。

---

## 附录 A：实现锚点（已核实的 DSH API）

这一节把设计里每个机制落到**具体的服务 / 事件 / 签名**上，
全部来自 `cordis_inspect_*` 的实际查询结果，可以直接照着写代码。

### A.1 Run State Block 的注入

```ts
// @local/dsh-longloop-prompt，注册在 preset 行 → agent 作用域
ctx.systemPrompt.context({
  name: 'longloop_run_state',
  order: <在 persona 之后、tool 说明之前>,
  // AssembleContext = { scope?: ScopeKey; signal?: AbortSignal }
  // scope 就是当前 agent，可以据此取它正在跑的 Run
  text: ({ scope }) => ctx.longLoop.renderStateBlock(scope),   // 无活跃 Run 时返回 ''
})
```

`PromptContext.text` 支持 `string | ((context: AssembleContext) => string)`，
`AssembleContext.scope` 即当前 agent 作用域 —— **这正是"每轮重渲染"的实现方式**，
也是它对 compaction 免疫的原因（它不在对话历史里）。

### A.2 轮次驱动

```ts
// 观察 / 计费 / 停滞评分：turn 即将关闭，此时上下文最完整
ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
  await governor.observe(agent, turn)          // 提取台账 + 计费 + 停滞评分
  if (decision.steer) agent.steer(decision.message)   // 反对关闭 → 再跑一步
})

// 排下一轮：整 agent 空闲，回合边界干净，可安全 flush
ctx.on('agent/status', async ({ agent, status }) => {
  if (status !== 'idle') return
  await ctx.sessions.flush(session)            // 持久化屏障
  driver.scheduleNextRound(agent)
})

// 竞态围栏：轮次消息进入前校验 Run 版本，前后各一次
ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
  const before = fence.check(agent, messages)
  const decision = await next()
  return fence.recheck(before, decision)       // PreStepDecision: reject | enter
})
```

**照抄对象**：`dsh-goal-round-driver` 的"预留 → 准入 → 前后双检 → flush 后复查 →
fail-closed 拆除"。这套模式已经在生产里验证过，不要发明新的。

`PreStepDecision` 的完整形状：
```ts
type PreStepDecision =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true }
```

### A.3 终止回合

```ts
// run_finish / run_block / run_handoff 的 execute 返回
return {
  isError: false,
  value: { submitted: true, note: '验证已提交；通过与否在下一轮告知' },
  content: [...],
  concludesTurn: true,        // ToolExecutionSuccess.concludesTurn
}
```
`concludesTurn: true` 让回合在该步骤结束，避免多跑一轮空转。

### A.4 持久化

```ts
// 跨会话索引
const spec = defineDomain({
  name: 'longloop',
  version: 1,
  tables: {
    runs:    domainTable(runSummarySchema),
    ledgers: domainTable(ledgerIndexSchema),
  },
})
const domain = await ctx.storageDomain.open(spec)   // 调用方拥有 handle
ctx.effect(() => () => void domain.close())

// 会话内事实
session.append({ type: 'longloop/ledger', ... })    // 声明合并后即合法
await ctx.sessions.flush(session)                   // 屏障
```

### A.5 预算计量

```ts
const m = ctx.tokenMeter.measure(session, requestHeader)
budget.charge({ tokens: m.totalTokens /* 或 surfaceTokens */ })
// 另有 ctx.tokenMeter.estimateMessage(message) 做单条估价
```

### A.6 验证门执行命令

```ts
const spec = ctx.shell.resolve({
  command: criterion.check.command,
  cwd: run.workspaceCwd,
  signal,
})
const before = await gitTreeHash(run.workspaceCwd)
const result = await ctx.shell.run(spec)         // ShellRunResult: exitCode 等
const after = await gitTreeHash(run.workspaceCwd)
if (before !== after) return { status: 'unknown', note: '验证期间工作区被修改' }
```

### A.7 验证器只读约束

```ts
// 在评估器子智能体的 setup 里：
agentCtx.tools.restrict({ deny: ['write', 'edit', 'str_replace_editor', 'bash'] })
// 或更细：允许 read/glob/grep + 只读命令的白名单
```

### A.8 Remote 控制面

```ts
class LongLoopController {
  @Remote listRuns(sessionId: SessionId): RunSummary[]
  @Remote pause(runId: RunId): void
  @Remote resume(runId: RunId): void     // 显式 re-arm
  @Remote stop(runId: RunId, reason: string): void
  @Remote verify(runId: RunId): Promise<Verdict>
  @Remote({ mode: 'stream' }) follow(runId: RunId, signal: AbortSignal): AsyncIterable<RunFrame>
}
```

### A.9 UI 槽位（已核实的 live 树）

| 槽位 | kind | 用途 |
|---|---|---|
| `sidebar.right.pane.tab` | keyed（key 自由） | **Run Console 主体**，key = `'longloop'` |
| `sidebar.right.pane.tab.title` | keyed（同 key） | 标签页标题 |
| `conversation.composer.dock` | list | 紧凑 Run Strip（状态 + 预算条 + 暂停） |
| `conversation.session.header.utilities` | list | 头部一个状态指示灯 |
| `conversation.input.overlay` | list | 悬浮的升级提示（如 L3 换模式时） |
| `shell.overlay` | list | 需要全局提示时 |

`sidebar.right.pane.tab` 的 keyDomain 是 `open`（无编译期键集），
所以注册 `'longloop'` 不需要改任何 shipped 代码。

### A.10 命令注册

```ts
ctx.commands.register({
  name: 'run',
  // /run <objective> · /run status · /run pause · /run resume · /run stop · /run verify
})
```

---

## 附录 B：为什么叫 LongLoop

- **Long** —— 面向长任务（long-horizon），不是单轮助手
- **Loop** —— 核心交付物是"循环的治理"，不是循环本身

服务键：`ctx.longLoop`；包前缀：`@local/dsh-longloop`；UI 标签：`Run Console`。

## 附录 C：一页纸速查

```
定位       循环治理层，不是新循环
核心实体   Run（跨会话、可验证、有预算、可恢复的运行实体）
六个治理器 Budget / Progress / Context / Verification / Escalation / Recovery
循环协议   ORIENT → ACT → OBSERVE → VERIFY → DECIDE（= 学术界的 MEA loop）
九条公理   会话日志唯一真源 · 状态走 runtime context · 完成必须可证明
           预算多维带阶梯 · 停滞要升级不重试 · 恢复后不自动续跑
           一切可观测 · 提示极简验证厚重 · 每道门都有逃生阀
外部记忆   Run State Block（runtime context，compaction 免疫）+ 约束白名单
终止语义   done | exhausted | blocked | aborted | suspended，全部产交接包
验证门     三层漏斗：非 LLM 证据门 → 确定性检查 → 独立评估器（可执行/只读/契约冻结）
停滞升级   L0继续 → L1带外部信号的提示 → L2重规划 → L3换 fresh agent
           → L4独立诊断 → L5阻塞上报
三平面     host（服务+驱动+治理器） / preset（工具+命令+极简提示） / client（Run Console）
M0 范围    Run 台账 + inline 驱动 + 5 个工具 + rounds/wallClock/toolCalls 预算 + self 级验证
```

### 关键默认值（可直接作为配置初值）

```yaml
maxRounds: 1000              # 硬上限，不可被模型覆盖
noProgressWindow: 3          # 工作区 digest 连续不变即 stall
maxStateBlockTokens: 2000    # Run State Block 硬上限
proactiveCompactAt: 0.70     # 主动压缩阈值（别等自动触发）
processVerifyEveryRounds: 10 # 过程验证间隔
verifyTokenRatio: 0.40       # 验证预算 ≤ 40% × 执行预算
ladder:
  - { atRatio: 0.70, action: disable-exploration }
  - { atRatio: 0.80, action: narrow-scope }
  - { atRatio: 0.90, action: force-wrapup }
  - { atRatio: 1.00, action: stop }
escapeValves:
  verifyChallengeMax: 2      # 挑战 2 次后放行（但记 unknown）
  blockedAfterSameReason: 3  # 同一阻塞 3 次 → 强制 blocked
  maxEscalationLevel: 5
  maxToolCallsPerRound: 200
```

---

## 附录 D：开源实现的循环引擎对照（选型与借鉴速查）

> 这张表的作用是**回答"这个机制别人怎么做的"**，避免重新发明。
> 只列对长任务循环工程有直接借鉴价值的一手事实。

### D.1 循环边界与驱动器

| 项目 | 驱动者 | 单步边界 | 可借鉴点 |
|---|---|---|---|
| **OpenHands** | `LocalConversation.run()` 的 `while True` | `AgentBase.step()`（一次 LLM 调用 + 工具执行 + 追加事件） | **引擎与策略分离最干净的形态**；docstring 明写 *"Conversation will kick off the next step"* |
| **mini-SWE-agent** | `run()` 里的 `while True: self.step()` | ~100 行，显式 | **异常即控制流**：`FormatError` / `InterruptAgentFlow` 都是正常路径，只有未捕获异常才真崩 |
| **Goose** | Rust `Agent::reply` 循环 | 一次 reply | `DEFAULT_MAX_TURNS = 1000`；`MAX_EMPTY_TURN_RETRIES = 3` |
| **smolagents** | `while not returned_final_answer and step_number <= max_steps` | 一次 Thought+Code 块 | 条件写在 while 里；`planning_interval` 用**注入 assistant(plan) + user("Now proceed")** 而非改 system prompt（保前缀） |
| **MetaGPT** | `Role._react()` 的 `while actions_taken < max_react_loop` | `_think()` → `_act()` | **发布-订阅消息路由**（`cause_by` + `watch`），把"该谁说话"变成数据而不是控制流 |
| **Agent Zero** | `Agent.monologue()` 双层 `while True` | 一次模型调用 + 工具处理 | **intervention 在多个 step 边界检查**（可在任意边界插话，不在工具中途打断） |
| **Ralph** | **bash `while :; do cat PROMPT.md \| claude-code ; done`** | 一次完整 agent 运行 | **主 context 只当 scheduler**，昂贵工作外包给 subagent |

### D.2 计划与任务表示

| 项目 | 表示 | 可借鉴点 |
|---|---|---|
| **OpenHands** | `GoalController(objective, judge_llm, max_iterations=10)` | **把"是否完成"做成独立审计外循环**：judge 不执行动作，返回 `GoalVerdict{score, complete, missing}`；**解析失败时保守返回 `score=0.0, complete=False`**（"keep working rather than stop early"）；`missing` 变成下一轮的 followup；**judge transcript 显式排除 system prompt**（"thousands of tokens 且无信息量"） |
| **Claude Code** | Plan mode → `PLAN.md`（可 `Ctrl+G` 直接编辑）→ 对照计划实现 | **计划要能被人类直接编辑**；官方成本意识：*"如果你能用一句话描述这个 diff，就跳过计划"* |
| **Ralph** | `fix_plan.md`（唯一任务真源）+ `specs/*` + `AGENT.md` | 发现即写入、解决即删除、定期用 subagent 清理；**`AGENT.md` 记"怎么构建、怎么跑测试"的经验** |
| **CrewAI** | `planning=True` → 每轮全量重规划并注入每个 task description | ⚠️ 反例：全量重规划既贵又易漂移 |
| **Cline / Roo** | Plan/Act 模式 + TODO/Focus Chain + 看板卡片 | 模式切换时**对话历史完整保留** |

### D.3 压缩与上下文

| 项目 | 关键常量 / 机制 | 可借鉴点 |
|---|---|---|
| **Codex** | `auto_compact_token_limit = min(config, window × 9/10)`；`COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000` | **溢出重试牺牲最旧项**以保住 prefix cache；**ghost snapshots 让压缩后 `/undo` 仍可用**（"一个不变量不摧毁另一个"） |
| **Codex** | 五层指令：`base_instructions` / `initial_context` / skills / developer / user | **每层生命周期不同**，且 API 上是不同类型而不是一个 `messages[]` |
| **Codex** | `<environment_context>` 只发变化字段 | 避免每轮重发 CWD/git branch 让模型"在重复中迷路" |
| **Claude Code** | 200k 窗口实测装填：system **4200** / MEMORY.md **680** / env **280** / MCP deferred **120** / skills **450** / CLAUDE.md **320+1800** | 非消息上下文约占 **7.8k**；**skill 描述压缩后不重新注入** |
| **OpenCode** | `COMPACTION_BUFFER=20000`、`PRUNE_PROTECT=40000`、`TOOL_OUTPUT_MAX_CHARS=2000`、`MIN/MAX_PRESERVE_RECENT_TOKENS=2000/15000`、`PRUNE_PROTECTED_TOOLS=["skill"]` | 按 **turn** 切分历史（`splitTurn`），不是按消息 |
| **OpenHands** | `LLMSummarizingCondenser(max_size=240 events, keep_first=2)`；`Reason.TOKENS` / size | **压缩触发与压缩动作分离**（`get_compaction_reasons()` vs `condense()`），便于 `/compact` 复用同一路径 |
| **Goose** | `TOOLCALL_SUMMARIZATION_BATCH_SIZE = 10`；三段 continuation 文本 | 工具调用**分批摘要**；压缩后显式告知模型"别露馅" |
| **SWE-agent** | **不做历史压缩**，靠 ACI 把噪声挡在 observation 生成端 | file viewer 100 行、search 只列文件名、编辑前 lint 门控；**"把噪声挡在生成端比事后再压缩便宜得多"** |

### D.4 持久化与恢复

| 项目 | 介质 | 可借鉴点 |
|---|---|---|
| **OpenHands** | 逐事件 JSON 文件 + 锁 + 长度标记；`base_state.json` 存 HEAD | **`append_event()` 是唯一写入 chokepoint**；`leaf_event_id` 显式 → **会话是可分支的树**；`View` 挂 4 个不变量校验器（`tool_call_matching` / `observation_uniqueness` / `batch_atomicity` / `tool_loop_atomicity`）；**resume 不变量：工具只能加不能删**（"Removing tools breaks backward compatibility because the LLM may have already been told about them"） |
| **Goose** | SQLite `sessions.db` + **WAL** + `schema_version` 迁移表 | 会话是一等持久化实体；扩展状态（含 `TodoState`）单独持久化；**内置 Claude Code / Codex 导入格式转换** |
| **Letta** | **数据库是唯一真源**，"context window 只是 DB 的一个投影" | 遗忘 ≠ 丢失；**MemFS = git 版本化的记忆文件**（可 diff / 回滚 / 审计） |
| **LangGraph** | `checkpoints` / `checkpoint_blobs` / `checkpoint_writes` | **checkpointer（thread 级）与 store（跨 thread）分开**；`interrupt()` 是函数调用、可条件化、可放在任意位置；**"错误状态也是可恢复状态"**；⚠️ checkpoint 表**无界增长**是固有代价 |
| **Cline** | 每任务目录 + **shadow git repo** | **Checkpoint 支持 Compare / Restore，且"代码回滚但保留对话"** —— 这个分离让人敢让 agent 跑快 |

### D.5 子智能体与写冲突

| 项目 | 做法 | 可借鉴点 |
|---|---|---|
| **Cline subagents** | **只读**：能读/搜/列目录/跑只读命令，**不能编辑、不能开浏览器、不能用 MCP、不能嵌套** | **返回"下一步该读哪些文件路径"，而不是一段散文结论** —— 比结论更抗压缩 |
| **Roo Boomerang** | 父任务**真的 pause**，子任务独立 context，完成后只回传 summary | 避免"父子同时写"这个最危险的状态 |
| **Cline Kanban** | 每卡片一个 **ephemeral git worktree**；卡片 link 成依赖链，前卡完成后**自动 start** | gitignored 文件用 symlink 链过去；滚轮里可在 diff 行留 inline comment 回喂 |
| **Codex Guardian** | 审批复审子 agent **不继承调用方的 exec policy** | **防止"通过复审者自我批准"**（见 8.4） |
| **Cognition** | **"writes stay single-threaded and the additional agents contribute intelligence rather than actions"** | 干净 context 的 reviewer 平均每 PR 找到 **2 个 bug、58% 严重**；**"map-reduce-and-manage"** 才是实际形态，非结构化 swarm *"mostly a distraction"* |

**写冲突控制的强弱谱**（按需组合）：

| 级 | 手段 | 成本 | 隔离强度 |
|---|---|---|---|
| 1 | 顺序执行（`max_workers = 1`） | 最低 | — |
| 2 | 进程内资源锁（OpenHands `ResourceLockManager`） | 低 | 单 agent 内 |
| 3 | **路径所有权声明 + 调度器相交检测** | 中 | **⚠️ 当前生态的明确空白位** |
| 4 | git worktree 物理隔离（Cline Kanban） | 高 | 最强 |
| 5 | 只读子智能体 | 低 | 只对读有效 |
| 6 | **单写者 + 智能注入**（Cognition 最高原则） | — | 架构级 |

**第 3 级值得做成卖点**：调研的 17 个框架里**没有一个把"路径所有权 + 相交检测"做成一等公民**。
DSH 的 Agent Teams 目前只做到"文件提示产生警告，但从不阻断"。
本框架可以把它升级为：**Task 声明 `writeScope`，调度器对 in-progress 任务做集合相交，
冲突则串行化或拒绝 claim** —— 成本低，收益明确。

### D.6 HITL 的时机设计

| 范式 | 代表 | 特点 |
|---|---|---|
| 每 tool call 前审批 | Cline / Roo | 最安全最慢；**授权粒度可很细**（类别 × workspace 内外 × 命令 safe/危险）；Cline 的"all files 开关只在基础开关打开时生效"是防误开的典范 |
| 策略对象 | OpenHands | `confirmation_policy` + `security_analyzer`，默认 `NeverConfirm`；**被拦的动作进 `blocked_actions` 并参与持久化** |
| 沙箱 + 审批等级正交 | Codex | `AskForApproval` × `SandboxPolicy`；**Guardian 架构隔离** |
| hook 外置 | Claude Code | `PreToolUse`/`PostToolUse` 可返回 decision，handler 可以是 shell / HTTP / MCP / LLM / **subagent** —— 策略不写进 harness，可测试、可版本化 |

**四条 HITL 铁律**（跨项目一致）：

1. **审批回调必须被持久化** —— 否则崩溃后人已经批过的东西要重批
2. **永远不要在工具执行中间打断** —— Claude Code 明确 "a running tool is never interrupted"；
   运行中的消息在**两次 tool call 之间**被读取
3. **不许让 agent 复审自己的写操作** —— Codex 用架构隔离解决
4. **writer 与 reviewer 不共享 context** —— 共享只会同化盲区

**ask-user 的时机**（综合结论）：只在三类时刻**同步打断** ——
① 不可逆副作用之前；② 越出授权范围时；③ 计划发生实质变化时。
其余全部走**异步审批队列 + 默认继续**。
理由：**同步阻塞的人机闸门是长任务吞吐的头号杀手**
（Cline 的"每轮一个工具 + 每步审批"就是这个代价的极端体现），
而完全无闸门又会因不可逆副作用出事 —— 所以要用 checkpoint 把"犯错成本"降到接近零，
人才敢放开自动批准。

---

# 第二部分：控制面、工作区记忆与工作区 Skill

> 第 1–15 节回答"循环该怎么设计"。这一部分回答三个具体的产品问题：
> **人怎么看、怎么改；智能体怎么记事；技能怎么沉淀。**
>
> 配套实现：`packages/longloop/`（已安装为 `@local/dsh-longloop-console`）。

---

## 16. 交互控制台（Run Console）

### 16.1 为什么控制面不是可选项

长任务框架有一个绕不开的张力：

> 框架的全部价值是**让人不必盯着**；但一旦真的出事，**人必须能在几秒内接管**。

第 8.5 节已经把"同步阻塞的人机闸门是长任务吞吐的头号杀手"写成了结论。
推论就是控制面的设计目标：

| 目标 | 反模式 |
|---|---|
| **随时可看，不用等** | 必须暂停才能查询状态 |
| **改动立即生效，不打断正在跑的一步** | 改任务要重启循环 |
| **批量操作**（一次调 5 个优先级） | 一次只能改一个 |
| **看见的就是权威的** | UI 有自己的副本，和实际状态漂移 |

### 16.2 三平面落位

```
Client   sidebar / header 上的入口  +  shell.overlay 面板
            │  fetch('/longloop/…')  ← 同源 cookie，自动携带
Host     ctx.webServer.register({ kind:'prefix', path:'/longloop' })
            │  ctx.connection.requestRejection(req)  ← 信任栅栏，第一行
Store    <cwd>/.longloop/tasks.json · memory/*.md · .dsh/skills/
```

### 16.3 为什么用 webServer 路由，而不是 Typert Remote

DSH 的正规做法是 `@Remote` 装饰器 + Typert 代码生成（`dsh-goal`、`dsh-agentTeams` 都走这条路）。
它对**产品内建的**能力是对的：类型安全、自动生成客户端桩、走 Gateway 的流与取消。

但对**一个新装的本地插件**，它有一个硬门槛：**需要仓库的 tsdown 代码生成链路**。
一个纯 JS 的工作区 bundle 拿不到。

而 `webServer.register` 是公开契约、被 `dsh-host-open-in-app` 等**生产包**使用，
并且它的信任模型和 Remote 完全一致 —— 都经过同一个 `requestRejection` 栅栏：

```js
const guard = (req, res) => {
  const rejection = connectionOf(ctx)?.requestRejection(req)
  if (rejection === undefined) return false    // admitted
  res.statusCode = rejection
  res.end()
  return true
}
```

**实测确认**（无 cookie / 伪造 cookie / 未知子路由）：

```
/longloop/state        -> HTTP 401   ← 我的处理器跑了，栅栏拒绝
/longloop/bogus        -> HTTP 401   ← 同上，证明整段 prefix 已注册
/zzz-not-a-route       -> HTTP 404   ← 不是我的，对照组
```

**设计规则**：栅栏必须是处理器的**第一条语句**，在任何解析、读盘之前。
这条规则让"新增一个 HTTP 面"不会变成"新增一个未授权面"。

### 16.4 面板的四个页签

| 页签 | 数据源 | 可做的操作 |
|---|---|---|
| **任务** | `<cwd>/.longloop/tasks.json` | 新增（含优先级）、改标题、**点优先级 chip 循环 P0→P3**、**点状态 chip 循环**、↑↓ 手动排序、删除 |
| **记忆** | `<cwd>/.longloop/memory/*.md` | 新建、编辑（textarea）、保存、删除 |
| **Skill** | `<cwd>/.dsh/skills/` | 列出（含 description 与路径）、脚手架式新建 |
| **智能体** | `ctx.agentTeams`（宿主侧读取） | 只读：花名册与状态、共享任务板的 ready / 阻塞 / write-scope 警告 |

**优先级为什么是独立的字段而不是排序**：
优先级是**语义**（哪件事更重要），排序是**偏好**（我想先看到哪个）。
把两者合并成一个数字，人就没法表达"这两件事都重要，但我想按这个顺序看"。
`tasks.json` 里因此有 `priority: 0..3` 和 `order: 0..n` 两个字段，
而 `order` 在**每次写入时重新规范化** —— 这样人打开文件看到的顺序永远就是板上的顺序。

### 16.5 与既有 Agent Teams 面板的关系（互补，不重复）

`dsh-experimental-client-ui-agent-team` **已经**提供了会话内团队的
花名册、任务板 CRUD（create / edit / assign / complete / reopen / delete）。

本控制台**不重复它**，而是补三个它没有的东西：

| 缺口 | 本控制台的做法 |
|---|---|
| **任务模型没有优先级** | 自己的工作区任务层，带 `priority` + `order` |
| **任务板是会话内的**（团队解散就没了） | 任务落在**工作区文件**里，跨会话、跨团队、可 git |
| **没有跨会话的长期记忆与技能** | 记忆目录 + 工作区 skill 授权 |

**两者如何共存**：团队的共享任务板管"这一队人此刻在干什么"；
工作区任务板管"这个项目长期要做完什么"。
控制台同时显示两者（智能体页签只读展示团队板），
让人能看出**委派关系**（工作区任务的 `owner` 字段就是队友名）。

### 16.6 挂载点选择

| 槽位 | kind | 用途 | 风险 |
|---|---|---|---|
| `shell.overlay` | list（root） | 面板本体 | 低 —— root 作用域，必然可挂 |
| `conversation.session.header.utilities` | list（session） | 头部按钮 | 中 —— session 作用域 |
| `sidebar.panellist` | list（root） | 备用入口 | 低 |

**实现上，前两个入口各自 `try/catch`**：头部槽位若因作用域不匹配失败，
面板仍然通过全局入口可用，而不是整个插件挂掉。
**降级路径必须显式写出来**，否则一个槽位改名就会让整个功能消失。

### 16.7 一条 UI 原则

> **面板只做"读当前真相 + 发一个意图"，自己不留状态。**

所有变更走 `POST /longloop/<route>` → 宿主改文件 → 面板重新拉 `/state`。
面板唯一的本地状态是"是否打开"。

代价是每 5 秒一次轮询；收益是**面板永远不可能显示一个已经不存在的任务**。
对长任务控制台，这个交换是划算的 —— 一个撒谎的状态面板比没有面板更糟。

---

## 17. 工作区记忆系统

### 17.1 为什么是文件，不是数据库

第 3.3 节把记忆分成工作 / 情景 / 语义 / 程序性四层，第 6.4 节的 Run Ledger 承担情景层。
**这一节补的是语义层：跨 Run 复用的"我们在这个项目上学到了什么"。**

存储介质的选择是这一层的全部关键。三种候选：

| 介质 | 可读 | 可 diff | 可 git | 人可改 | 模型可改 |
|---|---|---|---|---|---|
| `storageDomain`（KV 域） | 否（二进制/JSON blob） | 弱 | 弱 | 否 | 只能通过工具 |
| 会话日志 | 是 | 是 | 是 | 否 | 否 |
| **`<cwd>/.longloop/memory/*.md`** | **是** | **是** | **是** | **是** | **是（用普通 write/edit）** |

用户要的是"**长期维护**的工作区记忆"。
长期维护的含义是：三个月后有人能打开它、读懂它、改它、在 code review 里看到它的变化。
**只有纯 markdown 文件同时满足这四条。**

对照三个已验证的先例：

| 项目 | 做法 | 共同结论 |
|---|---|---|
| Letta **MemFS** | git 版本化的记忆文件系统，`/doctor` 审计"放置是否漂移、是否重复" | 记忆要能被审计 |
| Cline **Memory Bank** | 项目内 6 个分层 markdown（projectbrief / activeContext / progress …） | 零基础设施成本的跨会话记忆 |
| Ralph **`AGENT.md`** | 记"怎么构建、怎么跑测试"的经验，每条踩坑都回写 | 经验要落成**下一次能读到的东西** |

**Agent Zero 官方文档在这个问题上罕见地诚实**：
> "Long-term AI memory is not a solved problem, even for large AI labs…
> A sustainable memory system needs some **human gardening**."

**"需要人类养护"就是选择文件格式的理由** —— 只有文件是普通人能养护的。

### 17.2 目录与格式

```
<workspace>/
├── .longloop/
│   ├── tasks.json              # 任务板（机器写，人可读）
│   └── memory/                 # 长期记忆（人和模型都写）
│       ├── redis-migration.md
│       ├── build-quirks.md
│       └── api-conventions.md
└── .dsh/skills/                # 工作区专属 skill（见 §18）
    └── <name>/SKILL.md
```

**记忆文件没有强 schema** —— 这是刻意的。格式约定只有一条：
**第一行是有意义的一句话**，因为注入时只取这一行。

```markdown
# Redis 迁移

只用 ioredis，不新增依赖（约束来自 Contract C1）。
序列化用 msgpack：JSON 处理不了 Date，试过并否决。
```

### 17.3 注入策略：摘要，不是全文

```
<workspace_state>
  <task_board path=".longloop/tasks.json">
    [~] T2 P2 补重启持久化脚本 @reviewer
    [ ] T3 P0 清理遗留 TODO
  </task_board>
  <workspace_memory dir=".longloop/memory">
    redis-migration.md — Redis 迁移
    build-quirks.md — 构建怪癖
  </workspace_memory>
  这些文件是你的长期工作记忆：需要事实时先读它，学到结论后用 write/edit 更新它。
</workspace_state>
```

**四个设计决定**：

1. **只给索引，不给内容。** 每份记忆只出现"文件名 + 第一句话"。
   模型需要细节时自己去 `read`。这守住了 §3.2 的最小高信号原则。
2. **走 `systemPrompt.context()`，不走对话历史。**
   与 §7.3 的 Contract 同理：它每轮重渲染，compaction 碰不到。
   但它是**动态**的，所以放在 §7.3 说的"动态段"位置，且**不是同步阻塞的** ——
   实现上用同步文件读 + 5 秒 TTL 缓存，因为 `PromptContext.text` 的契约是
   **返回 `string`，不是 `Promise<string>`**。这是个容易踩的坑：
   写成 async 会静默渲染出空串。
3. **空工作区零成本。** 没有任务也没有记忆时，`text()` 返回 `''`，
   不产生任何 token。不会因为装了插件就让每个会话都多一段提示。
4. **上限硬编码**：任务最多 20 条、记忆最多 20 份，超出折叠成"另有 N 条"。
   提示里的任何一段都必须有上限（§4.3 A8）。

### 17.4 与压缩的关系：约束白名单的第二道防线

§8.3 的约束白名单处理的是"**临时的**会话约束"（人类中途说的一句话）。
工作区记忆处理的是"**持久的**项目约束"（三个月前就定下的规矩）。

两者是互补的：

| | 约束白名单 | 工作区记忆 |
|---|---|---|
| 来源 | 本次会话的人类发言 | 跨会话的项目知识 |
| 抽取方式 | 压缩前后各跑一次抽取器 | 人/模型显式写入 |
| 存活方式 | 进 `Run.constraints`，进 Run State Block | 进 system prompt context |
| 失败模式 | 抽取器漏掉 | 没人写、或写了不更新 |

**第三道防线**是 §7.3 的 Contract：它在 `armed` 前冻结，是三者里最硬的。

### 17.5 防止记忆退化

第 3.3 节引了 MemProbe 的负面结论：**记忆可能带来负收益**。
三条防护：

| 防护 | 做法 |
|---|---|
| **只收被验证的事实** | 记忆里写"X 可行"必须有证据指针；推测要显式标注 |
| **死胡同必须记** | "试过 msgpack，JSON 处理不了 Date，否决" —— 这条比"用了 msgpack"更值钱 |
| **定期园艺** | UI 里可以直接删/改；建议每条记忆带一个"最后复核日期" |

**记忆的失效是静默的**，这是它比代码更危险的地方 ——
代码错了测试会红，记忆错了只会让模型安静地走错路。
所以控制台把记忆做成**可见、可编辑、可删除**的一等公民，
而不是藏在某个数据库里靠工具访问。

---

## 18. 工作区专属 Skill

### 18.1 好消息：DSH 已经做了

调研发现 `@deepseek-ai/dsh-skill-filesystem` **已经在扫描工作区级目录**：

| rank | source | 路径 |
|---|---|---|
| 100 | `project-dsh` | **`<projectRoot>/.dsh/skills`** |
| 200 | `project-agents` | **`<projectRoot>/.agents/skills`** |
| 300 | `custom` | `Config.customSkillDirs` |
| … | `user-*` | `$DSH_HOME/skills`、`$DSH_AGENTS_HOME/skills` |
| 600 | `bundled` | `Config.bundledSkillDir` |

其中 `projectRoot` = **最近的含 `.git` 的祖先目录**（没有则用 cwd）。
而且它**监听这些目录**：新增/重命名/删除会触发目录刷新，
`write`/`edit` 工具还会**同步失效**提供者缓存 —— 模型改完自己立刻能看到。

**结论：不需要新写 skill provider。**
需要的是三件事：**让人知道它存在、让人能方便地创建、让它进版本控制。**

### 18.2 三个交付

| 交付 | 做法 |
|---|---|
| **可见** | 控制台 Skill 页签列出 `<cwd>/.dsh/skills/` 下的条目、description 与绝对路径 |
| **可创建** | 表单式脚手架：名称 + description + whenToUse + 正文 → 写出 `<name>/SKILL.md`（带合法 frontmatter） |
| **可版本化** | 就在工作区里，`.dsh/skills/**` 直接进 git，和代码一起 review |

**frontmatter 必须合法**，否则 skill 会被静默跳过
（官方 README 原文："A file without valid frontmatter … is skipped with a warning,
so the model catalog receives no per-skill diagnostic"）。
所以脚手架代填 `name`（kebab-case）与 `description`（必填），
并拒绝已存在的名字，而不是覆盖。

### 18.3 为什么是"工作区"专属而不是全局

| 范围 | 放哪 | 适合 |
|---|---|---|
| 全局（所有项目） | `$DSH_HOME/skills` | 通用工作方式（写 commit message、review 清单） |
| **工作区** | **`<cwd>/.dsh/skills`** | **这个项目的部署流程、这个仓库的测试怎么跑、这套 API 的约定** |
| 会话内（临时） | 会话内的 runtime 注册 | 一次性的 |

工作区级正好卡在中间：**比全局具体，比会话持久**。
它解决的问题是"**换一个会话，这些项目知识要不要重新讲一遍**"。

### 18.4 与记忆的分工（容易混淆，必须说清）

两者都是"跨会话的项目知识"，但**触发方式根本不同**：

| | 工作区记忆 | 工作区 Skill |
|---|---|---|
| 形态 | 陈述性知识（"是什么"） | 程序性知识（"怎么做"） |
| 何时进入上下文 | **每轮**（摘要常驻） | **按需**（模型判断相关才加载） |
| 谁决定用不用 | 框架（总是注入摘要） | 模型（读 description 后自己决定） |
| 成本 | 每轮固定几十 token | 加载时才付全文成本 |
| 典型内容 | "约束是只用 ioredis" | "把会话存储迁到 Redis 的固定五步" |

**判据**：**"每轮都需要知道"的进记忆；"需要时才查"的进 skill。**
把操作流程塞进记忆会白白烧掉每轮的上下文预算；
把项目约束塞进 skill 会因为没被加载而被违反。

### 18.5 与 Voyager / CoALA 的对应

第 3.3 节的 CoALA 分类里，**程序性记忆**（procedural memory）的最佳实例是
Voyager 的 **ever-growing skill library of executable code** ——
把验证过的行为以可执行形式存起来，按需检索复用，天然可组合、可解释。

DSH 的 `skills/` 目录就是它的工业版本，差别只在于载体是 **markdown 指令**而不是可执行代码。
工作区级 skill 让这套机制获得了**项目边界** ——
一个项目的技能库不会污染另一个项目。

---

## 19. 已实现的验证状态

> 这一节如实记录**已经验证了什么、没验证什么**，避免把"装上了"当成"能用了"。

### 19.1 交付物

| 文件 | 作用 |
|---|---|
| [`packages/longloop/package.json`](../packages/longloop/package.json) | bundle 声明 + `dsh.client` 浏览器名册 |
| [`packages/longloop/cordis.patch.yml`](../packages/longloop/cordis.patch.yml) | 一行插入 host 行（`driver: false` 默认关闭） |
| [`packages/longloop/index.js`](../packages/longloop/index.js) | 宿主：存储 + `/longloop` 路由 + 提示注入 + 工具 + 驱动器装配 |
| [`packages/longloop/governors.js`](../packages/longloop/governors.js) | 纯函数治理策略：预算 / 停滞 / 升级 / 提示渲染 |
| [`packages/longloop/run.js`](../packages/longloop/run.js) | Run 存储、工作区 digest、JSONL 账本、评估 |
| [`packages/longloop/driver.js`](../packages/longloop/driver.js) | 轮次驱动器状态机 |
| [`packages/longloop/verify.js`](../packages/longloop/verify.js) | 验证门：廉价证据门 + 可执行检查 + 裁决汇总 |
| [`packages/longloop/client.js`](../packages/longloop/client.js) | 浏览器：五页签面板 + 两个入口 |
| [`packages/longloop/handoff.js`](../packages/longloop/handoff.js) | 交接包：终态文档、风险推导 |
| [`packages/longloop/context.js`](../packages/longloop/context.js) | 约束白名单、上下文健康度、主动压缩 |
| [`packages/longloop/escalate.js`](../packages/longloop/escalate.js) | L3 换模式、L4 独立诊断 |
| [`packages/longloop/commands.js`](../packages/longloop/commands.js) | `/run` 命令族 |
| [`packages/longloop/test/`](../packages/longloop/test/) | **183 个用例**：verify 45 · host 39 · context 20 · driver 19 · governors 17 · commands 16 · handoff 15 · escalate 12 |

### 19.2 已验证 ✅

| 项 | 证据 |
|---|---|
| bundle 安装 | `plugin_manager install_bundle` → `application: applied`、`enabled: true` |
| 包进入 profile | `profiles/web/node_modules/@local/dsh-longloop-console` 符号链接存在 |
| **路由注册** | `/longloop/*` → **401**（我的栅栏），`/zzz-not-a-route` → **404**（对照） |
| **信任栅栏** | 无 cookie 与伪造 cookie 均为 401，处理器体未执行 |
| 任务板 CRUD | 12/12 用例：创建/优先级/移动/状态/删除/整表重排 |
| 拒绝是显式的 | 空标题、未知 id、非法 op、越权 workspace 各自返回明确错误 |
| **路径逃逸** | `../../escape` 被规整为 `escape`；`...` 被拒绝 |
| 记忆读写删 | 写盘内容与读回一致；`.md` 落在 `.longloop/memory/` |
| **Skill 落在正确 root** | 生成 `<cwd>/.dsh/skills/<name>/SKILL.md`，frontmatter 合法；扁平 `.md` 也能被发现 |
| 多智能体读取 | 花名册与共享板来自宿主 `agentTeams`；服务缺席时降级为 `available:false` |
| 提示注入 | 摘要含任务板与记忆索引；**空工作区返回空串**（零 token） |
| 会话作用域解析 | `?session=` 决定工作区，而不是宿主的 `process.cwd()` |

### 19.3 M0 增量：Run 实体、治理器与驱动器

第二轮把 §11.7 的 M0 落地了。

| 文件 | 职责 |
|---|---|
| [`governors.js`](../packages/longloop/governors.js) | **纯函数**：预算阶梯、停滞评分、L0–L5 升级、提示渲染 |
| [`driver.js`](../packages/longloop/driver.js) | 轮次驱动器（预留 → 准入 → 双侧围栏 → 人类优先） |
| [`run.js`](../packages/longloop/run.js) | Run 存储、工作区 digest、账本、评估 |

**新增能力**：

| 能力 | 实现 |
|---|---|
| **Run 实体** | `<cwd>/.longloop/run.json`：目标 / 冻结契约 / 预算 / 轮次 / 停滞 / 账本 |
| **预算治理** | 轮数 + 墙钟（+ Token / 工具调用，有计量表时）三维，四档降级阶梯 |
| **停滞检测** | 工作区 digest（**排除 `.longloop/**` 等引擎自身写入**）+ 任务板 digest + 工具活动 |
| **升级阶梯** | L0 继续 → L1 带外部信号的提示 → L2 重规划 → L3 换模式 → L4 诊断 → L5 上报 |
| **驱动器** | `agent.followup()` 入队；`agent/pre-step` 双侧围栏；人类消息立即让位 |
| **五个工具** | `run_start` / `run_status` / `run_note` / `run_finish` / `run_block` |
| **提示分两段** | `<run_contract>` 走静态 context（压缩后重注入），`<run_round>` 每轮追加 |
| **控制台「循环」页签** | 目标 / 状态 / 三维预算条 / 停滞与升级 / 验收标准（标注可验证与否）/ 最近裁决 / 阻塞记录 / 控制按钮 |
| **验证门** | 三层漏斗的前两层；`run_finish` 真的执行冻结的检查并产出裁决 |
| **人工裁决** | 没有可执行检查的标准由人在控制台确认 —— 人也是合法的验证者 |

**两处被测试逼出来的策略修正**（都有真实后果）：

1. **单个强信号不再直接判停滞。** 工作区零变更权重 3、阈值 4 —— 
   因为"跑测试 / 读代码规划 / 等构建"都会让文件树不动却是有效工作。
   两个信号互证（工作区 + 任务板都没动 = 6）才判停滞；
   而 `blocker-repeated` 设为 4，因为**重复本身就是互证**。
2. **模糊轮次保持停滞计数，不再清零。** 原实现是 `stalled ? +1 : 0`，
   这会让 停滞→安静→停滞→安静 永远到不了 L2。
   现在是三态：停滞 +1 / 明确有进展归零 / 模糊保持。

### 19.4 已验证（第二轮）✅

| 项 | 证据 |
|---|---|
| 全部用例 | **183/183**（验证门 45 · 主机 39 · 上下文 20 · 驱动器 19 · 治理器 17 · 命令 16 · 交接包 15 · 升级 12） |
| **验收检查被执行** | 带 `check` 的标准真的跑了命令（`pnpm test`），裁决带退出码与输出片段 |
| **沙箱约束** | 检查以 `workspace-write` + workspaceRoot 执行，够不到项目之外 |
| **证据绑定** | 每条证据带 `digestBefore`，绑定到它产生时的那棵树 |
| **契约冻结** | 检查在 `run_start` 定型；读取侧再挡一次空命令 |
| **`partial` 完成** | 必达全过、次要未决 → `done`；必达有 unknown/fail → 不完成 |
| **逃生阀** | 退回 2 次后按可判定结果裁决，不死锁 |
| **人工裁决** | `by: 'human'` 记录 `level: 'human'` 的通过裁决并结束运行 |
| **缺口回流** | 上一次裁决进下一轮提示（`<last_verdict>`），只列未通过项 |
| **第 3 层策略自建** | 评估器拿到 `{allow:['read','glob','grep']}` + 自己的 persona，`maxDepth: 1`，**不继承调用方** |
| **两层合并** | 评估器可推翻通过的检查（带反例），也可裁定确定性检查判不了的标准 |
| **降级被记录** | 评估器不可用时 `level` 退回 `executable` 并写 `verify-degraded` 账本 |
| **解析宁可 unknown** | 漏判 → unknown；fail 无反面例子 → 降级 unknown；畸形 → 全 unknown |
| 预算阶梯 | 四档分界精确；无上限的维度**不出现**而不是记 0；暂停时间不计入墙钟 |
| 停滞评分 | 单信号不误报；双信号互证触发；弱信号可累积；模糊轮保持计数 |
| 升级阶梯 | L0–L5 逐级；每级指令**必须含可执行的外部事实**（有测试断言它不含"再试一次"） |
| 准入语义 | 只有准入才消耗轮次；`next()` 前后各校验一次；别人的消息原样透传 |
| 人类优先 | 人类消息立即暂停运行并丢弃已排队的轮次 |
| 逃生阀 | 轮数上限触发 `round-limit` 稳定码；渲染/入队失败清空预留以便重试 |
| 契约可见性 | 契约同时进提示与 `runSummary` —— 面板与提示不可能对"做完"有分歧 |
| 端到端停滞 | 连续 6 次评估：0→1→2(replan)→3(switch-mode)→…→5(block)，终态带原因 |
| 工具面 | 5 个工具注册成功；`run_block` 拒绝空尝试列表；`run_finish` 调 `concludeTurn` 但**不结束运行** |

### 19.5 验证门的实现（三层全部落地）

§8.4 要的是**漏斗，便宜的先跑**。三层现在都在。

| 层 | 触发 | 实现 | 耗时 |
|---|---|---|---|
| **第 1 层** 证据门 | 每次 `run_finish` | 完成措辞识别 + 检查可验证性判定 | 微秒 |
| **第 2 层** 确定性检查 | 证据门放行后 | 通过 `ctx.shell` 执行冻结的命令，比对期望 | 秒 |
| **第 3 层** 独立评估器 | `assurance: 'independent'` | fresh-context 子智能体 + **自建策略** + 结构化输出 | 分钟 |

#### 第 3 层的三件套，全是显式请求的

`SubagentStartRequest` 支持的每一项都被用上，而**没有任何一项继承调用方**：

```js
await subagents.start('spawn', {
  persona: EVALUATOR_PERSONA,                    // 自己的身份，不是执行者的
  toolFilter: { allow: ['read','glob','grep'] }, // 白名单从零构建，不是从调用方减去
  outputSchema: EVALUATOR_SCHEMA,                // 结构化裁决
  maxDepth: 1,                                   // 能生评估器的评估器是带预算的 fork 炸弹
})
```

**白名单里没有 `bash` 是刻意的，不是遗漏。** 第 2 层已经跑过命令了；
第 3 层要回答的是"那些证据是否真的支持这条标准" —— 一个命令回答不了、
而执行者最不适合回答的问题。没有 `web_fetch` 和写入工具同样是设计的一部分：
断网与不可写属于 §8.4 的污染控制。

Codex Guardian 的教训在这里落地：**继承调用方策略的复审者会被调用方用来批准自己**
（源码里有 `guardian-reviewer-bypass-exec-policy` 这条规则）。

#### 合并规则（五条，各有理由）

```
确定性 fail                     → fail        命令跑了，没达标
确定性 pass + 评估器 fail        → fail        ★ 第 3 层存在的理由
确定性 pass + 评估器 pass        → pass
确定性 unknown                  → 取评估器判断
评估器缺席                       → 确定性结果照旧
```

第二条是这个设计里最有价值的一条：**检查通过，但它测的不是标准想说的东西**。
ExecCritic 的整个论点就在这里。

#### 降级语义

评估器**不可用**（没有 `subagents`、没有活跃 Agent、provider 未注册、
起不来、`stopReason !== 'completed'`）时返回 `undefined`，
确定性结果照旧生效，并写一条 `verify-degraded` 账本记录。

**一个缺席的评估器只能意味着"验证更少"，绝不能意味着"已验证"。**
静默降级是这里唯一不可接受的失败方式，所以它同时被记进账本和显示在控制台上。

#### 解析规则：宁可 unknown，不可放行

| 评估器给了什么 | 怎么处理 | 为什么 |
|---|---|---|
| 正常判断 | 采纳 | — |
| **漏掉某条标准** | unknown | 它没验证过，假装验证过正是第 3 层要防的事 |
| **判 fail 但没给反例** | **降级为 unknown** | 无法指认的断言不可执行，§8.4 禁止把它当事实传递 |
| 非法 status / 畸形条目 | 忽略 | 强扭会制造信心 |
| 整个 payload 畸形 | 全部 unknown | 同上 |

#### 契约冻结的两道防线

```js
// run.js：检查在 createRun 时定型，此后没有任何 op 能改它
entry.check = { command: check.command.trim(), expect: normalizeExpect(check.expect) }

// verify.js：读取侧再挡一次空命令
const command = typeof criterion.check?.command === 'string' ? criterion.check.command.trim() : ''
```
**一条空命令会以退出码 0 免费认证一条标准**，所以两道防线都要有。

#### 沙箱与证据绑定

每条检查都以 `{mode:'workspace-write', workspaceRoot: root}` 执行 ——
验证命令够不到它正在验证的项目之外。工作区 digest 在前后各取一次，
**不为了让检查失败**（跑测试写缓存是正常的），而是**把副作用记录在案**，
并把证据绑定到它产生时的那棵树。

#### 逃生阀

`VERIFY_CHALLENGE_MAX = 2`：证据门最多把声明退回两次，第三次按可判定结果裁决。
**能永远发问的门就是死锁源**（A9）。

**`unknown` 是一等结果**：超时 → fail（命令跑了但没达标），
被取消 / 沙箱拒绝 / 进程起不来 / 评估器缺席 → unknown。
**必须给 pass 或 fail 的验证器会制造它并不拥有的信心** ——
那比没有验证器更糟，因为它把猜测洗成了认证。

#### 六处被测试逼出来的修正

1. **完成措辞表漏了最常见的说法。** 第一版正则只认 `I've completed`，
   不认 `I have completed` —— 而后者才是真实声明里的主流形式。
   测试逼出了这个洞；现在覆盖 10 种说法，并有反向用例保证进度描述不误报。
2. **`partial` 原本永远无法完成任何事。** 我最初写 `completed = status === 'pass'`，
   但 `partial` 的定义是"所有**必达**标准通过、只有次要项未决" ——
   那正是契约要求的东西，应该完成。否则 `partial` 是个没有出口的状态。
3. **单个强信号不判停滞**（见 §19.3）。
4. **模糊轮次保持停滞计数**（同上）。
5. **第 1 层的"有证据但无检查"应该转人工，不是退回。** 前者再问也没用，
   机器判不了；后者值得一轮去要证据 —— 因为证据可能是人类唯一能复核的东西。
6. **`parseChecks` 会接受空命令。** 写入侧已经挡了，读取侧也必须挡（见上）。

### 19.6 模块补全（第三轮）：把设计里承诺的补齐

前两轮做的是核心链路；这一轮把设计文档里**已经写明但还没实现**的模块补完。

| 新增模块 | 对应设计 | 作用 |
|---|---|---|
| [`handoff.js`](../packages/longloop/handoff.js) | §9.2 | **交接包**：任何终止都产出一份，写进工作区 |
| [`context.js`](../packages/longloop/context.js) | §8.3 | **约束白名单**、上下文健康度、主动压缩阈值 |
| [`escalate.js`](../packages/longloop/escalate.js) | §8.2 §7.5 | **L3 换模式**、**L4 独立诊断** |
| [`commands.js`](../packages/longloop/commands.js) | §10.1 | **`/run` 命令族** |

**同时补齐的行为**：

| 缺口 | 补法 |
|---|---|
| 终止只改状态，不产交接包 | 五种终态全部写 `.longloop/<runId>-handoff.md`，并记账 |
| L3/L4 只算级别，没有动作 | L3 把 `mode` 切到 `fresh`（下一轮交给全新子会话）；L4 起只读诊断子智能体并把报告注入后续轮次 |
| 恢复后仍显示 `armed` | 插件装载时把 `armed` 扫成 **`suspended`**，等人显式重新授权（A6） |
| 约束只靠 runtime context，中途新增的没人收 | `agent/pre-step` 扫描进入步骤的人类消息，**在还被逐字保留时**钉住 |
| 验证花掉的钱没有计量 | `verifyTokens` 独立维度，上限为执行预算的 40%（§8.4） |
| 降级档只改数字 | `disable-exploration` / `narrow-scope` 真的往下一轮注入"禁止探索"指令 |
| 缺少循环纪律提示段 | `longloop_discipline` context，几百 token，可配置关闭（A8） |
| 没有人类命令入口 | `/run status\|start\|pause\|resume\|stop\|verify\|handoff` |

#### 三个我认为值得单独说的决定

**1. L3 的模式切换不放在驱动器里。** 驱动器只**读** `run.mode`；
是 `finishRound` 里的升级策略**写**它。这样内联路径保持完全同步
（一轮排队落在同一个 tick 里），而"何时换手段"是一条纯策略，可独立测试。
驱动器新增的唯一异步路径是 fresh 轮次，它自带并发闸（一轮在飞时不排第二轮）。

**2. fresh 轮次结束后必须主动请求下一轮。** 因为 fresh 轮次**不会让 owner agent 变成非空闲**——
没有任何事件会再次触发 `handleStatus`。这个自我调度点也是驱动器唯一可能空转的地方，
所以每一轮之后都**重新读一遍终态、轮数上限和暂停状态**。

**3. 交接包的"风险"是推导出来的，不是写出来的。** §9.2 只点名了一条自动提取项，
而它恰好是最重要的一条：**一次在运行中改动了自己验证方式的任务，是潜在 reward hack 的审计线索**，
而没有任何 agent 会主动坦白这件事。所以 `sideEffects`、未验证的标准、
已记录的降级、以及"裁决强度低于 independent"都会自动进风险段。

#### 又一处测试逼出来的缺陷

**`assess` 和 `finishRound` 各自算了一遍预算。** 我给 `finishRound` 加了
`verifyTokens` 维度却忘了 `assess` —— 于是控制台上看不到这个维度，只有轮次推进时才出现。
现在比率常量只有一个来源（`run.js` 的 `VERIFY_TOKEN_RATIO`），两处都从它派生。

另一处：`Number.isFinite(undefined)` 为 false，所以"有上限但还没花过"的
验证预算维度**直接消失了**。改成 `input.verifyTokens ?? 0` ——
**"未支出"不等于"未预算"**。

### 19.7 未验证 ⚠️

| 项 | 原因 |
|---|---|
| **面板的可视渲染** | 本会话没有浏览器控制能力，无法截图或读取 DOM |
| 面板与宿主的数据往返 | 同上；只能证明路由与存储两侧各自正确 |
| 客户端插件是否已进浏览器名册 | `/plugins/<pkg>/client.<name>.js` 需要 `?rev=`，无 rev 必然 404，无法据此判断 |
| **驱动器在真实会话里的行为** | 默认关闭（`config.driver: false`），需要一行配置才启用 |
| **第 3 层在真实模型上的表现** | 全部用例用桩 subagents 驱动；真实评估器的判断质量、成本、耗时都未测量 |
| **fresh 模式在真实会话里跑起来** | 驱动器默认关闭，且需要 subagents 服务；全部用例用桩驱动 |
| **约束抽取的召回与误报** | 规则式抽取器有 20 个用例，但从未在真实的中文/英文长会话上测过召回率 |

**两件事需要你做**：

1. **刷新页面**才能看到面板。本部署是 `npx` 安装（非开发 checkout），
   `pnpm run dev:web` 未运行，客户端 bundle 不会热重载。
2. **重启 profile** 才能加载新的模块代。`hmr.root: []` 意味着模块根不自动重载，
   当前跑的是第一代（只有任务台/记忆/Skill/智能体四页签）。

### 19.8 驱动器的启用方式（默认关闭）

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: longloop-console
  config:
    driver: true
```

**为什么默认关闭**：A6 说"恢复后不自动续跑"。一个默认开启的驱动器意味着
重启进程就可能继续干活，而没有人重新授权过它。打开它是一行配置，
但它必须是**有人主动写下的那一行**。

即便打开，驱动器仍要求：运行处于 `armed`、agent 空闲、未超出轮数上限、
没有人类消息插队。任一不满足即不排队。

### 19.9 开发过程中的一个异常

`packages/longloop/index.js` 在 16:15 被**本会话之外**的写入者重写过一次
（从 async 版改为 sync 版，并留下 `index.js.bak-161501`）。
改后的版本更正确 —— `PromptContext.text` 的契约是同步返回字符串，
async 会静默渲染成空串。当前文件即该版本，12/12 用例在其上通过。
**若这不是预期行为，说明该工作区有第二个写入者，需要排查。**
