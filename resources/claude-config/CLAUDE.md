<!-- 由 resources/claude-config/CLAUDE.md 打包注入 SDK system prompt 末尾;维护说明详 resources/claude-config/README.md。 -->

--- Agent Deck 应用环境约定（随应用打包注入到每个 SDK 会话）---

# 应用环境约定

## 优先级声明（必读）

本文件是 agent-deck 应用环境的 baseline 约定。**优先级链**:
- SDK preset claude_code 内置安全约束（IMPORTANT 节）始终**最高优先级**,本文件与 user CLAUDE.md 都不替代
- user CLAUDE.md（`~/.claude/CLAUDE.md`）通用约定**优先于**本文件;与本文件冲突时**以 user CLAUDE.md 为准**
- 本文件提供 agent-deck 应用专属补充能力（mcp tool / plugin SKILL / cold-start 协议等）,不替换 user 通用约定

> **注:** 优先级链 in scope 是 claude SDK system prompt 注入的 baseline 文件之间(`settingSources: ['user',...]` 自动加载 user CLAUDE.md 作 baseline)。per-turn user message / developer message 等 SDK API 内置 prompt 类型的优先级在 SDK preset 内规定,与本节正交。**codex 视角等价 `CODEX_AGENTS.md` 因 codex SDK 加载机制不同(`~/.codex/AGENTS.md` marker 注入,无 user 通用约定全局加载机制)措辞不同是 adapter 差异不是 SSOT drift,维护时不要强行对齐两端**。

**加载范围**:本文件总是随应用打包注入到 SDK system prompt 末尾。`settingSources: ['user','project','local']` 的交互式 SDK 会话同时加载 user CLAUDE.md;`settingSources: []` 的内部 oneshot（如间歇总结）不加载 user CLAUDE.md,**本文件 self-contained 包含所需工程实践 inline**(§决策对抗 / §核心流程架构变更必走 plantUML / §复杂 plan workflow / §新项目工程地基)。

## 应用环境特有能力（不依赖 user CLAUDE.md）

### 协议覆盖：teammate 协作走 mcp tool

本应用环境（agent-deck）teammate 协作走 mcp tool（详 §Agent Deck Universal Team Backend 节）。teammate 通过 `send_message` 发消息 → universal-message-watcher → adapter.receiveTeammateMessage → adapter.sendMessage → SDK emit user-role event 自动注入 receiver conversation flow（receiver Claude 看到 user message 直接 act on it，无需主动 poll）。

### task 进度跟踪走 `mcp__agent-deck__task_*`,不走原生 `TaskCreate / TaskUpdate / TaskList`

本应用环境跑 plan / 多 Agent 协作 / 多步骤工作时,**task 进度跟踪必须走** `mcp__agent-deck__task_create` / `task_update` / `task_list` / `task_get` / `task_delete`,**不走** Claude Code CLI 内置的 `TaskCreate` / `TaskUpdate` / `TaskList`。

**Why**:
- task 必有归属 session（创建时自动绑当前 caller，不存在「无归属 task」）— 归属 session row 被 `historyRetentionDays` GC 或显式 `sessionRepo.delete` 物理删除时，DB FK ON DELETE CASCADE 自动删 owner task（**注意**：`closed` / `archived_at` 仅打 lifecycle 标记不删 row 不触发 CASCADE），无 backlog 累积
- task 可绑 team 也可不绑 — 绑了 = team 共享（同 team teammate 可见可写），没绑 = 私人（仅 owner 可见可写），类比群聊 vs 私聊。team 之间严格隔离避免 lead 跨 team 时 task 串流
- **权限**按 team_id 决定：team-bound → caller 必须是该 team active member 才能 read/write；personal → 仅 owner 可见可写（不开放同 team 共享，避免 lead 私人 task 被 teammate 偷看 / 偷改）
- **personal task 是 first-class**：用户不在任何 team 时仍能用 task（典型场景：lead 起 reviewer pair 不必加 team 也想用 task 跟踪）。不传 `team_id` = personal default
- `hand_off_session` baton 时按 `team_task_policy` 三态处理 task（详 §hand_off 节）
- 原生 `TaskCreate` 只 in-process 当前 SDK session 可见，跨会话 / 跨 teammate 全部丢失，与 universal team backend 协作意图相违背

**How to apply**:
- **新建 personal task** (default): `mcp__agent-deck__task_create({ subject, description?, status?, priority?, blocks?, blocked_by?, labels? })` → owner_session_id 自动闭包当前 caller, team_id=NULL
- **新建 team-bound task** (caller 必在该 active team): `mcp__agent-deck__task_create({ subject, team_id: <team-uuid>, ... })` — 不在该 team 是 active member 时 reject
- 状态切换: `mcp__agent-deck__task_update({ task_id, status })`, 枚举 `pending` / `active` / `completed` / `blocked` / `abandoned`(注意 `active` 替代原生 `in_progress`)。写权限按 team_id 判定;跨 team 写 reject
- 列表查询:
  - 默认 `mcp__agent-deck__task_list()` → caller 可见 scope(自己 personal ∪ 所有 active team 的 team task)
  - `task_list({ team_id_filter: <team-uuid> })` → 该 team 绑定的 task(caller 必在该 team active member)
  - `task_list({ team_id_filter: 'null-personal' })` → caller 自己的 personal task(字面量,与传 team-uuid 区分语义)
- 单个查询: `mcp__agent-deck__task_get({ task_id })` — 严格 team-scoped read + deny external caller
- 删除: `mcp__agent-deck__task_delete({ task_id, force?: false })`, force=true 级联删 downstream(每个 child 都过写权限,跨 team 子节点 skip)

**例外**: 应用 settings `enableAgentDeckMcp: false` 关闭时本组工具(以及其他 agent-deck mcp 工具)整体不挂 → 退化用 Claude Code CLI 内置原生 `TaskCreate / TaskUpdate / TaskList`。本应用打包 SDK 会话默认行为是 toggle ON 时挂上,挂上后**优先用 mcp__agent-deck__task_\***,不重复用原生 TaskCreate 制造两套 task list 进度漂移。

### reviewer-codex 失败 → SKILL 内合规兜底分支

`deep-review` SKILL 内若 reviewer-codex teammate 失败（codex SDK 起不来 / OAuth 过期 / shell tool call cancel / sandbox 拒 / timeout / codex thread jsonl 缺失 fresh-session abort），lead 走 Bash `{{AGENT_DECK_RESOURCES}}/templates/reviewer-codex.sh.tmpl` 起外部 codex CLI 仍构成异构对（详 SKILL.md §失败兜底 表第 1 行）。**严禁**自动降级到同源双 Claude（破坏异构对抗原则）。

---

## 决策对抗

下结论 / 出 plan 前必做。

**适用范围**（任一即触发）：
- 给代码下定性判断：bug / 优化 / code review / 安全 / 架构 / 根因
- 出执行计划（plan）
- 重要技术选型 / 重构方向决策
- **例外**：trivial 改动（typo / 样式数值 / 单点 rename / 显然措辞修订）

**场景分流**：

| 场景 | 走哪条 | 不能反过来 |
|---|---|---|
| **单次决策对抗**（1-2 个问题就够：单点判定 / plan 评审）| 本节 §主路径 双 Bash 起外部 CLI —— 同 message 并发起两个外部 CLI 进程 | 多轮 review 别走本路：fresh per turn 丢 in-memory state，反驳轮没自己上轮推理链反驳质量崩 |
| **多轮深度 review**（多轮 review × fix 循环 + 反驳轮 + focus 切片）| 应用环境若提供多轮 review 编排能力（teammate / SKILL 模式）则走之；否则降级为多次单点对抗（每次跑双 Bash），跨轮 mental model 丢失，反驳轮无法引用自己 R_N 推理链 | 单次决策对抗别走多轮编排：teammate 编排开销大无收益 |

### 主路径：双 Bash 起异构外部 CLI

**操作**：在同一 message 里并发起两个 Bash 调用，分别拿独立 stdout：

1. reviewer-claude 走 `zsh -i -l -c "claude -p ..."`（外部 Claude Code 进程，oneshot print mode）—— 模板：`{{AGENT_DECK_RESOURCES}}/templates/reviewer-claude.sh.tmpl`
2. reviewer-codex 走 `zsh -i -l -c "codex exec ..."`（外部 codex CLI 进程，oneshot exec mode）—— 模板：`{{AGENT_DECK_RESOURCES}}/templates/reviewer-codex.sh.tmpl`

> ⚠️ 这两份 `.sh.tmpl` 是 **Bash oneshot 起外部 CLI 用**（本节 §主路径单次决策对抗）；与 SDK 内可能挂载的同名 `reviewer-{claude,codex}` agent body（teammate 模式，跨轮 context 持久化、属环境专属编排）是**两套独立物件**，不要混用：单次决策对抗用本节 .sh.tmpl，多轮深度 review 走环境提供的 SKILL teammate 模式（如有）。

两个进程完全独立（互不知道对方存在 / 不沟通）→ 各自 stdout 回到主 agent → 主 agent 做三态裁决。

#### 外部 CLI 对抗 Agent 通用姿势

任何外部 CLI 当对抗 Agent 都遵循：

- **登录式 shell 包外层**（macOS：`zsh -i -l -c "..."`），否则缺 brew / nvm / path_helper PATH
- **强制非交互模式**（`-p` / `exec` / `--non-interactive` / `--batch`）
- **进程级只读约束**（codex 用 `--sandbox read-only --skip-git-repo-check`；claude 用 `--permission-mode plan` + `--allowedTools` 只读白名单）
- **显式传项目绝对路径**（`-C` / `--cwd` / `--workdir`）
- **分离最终答案与日志**：codex 用 `-o <FILE>`；claude 用 stdout 重定向 `> <FILE>`
- **reasoning effort 取最高档**（review / plan / 探索类用最高档；简单 yes/no 核查可临时降档省时间，但**宁可慢别错**）
- **长 prompt 走 stdin**（避免 argv 长度 / shell 转义陷阱），prompt 里**写死要读的文件绝对路径**，不让 CLI 自由 grep / explore
- **后台并发 + 等 task-notification**：Bash 工具用 `run_in_background: true`，让两个 CLI 真并发跑
- **超时只走 Bash 工具的 `timeout` 参数**（命令体内绝不写 `timeout` / `gtimeout`）。重 review 给 5-10 分钟（300000-600000 ms）
- **大 scope 拆批**：单批 ≤ 10 文件 / prompt ≤ 30 行；超出按主题拆批 + `run_in_background` 并发；卡住 `TaskStop` 后再拆更小批，不要傻等（详 `{{AGENT_DECK_RESOURCES}}/SOPs/codex-cli-stuck-lessons.md`）

### 反驳轮 + 三态裁决

**反驳轮**：单方独有 + HIGH 候选 → spawn 对方 reviewer 反驳一次（保持异构），反驳 prompt 明禁「借机提其他 finding」专注单点。反驳后主 agent 推到 ✅ / ❌ / 仍 ❓ → 必要时主 agent 自己现场验证（**单 finding ≤ 5min / ≤ 5 次 grep / ≤ 1 个 test，超就降级非 HIGH 不再纠缠**）。

