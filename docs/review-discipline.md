# 天枢审查纪律

> 实证来源：2026-06-06 三轮对抗审查  
> 实现计划：[`docs/superpowers/plans/2026-06-06-review-discipline-internalization.md`](../superpowers/plans/2026-06-06-review-discipline-internalization.md)  
> 代码入口：`src/tools/review-changes.ts`、`src/agent/review-discipline.ts`、`src/agent/review-router.ts`、`src/agent/review-coordinator-deps.ts`、`src/agent/review-inbox.ts`

## 定位校准（2026-06-07）

外部 Claude Code Opus 的审查能力不能假设长期在场；本机制的目标是把它暴露出的客观、彻底、敢于不信绿灯的视角内化到天枢自己的工作流中。它不是替代交付侧 TDD 自闭环，而是辅助主控在「提交存在、测试绿、作者声称已修」之后继续做独立复核。

因此当前运行时策略（2026-10-25 起）是：提交、验证、审查三者分离，提交不再自动进入 ReviewRouter。审查由用户显式发起（`/review` 或 `review_changes`），只读、不阻断提交。仍会自动运行的审查只有两处，且都要显式开启：议事会 `autoExecute` 执行完最后一波后的审查门（L2/L3 在那里通过 adversarial verifier / squadron 给出独立证据），以及 `galaxy` / `starflow` 的 `autoReview` 追加审查维度。

## 四条纪律（实证驱动）

以下四条纪律来自 2026-06-06 的 Server 子系统对抗审查——18 个缺陷在三轮审查中被发现，其中 R2 和 R3 各自有一个假修复被独立 verifier 打破：

| 轮次 | 暴露的缺口 | 对应纪律 |
|------|-----------|----------|
| R1 | 首轮 18 缺陷全在正向数据流之外（安全/并发/失败模式被功能正确性挤占） | 纪律 1、2 |
| R2 | `51a26a3` H3 假修复（锁只包了 read），作者声称修复但无并发测试 | 纪律 2、4 |
| R3 | `411a51f` H4 删坏相邻行，作者声称"5 套件全过"但触发测试必红 | 纪律 3、4 |

### 纪律 1：不可同上下文自我审批

修复或交付前，须经一次独立验证 pass（换 agent/换上下文）。作者的自信不能顶替验证者的命令行。

### 纪律 2：修复提交前 spawn adversarial_verifier

拿命令+观察输出证据——不是读懂代码就盖 PASS。verifier 与 patcher 必须是不同子代理。

### 纪律 3：改 X 必跑覆盖 X 的既有测试；删除行同等审视

不只跑你为 X 新写的测试。审 diff 时删除行（`-`）与新增行同等审视——回归常长在编辑点的相邻行。

### 纪律 4："测试全过"声明 fail-closed

无"实际运行的命令+观察到的关键输出"的绿声明，一律按未验证处理。

---

## 审查工作流：提交、验证、审查分离

提交、验证、审查是三个独立入口，互不触发：

| 入口 | 只做什么 | 不做什么 |
|------|---------|---------|
| `deliver_task` | 文件归属、范围校验与 Git 安全保护，然后提交；回执写明「本次未执行测试或审查」 | 不跑测试、不触发审查 |
| `run_tests` | 执行测试（定向或全量） | 不审查、不提交 |
| `review_changes` / `/review` | 对固定快照做只读审查，发现存入本会话收件箱 | 不跑测试、不改代码、不提交 |

### 怎么发起审查

| 入口 | 深度 | 工作流 |
|------|------|--------|
| `/review [重点]`；桌面端 Plus 菜单 → ⚖ 审查 → L2 标准 | L2（`depth="default"`） | 1 个只读审查员 |
| `/review max [重点]`（`/review l3` 同义）；Plus 菜单 → Max 深度 | L3（`depth="max"`） | 5 人只读编队：安全 / 生命周期 / 数据流 / 静默 / 接线 |
| `/review l1`；Plus 菜单 → L1 轻量 | L1 | 只做范围与证据的静态提醒，不启动审查 worker |

L2 / L3 两档在 TUI 里直接调用 `review_changes`；桌面端 sidecar 把同一条斜杠命令翻译成对 `review_changes` 的调用，并按需挂载该工具。`review_changes` 在 minimal / frontend / full 开发档都已注册（扩展层，按需挂载）；用户要求审查时，主控也可以直接调用它。

### `review_changes` 的行为

- **审查对象**：优先用显式传入的 `files` / `commit_ref` / `range`；都没给时审本会话已归属的未提交改动，再没有就审本会话最近一次提交；仍无法确定时请用户指定，不会借用其他会话的 HEAD。
- **固定快照**：启动时锁定审查基准；审查期间代码变化只把报告标为「旧快照结果」，不自动重审。
- **只读**：不执行测试、不修改代码、不提交。「代码审查未发现问题」不等于「测试已通过」，验证仍归 `run_tests`。
- **发现持久化**：发现写入本会话收件箱（会话目录下的 `review-inbox.json`），用 `review_changes(action="list")` 查询、`action="update"` 登记处理；登记为 `fixed` 需要真实的修复提交。
- **不驱动后续执行**：审查完成后只通知原会话，不唤醒主控、不自动派补丁 worker。