**三态裁决**（每条 finding）：
- ✅ **真问题**（HIGH 必须满足 ≥1 个验证条件）：「**双方独立提出**」（异构强冗余即算验证）**或**「**一方提出且现场实践验证成立**」（grep 出 N 处证据 / 写小 test 复现挂掉 / 跑命令确认）→ 必修
- ❌ **反驳**：被对抗或现场核实证伪 → 不修，记反驳依据
- ❓ **部分 / 未验证**：双方角度不同 / 一方提出但纯文本推理（含弱断言）尚未实践验证 → 综合后决定

**单方独有分流**：HIGH → 反驳轮；MED → 主 agent 自己验证；LOW/INFO → 直接 ❓。双方都说没问题 → ✅ 可合。

### Finding 输出契约（reviewer prompt + 三态裁决 + REVIEW.md 共用）

每条 finding 必须带：
- `文件:行号` + 代码 / 原文片段（≤ 6 行）
- **验证手段**（如 "grep 出 3 处全无 null check" / "写 stateful mock 模拟双 disconnect 实测 abort 0 次"）
- 严重度分组：HIGH / MED / LOW / INFO（提示性、不影响合并）/ *未验证*

**强制约束**：
- 空泛 finding + 没验证 = 直接降 ❓ 或 ❌
- **任何 ✅ HIGH 都必须落到上述两个验证条件之一**（双方独立 / 单方 + 现场验证）
- 弱断言关键词（"可能 / 也许 / 看起来 / 应该 / 大概"）**只允许**出现在标注 *未验证* 的条目里 (注:reviewer-{claude,codex}.md §核心纪律 inline 重复此列表是设计意图 — reviewer agent body 独立注入 SDK,不依赖本文件 baseline 加载顺序,维护时不要按「冗余必合并」规则去抽 SSOT)
- 未验证强制降级为非 HIGH

### reviewer-codex 失败兜底

reviewer-codex CLI 失败（二进制缺失 / OAuth 过期 / 超时 / `$OUT` 空）→ 提示用户决策：等恢复 / 单方 reviewer-claude 出结论 / 稍后重试 / abort。invariant「严禁同源双 Claude」+ 合规兜底分支详 §应用环境特有能力 §reviewer-codex 失败 → SKILL 内合规兜底分支 节。

---

## 核心流程 / 架构变更必走 plantUML

涉及核心流程 / 架构变更时必须用 plantUML 画图并落到 `ref/` 对应子目录。**「怎么画」(plantUML syntax / 图类型 / workflow)由 `agent-deck:flow-arch-plantuml` SKILL 规定;「画在哪 / INDEX 怎么维护」由本节规定**(关注点分离 — SKILL 与位置约定独立维护)。

### 触发条件

详 SKILL.md §何时用 节；速查：
- **user 明示**「画架构图」/「画流程图」/「画 plantUML」/「核心流程图改一下」等
- **LLM 自检** 本次改动属以下 4 类任一：① 会话状态机（session lifecycle / sdk-bridge / context resume）② 跨进程通信（IPC / 跨 adapter 编排 / spawn-link 树 / event-bus 路由 / sandbox / permission）③ 数据库 / 协议（DB schema / wire format / canUseTool）④ 关键 mcp tool 行为（archive_plan / hand_off_session / spawn_session / send_message dispatch / lifecycle scheduler）
- **trivial 改动**（typo / 单点 rename / UI 微调 / 业务模块内部不动协议）**不触发**

invoke 前必须与 user 显式确认是核心变更(SKILL 入口 AskUserQuestion enforce);否则 skill no-op exit。

### 文件位置约定

- **流程图**(sequence diagram / activity diagram)落 `<main-repo>/ref/flows/<topic>.puml`
- **架构图**(component diagram / 模块依赖 / 跨进程边界)落 `<main-repo>/ref/architecture/<topic>.puml`
- **文件命名** `<topic>.puml`,topic 用 kebab-case(`archive-plan-flow.puml` / `mcp-server-architecture.puml`)
- **同主题需要双图**(流程图 + 架构图)→ 拆两份分别落各自目录,topic 名可一致(`archive-plan-flow.puml` vs `archive-plan-architecture.puml`)
- **目录不存在**(典型新项目 / 本 plan 实施前):SKILL 主动 `mkdir -p ref/flows ref/architecture` + 建空 INDEX.md(下节 4 列模板)
- **codex 端走法**: codex SDK session 无 `flow-arch-plantuml` SKILL 入口(本 SKILL 仅 claude-config 端打包,详 README.md §设计 SSOT)。codex lead 需画 plantUML 时按本节文件位置 / INDEX 规则手工编辑 `.puml` + INDEX.md(与 claude 端 SKILL 编辑动作等价 — 本约定纯生成/修改 .puml SSOT 不渲染);可选跑 `shell: plantuml -syntax <file>.puml` 做语法检查。**严禁** codex 端调 `plantuml -tpng / -tsvg` 渲染产 PNG/SVG(违反 flow-arch SKILL §不渲染 SSOT — user 想看渲染产物自跑 plantuml CLI)。

### INDEX.md 格式

`ref/flows/INDEX.md` 与 `ref/architecture/INDEX.md` 都用 4 列表:

```markdown
| 文件 | 状态 | 关联 plan / commit | 概要 |
|---|---|---|---|
| [archive-plan-flow.puml](archive-plan-flow.puml) | active | [ref-layout-full-migration-20260526](../plans/ref-layout-full-migration-20260526.md) | archive_plan 5 步收口 sequence 图 |
| [mcp-server-architecture.puml](mcp-server-architecture.puml) | active | commit ef1679 | 主进程 mcp server 内部模块依赖 |
```

- **状态**:`active`(当前 SSOT)/ `archived`(图过时但保留作历史 reference;.puml 内同步加注释 `' ARCHIVED: ...`)/ `draft`(未确认)
- **关联 plan / commit**:链接到 `ref/plans/<plan-id>.md` 或 commit hash 让读者溯源(commit hash 用 7 字符 short hash 即可)
- **概要**:≤80 字描述本图主题

### 与 user 确认机制

SKILL 入口必须先 AskUserQuestion(2-3 题)对齐 — **是否核心变更 / 图类型选择 / 新建 vs 修改 vs archived 已有**(详 SKILL.md §与 user 确认机制)。本应用工程实践**严禁** agent 默认静默生成图;每次画图前都要与 user 确认。

### 与其他规则关系

- 与 `agent-deck:deep-review` SKILL 互斥并行(同会话不并行,避免 .puml SSOT 写竞争);deep-review 中发现需画图 → 完成 review 后 invoke `flow-arch-plantuml`
- 与本应用 `agent-deck:flow-arch-plantuml` SKILL **关注点分离**:本节定位置/INDEX 规则,SKILL 定画图技术 — 两边修改时**不要复制 SSOT**,只保留 cross-ref(SSOT 单源不复制 — 同款规则只在一处其他位置引用)

---
## 复杂 plan：worktree 隔离 + 跨会话 hand off + RFC / spike / Deep-Review 前置

单会话上下文容量有限（200K-1M token，溢出触发 compaction 把旧信息压缩丢失）。**预计跨多会话**的 plan 必须在动手**前**就设计成两层隔离：

- **空间**：git worktree 锁**代码改动**在 `.claude/worktrees/<plan-id>/`，主分支代码区零污染
- **时间**：plan 文件保留跨会话进度 / 决策 / 下一步，新会话 cold start 直接接力

不要等 context 70%+ 才临时抢救。

### 触发（任一即走）

- **预计跨 ≥ 2 个会话才能收口**（≥ 5 个非 trivial step / 跨多模块 / ≥ 数百行代码 / 当前会话已吃 ≥ 40-50% 上下文 / **OR 含不确定 design / SDK 行为未知 / 需 spike 才能完成设计**）
- **破坏性 / 实验性改动，希望失败时整片回退**
- **跨 adapter / 跨 schema / 跨进程边界改造**（独立代码量不大但牵动多底层组件）

### 流程总览（触发后执行序）

```
Step 0    §RFC 前置        (agent 主动 AskUserQuestion 多轮对齐 design 大方向 / 不变量 / 边界)
Step 0.5  §spike 前置      (agent 写 mini-runner 实测 SDK / lib 行为, 输出 spike-reports/)
Step 1    §Plan 文件 hand off (agent Write plan 文件 inline RFC + spike 结论 / 设计决策 / 步骤 checklist)
Step 1.5  §Deep-Review     (agent invoke 应用环境提供的 deep-review SKILL,reviewer 出 finding fix 直到通过)
Step 2    §EnterWorktree   (user confirm 后, agent 进 worktree; 不再是 plan 写作前置)
Step 2.5  §何时主动 hand off (lead 自检触发跨会话接力)
Step 3    §接力姿势        (会话末必做 + 选项 A/B 起新会话)
Step 4    §plan 完成 / 中止 cleanup
```

### Step 0. RFC 前置（agent 主动起 AskUserQuestion 对齐 design）

**触发**（任一即走）：
- §触发 命中 + 含不确定 design / SDK 行为未知 / 选型问题
- 重要 design 决策（架构 / 选型 / 重构方向 / breaking change 接口设计）
- 用户明示「商讨」「rfc」「先讨论再动手」

**形式**：
- agent 主动用 `AskUserQuestion` 多轮（每轮 3-4 个问题，2-3 轮内对齐）
- 每轮聚焦一个 design 维度（如 schema 选型 / 边界条件 / 不变量定义 / fallback 策略）
- 用户回答 → agent 综合到下一轮 / 收敛结论
- **不要等用户先发起**：agent 识别「这步前我不确定该怎么 design」即起 RFC

**输出**：
- design 结论 inline 到 plan §设计决策节（每条决策含 RFC 来源 reference，如 `(RFC 第 N 轮 Q2)`）
- 不变量 / 边界条件 inline 到 plan §不变量节
- 不确定项标注 *待 spike 验证* 留 Step 0.5

> 与 §决策对抗 正交：RFC = design 大方向对齐（与用户讨论）；决策对抗 = 结论评审（双 Bash 起异构 CLI 单次 review）。RFC 后仍可叠加决策对抗。

### Step 0.5. Spike 前置（实测 SDK / lib 行为验证假设）

**触发**：
- RFC 阶段发现 SDK / 三方 lib / 系统 API 行为未知（"我想这样 design 但不知 SDK 是否支持"）
- 关键假设未实证（性能 / 边界 / 错误处理 / sandbox 等）
- plan §设计决策内含 *待 spike 验证* 标注

**形式**：
- **路径术语**：`<plan-file-dir>` = plan 文件所在目录；`<plan-artifact-dir>` = `<plan-file-dir>/<plan-id>/`（与 `<plan-id>.md` 平级的 artifacts 目录）
- 写 mini-runner（Bash `run_in_background` 起外部 CLI / Python script / Node script）
- 输出落盘到 `<plan-artifact-dir>/spike-reports/spike<N>-<topic>.md`（每个 spike 独立 md + 可选 .mjs / .py runner 源码）
- spike md 含：动机 / 假设 / 实测命令 / 实测结果 / 结论 / 残留风险

**输出**：
- spike 结论 inline 到 plan §设计决策（含实测铁证 + 残留风险）
- plan §设计决策内 *待 spike 验证* 标注改为 *已 spike：实证 X / 假设 Y 推翻*
- 残留风险列表入 plan §已知踩坑
- **归档**：spike 产物（spike md + runner + .log trace）写作期落 `<plan-artifact-dir>/spike-reports/`；plan 完成时按 §Step 4 完成节 step 3 一起 mv 到 `<main-repo>/ref/plans/<plan-id>/spike-reports/`，成为归档 plan .md 的同名 artifacts 目录并入 git（design 决策溯源 evidence 永久保留）

> 与 §决策对抗 正交：spike = 实测假设（单 runner 跑 SDK）；决策对抗 = 评审结论。两者可叠加。

### Step 1. Plan 文件 hand off（时间隔离）

新建 plan 文件，**用绝对路径写入**（不要写到 worktree working tree——worktree 是独立 branch，跨会话主 repo 看不到该 branch 的文件）。三个合法位置：

- `<main-repo-abs-path>/ref/plans/<plan-id>.md` —— **项目内 git 归档版（completed 落此）**。在统一参考资产根 `ref/` 下，与 `ref/changelogs/` `ref/reviews/` `ref/conventions/` 同级，跟项目一起入 git。同步建 `ref/plans/INDEX.md` 一行表索引
- `<main-repo-abs-path>/.claude/plans/<plan-id>.md` —— project-specific local 工作目录（`.gitignore` 必加 `.claude/plans/`）。适合 in_progress 短临时草稿；完成后挪到 `<main-repo>/ref/plans/`
- `~/.claude/plans/<plan-id>.md` —— 跨项目 plan 或 CLI `/plan` slash command 默认位置；不入任何项目 git

不论哪种位置，§Step 3 cold start prompt 必须写明绝对路径，让新会话能直接 `Bash: cat`（详 §Step 3 末尾 callout 关于跨会话第一次读「长期存在 + 其他会话动过的文件」必须走 cat 而非 Read 的原因）。

`<plan-id>` 命名 `<topic>-<YYYYMMDD>`（如 `mcp-server-rollout-20260511`），与 §Step 2 worktree branch / 目录名严格一致。**字符集限 `[A-Za-z0-9._-]`、单 segment ≤ 64 字符**（EnterWorktree 工具校验）。

**plan 内容**：
- frontmatter: `plan_id` / `created_at` / `worktree_path`（绝对路径）/ `status: in_progress|completed|abandoned` / `base_commit` / `base_branch`（切 worktree 时所在的分支名 —— §Step 4「完成」ff-merge 目标，**默认不是 main**，是创 plan 时主仓库当前 HEAD 所在分支；feature branch 上跑 plan 时这个值就是 feature branch 名，让 worktree 改动合回 feature branch 而非 main 误污染主线）
- **总目标 & 不变量**（含 Step 0 RFC 决策 + Step 0.5 spike 实证）
- **设计决策（不再争论）**：每条带简短理由（含 RFC 来源 reference / spike 实证 reference）
- **步骤 checklist**：`- [x] Step N — done by <session> on <date>，commit <hash|uncommitted>`
- **当前进度**：卡在哪 / 已验什么 / 未验什么
- **下一会话第一步**：cold start 的**完整指令载体**，具体到「先 `Bash: cat X` / 跑 `pnpm Y` / 改 `Z:line`」级别（**不要写 `Read X`**——cold start 跨会话第一次读文件强制走 `Bash: cat`，详 §Step 3 末尾 callout）。**所有指向代码资产的路径用 worktree 内绝对路径**（路径规则见 §Step 2 末 callout）
- **已知踩坑**（可选）

### Step 1.5. Deep-Review（plan 写完先评审 design / 流程一致性 / 不变量）

**触发**：Step 1 plan 文件写完，进 Step 2 EnterWorktree **之前**必走（确保 design 经评审才进 worktree 实施，避免后期发现 design 错误整片返工）。

**形式**：
- agent 主动 invoke 应用环境提供的 deep-review SKILL（如 agent-deck 应用环境的 `/agent-deck:deep-review`）
- args（typed scope）：`{kind: 'plan', paths: ['<plan-abs-path>']}`（plan 评审走 kind='plan' 模板）；如同时含 code 实施一致性需 review → kind='mixed'
- SKILL 内部走多轮异构对抗（reviewer-claude / reviewer-codex teammate）+ 反驳轮 + 三态裁决
- finding HIGH 必修 / MED 现场验证 → fix 直到 reviewer 共识可合

**输出**：
- 修订后的 plan 文件（design 经过双对抗评审，不变量明确，步骤 checklist 行级精确）
- 若 review 出 HIGH design 缺陷 → 回到 Step 0 RFC / Step 0.5 spike 重新对齐
- 若 0 HIGH 0 真 MED → 进 Step 2 EnterWorktree

**与 §决策对抗 关系**：本 Step 1.5 = 复杂 plan 内嵌的多轮深度 review；§决策对抗 主路径是单次决策对抗（双 Bash 起外部 CLI）。复杂 plan 走多轮 SKILL 编排，单次决策走主路径。

> ⚠️ **没有应用环境提供 deep-review SKILL 时**：降级为 §决策对抗 主路径单次 review（双 Bash 起外部 CLI，模板 `{{AGENT_DECK_RESOURCES}}/templates/reviewer-{claude,codex}.sh.tmpl`），仅评审 plan 文件本身（不含多轮 fix loop）。这是 fallback 不是替代,有应用 SKILL 优先用 SKILL。

### Step 2. EnterWorktree（空间隔离 — user confirm 后才进）

**前置**：Step 1 plan 写完 + Step 1.5 Deep-Review 通过 + **user 明确 confirm 进 worktree 实施**（agent 不能在 user 没看完 plan + review finding 前自动进 worktree）。

**进 worktree 操作**（避开 §EnterWorktree CLI stale base bug 必须走主路径 (b) Bash 显式建 worktree + EnterWorktree(path:) 进入，详 §EnterWorktree CLI stale base bug callout）：

```bash
# 1. 在 main repo 跑（cwd 在 main repo 或任何子目录都可）
git -C <main-repo-abs-path> worktree add -b worktree-<plan-id> <main-repo-abs-path>/.claude/worktrees/<plan-id>
# 2. 用 EnterWorktree(path: ...) 进入已建好的 worktree（注意是 path 不是 name）
```
```
EnterWorktree(path: "<main-repo-abs-path>/.claude/worktrees/<plan-id>")
```

所有代码改动 / 测试 / 验证全在 worktree 里跑。

> `EnterWorktree` 工具默认禁用（仅当用户或 CLAUDE.md 显式要求才用）。**只有触发条件 + Step 1 + Step 1.5 全过且 user 显式 confirm 进 worktree 后**，本节才授权直接走上面 Bash + EnterWorktree(path:) 进 worktree。
> **不要用 `EnterWorktree(name: "<plan-id>")` 一步创+进**：撞 CLI v2.1.112 stale base bug（详下方 callout），必须走 Bash + path 两步形式。仅当 §何时仍可用 `EnterWorktree(name: ...)` callout 三种例外场景才可用 name 单步形式。

`<plan-id>` 命名遵守 §Step 1 plan 文件 stem 一致性约束。

#### ⚠️ EnterWorktree CLI **stale base bug**（v2.1.112 实测，必看）

**Claude Code CLI v2.1.112 builtin EnterWorktree 工具默认 base 用 `origin/<default-branch>` 而非本地 HEAD**（CLI tool description 明文承诺 `based on HEAD` 与实现严重不符 = contract vs implementation 矛盾 bug）。

**触发条件**：本地 `HEAD != refs/remotes/origin/<default>`（即本地 ahead / behind / divergent origin） + 有 origin remote 配置 + `refs/remotes/origin/<default>` ref 存在 → **必中**。典型场景：
- `commit` 但未 `push`（本地 ahead origin 1+ commits） — **R37 archive_plan 完成后立即 EnterWorktree 是教科书级触发**
- `git pull` 完后立即 commit
- feature branch 上 commit 未 push
- 任何长会话中本地有未同步 commit

**症状**：新 worktree HEAD = `origin/<default>`（last fetch 状态）落后本地 HEAD 二十甚至更多 commit。改动基于 stale base → ff-merge 失败 / 与 main 已有改动冲突 / 测试基于 stale 验证不可信。**Edit / Read 在 worktree 里报「成功」时根本看不出**，直到收口阶段才暴露。

**主路径 (b)**：**禁用** `EnterWorktree(name: ...)` 创新 worktree，改用 §Step 2 EnterWorktree 节开头的 Bash + `EnterWorktree(path: ...)` 两步形式（隐式用 HEAD 作 base）。`git worktree add -b <branch> <path>`（省略 `<commit-ish>`） git 默认用 HEAD 作 start-point（man page 保证），**实测铁证 worktree HEAD == main HEAD**。

**兜底自检 (a)**：万一已经用 `EnterWorktree(name: ...)` 创了 worktree（如老 plan / 历史代码 / 临时探索），进 worktree 后**立即**自检 + 修正：

```bash
# 自检：worktree HEAD 应等于 main repo HEAD
git -C <worktree-abs-path> rev-parse HEAD              # 新 worktree HEAD
git -C <main-repo-abs-path> rev-parse HEAD              # main repo HEAD（cwd 在 worktree 时显式 -C 主仓库）
# 不等 → reset 修正（destructive，请确认 worktree 内无未保存改动；submodule 加 --recurse-submodules）
git -C <worktree-abs-path> reset --hard <main-HEAD>
```

**何时仍可用 `EnterWorktree(name: ...)`**：
- 本地 HEAD 已经等于 origin/<default>（最近 push 完且 fetch 同步） — 此时 stale 退化为 0 commit
- 没有 origin remote 配置（local-only repo） — CLI 走 `$ = "HEAD"` fallback 路径正确
- 你**明确**想从 origin/<default> 起手（非 plan 工作流场景）

**追溯**：上游 bug 跟踪走 anthropics/claude-code GitHub issue（complete reproduction recipe 详细分析见 agent-deck 项目 [`ref/reviews/REVIEW_38.md`](../../ref/reviews/REVIEW_38.md) 与 plan `worktree-stale-base-bug-20260515`，包含 cli.js byte offset / minified code 反编译 / git man page 实证 / reflog 加强证据）。

#### ⚠️ worktree 路径陷阱（**唯一**一处约束，§Step 1 / §Step 3 引用此处）