### 仍会自动运行的两处审查（都需显式开启）

**议事会 `autoExecute` 的末波审查门**：`council_convene` 传 `autoExecute: true` 时，批准的计划会自动分波执行；最后一波有改动文件时，按 `teamReviewForceLevel` 选档：

| 档位 | 触发条件 | 工作流 |
|------|---------|--------|
| **L3 编队** | 跨模块 / ≥5 文件 / 触及安全边界 / 本波 ≥3 个任务 / 含高风险任务；改动文件 tsc 报错也升 L3 | 5 个审查员并行；有证据的 CRITICAL/HIGH 缺陷判 rejected |
| **L2 对抗验证** | 其余情况 | 1 个 `adversarial_verifier`；判 rejected 时交 `patcher` 补丁后复验，最多 3 轮 |

结论写进本次执行结果；verifier 与 patcher 为不同子代理。`team_orchestrate` 与 `plan_task` 的执行不带这道门，审查仍需用户发起。

**`galaxy` / `starflow` 的 `autoReview`**：默认 `false`（3.37 起由 `true` 改为 `false`）。显式传 `true` 时，所有执行维度完成后追加一个瑶光审查维度（`reviewer` profile）做全局审查；维度里已有 review / verify 维度时不再追加。

### 客观审查姿态

`src/agent/review-discipline.ts` 额外集中定义 `OBJECTIVE_REVIEW_STANCE`，并由 `src/agent/review-coordinator-deps.ts` 注入到只读审查员 / verifier / squadron objective：

1. 把自己当外部审查者，不替实现者补意图。
2. 区分亲自观察的证据与沿用他人声明。
3. 主动构造畸形输入、并发交错、错误路径、删除行相邻回归等反例。
4. 复核“定义”是否真的接入调用边界。

这部分来自外部 Opus 审查视角，但目标是让天枢在没有外部辅助时也能自带这把尺。

---

## 配置

### 没有「关闭自动审查」的开关

提交、测试和 `team_orchestrate` / `plan_task` 执行都不会触发审查，所以不需要关。不想审查就不发起；议事会的末波审查门只在传 `autoExecute: true` 时运行，`galaxy` / `starflow` 的追加审查只在传 `autoReview: true` 时运行。

### 只为兼容保留、已不生效的旧开关

| 旧开关 | 现状 |
|--------|------|
| `review.skipAuto`（TUI 设置面板「关闭提交后自动审查」）、`review.skipAutoSpark` | 照常读写，只初始化一个兼容用的会话标记，不改变任何执行 |
| `review.mechanicalFastPath`（TUI「机械变更走快路径」、桌面端「纯文档 / 重命名变更跳过审查」） | 原来控制的提交后自动审查路径已删除，现在没有效果 |
| `/review off` · `/review on` · `/review status`（TUI） | 只读写同一个兼容标记；桌面端收到这三条命令时回复「兼容空操作」 |
| 旧的进程级审查纪律环境变量 | 已没有任何执行路径读取，设了也不起作用；CI / headless 不需要再设 |

桌面端 Plus 菜单 → ⚖ 审查 只剩 L1 / L2 / Max 三个手动入口，没有 Auto / Off。

### 仍然生效的配置

- `agent.review.profiles`：按 worker profile 给审查子代理指定 provider / model。`/review`、`/review max` 与 `galaxy` 追加的审查维度用 `reviewer`；议事会末波审查门的 L2 用 `adversarial_verifier` 与 `patcher`，L3 编队用 `reviewer`。写法见 [Provider 配置用户手册](./user-guide-provider-config.md) 的 `agent.review` 一节。
- `RIVET_REVIEW_CHANGES=1`：在默认不含 `review_changes` 的工具档上强制注册它。
- 两处自动审查都由调用参数开启：议事会不传 `autoExecute` 就没有末波审查门（`COUNCIL=0` 整体停用议事会）；`galaxy` / `starflow` 不传 `autoReview: true` 就没有追加审查维度。

### 重入护栏

`reviewDepth` 数值穿过 `delegate` 边界结构化传播到子代理。审查子代理的 objective 写明不得调用 `deliver_task`、只报告 verdict / evidence；议事会末波审查门只在 `reviewDepth === 0` 的顶层调用里启动，审查子代理内部即使再跑编排，也不会递归触发新一轮审查。

---

## 扩展

- 审查纪律文本集中定义在 `src/agent/review-discipline.ts`（`REVIEW_DISCIPLINES` 常量），prompt/hook/gate/router 统一引用。
- 修复上下文识别逻辑（`isFixContext`）和变更规模分级（`classifyChangeScale`）同文件。
- 跨模块判定默认按 `src/<module>/` 顶层目录跨度（`isCrossModule`），可替换为 import 图或 owner 口径。
- 要调整审查门槛：规模分级在 `review-discipline.ts`；议事会末波审查门的升档条件（`teamReviewForceLevel`）与最大轮数（`maxRounds: 3`）在 `plan-executor.ts`；只读审查的时间预算在 `review-router.ts`（`reviewWorkflowBudgetMs`）。