进 worktree 后，凡指向**代码资产**的路径都必须含 `.claude/worktrees/<plan-id>/` 前缀。`cwd` 切了不代表绝对路径自动重映射 —— 不带前缀 + worktree cwd = 操作主仓库文件、worktree 内岿然不动，Edit / Read 都报「成功」实际上主仓库被悄悄污染。

**必须落 worktree**：Edit / Read / Write / Grep / Glob 的 path；Bash 命令体内绝对路径；`git -C`；外部 CLI 的 `-C` / `--cwd` / `--workdir`。**例外**（非代码资产）：plan 文件本身、`~/.claude/...` 配置、worktree 之外其他独立项目。

**防再踩**：(1) 进 worktree 第一件事 `Bash: pwd` 自检；(2) 路径快速取法 `echo "$(pwd)/<rel>"`；(3) 大批量编辑后双向 `git status` 验证（worktree 应 dirty / 主仓库应 clean），改错只 `git -C <main> checkout -- <污染文件>`，**严禁** `git reset --hard`；(4) plan「§下一会话第一步」直接写 worktree 内绝对路径。

### Step 2.5 何时主动 hand off（lead 自检触发）

§Step 1 + §Step 2 决定要不要进 worktree + 写 plan；本节决定**当前会话**要不要现在 hand off。lead 周期性自检，触发信号 + 前置全满足 → 主动走 §选项 B（环境提供自动 tool 时）或 §选项 A（兜底）；不要等 context 烧到 80%+ 才被动 compaction。

**触发信号**（任一即考虑）：完成一个独立 phase（与下一 phase mental model 重叠度低）/ 用户语义信号（「告一段落」/「换个会话继续」/「context 太满了」类）/ 可选 context ≥ 60%（仅当 host 通过 system reminder 明示 token usage 时启用 — agent 端无 self-introspection API，多数 turn 用不到）

**前置条件**（必须全满足）：worktree clean（`git status` 空）+ plan「下一会话第一步」+「当前进度」节已写好

**默认动作**：环境提供自动接力 tool → §选项 B 一行完成 baton + 归档；否则 → §选项 A 把 cold start prompt 给用户

**前置不满足时**：worktree dirty → 先 commit；plan 节空 / 偏离 → 先写。**例外**（暂不 hand off）：正在跑不可分割事务（typecheck / build / 测试）等收尾；用户明示「先做完 X 再说」听用户。

> ⚠️ 环境未提供自动接力 tool / tool 不可用（如 plan_id 已 status=completed）→ 退化到 §选项 A。

### Step 3. 接力姿势

#### 会话结束前必做

1. 更新 plan：打勾完成步骤 + 写「当前进度」+ 写「下一会话第一步」
2. **退出 worktree** 一律用 `ExitWorktree(action: "keep")`（详 §Step 4）
3. 起新会话（两种选项 §A / §B 二选一，看应用环境）

#### 选项 A：把 cold start prompt 给用户（默认；任何应用环境都适用）

```
按 <plan-abs-path> 接力
```

例：`按 /Users/<user>/Repository/<your-project>/.claude/plans/<plan-id>.md 接力`

新会话 agent 看到这一句**必做**：

1. `Bash: cat <plan-abs-path>` 全文（详下方 callout 关于强制 cat 的范围）
2. 从 frontmatter 拿 `worktree_path` → `EnterWorktree(path: <worktree_path>)` 进同一 worktree（用 `path`，不是 `name`）
3. （可选自检）`git log --oneline -3` 确认 HEAD = frontmatter `base_commit` 或之后
4. 按 plan **§下一会话第一步** 节直接动手；**不重新讨论已记录的 §设计决策**；**所有指向代码资产的路径换 worktree 前缀**（路径规则见 §Step 2 末 callout）
5. 进度 / 决策变更必须先告诉用户征得确认

> ⚠️ **跨会话第一次读「长期存在 + 其他会话动过的文件」（含 hand off plan 本身 / 本节 §下一会话第一步指向的代码资产文件）必须走 `Bash: cat`，严禁用 `Read` 工具** —— Claude Code CLI 在「新会话 + 同 cwd + 同 system prompt」组合下会复用前会话 jsonl 里同 file_path 的 cached Read tool_result（不真去读 fs），导致拿到旧版本内容。`Bash: cat` 走 shell 通道每次真跑 fs。**作用范围**：仅跨会话第一次 + 长期存在 + 其他会话动过的文件；本会话内自己刚改 / 刚 Read 过的文件不约束。

#### 选项 B：用环境提供的自动接力 tool 起新会话（如挂载了 mcp 编排能力）

如果当前会话所在的应用环境提供了接力自动化 tool（如 Agent Deck MCP 的 `hand_off_session`），调它一行完成：起新 SDK session（cold start prompt = `按 <plan-abs-path> 接力`）+ 自动归档当前 caller。新 session 同走 §选项 A cold-start 5 步（cat plan → EnterWorktree → 自检 → 动手），应用 SDK 会话总是注入本文件加载有保证。

具体调用方式 / args / 返回值 / cwd resilience / baton 语义 / 双模式（plan-driven vs generic）/ default team 行为等细节由各应用 CLAUDE.md / SKILL 定义（应用 build 时把工具 description 注入 SDK system prompt 的 tool definitions），本节不重复 SSOT。

### Step 4. plan 完成 / 中止 cleanup

> ⚠️ `ExitWorktree(action: "remove")` **只对当前会话自己创建的 worktree 有效**；用 `path` 参数进入的现有 worktree 上 CLI validateInput 直接拒（errorCode 4，强制 `keep`）。跨会话场景**统一**走 `keep` + Bash 手动 `git worktree remove` 或下文的 mcp tool 自动化。

#### 完成

> 💡 如环境提供 plan 归档自动化 tool（如 mcp 形式），优先调它**一行原子完成**替代下方手工序列；具体 schema / 自动做的事情 / 预检规则 / 返回值由各应用 CLAUDE.md / SKILL 定义，本节不重复。

通用 5 步收尾（手工或被自动 tool 等价执行）：

1. `ExitWorktree(action: "keep")` —— 先把 cwd 切出 worktree（自动 tool 也不能调 ExitWorktree CLI 内部 tool，caller 必须先做这步）
2. worktree branch 合回**切 worktree 时所在的原分支**（plan frontmatter 里的 `base_branch`，不是直接 main）：
   ```bash
   git -C <main-repo-abs-path> checkout <base-branch>
   git -C <main-repo-abs-path> merge --ff-only worktree-<plan-id>
   ```
   **关键 ⚠️**：`<base-branch>` 必须是切 worktree 时主仓库 HEAD 所在分支（feature branch 上开 plan 就是 feature branch，main 上开 plan 就是 main），**不是无脑用 main**。否则会把 worktree 改动合进 main 而非原 feature branch，污染主线 + 丢 feature branch 上的工作。caller 当前 HEAD 不在 base-branch 时手工 checkout 切过去。
3. plan 归档到项目内 git：
   - 更新 frontmatter：`status: completed` + `final_commit: <hash>` + `completed_at: <ISO ts>`
   - `mv` plan 文件到 `<main-repo>/ref/plans/<plan-id>.md`（在 `ref/` 统一参考资产根下，与 `ref/changelogs/` `ref/reviews/` `ref/conventions/` 同级）
   - **如 plan 有 spike**（`<plan-artifact-dir>/spike-reports/` 存在 → §Step 0.5 产物；`<plan-artifact-dir>` = `<plan-file-dir>/<plan-id>/`）：`mv <plan-artifact-dir>/spike-reports/ <main-repo>/ref/plans/<plan-id>/spike-reports/`（plan .md 同名子目录与 plan .md 平级；约定 plan .md 是主体 + 同名目录是 artifacts），保留 spike md + runner + .log trace 永久入 git（design 决策溯源 evidence）。`.gitignore` 必备条目已含 `!ref/plans/**/spike-reports/**/*.log` exception 让 .log 跳过全局 `*.log` 过滤（详 §新项目工程地基 §.gitignore 必备条目）。
   - 同步 `<main-repo>/ref/plans/INDEX.md`（不存在则建，存在则 append 一行）
   - `git add <main-repo>/ref/plans/<plan-id>.md <main-repo>/ref/plans/INDEX.md <main-repo>/ref/plans/<plan-id>/`（含 spike-reports/ 子目录如有）+ `git commit -m "chore(plans): archive <plan-id>"`
4. `<main-repo>/ref/changelogs/CHANGELOG_X.md` 引用归档（不抄全 plan）—— agent 自己写
5. 删 worktree + branch：`git worktree remove <worktree_path>` + `git branch -D worktree-<plan-id>`

> ⚠️ 步骤 1、2、3、5 属于同一收口事务，必须**原子完成**（步骤间任一失败应整片回滚或 abort，不要做部分回滚 — git 操作不可逆；步骤 4 是 changelog 引用补写，不计入归档事务）。手工执行时遇预检条件（plan status ≠ in_progress / worktree dirty / cwd 在 worktree 内 / detached HEAD 任一命中）应立即 abort，不要硬上。

#### 中止

frontmatter 置 `status: abandoned` + 中止理由 → `ExitWorktree(action: "keep")` → Bash `git worktree remove --force <worktree_path>` + `git branch -D worktree-<plan-id>`（abandoned plan 不入项目 git 归档，不走自动化归档 tool — tool 强制 `status=completed`，详 §plan hand-off §archive_plan §app-only 差异）。

### 与其他机制的关系

- **载体分工**：本节 plan 文件 = 跨会话设计文档（滚动）；`ref/changelogs/` = 实施完成存档（plan 完成后引用归档）；mcp 结构化 task store（应用提供，如 agent-deck 的 `mcp__agent-deck__task_*`）= 单会话 / 跨会话 task 进度可见性通道
- **决策流程分工**：本节进 plan + worktree 双隔离是「机械触发」**不**走对抗；plan 内的设计决策（架构 / 选型）该走还得走，结论记入 plan「设计决策」节。`ExitPlanMode` 是「单次实施前与用户对齐」工具，输出**设计内容**进 plan「设计决策」节

---

## 新项目工程地基

新建任何长期维护工程时，第一次提交就把这套结构建好。

### 目录骨架

```
project-root/
├── CLAUDE.md                     # 项目专属（与 ~/.claude/CLAUDE.md 互补）
├── README.md                     # 功能总览（用户视角）
├── src/                          # 源码（统一根入口，详 §src/build 标准目录结构 节）
├── build/ 或 dist/               # build 产物（统一根出口二选一，详 §src/build 标准目录结构 节）
└── ref/                          # AI Coding 参考资产（changelogs / reviews / plans / conventions 统一收纳）
    ├── changelogs/INDEX.md       # 一行表索引；CHANGELOG_X.md 第一次有变更时再建
    ├── reviews/INDEX.md          # 一行表索引；REVIEW_X.md 第一次 review 时再建
    ├── plans/                    # 项目内 git 归档版 completed plan（in_progress 草稿在 .claude/plans/）
    │   └── INDEX.md              # 第一次有 completed plan 时再建
    └── conventions/              # 项目特定约定（与 ref/changelogs/ ref/reviews/ ref/plans/ 同级）
        ├── INDEX.md              # 已升级约定一行表索引 + 候选概览
        ├── tally.md              # 反馈 / 踩坑候选状态机（自维护，不要手工删条目）
        └── <X>-<topic>.md        # 单条已升级约定，X 递增整数
```

模板见 `{{AGENT_DECK_RESOURCES}}/templates/`：
- `project-claude.template.md` / `changelog-index.template.md` / `reviews-index.template.md` / `conventions-tally.template.md` / `conventions-index.template.md` / `convention-single.template.md` / `changelog.template.md` / `review.template.md`

### src/build 标准目录结构

> 源码与 build 产物的统一根入口/出口约定，避免后续大重构。

- **源码** 落 `<project-root>/src/`。first-party 源代码（业务 / 工具脚本 / first-party test 源；**不含**测试 fixture / 自动生成产物 / 第三方依赖）落本目录
- **build 产物** 落 `<project-root>/build/` 或 `<project-root>/dist/` 二选一（项目内统一用一个；本节后续表述 `build/` 处泛指你选定的那一个）。任何工具链输出（`out/` `release/` `target/` `.next/` `.turbo/` `node_modules/.cache/` 等历史命名）一律收敛到所选根出口的子目录
- **选 build/ 还是 dist/**：跟工具链默认走（Vite / Webpack / Cargo / tsup / TypeScript 默认 `dist/` → 用 `dist/`；Go / electron-builder / make 默认 `build/` → 用 `build/`），减少配置摩擦。**同项目内不混用**（典型陷阱：Vite 默认 `dist/` + electron-builder 默认 `build/dist` → 选一个 root 把另一类产物拍到子目录，如 `dist/renderer/` + `dist/electron/` 或 `build/renderer/` + `build/electron/`）
- **多入口项目**（Electron / monorepo / 多语言混合）按子目录分流：`src/<entry>/` ↔ `build/<entry>/` 或 `dist/<entry>/`（典型 Electron：`src/main/` `src/preload/` `src/renderer/` `src/shared/` 对应 `build/main/` `build/preload/` `build/renderer/`，或同款用 `dist/`）
- **顶层非 src/ 非 build/dist/ 资产**按用途归位，**不归 src/ 也不归所选根出口**：
  - 项目元数据 / 顶层配置 / 锁定文件：`README.md` `CLAUDE.md` `LICENSE` `package.json` `tsconfig*.json` `*.config.*`（`vite.config.ts` `vitest.config.ts` `postcss.config.mjs` 等）`pnpm-lock.yaml` `Cargo.toml` `Cargo.lock` `go.mod` `go.sum` 等放 `<project-root>/` 根
  - 静态资产：`public/` / `static/` / `assets/`（按框架惯例：Next.js / Vite / 11ty / Hugo 等）
  - CI / IDE / Git：`.github/` `.gitlab-ci.yml` `.vscode/` `.idea/` `.editorconfig` `.gitignore` `.npmrc`
  - 第三方依赖：`node_modules/` `vendor/`（包管理器自治位置）
  - 本约定专属顶层目录：`ref/`（详 §目录骨架 节）/ `.claude/`（per-session state）
- **.gitignore 必备**：`build/` 与 `dist/` **都加**（详 §.gitignore 必备条目 节；项目实际用其一，另一个无害保留为防御性条目，避免临时工具链产生未追踪产物意外入 git）

**落地姿势**：配工具链时显式声明 outDir / distDir 指向所选根目录：
- TypeScript：`tsconfig.json` `"outDir": "build/"` 或 `"dist/"`
- Vite / Webpack：`build.outDir: 'build/'` 或 `'dist/'`（Vite 默认 `dist/`）
- electron-vite：`main.build.outDir: 'build/main'` / `preload.build.outDir: 'build/preload'` / `renderer.build.outDir: 'build/renderer'`（或同款用 `dist/`）
- electron-builder：`directories.output: 'build/dist'` 或 `'dist/'`
- Go：`go build -o build/<binary>` 或 `dist/<binary>`
- Cargo：`CARGO_TARGET_DIR=build/target` 或 `dist/target`

**例外**：本约定**只约束新项目**第一次落地时按此布局；已有项目按工具链默认惯例（含 `out/` `release/` `target/` 等历史命名）保留原状，**不要 retro 改造**（改 outDir 牵动 dev / build / dist / 打包链路多处，易回退稳定性）。**如需迁移已有项目**，走 §复杂 plan 完整流程（RFC + spike 验证工具链 outDir 行为 + plan 文件跟踪逐项验证 dev / build / dist / 打包链路）。

### .gitignore 必备条目

`.gitignore` 必含以下条目（按用途分组）：

```gitignore
# Claude Code 运行时产物
.claude/worktrees/        # plan 隔离 worktree（per-session state）
.claude/scheduled_tasks*  # cron 任务持久化与锁文件
.claude/plans/            # plan local 工作目录（in_progress 短临时草稿；
                          # completed 后归档到顶级 ref/plans/<plan-id>.md / 同名子目录入 git）

# build 产物（详 §src/build 标准目录结构 节；build/ 与 dist/ 都加，项目实际用其一，另一个无害保留为防御性条目）
build/
dist/

# 全局 *.log 过滤 + spike artifacts exception
*.log
!ref/plans/**/spike-reports/**/*.log
# ↑ spike artifacts exception：plan-driven spike reports 内的 .log 是 spike 实测命令输出
# trace（case-A.log / case-B.log 等），与 spike1-<topic>.md 结论同等重要（实测 evidence
# 历史可追溯），必须入 git 归档（详 §Step 0.5 spike 节 + §Step 4 完成节 spike-reports 归档）。
```

`ref/` 顶级目录及其子目录（含 `ref/plans/` 与 `ref/plans/<plan-id>/spike-reports/`）**不在 .gitignore**（completed plan + changelog + reviews + conventions + spike-reports/ 子目录都要入 git 归档）。仅 `.claude/plans/` 临时草稿位置忽略。

### README.md = 功能总览（用户视角）

改完功能 3 问：

1. 改了**用户可见行为**？（UI / CLI / API / 设置项 / 快捷键 / 状态显示）→ 改对应章节
2. 改了**文件结构 / 新建模块**？→ 改「项目结构」节
3. 改了**启动方式 / 端口 / 依赖 / 验证步骤**？→ 改「开发与运行」节

纯 bug 修复 / 内部重构（不改用户感知）→ 不动 README，写 changelog 或 review。

### ref/changelogs/ + ref/reviews/ 双轨

| 类型 | 写到 | 例子 |
|---|---|---|
| **功能变更**（新功能 / 行为修改 / API / 依赖升级） | `ref/changelogs/` | 新建 XXX、升级 SDK、加 CLI 命令 |
| **Debug / 性能 / 安全 review**（不引新功能，修问题或加固） | `ref/reviews/` | code review 修复、TOCTOU、内存泄漏 |

**通用规则**：
- 文件名 `CHANGELOG_X.md` / `REVIEW_X.md`，X 递增整数。新建前 `ls` 找最大 X
- 小改动追加最新一条；大改动新建一条
- 同步更新对应 `INDEX.md`（一行表概要 ≤80 字）
- changelog 单文件：标题 + 概要 + 变更内容（按模块 bullet）；**不要写「踩坑细节」**——那些去 reviews
- reviews 单文件结构见 `{{AGENT_DECK_RESOURCES}}/templates/review.template.md`

**改功能前**：先 `ls ref/conventions/ ref/changelogs/ ref/reviews/` + 浏览相关条目（含 `ref/conventions/INDEX.md` 已升级约定 + 相关 changelog/review），了解历史决策、避免推翻已有约定 / 重复踩坑。

### 已审文件过期（File-level Review Expiry）

`ref/reviews/` 不是「审过即终身豁免」。下一轮 review 强制最小范围 = 未审 ∪ 已审过期 ∪ scope_unknown。

**过期判定**（任一命中即过期，自上次 REVIEW 覆盖基线起）：
- 净 churn ≥ min(200 行, 当前文件 LOC 的 30%)
- distinct commit 数 ≥ 3
- 距覆盖 ≥ 90 天且期间该文件至少有 1 次代码变更
- frontmatter `expired: true`（人工兜底）

`<BASE>` = REVIEW.md 文件首次加入 git 的 commit（自动取，不写 frontmatter）。**rename / move / split 出来的新路径不继承旧路径已审状态**，按未审处理。

**默认硬合并**——这正是机制存在的意义。仅当合并后 > 20 文件 / > 6000 行时问「拆批 / 先审哪批」（不是问跳过）。用户主动跳过某过期文件需写入本份 REVIEW frontmatter 的 `skipped_expired` 备注。

阈值（200 / 3 / 90）调整属约定升级；过期检查本身不走对抗。

**自检脚本**（agent 在「下一轮 review」第一步必跑）：`bash {{AGENT_DECK_RESOURCES}}/SOPs/file-level-review-expiry.sh`

### 单文件大小护栏（≤ 500 行）

任何代码源文件 LOC > 500 行触发拆分尝试（commit 前必做一次）。3 档风险升序选择 + 真不能拆的登记机制详 `{{AGENT_DECK_RESOURCES}}/SOPs/file-size-guardrail.md`。阈值 500 调整属约定升级。

**facade 自身 LOC 必计**：facade pattern 拆分后 facade 自身**也**必须 ≤ 500 LOC（子模块 ≤ 500 不够）。≥ 400 LOC 进入临界监控，≥ 480 LOC 下次任意改动触发再拆 — 任何新加 import / re-export / helper 都需要先把 facade 内已有 helper 抽到 sub-module 腾 LOC。

### 大文件拆分实战经验（facade pattern）

**facade pattern**：原文件改 facade 仅 re-export 子模块 API（原 import path 全保留 byte-identical）；子模块按 entity / 功能 / 行为域拆；共性 helper 抽到 `_shared/` 子目录。

**4 种 facade pattern ROI 排序**（按 LOC 增量，低增量 = 高 ROI）：

| ROI | Pattern | 平均增量 | 适用场景 |
|---|---|---|---|
| 高 | D pure type re-export | +52 LOC | 纯 type / interface declaration 文件 |
| 中高 | A factory + singleton | +176 LOC | DB repo / 跨 entity store 类 |
| 中 | C free fn entry + 子模块 named function | +305 LOC | god-function 拆出来的多 phase 流程 |
| 中低 | B class shell + thin method delegate | +339 LOC | adapter / manager / window 类 |

**LOC trade-off**：拆分后总 LOC 升 +20-30% 是 readability tax，**0 runtime overhead**。增量来源 jsdoc 重复 + ctx interface signature 重复。**接受现实**：facade ≤ 500 LOC 让单文件 review 上下文成本可控，trade-off 合理。

**核心 invariant**：facade barrel re-export **byte-identical**，生产代码 caller import path **0 改动**，测试 import path **0 改动**（test 文件直接 import 子模块属 unit test 覆盖合理，与 §不变量「测试不动」一致）。

**mini-spike + user 1-min confirm 3 题**：每文件实拆前 5-15 min 输出 spike 与 user 确认 3 题：① 子模块名 ② 边界划法 ③ 是 entity / 功能 / 行为域。**不 confirm 实施细节**（function 命名 / import 顺序 lead 自决）。**失败兜底**：spike 时间 ≥ 30 min 或子模块边界含跨文件互依赖（典型 `index.ts` + `recoverer.ts` 对偶拆）→ 改走 full spike 落 `<plan-artifact-dir>/spike-reports/spikeN-<topic>.md`，不走 mini-spike。

**不预先抽 _shared/ 大坨**：跨 facade 重复 helper（典型 `getById` / `rowToRecord` 2-3 处实现）实际重复成本 < 抽离收益（类型签名不同，抽 generic factory 让 TypeScript inference 变复杂）。**例外**：真实跨子模块共享算法 / 常量必抽（如 `_impl-shared/isError<T>` generic 化 5 种 result 共用）。

### 多轮 Deep-Review 收口经验

> 与 §决策对抗 §反驳轮 + 三态裁决 正交：那节定义 per-finding ✅/❌/❓ 三态裁决；本节定义**整 review session 何时 conclude** 的判定 + 反驳轮自纠机制 + fix 后同步纪律。适用任何走多轮异构对抗的 review session（典型应用环境 deep-review SKILL）。

**双方共识收口判定**：收口条件 = **双方 reviewer 在最后一轮明示「同意 conclude」** + 0 HIGH/MED finding（LOW/INFO 留 follow-up plan）。**单方收口不算**（漏审风险，典型 R1 一方漏审某维度，另一方在 R2 抓出 HIGH-1 仍需 fix 才能合）。

**反驳轮自纠 mental model**：reviewer 在 R_{N+1} 主动检查自己上轮漏审维度。**触发**：对方 reviewer 在自己未覆盖维度抓 finding 时，R_{N+1} 必须显式 acknowledge 漏审 + 升级 mental model（典型升级：「facade refactor sanity 必须穷举 baseline named export 列表 1:1 diff，不能只看形态」），否则下轮同款漏审重发。

**fix 后表格 / 描述文字必同步**：数据 fix 后，所有引用了原数据的表格 + 描述都要同步更新。**Why**：反驳轮验证 fix 时会 grep 原数据找漂移，导致原本只是 R_N INFO 的下次评审变 R_{N+1} MED。**How to apply**：R_N fix 数据 X 后，`grep '<原数据>' ref/reviews ref/plans ref/conventions` 找命中处一并更新。典型样例：REVIEW.md §临界文件监控 fix LOC 411→406 后必须把 §B INFO 引用同步。

### 反复反馈 / 反复踩坑 → 升级约定

候选放 `ref/conventions/tally.md`（统一参考资产根 `ref/` 下与 `ref/changelogs/` `ref/reviews/` `ref/plans/` 同级，git 管理；**不**绑 `.claude/` 工具目录）。count ≥ 3 升级**不再**写到项目 `CLAUDE.md` —— 改为新建 `ref/conventions/<X>-<topic>.md`（X 递增整数，单约定单文件）+ 同步 `ref/conventions/INDEX.md` 加行 + 从 tally 删该条。让项目 CLAUDE.md **保持静态**（只放设计原则 + 流程性约定），动态累积沉淀到 ref/conventions/ 解耦。

两类候选同一文件分 section：

| 类型 | 触发条件 |
|---|---|
| **用户反馈**（`# 用户反馈候选`） | 用户给「纠正性 / 偏好性」反馈：「不要…」「应该…」「我已经说过…」「以后…」「记住…」「每次…」 |
| **Agent 踩坑**（`# Agent 踩坑候选`） | Coding Agent 在 review / 修 bug 时**自己**发现踩了同类坑（典型：try/finally 漏 cleanup / TOCTOU / N+1 查询 / async listener 不被 await） |

**流程**：找语义相近条目 → `count` +1 + 更新 `last_at`；没找到 → 新增（`count: 1`）。**count = 3** → 走「决策对抗」三态裁决，结论告诉用户后**新建** `ref/conventions/<X>-<topic>.md`（X 递增）+ 同步 `ref/conventions/INDEX.md` 加行 + 从 tally 删该条。count < 3 → 静默更新。

**边界**：不计一次性请求 / trivial 反馈；用户反馈必须是工程偏好 / 设计取舍 / 工作流偏好；Agent 踩坑必须是模式化问题。30 天未更新且 count < 3 → 下次扫描可清理。


## Agent Deck Universal Team Backend

跨 adapter 协作通过 Agent Deck MCP 15 tool（10 现有：`mcp__agent-deck__spawn_session` / `send_message` / `list_sessions` / `get_session` / `shutdown_session` / `archive_plan` / `hand_off_session` / `enter_worktree` / `exit_worktree` / `shutdown_baton_teammates`；+ 5 task：`task_create` / `task_list` / `task_get` / `task_update` / `task_delete`）编排 + 管理结构化任务。teammate 调工具时走自己 SDK 会话的 canUseTool，**lead 不插手 teammate 权限审批**（失败弹给真人走 teammate 自己 session 的 PendingTab）。

速查：`spawn_session` 起 SDK session；`send_message` 统一发消息 / reply；`list_sessions` / `get_session` 只读查会话；`shutdown_session` close lifecycle 不删数据；`archive_plan` 原子归档 plan；`hand_off_session` baton 接力；`enter_worktree` / `exit_worktree` 管 worktree；`shutdown_baton_teammates` 补跑 teammate cleanup。

### 三个核心约定（lead 角度）

1. **spawn 首轮锚点**：`spawn_session` 返回 `spawnPromptMessageId: string | null`（仅当传 `team_name` 且 caller 在 sessions 表时非空），是首轮 prompt 在 messages 表的 placeholder id。teammate first turn 完成后调 `send_message({reply_to_message_id: spawnPromptMessageId, ...})` 回复，reply 自动注入 lead conversation。lead 不需主动 poll —— 看到 user-role wire-prefixed message 即知 reply 到了
2. **后续轮次锚点**：`send_message` 返回 `{ sessionId, teamId, messageId, replyToMessageId, sentAt, queued: true }`。caller 用 `messageId` 在 DB 查 reply chain（如有审计需求）；正常对话不需要 — receiver 收到 message 后会**自动通过 wire prefix `[msg <id>][sid <senderSid>]`** 提到 caller 的 messageId 当 `reply_to_message_id` 调 send_message reply 回来。`replyToMessageId` 仅当 caller 调 send 时显式传入 `reply_to_message_id` 才有值，开新话题（首条 message / 不挂 reply chain）时为 `null`
3. **shutdown 不删数据**：`shutdown_session` 只标 lifecycle='closed' + abort SDK live query；events / file_changes / summaries / messages 子表保留，lead 在裁决报告里仍可引用。`team_member` 通过 `left_at` 软退出（行不删，archive 时归档面板仍可看 member 历史）；`spawn_link` 父子关系全保留（list_sessions(spawned_by_filter) 跨 lifecycle 全见，跨会话救火依赖此）

> **dormant ≠ 丢 mental model**：lifecycle scheduler 转 dormant 只 abort SDK live query + 清 in-process Map，**不删 jsonl**；下一次 `send_message` 自动 SDK resume 复原对话历史。**唯一例外**：jsonl 缺失（用户手动删 `~/.claude/projects/` / 应用重装 / 跨设备同步未带）走 hard fail fallback → teammate 触发 `⚠ FRESH SESSION` warn 必须重 spawn。
>
> 实操：复用直接 `send_message`；彻底不再用才 `shutdown_session`。机制详 `src/main/adapters/claude-code/sdk-bridge/recoverer.ts:103-220`。

### send_message 一统消息发送

最小调用（普通 / reply 都用同一 tool，reply 加 `reply_to_message_id` 链接 DB 对话链）：

```ts
mcp__agent-deck__send_message({ session_id, team_id, text, reply_to_message_id?, caller_session_id? })
// return: { sessionId, teamId, messageId, replyToMessageId, sentAt, queued: true }
```

字段速查：

| 字段 | 必传 | 含义 |
|---|---|---|
| `session_id` | ✓ | target receiver session id |
| `team_id` | caller/target 共享多 team 时必传 | 共享单 team 自动 resolve |
| `text` | ✓ | message body |
| `reply_to_message_id` | optional | 从收到的 wire prefix `[msg <id>]` 提取链入 reply chain |
| `caller_session_id` | optional | in-process 自动闭包；HTTP transport 必传 |

**收消息**：caller 调 send_message → universal-message-watcher 自动把 message dispatch 给 receiver adapter → adapter 给消息加 wire prefix `[from <name> @ <adapter>][msg <id>][sid <senderSid>]` → 喂给 receiver SDK → receiver Claude 看到 user-role message 直接处理（lead 不需主动 poll，看到 wire-prefixed user message 即知 reply 到了）。

### 跨会话救火：list_sessions(spawned_by_filter)

lead context 重置 / 重启后捡 stranded reviewer：`list_sessions(spawned_by_filter:'<old_lead_sid>', status_filter:'active')` 拉自己以前 spawn 的 active reviewer；按 sessionId 调 `send_message` 发新 prompt（receiver reply 通过 wire prefix `[msg <id>][sid <senderSid>]` 自动挂 reply chain 注入 lead conversation，与 §三个核心约定 §2 后续轮次锚点同款）；收尾走 `shutdown_session`。

> ⚠️ **shared-team 前置约束**：`send_message` 必须在 caller session 与 target reviewer 至少共享一个 active team 时才能 dispatch（否则报 `no-shared-team` 立即 reject，不入 messages 表）。
> - **同 caller session（context 重置 / compaction）**：sessionId 不变 → team_member 关系不变 → 直接 `list_sessions(spawned_by_filter)` 捡回来 + `send_message` 即可
> - **真换了 caller session**（应用重启 / 用户手动新开 / hand_off_session 默认不携 team 起新 session）：新 caller 不在原 team 内 → `send_message` 必报 `no-shared-team` → 必须先满足以下任一条件：
>   1. 调 `spawn_session({adapter:'claude-code', team_name:<old-team-name>, ...})` 重起一对 reviewer（旧的走 `shutdown_session` 收尾，避免 ghost）
>   2. 通过 UI 手动把新 caller 加入旧 team（应用 → Team 面板 → Add Member）
>   3. `hand_off_session` 起新 session 时显式传 `team_name:<old-team-name>` 让新 session 直接落入 team（仅当 plan 接力同 team 场景；baton 单向交接默认场景不加 team）
> - 需要保留 reviewer 跨轮 mental model → 走选项 2/3；接受重跑 reviewer → 走选项 1

### Wire format / regex / DB invariant

teammate 端协议约束（`[from <name> @ <adapter>][msg <id>][sid <senderSid>]\n` 三段 wire prefix / regex 提 messageId + senderSessionId / 用 send_message 回 / DB messages.body 不含 wire prefix 的 invariant）已强约束在 reviewer-{claude,codex}.md「核心纪律」节，**lead 不需关心**这些细节。Wire format 字段 schema 与字段语义 SSOT 在 `src/main/agent-deck-mcp/tools/schemas.ts`（应用 build 时把 description 注入 SDK system prompt 的 tool definitions）。

**wire format id invariant**：`messageId` / `senderSessionId` 都由 `crypto.randomUUID()` 生成（v4 UUID lowercase hex + hyphen，charset `[0-9a-f-]{36}`），regex `/\[msg ([0-9a-f-]+)\]\[sid ([0-9a-f-]+)\]/` 与该 charset 严格对齐。

### NO MSG ANCHOR 退化路径（reviewer 端 fallback）

reviewer agent 收到的 user message 顶部如果没找到 `[msg <id>][sid <senderSid>]` 双锚点 wire prefix（典型：lead context 重置后用裸文本 ping / 第三方 dispatch 路径丢前缀），按下面 fallback 处理：

1. reply 顶部硬性输出 `⚠ NO MSG ANCHOR — prompt 顶部没找到 [msg <id>][sid <senderSessionId>] wire prefix，本 reply 没法挂 reply_to_message_id 进 lead 对话链；请 lead 通过 send_message 重新发本轮 prompt 提供 anchor`
2. **退化路径**：仍要交付 finding / codex 输出（不 abort）。`session_id` 反查：调 `mcp__agent-deck__list_sessions({status_filter: 'active'})`（不 filter adapter：cross-adapter native pair 中 lead 可能是 claude-code 或 codex-cli 任一）→ 按以下顺序定位 lead：① displayName 含 "Lead-" 前缀 / ② displayName 非 reviewer-* 标识 / ③ team 内排除自己 sessionId 后唯一 active；3 条都失败走第 4 步终极兜底。`team_id` 反查：调 `list_sessions` 看自己 session 的 `teams[]` 字段（与 lead 共享的 team_id）
3. **副作用警告**：reply 不挂 `reply_to_message_id` 失去对话链锚点，DB / SessionDetail 看不出 reply 链关系；NO MSG ANCHOR 是**降级体验**，触发后 lead 应优先 shutdown + 重 spawn / 重发带 anchor 的 prompt 而非长期靠这个路径
4. **list_sessions 反查 lead 也失败**（多对 lead+teammate 同时跑歧义 / API 错）：直接把 finding / codex 输出落本 SDK session 的 assistant output（不调任何 mcp tool），lead 切到本 reviewer 的 SessionDetail UI 仍可看到

### enter_worktree / exit_worktree（MCP 替代方案）

claude 端首选 CLI builtin `EnterWorktree` / `ExitWorktree` 工具（直接调用建/退 git worktree + 切 cwd + 写 sessionRepo.cwd 子表）。本应用 MCP 等价 tool 用于以下场景（builtin 不适用时）:

- `mcp__agent-deck__enter_worktree({ plan_id, worktree_path?, base_commit?, base_branch?, plan_file_path? })`:创建 worktree 目录 + 写 `cwd_release_marker`；它不是 Claude CLI builtin `EnterWorktree(path:)`，不会替调用方切当前 SDK cwd
- `mcp__agent-deck__exit_worktree({ action: "keep" | "remove", worktree_path?, discard_changes?: false })`:退出 worktree

**何时走 MCP 替代**:
- 想避开 EnterWorktree CLI v2.1.112 stale base bug（详**本文件** §Step 2 §EnterWorktree CLI stale base bug callout）— MCP impl 显式用 HEAD 作 base 不撞 origin/<default> 落后陷阱
- 跨 adapter 测试 / 调试 — MCP 路径主路径(codex 必走 MCP),claude 端走同款 MCP 可对齐行为
- 需要明确写 `sessionRepo.cwd_release_marker` 字段（archive_plan 4 态预检场景必需）— MCP enter_worktree 自动写 marker，builtin EnterWorktree 不写。**默认 workflow** 仍 builtin EnterWorktree + 手工 `ExitWorktree(action:"keep")` → archive_plan 走 sessionRepo.cwd 兜底,无需切 MCP

详 codex 端 protocol layer `resources/codex-config/CODEX_AGENTS.md §enter_worktree / exit_worktree` 节(codex 必走 MCP,无 fallback)。

### plan hand-off 自动化：archive_plan

`archive_plan` 在 plan 完成后**原子执行** **本文件** §Step 4「完成」5 步：ff merge worktree branch → `base_branch` / 更新 frontmatter (`status=completed` + `final_commit` + `completed_at`) / mv plan → `<main-repo>/ref/plans/<plan_id>.md` / **如 plan 有 spike-reports/ → mv `<plan-artifact-dir>/spike-reports/` → `<main-repo>/ref/plans/<plan_id>/spike-reports/`** / 同步 `<main-repo>/ref/plans/INDEX.md` / `git add` + commit / `git worktree remove` + `git branch -D`。caller 调用前必须先 `ExitWorktree(action: "keep")`。

**调用**：`mcp__agent-deck__archive_plan({ plan_id, worktree_path, base_branch?: <plan frontmatter.base_branch ?? "main">, plan_file_path?, changelog_id? })`(`base_branch` 默认值:schema 优先读 plan frontmatter.base_branch,缺失才 fallback "main")
**返回**：`{ archivedPath, commitHash, branchDeleted, worktreeRemoved, plansIndexAction: 'created'|'appended'|'updated'|'unchanged', finalStatus, warnings: string[], spikeReportsArchived: { srcPath, dstPath } | null, archived: 'ok'|'failed'|'skipped', teammatesShutdown: { closed, failed, skipped } }`

**app-only 差异**：

- **预检短路**：plan status ≠ in_progress / worktree dirty / cwd 在 worktree 内 / detached HEAD 任一命中 → 立即返回 error，不做部分回滚（git 操作不可逆）
- **lead 必须先 ExitWorktree**：mcp 不能调 ExitWorktree CLI 内部 tool；cwd 在 worktree 内时 tool 直接 reject
- **自动归档 caller session**：plan 收口后默认归档 caller（baton 同款语义），返回 `archived` 三态字段；归档失败仅 warn 不阻塞 ok return
- **abandoned plan 不走本 tool**：tool 强制 `status=completed` 且入项目 git 归档；abandoned 走 **本文件** §Step 4 §中止 手工流程
- **changelog 引用归档** agent 自己写（tool 不做）
- **spike-reports/ 自动归档**：detect `<plan-artifact-dir>/spike-reports/` 存在（`<plan-artifact-dir>` = `<plan-file-dir>/<plan-id>/`，即 plan 文件父目录下的同名 artifacts 目录）→ mv 到 `<main-repo>/ref/plans/<plan_id>/spike-reports/`（plan .md 同名子目录与 plan .md 平级，约定 plan .md 是主体 + 同名目录是 artifacts），spike-reports/ 子目录递归入 git 归档 commit。不存在 → skip 不报错（trivial plan 无 spike 是合法场景）。mv 失败（EXDEV 跨 fs / perm）→ warnings 落 hint「spike-reports archive failed: ... Manually run \`mkdir -p && mv && git add+commit --amend\`」+ 不阻塞 ok return。`spikeReportsArchived` 字段告诉 caller 实际归档结果（null = skip / `{srcPath, dstPath}` = 成功）
- **UX 完善**：
  - fallback 链 `<main-repo>/.claude/plans/` > `<main-repo>/ref/plans/` > `~/.claude/plans/`(加中间档兜底本项目实际惯例)
  - `plan_file_path` 文件名 stem 必须 == `plan_id`(impl 层 reject 防 silent unlink)
  - INDEX 4 列 canonical `| 文件 | 状态 | 关联 changelog | 概要 |` + smart update existing 行(替换 status / changelog / description)
  - `changelog_id` optional string + csv(单值 `"122"` / 多值 `"121,122"`),拼成 markdown link 写入 INDEX 第 3 列;不传时 smart update 保留老 4 列 changelog 列 / 旧 2 列或新 append 用 `—` placeholder
  - `plansIndexAction` 四态 enum 替代旧 boolean,让 caller 区分 INDEX 行真正发生的事情
  - `warnings` non-fatal warning 数组(如 `.claude/plans/<id>.md` 与 `ref/plans/<id>.md` 同 id 双存覆盖警告 — 走 warn 而非 reject)
  - 7 phase post-ff-merge 失败专用 phaseHint 给具体 manual recovery 决策树
- **mainRepo dirty precheck 精确化**：仅 reject 三具体路径 `{archivedPath, indexPath, planFilePath}` 命中 dirty / staged / untracked / R rename / C copy（含 old/new path 任一命中）— 其他无关 dirty 文件降 warning + commit message 注脚（commit pathspec 隔离不吞）。precheck 失败时 hint 软引导 caller fix 撞 critical paths 后重 invoke archive_plan，**或** 走 §escape hatch: shutdown_baton_teammates 补跑 baton-cleanup phase 1（如 caller 必须手工归档场景）— 不硬技术阻断手工归档（**本文件** §Step 4 5 步手工归档仍是合法 fallback）

### escape hatch: shutdown_baton_teammates

`shutdown_baton_teammates` 让 caller 手工归档 plan 后**补跑** baton-cleanup phase 1（同 team 其他 active+dormant teammate 一并 close + `team_member.left_at` 软退出）。仅供 archive_plan 撞 precheck fail / 历史 dormant 残留清理使用。

**调用**：`mcp__agent-deck__shutdown_baton_teammates({ caller_session_id?, plan_id? })`
**返回**：`{ closed: string[], failed: Array<{sessionId,reason}>, skipped: null, planId: string | null }`

**典型场景**：

archive_plan tool 撞 mainRepo dirty / cwd resilience guard 等 precheck fail → caller 走 **本文件** §Step 4 5 步手工归档绕过 archive_plan tool（commit + mv plan + git worktree remove + branch -D）→ runBatonCleanup phase 1 没被调到 → 同 team teammate（reviewer-claude / reviewer-codex 等）自然衰减成 dormant 但**没** closed，占内存 + SDK live query。本 tool 让 caller 显式补跑 phase 1。

**与 archive_plan 的边界**：

- archive_plan 是 plan 收口 tool（git ff-merge / mv plan / commit / git worktree remove）+ default baton-cleanup phase 1+2(archive_plan 不再支持 phase 1 跳过)
- `shutdown_baton_teammates` 是「补跑 phase 1」的独立 tool，**不**做任何 git/fs 归档操作；**不**调 phase 2 archive caller（caller 决定何时 archive；典型场景 caller 已手工归档完毕）

**错误契约**：

- caller 不在任何 team 是 lead（caller 是 teammate / 无 active membership / 所有 caller-lead 团队都已 archive）→ **error + hint**（**非** silent return success — escape hatch 是 caller 显式请求 cleanup，no-op 误导 caller 以为成功了）。hint 指向 IPC `TeamShutdownAllTeammates` handler 或 UI Team 面板「Shutdown all teammates」按钮（不要求 caller 是 lead）
- helper 自身抛错（agentDeckTeamRepo SQLite locked / sessionManager.close abort 等）→ error + console.warn，**不**像 archive_plan / hand_off_session 兜底 warn 不阻塞（本 tool 是 escape hatch，helper 失败就是补跑没成功，需让 caller 显式知道）

**deny external caller**：sessionManager.close 是写操作 + caller=lead 反查需要真实 caller_session_id，绝不允许 stdio external client 调用（避免被恶意 mcp client 利用清理任意 team session）。

### plan hand-off 自动化：hand_off_session

`hand_off_session` 起新 SDK session 接力 + 自动归档 caller。**双模式**：plan-driven 传 `plan_id`（读 plan frontmatter，要求 `status: in_progress` + 有 `worktree_path`，cold start prompt = `按 <plan-abs-path> 接力`，可附 `phase_label`）；generic 不传 `plan_id`（不读 plan，cold start prompt = `args.prompt` 或默认「从上一个会话接力继续工作」）。

**调用**：`mcp__agent-deck__hand_off_session({ plan_id?, phase_label?, prompt?, cwd?, adapter?: "claude-code", team_name?, permission_mode?, plan_file_path?, archive_caller?: true, adopt_teammates?: false, team_task_policy?: 'clear-team' | 'preserve-team' | 'skip' })`
**返回**：`{ mode: 'plan'|'generic', planId, planFilePath, worktreePath, initialPrompt, sessionId, cwd, teamId, teamName, spawnPromptMessageId, archived, teammatesShutdown, taskReassignment, ... }`

**app-only 差异**：

- **cwd resilience**：plan-driven 默认 `cwd = mainRepo`（fallback 链 `args.cwd > resolved.mainRepo > resolved.worktreePath`），让 sessionRepo.cwd 在 worktree 被 archive_plan 删后仍 valid；新 session 自己按 **本文件** §Step 3 cold-start `EnterWorktree(path: worktreePath)` 进 worktree。generic 默认 `cwd = caller cwd`
- **hand-off 完全独立于 spawn-guards / 永不写 spawn-link**:`hand_off_session` 内部调 spawn 时传 `handOffMode: true`,让 spawn handler **完全跳过** spawn-guards 三道防御(depth check + fan-out + spawn-rate)+ **永不写** `spawn-link`(`sessions.spawned_by`/`spawn_depth` 保持 null/0)。理由:hand-off 是「平级接力 + 接管 lead 身份」语义不是 spawn 派遣关系(`hand-off-session.ts:21-39` jsdoc 明文「不是派出小弟干活」),数据层不应记录 spawn-link 让 SessionList Phase C 树形分组错挂 teammate badge。**统一行为**:无论 `archive_caller` 值(default true / 显式 false)/ `adopt_teammates` 值(default false / true),hand-off 路径行为完全一致 — 新 session 在 SessionList 呈现为独立 root,不显示与 caller 任何 spawn 关系。**`archive_caller: false × N` 滥用风险**:caller 持 false × N 次起 N 个 session 是合法 power-user 路径(典型 lead 起多 hand-off 子任务自己仍想看 reviewer reply / debug 工具用例),应用层不阻止 — power-user 自负责任
- **archive 默认 true,可 opt-out**：caller 无论 untracked / dirty / 已加入 team 都归档（default）；typical baton 语义「任意时刻单 in-flight session」自然成立。**例外 opt-out**：caller 显式传 `archive_caller: false` 跳过归档（罕见场景：lead 起多个 hand-off 子任务并行做事自己仍想看 reviewer reply / 出 summary；debug 工具想起新 session 实测某 plan 但 caller 仍要观察）。`archive_caller: false` 时 ok return.archived === "skipped"
- **default 不加 team**：baton 单向交接不强加 lead/teammate 关系;显式 `team_name` 才启用通信
- **adopt_teammates 选 in 接管 caller 同 team 当 lead**:default false 走纯 baton(原 teammate 与新 session 失去 shared active team,`send_message` 撞 no-shared-team)。**`adopt_teammates: true`** 让新 session 接管 caller 同 team 当 lead,原 teammate 与新 session 共享 active team 可继续 send_message 沟通。**N5 ≥1 lead 硬约束**:caller 在所有 team 都不是 lead → handler spawn 之前 fail-fast 返 error,不 spawn / 不 archive caller。**N2.c 互斥**:adopt 路径自动过继 caller 自己 team,与显式额外 team 语义冲突。**archived team / archived teammate filter**:caller 在 archived team 的 ghost membership(role 不论 lead / teammate)push failed reason='team-archived';archived teammate(`sessions.archived_at !== null`)进 failed reason='session-archived' + cold-start prompt 装配时已过滤(避免新 session 调 send_message 撞 findSharedActiveTeams 强制 archived 过滤)。Detail 见 ok return.adopted 字段:`{ preserved, failed, teamsTotal, teamsAdopted, firstTeamId } | null`(adopt_teammates: true 时 non-null;`failed.reason` 取值 `'caller-not-lead-in-team' / 'team-archived' / 'swap-lead-failed: ...' / 'swap-lead-error: ...' / 'session-missing' / 'lifecycle-closed' / 'session-archived'`)。
- **预检短路**：plan-driven 模式 plan 文件不存在 / status ≠ in_progress / frontmatter 缺 `worktree_path` / spawn 失败 → 立即返回 error
- **新 session cold-start 5 步**（plan-driven 模式；本文件含 §复杂 plan workflow 让 cold start prompt「按 <plan-abs-path> 接力」可识别,self-contained）：① `Bash: cat <plan-abs-path>` 全文 → ② frontmatter 取 `worktree_path` → ③ `EnterWorktree(path: <worktree_path>)` 进 worktree（用 `path` 不用 `name` 避开 v2.1.112 stale base bug）→ ④ `git log --oneline -3` 自检 HEAD = frontmatter `base_commit` 或之后 → ⑤ 按 plan §下一会话第一步 直接动手。详细约定见**本文件** §复杂 plan workflow §Step 3 接力姿势节
- **task 自动过继 + team_task_policy 三态**: spawn 完成 + 新 sid 落 DB + adopt 完成后、archive caller 之前, 按 `team_task_policy` 三态处理 caller owned task。**`reassignOwner` 不刷 `updated_at`** 让 list 默认排序保持稳定。
  - **`'clear-team'`** (default): `UPDATE tasks SET owner_session_id=newSid, team_id=NULL WHERE owner_session_id=callerSid` — 过继 ownership 同时清 team_id 变 personal。适用面最广,newSid 拿到的 task 都是 personal,caller==owner 写权限路径直接生效;newSid 不必加任何 team 就能继续 own / read / write 全部过继的 task。typical baton 场景首选,task 不丢
  - **`'preserve-team'`** (caller 自负责任): `UPDATE tasks SET owner_session_id=newSid WHERE owner_session_id=callerSid`(不动 team_id)。caller 想让 newSid 接管 team-bound task 同时继承 team 上下文(典型与 `adopt_teammates=true` 配合让 newSid swapLead 接管 team 当 lead,team-bound task 仍指向同一 team newSid 可写)。**Caller 自负责任**:如 newSid 没成为对应 team 的 active member,newSid 撞写权限 reject — handler 不 hard reject 但 ok return `taskReassignment.policyWarning='preserve-team-unadopted-teams'` + `unadoptedTeamIds: string[]` 暴露差集 team_id
  - **`'skip'`** (清理场景): 单 transaction 4 步原子化:SELECT caller owned team task ids → DELETE → cleanup blocks/blocked_by 引用 → reassign 剩余 personal task to newSid。caller 不希望 team-bound task 跨 baton 保留(典型 plan 收口后 abandon 中间 task);不依赖 caller archive 后 CASCADE — task 在 handoff 时被立即 DELETE 语义干净零中间窗口
  - **`archive_caller=false` 优先级**:caller 显式 `archive_caller=false` 时 reassign 整段被 skip(caller 仍 active 继续 own 自己 task),`team_task_policy` 不执行 — ok return `taskReassignment={status:'skipped', reason:'archive-caller-false', policy: <resolvedPolicy>}`(policy 字段仍透传 advisory)
  - **失败兜底**: applyHandOffSkipPolicy DB throw / reassignOwner SQL 异常都仅 warn 不阻塞 ok return — task 过继是 nice-to-have,baton 本质是 session 接力;caller 通过 ok return `taskReassignment` 字段(`'ok'+count+policy[+policyWarning+unadoptedTeamIds]` / `'failed'+error+policy` / `'skipped'+reason+policy`)看到结果。配合 ON DELETE CASCADE 让 caller archive 后被物理删时 task 已留新 session 名下不被 CASCADE 删
- **ShutdownAllTeammates 不调 reassignTaskOwner**:与 hand_off caller→newSid 不对称。teammate 关闭后 task 仍在 teammate 名下,被 `LifecycleScheduler.historyRetentionDays` TTL GC 触发 `sessionRepo.delete` 时 CASCADE 删。teammate context 已死 task 本质无主,删干净是合理设计(配合 GC 主语义)。
- **典型主动触发（generic mode）**：当前 cwd 不适合手头任务（cwd 已失效 / 不属目标 repo / 用户明示换目录 / 跨 repo 任务）→ 不要在当前 session 强行 `cd` / 跨目录绝对路径（**Bash / shell tool 跨 turn 起新子 shell,cwd 切换不持久** — claude Bash 与 codex shell 同款行为,每次 tool call 走 child_process,设了 `cd` 下次 turn 失效）,用 generic mode 显式传新 `cwd` + 自包含 `prompt` 接力到正确目录
- **prompt 装不下完整 context 时**（必要信息务必传递完整，避免 hand-off 丢失大量上下文）：caller 先把 context 落盘到 `/tmp/handoff-<id>.md`（临时文件不用清理），prompt 起手写「先 `Bash: cat <abs-path>` 再按文件内指令推进」让新 session cold-start 第一步读全
- **想保留 caller 不归档**：传 `archive_caller: false`（详上 archive 默认 true 节）；要起独立 spawn 而非接力身份交接 → 用 `spawn_session` 替代 `hand_off_session`（spawn 出新 session 但不切接力身份，适合并行子任务）

### recoverer cwd 启发式 fallback（兜底）

caller 取消归档继续给已收口 plan-driven session 发消息（撞 cwd 失效）/ 用户手动 `git worktree remove` 不走 archive_plan / 跨设备同步丢目录 → sdk-bridge.recoverer 启发式找仍存在的祖先目录当 cwd 兜底（worktree 路径取段之前部分 / 父目录 walk 不超过 home），找到 → emit info + 强制走 jsonl missing fallback 同款下游（CLI 历史失但应用层 events / file_changes / summaries 子表保留）；找不到 → emit error 清晰告诉用户。算法详 `src/main/adapters/claude-code/sdk-bridge/recoverer.ts:103-220`。
