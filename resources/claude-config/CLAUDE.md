<!-- 由 resources/claude-config/CLAUDE.md 打包注入 SDK system prompt 末尾;维护说明详 resources/claude-config/README.md。 -->

--- Agent Deck 应用环境约定（随应用打包注入到每个 SDK 会话）---

# 应用环境约定

## 优先级声明（必读）

本文件是 agent-deck 应用环境的 baseline 约定。**优先级链**:
- SDK preset claude_code 内置安全约束（IMPORTANT 节）始终**最高优先级**,本文件与 user CLAUDE.md 都不替代
- user CLAUDE.md（`~/.claude/CLAUDE.md`）通用约定**优先于**本文件;与本文件冲突时**以 user CLAUDE.md 为准**
- 本文件提供 agent-deck 应用专属补充能力（mcp tool / plugin SKILL / cold-start 协议等）,不替换 user 通用约定

> **注:** 优先级链 in scope 是 claude SDK system prompt 注入的 baseline 文件之间(`settingSources: ['user',...]` 自动加载 user CLAUDE.md 作 baseline)。per-turn user message / developer message 等 SDK API 内置 prompt 类型的优先级在 SDK preset 内规定,与本节正交。**codex 视角等价 `CODEX_AGENTS.md` 因 codex SDK 加载机制不同(`~/.codex/AGENTS.md` marker 注入,无 user 通用约定全局加载机制)措辞不同是 adapter 差异不是 SSOT drift,维护时不要强行对齐两端**。

**加载范围**:本文件总是随应用打包注入到 SDK system prompt 末尾。`settingSources: ['user','project','local']` 的交互式 SDK 会话同时加载 user CLAUDE.md;`settingSources: []` 的内部 oneshot（如间歇总结）不加载 user CLAUDE.md,**本文件 self-contained 包含所需工程实践 inline**(§核心流程架构变更必走 plantUML / §复杂 plan workflow / §新项目工程地基 / §提示词资产维护)。

## 应用环境特有能力（不依赖 user CLAUDE.md）

### 协议覆盖：teammate 协作走 mcp tool

本应用环境（agent-deck）teammate 协作走 mcp tool（详 §Agent Deck Universal Team Backend 节）。teammate 通过 `send_message` 发消息 → universal-message-watcher → adapter.receiveTeammateMessage → adapter.sendMessage → SDK emit user-role event 自动注入 receiver conversation flow（receiver Claude 看到 user message 直接 act on it，无需主动 poll）。

### task 进度跟踪走 `mcp__agent-deck__task_*`,不走原生 `TaskCreate / TaskUpdate / TaskList`

本应用环境跑 plan / 多 Agent 协作 / 多步骤工作时,**task 进度跟踪必须走** `mcp__agent-deck__task_create` / `task_update` / `task_list` / `task_get` / `task_delete`,**不走** Claude Code CLI 内置的 `TaskCreate` / `TaskUpdate` / `TaskList`。

**Why**:
- task 必有归属 session（创建时自动绑当前 caller，不存在「无归属 task」）— 归属 session row 被历史保留期 GC 或显式物理删除时，DB FK ON DELETE CASCADE 自动删 owner task（**注意**：`closed` / 归档标记 仅打 lifecycle 标记不删 row 不触发 CASCADE），无 backlog 累积
- task 可绑 team 也可不绑 — 绑了 = team 共享（同 team teammate 可见可写），没绑 = 私人（仅 owner 可见可写），类比群聊 vs 私聊。team 之间严格隔离避免 lead 跨 team 时 task 串流
- **权限**按 teamId 决定：team-bound → caller 必须是该 team active member 才能 read/write；personal → 仅 owner 可见可写（不开放同 team 共享，避免 lead 私人 task 被 teammate 偷看 / 偷改）
- **personal task 是 first-class**：用户不在任何 team 时仍能用 task（典型场景：lead 起 reviewer pair 不必加 team 也想用 task 跟踪）。不传 `teamId` = personal default
- `hand_off_session` baton 时按 `teamTaskPolicy` 三态处理 task（详 §handOff 节）
- 原生 `TaskCreate` 只 in-process 当前 SDK session 可见，跨会话 / 跨 teammate 全部丢失，与 universal team backend 协作意图相违背

**How to apply**:
- **新建 personal task** (default): `mcp__agent-deck__task_create({ subject, description?, status?, priority?, blocks?, blockedBy?, labels? })` → owner_session_id 自动闭包当前 caller, teamId=NULL
- **新建 team-bound task** (caller 必在该 active team): `mcp__agent-deck__task_create({ subject, teamId: <team-uuid>, ... })` — 不在该 team 是 active member 时 reject
- 状态切换: `mcp__agent-deck__task_update({ taskId, status })`, 枚举 `pending` / `active` / `completed` / `blocked` / `abandoned`(注意 `active` 替代原生 `in_progress`)。写权限按 teamId 判定;跨 team 写 reject
- 列表查询:
  - 默认 `mcp__agent-deck__task_list()` → caller 可见 scope(自己 personal ∪ 所有 active team 的 team task)
  - `task_list({ teamIdFilter: <team-uuid> })` → 该 team 绑定的 task(caller 必在该 team active member)
  - `task_list({ teamIdFilter: 'null-personal' })` → caller 自己的 personal task(字面量,与传 team-uuid 区分语义)
- 单个查询: `mcp__agent-deck__task_get({ taskId })` — 严格 team-scoped read + deny external caller
- 删除: `mcp__agent-deck__task_delete({ taskId, force?: false })`, force=true 级联删 downstream(每个 child 都过写权限,跨 team 子节点 skip)

**例外**: 应用 settings `enableAgentDeckMcp: false` 关闭时本组工具(以及其他 agent-deck mcp 工具)整体不挂 → 退化用 Claude Code CLI 内置原生 `TaskCreate / TaskUpdate / TaskList`。本应用打包 SDK 会话默认行为是 toggle ON 时挂上,挂上后**优先用 mcp__agent-deck__task_\***,不重复用原生 TaskCreate 制造两套 task list 进度漂移。

### reviewer-codex 失败 → SKILL 内合规兜底分支

`simple-review` / `deep-review` SKILL 内若 reviewer-codex teammate 失败（codex SDK 起不来 / OAuth 过期 / shell tool call cancel / sandbox 拒 / timeout / codex thread jsonl 缺失 fresh-session abort），lead `shutdown_session` 掉失败的 reviewer-codex → `spawn_session({adapter:'codex-cli', agentName:'reviewer-codex', ...})` 重 spawn 一个，与未动的 reviewer-claude teammate 仍构成异构对（详 SKILL.md §失败兜底 表第 1 行）。**严禁**自动降级到同源双 Claude（破坏异构对抗原则）。

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
- **codex 端走法**: codex SDK session 有独立 `flow-arch-plantuml` SKILL 入口(codex-config 端打包,与 claude 端两端独立 SSOT,详 README.md §设计 SSOT)。codex lead 需画 plantUML 时 invoke 该 SKILL —— 画图技术(图类型 / syntax / workflow)见 codex flow-arch SKILL,文件位置 / INDEX 规则见 `CODEX_AGENTS.md §核心流程 / 架构变更必走 plantUML 节`。**严禁** codex 端调 `plantuml -tpng / -tsvg` 渲染产 PNG/SVG(违反 flow-arch SKILL §不渲染 SSOT — user 想看渲染产物自跑 plantuml CLI)。

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

> 与 review 对抗正交：RFC = design 大方向对齐（与用户讨论）；review 对抗 = 结论评审（`agent-deck:simple-review` 单次 / `agent-deck:deep-review` 多轮）。RFC 后仍可叠加 review 对抗。

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

> 与 review 对抗正交：spike = 实测假设（单 runner 跑 SDK）；review 对抗 = 评审结论。两者可叠加。

### Step 1. Plan 文件 hand off（时间隔离）

新建 plan 文件，**用绝对路径写入**（不要写到 worktree working tree——worktree 是独立 branch，跨会话主 repo 看不到该 branch 的文件）。三个合法位置：

- `<main-repo-abs-path>/ref/plans/<plan-id>.md` —— **项目内 git 归档版（completed 落此）**。在统一参考资产根 `ref/` 下，与 `ref/changelogs/` `ref/reviews/` `ref/conventions/` 同级，跟项目一起入 git。同步建 `ref/plans/INDEX.md` 一行表索引
- `<main-repo-abs-path>/.claude/plans/<plan-id>.md` —— project-specific local 工作目录（`.gitignore` 必加 `.claude/plans/`）。适合 in_progress 短临时草稿；完成后挪到 `<main-repo>/ref/plans/`
- `~/.claude/plans/<plan-id>.md` —— 跨项目 plan 或 CLI `/plan` slash command 默认位置；不入任何项目 git

不论哪种位置，§Step 3 cold start prompt 必须写明绝对路径，让新会话能直接 `Bash: cat`（详 §Step 3 末尾 callout 关于跨会话第一次读「长期存在 + 其他会话动过的文件」必须走 cat 而非 Read 的原因）。

`<plan-id>` 命名 `<topic>-<YYYYMMDD>`（如 `mcp-server-rollout-20260511`），与 §Step 2 worktree branch / 目录名严格一致。**字符集限 `[A-Za-z0-9._-]`、单 segment ≤ 64 字符**（EnterWorktree 工具校验）。

**plan 内容**：
- frontmatter: `plan_id` / `created_at` / `worktree_path`（绝对路径）/ `status: in_progress|completed|abandoned` / `base_commit` / `base_branch`（切 worktree 时所在的分支名 —— §Step 4「完成」ff-merge 目标，**默认不是 main**，是创 plan 时主仓库当前 HEAD 所在分支；feature branch 上跑 plan 时这个值就是 feature branch 名，让 worktree 改动合回 feature branch 而非 main 误污染主线）。**注**：plan frontmatter 字段名按 snake_case 写（archive_plan / hand_off_session 按 snake_case key 解析）；mcp tool input args 用 camelCase（详 §Agent Deck Universal Team Backend）。
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

**与 review SKILL 关系**：本 Step 1.5 = 复杂 plan 内嵌的多轮深度 review（`agent-deck:deep-review`）；单点 / 单次评审走 `agent-deck:simple-review`。复杂 plan 走多轮 SKILL 编排，单次决策走 simple-review。

> ⚠️ **没有应用环境提供 deep-review SKILL 时**：降级为 `agent-deck:simple-review` 单次评审 plan 文件本身（不含多轮 fix loop）；连 simple-review 也无（MCP 关）→ 人审。这是 fallback 不是替代，有应用 SKILL 优先用 SKILL。

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
- `commit` 但未 `push`（本地 ahead origin 1+ commits） — **archive_plan 完成后立即 EnterWorktree 是教科书级触发**
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

**追溯**：上游 bug 跟踪走 anthropics/claude-code GitHub issue。本约定基于实测复现确认非推测（cli.js minified code 反编译 + git man page start-point 行为实证 + reflog 证据）。

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

> ⚠️ 环境未提供自动接力 tool / tool 不可用（如 planId 已 status=completed）→ 退化到 §选项 A。

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
2. 从 frontmatter 拿 `worktree_path` → `EnterWorktree(path: <worktree-path-value>)` 进同一 worktree（用 `path`，不是 `name`）
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
5. 删 worktree + branch：`git worktree remove <worktreePath>` + `git branch -D worktree-<plan-id>`

> ⚠️ 步骤 1、2、3、5 属于同一收口事务，必须**原子完成**（步骤间任一失败应整片回滚或 abort，不要做部分回滚 — git 操作不可逆；步骤 4 是 changelog 引用补写，不计入归档事务）。手工执行时遇预检条件（plan status ≠ in_progress / worktree dirty / cwd 在 worktree 内 / detached HEAD 任一命中）应立即 abort，不要硬上。

#### 中止

frontmatter 置 `status: abandoned` + 中止理由 → `ExitWorktree(action: "keep")` → Bash `git worktree remove --force <worktree-path-value>` + `git branch -D worktree-<plan-id>`（abandoned plan 不入项目 git 归档，不走自动化归档 tool — tool 强制 `status=completed`，详 §plan hand-off §archive_plan §app-only 差异）。

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

**mini-spike + user 1-min confirm 3 题**：每文件实拆前 5-15 min 输出 spike 与 user 确认 3 题：① 子模块名 ② 边界划法 ③ 是 entity / 功能 / 行为域。**不 confirm 实施细节**（function 命名 / import 顺序 lead 自决）。**失败兜底**：spike 时间 ≥ 30 min 或子模块边界含跨文件互依赖（典型主入口文件 + 紧耦合子模块对偶拆，如 `index.ts` + `worker.ts`）→ 改走 full spike 落 `<plan-artifact-dir>/spike-reports/spikeN-<topic>.md`，不走 mini-spike。

**不预先抽 _shared/ 大坨**：跨 facade 重复 helper（典型 `getById` / `rowToRecord` 2-3 处实现）实际重复成本 < 抽离收益（类型签名不同，抽 generic factory 让 TypeScript inference 变复杂）。**例外**：真实跨子模块共享算法 / 常量必抽（如 `_impl-shared/isError<T>` generic 化 5 种 result 共用）。

### 多轮 Deep-Review 收口经验

> 与 `agent-deck:simple-review` / `agent-deck:deep-review` §反驳轮 + 三态裁决 正交：那两个 SKILL 各自 inline per-finding ✅/❌/❓ 三态裁决；本节定义**整 review session 何时 conclude** 的判定 + 反驳轮自纠机制 + fix 后同步纪律。适用任何走多轮异构对抗的 review session（典型应用环境 deep-review SKILL）。

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

**流程**：找语义相近条目 → `count` +1 + 更新 `last_at`；没找到 → 新增（`count: 1`）。**count = 3** → 走 `agent-deck:simple-review` 评审升级提案（三态裁决），结论告诉用户后**新建** `ref/conventions/<X>-<topic>.md`（X 递增）+ 同步 `ref/conventions/INDEX.md` 加行 + 从 tally 删该条。count < 3 → 静默更新。

**边界**：不计一次性请求 / trivial 反馈；用户反馈必须是工程偏好 / 设计取舍 / 工作流偏好；Agent 踩坑必须是模式化问题。30 天未更新且 count < 3 → 下次扫描可清理。


## 提示词资产维护

**改长生命周期 prompt 资产前必走本节**——即 `resources/claude-config/CLAUDE.md`（本文件）/ `resources/codex-config/CODEX_AGENTS.md` / `agent-deck-plugin/agents/reviewer-{claude,codex}.md` / `agent-deck-plugin/skills/*/SKILL.md` / 注入 SDK 的 mcp tool description / `resources/templates/` 模板。**不适用**：src/ 业务代码注释 / 一次性 prompt（spawn 临时拼的 reviewer / cold-start prompt）/ 历史快照（ref/ 下写定不改）。

**核心原则——受众优先**：这些资产是写给「读它的 agent」看的，不是写给维护者看的。每个单元（章节 / 工具描述）第一句先答**做什么 + 何时用**，让没读过代码的 agent 一眼知道何时调；调用契约 / 参数其次；内部不变量（§ref / 闭包机制 / 状态机细节）移到末尾或直接删。issue 工具长期没人调，就是因为描述开头全是 `§不变量` 而不是 trigger。

### 5 条硬约束

1. **去重**：同款规则只在一处写全，其余 cross-ref 不复制；`grep '<关键短语>' <资产>` 命中 ≥ 2 处即合并。**例外**：reviewer-{claude,codex}.md §核心纪律 / SKILL inline 纪律是有意独立注入 SDK 的 self-contained 副本，不抽 SSOT。
2. **只写当前事实**：禁「兼容旧 X / 过渡期 / 老版本仍可用 / 未来可能 / TODO / FUTURE / 后续会加」；废弃的功能 / 字段直接删，不留 deprecated 注释。**例外**：「不要 X，以前撞过 Y」这种行为锚点保留理由（如 EnterWorktree stale base bug callout）。
3. **可执行 > 描述**：写「做 X / 违反直接拒绝」，不写「建议 / 最好 / 可以 / 应该考虑」；模糊副词（通常 / 一般 / 大概）必须配「但 X 时例外」的具体边界。
4. **少兜底**：只留**会改变 caller 下一步动作**的失败处理（如「失败走 Y」）。纯防御性实现细节（race / TOCTOU / EXDEV / "仅 warn 不阻塞" / 穷举 error reason）属代码注释，不进 agent 读的描述。
5. **示例克制**：一条规则一两个最具代表性的示例够了；同款重复示例（"如 X / Y / Z" 里 Y/Z 与 X 雷同）删掉。

### 修改前自检（grep 命中即按对应约束处理，全过再 commit）

1. **去重**：`grep '<关键短语>' <file>` ≥ 2 → 合并（reviewer / SKILL inline 副本除外）
2. **当前事实**：`grep -nE '兼容|FUTURE|TODO|未来|向后|deprecated|过渡期|后续会加|老版本' <file>` ≥ 1 → 删（meta 引用 / 行为锚点除外）
3. **可执行**：`grep -nE '建议|应该考虑|最好|可以(用|走|考虑)|大概率?|通常|一般' <file>` → 改成可执行动作或配具体边界
4. **首句 trigger + 少兜底**：通读每节 / 每个工具描述首句——是否先答「做什么 + 何时用」？防御性兜底是否塞进了描述？无 trigger 则补，防御细节则删回代码注释
5. **示例**：`grep -nE '如[:：]|例如|比如' <file>` 命中后看示例数 ≥ 3 → 删雷同的

grep 工具不可用 / 假阳性 → 降级人工 review，不阻断 commit，commit message 注明「跳过自检 §N，理由」。


## Agent Deck Universal Team Backend

跨 adapter 协作通过 Agent Deck MCP 15 tool（10 现有：`mcp__agent-deck__spawn_session` / `send_message` / `list_sessions` / `get_session` / `shutdown_session` / `archive_plan` / `hand_off_session` / `enter_worktree` / `exit_worktree` / `shutdown_baton_teammates`；+ 5 task：`task_create` / `task_list` / `task_get` / `task_update` / `task_delete`）编排 + 管理结构化任务。teammate 调工具时走自己 SDK 会话的 canUseTool，**lead 不插手 teammate 权限审批**（失败弹给真人走 teammate 自己 session 的 PendingTab）。

速查：`spawn_session` 起 SDK session；`send_message` 统一发消息 / reply；`list_sessions` / `get_session` 只读查会话；`shutdown_session` close lifecycle 不删数据；`archive_plan` 原子归档 plan；`hand_off_session` baton 接力；`enter_worktree` / `exit_worktree` 管 worktree；`shutdown_baton_teammates` 补跑 teammate cleanup。

### 三个核心约定（lead 角度）

1. **spawn 首轮锚点**：`spawn_session` 返回 `spawnPromptMessageId: string | null`（仅当传 `teamName` 且 caller 在 sessions 表时非空），是首轮 prompt 在 messages 表的 placeholder id。teammate first turn 完成后调 `send_message({replyToMessageId: spawnPromptMessageId, ...})` 回复，reply 自动注入 lead conversation。lead 不需主动 poll —— 看到 user-role wire-prefixed message 即知 reply 到了
2. **后续轮次锚点**：`send_message` 返回 `{ sessionId, teamId, messageId, replyToMessageId, sentAt, queued: true }`。caller 用 `messageId` 在 DB 查 reply chain（如有审计需求）；正常对话不需要 — receiver 收到 message 后会**自动通过 wire prefix `[msg <id>][sid <senderSid>]`** 提到 caller 的 messageId 当 `replyToMessageId` 调 send_message reply 回来。`replyToMessageId` 仅当 caller 调 send 时显式传入 `replyToMessageId` 才有值，开新话题（首条 message / 不挂 reply chain）时为 `null`
3. **shutdown 不删数据**：`shutdown_session` 只标 lifecycle='closed' + abort SDK live query；events / file_changes / summaries / messages 子表保留，lead 在裁决报告里仍可引用。team 成员关系软退出（行不删，archive 时归档面板仍可看 member 历史）；spawn-link 父子关系全保留（list_sessions(spawnedByFilter) 跨 lifecycle 全见，跨会话救火依赖此）

> **dormant ≠ 丢 mental model**：lifecycle scheduler 转 dormant 只 abort SDK live query + 清 in-process Map，**不删 jsonl**；下一次 `send_message` 自动 SDK resume 复原对话历史。**唯一例外**：jsonl 缺失（用户手动删 `~/.claude/projects/` / 应用重装 / 跨设备同步未带）走 hard fail fallback → teammate 触发 `⚠ FRESH SESSION` warn 必须重 spawn。
>
> 实操：复用直接 `send_message`；彻底不再用才 `shutdown_session`。

### send_message 一统消息发送

最小调用（普通 / reply 都用同一 tool，reply 加 `replyToMessageId` 链接 DB 对话链）：

```ts
mcp__agent-deck__send_message({ sessionId, teamId, text, replyToMessageId?, callerSessionId? })
// return: { sessionId, teamId, messageId, replyToMessageId, sentAt, queued: true }
```

字段速查：

| 字段 | 必传 | 含义 |
|---|---|---|
| `sessionId` | ✓ | target receiver session id |
| `teamId` | caller/target 共享多 team 时必传 | 共享单 team 自动 resolve |
| `text` | ✓ | message body |
| `replyToMessageId` | optional | 从收到的 wire prefix `[msg <id>]` 提取链入 reply chain |
| `callerSessionId` | optional | in-process 自动闭包；HTTP transport 必传 |

**收消息**：caller 调 send_message → universal-message-watcher 自动把 message dispatch 给 receiver adapter → adapter 给消息加 wire prefix `[from <name> @ <adapter>][msg <id>][sid <senderSid>]` → 喂给 receiver SDK → receiver Claude 看到 user-role message 直接处理（lead 不需主动 poll，看到 wire-prefixed user message 即知 reply 到了）。

### 跨会话救火：list_sessions(spawnedByFilter)

lead context 重置 / 重启后捡 stranded reviewer：`list_sessions(spawnedByFilter:'<old_lead_sid>', statusFilter:'active')` 拉自己以前 spawn 的 active reviewer；按 sessionId 调 `send_message` 发新 prompt（receiver reply 通过 wire prefix `[msg <id>][sid <senderSid>]` 自动挂 reply chain 注入 lead conversation，与 §三个核心约定 §2 后续轮次锚点同款）；收尾走 `shutdown_session`。

> ℹ️ **shared-team 与 teamless DM**（plan teamless-dm-20260601 起放宽）：`send_message` 不再强制 caller 与 target 共享 active team。
> - **有 shared active team**：消息 team-scoped（行为不变；多 team 共享时仍需 `teamId` 去重）。
> - **无 shared active team 且未显式传 teamId**：自动降级 **teamless DM**（teamId=null），消息仍入 messages 表 + 注入 receiver SDK conversation，只是不进 team 聚合面板。
> - **显式传了不共享的 teamId**：仍 reject（`team-not-shared`，不静默降级）。
> - **archived caller / target**：teamless 路径显式 reject（不入队）。
>
> 对「跨会话救火」的实际影响：
> - **同 caller session（context 重置 / compaction）**：sessionId 不变 → 成员关系不变 → 直接 `list_sessions(spawnedByFilter)` 捡回来 + `send_message` 即可（team-scoped）。
> - **真换了 caller session**（应用重启 / 用户手动新开 / hand_off_session 默认不携 team 起新 session）：新 caller 不在原 team 内 → `send_message` 现在**会以 teamless DM 投递成功**（不再 hard reject）。若只是想继续给 reviewer 发 prompt，teamless DM 即可用。但**需要保留 reviewer 跨轮 mental model / 多 team 正确归属**时，仍建议先回到 team：
>   1. 调 `spawn_session({adapter:'claude-code', teamName:<old-team-name>, ...})` 重起一对 reviewer（旧的走 `shutdown_session` 收尾，避免 ghost）
>   2. 通过 UI 手动把新 caller 加入旧 team（应用 → Team 面板 → Add Member）
>   3. `hand_off_session` 起新 session 时显式传 `teamName:<old-team-name>` 让新 session 直接落入 team（仅当 plan 接力同 team 场景；baton 单向交接默认场景不加 team）
> - 需要保留 reviewer 跨轮 mental model → 走选项 2/3；接受重跑 reviewer → 走选项 1；只需单发消息不在意 team 归属 → 直接 teamless DM

### Wire format / regex / DB invariant

teammate 端协议约束（`[from <name> @ <adapter>][msg <id>][sid <senderSid>]\n` 三段 wire prefix / regex 提 messageId + senderSessionId / 用 send_message 回 / DB messages.body 不含 wire prefix 的 invariant）已强约束在 reviewer-{claude,codex}.md「核心纪律」节，**lead 不需关心**这些细节。

**wire format id invariant**：`messageId` / `senderSessionId` 都由 `crypto.randomUUID()` 生成（v4 UUID lowercase hex + hyphen，charset `[0-9a-f-]{36}`），regex `/\[msg ([0-9a-f-]+)\]\[sid ([0-9a-f-]+)\]/` 与该 charset 严格对齐。

### NO MSG ANCHOR 退化路径（reviewer 端 fallback）

reviewer agent 收到的 user message 顶部如果没找到 `[msg <id>][sid <senderSid>]` 双锚点 wire prefix（典型：lead context 重置后用裸文本 ping / 第三方 dispatch 路径丢前缀），按下面 fallback 处理：

1. reply 顶部硬性输出 `⚠ NO MSG ANCHOR — prompt 顶部没找到 [msg <id>][sid <senderSessionId>] wire prefix，本 reply 没法挂 replyToMessageId 进 lead 对话链；请 lead 通过 send_message 重新发本轮 prompt 提供 anchor`
2. **退化路径**：仍要交付 finding / codex 输出（不 abort）。`sessionId` 反查：调 `mcp__agent-deck__list_sessions({statusFilter: 'active'})`（不 filter adapter：cross-adapter native pair 中 lead 可能是 claude-code 或 codex-cli 任一）→ 按以下顺序定位 lead：① displayName 含 "Lead-" 前缀 / ② displayName 非 reviewer-* 标识 / ③ team 内排除自己 sessionId 后唯一 active；3 条都失败走第 4 步终极兜底。`teamId` 反查：调 `list_sessions` 看自己 session 的 `teams[]` 字段（与 lead 共享的 teamId）
3. **副作用警告**：reply 不挂 `replyToMessageId` 失去对话链锚点，DB / SessionDetail 看不出 reply 链关系；NO MSG ANCHOR 是**降级体验**，触发后 lead 应优先 shutdown + 重 spawn / 重发带 anchor 的 prompt 而非长期靠这个路径
4. **list_sessions 反查 lead 也失败**（多对 lead+teammate 同时跑歧义 / API 错）：直接把 finding / codex 输出落本 SDK session 的 assistant output（不调任何 mcp tool），lead 切到本 reviewer 的 SessionDetail UI 仍可看到

### enter_worktree / exit_worktree（MCP 替代方案）

claude 端首选 CLI builtin `EnterWorktree` / `ExitWorktree` 工具（直接调用建/退 git worktree + 切 cwd + 记录 session 的 cwd）。本应用 MCP 等价 tool 用于以下场景（builtin 不适用时）:

- `mcp__agent-deck__enter_worktree({ planId, worktreePath?, baseCommit?, baseBranch?, planFilePath? })`:创建 worktree 目录 + 写 cwd 释放标记；它不是 Claude CLI builtin `EnterWorktree(path:)`，不会替调用方切当前 SDK cwd
- `mcp__agent-deck__exit_worktree({ action: "keep" | "remove", worktreePath?, discardChanges?: false })`:退出 worktree

**何时走 MCP 替代**:
- 想避开 EnterWorktree CLI v2.1.112 stale base bug（详**本文件** §Step 2 §EnterWorktree CLI stale base bug callout）— MCP impl 显式用 HEAD 作 base 不撞 origin/<default> 落后陷阱
- 跨 adapter 测试 / 调试 — MCP 路径主路径(codex 必走 MCP),claude 端走同款 MCP 可对齐行为
- 需要明确写 cwd 释放标记（archive_plan 4 态预检场景必需）— MCP enter_worktree 自动写 marker，builtin EnterWorktree 不写。**默认 workflow** 仍 builtin EnterWorktree + 手工 `ExitWorktree(action:"keep")` → archive_plan 走 session 记录的 cwd 兜底,无需切 MCP

详 codex 端 protocol layer `resources/codex-config/CODEX_AGENTS.md §enter_worktree / exit_worktree` 节(codex 必走 MCP,无 fallback)。

### plan hand-off 自动化：archive_plan

plan 完成后一行原子收口，替代 §Step 4「完成」5 步手工序列：ff-merge worktree branch 回 `base_branch` → 改 frontmatter（status=completed + final_commit + completed_at）→ mv plan 到 `<main-repo>/ref/plans/`（有 spike-reports/ 一并归档）→ 同步 INDEX → commit → 删 worktree + branch。**调用前先 `ExitWorktree(action: "keep")`** 把 cwd 切出 worktree（mcp 不能替你调 ExitWorktree）。

**调用**：`mcp__agent-deck__archive_plan({ planId, worktreePath, baseBranch?, planFilePath?, changelogId? })`
- `baseBranch` 不传默认读 plan frontmatter.base_branch，缺失才 fallback "main"
- `changelogId` 关联 changelog 编号（`"122"` 或 `"121,122"`），写进 INDEX 链接列
- `planFilePath` 省略则按 `.claude/plans/` > `ref/plans/` > `~/.claude/plans/` 找；传了则文件名 stem 必须 == planId

**返回**：`{ archivedPath, commitHash, branchDeleted, worktreeRemoved, plansIndexAction, finalStatus, warnings, spikeReportsArchived, archived, teammatesShutdown }`

**要点**：
- **预检失败立即返 error 不回滚**（git 不可逆）：plan status ≠ in_progress / worktree dirty / cwd 还在 worktree 内 / detached HEAD。dirty 只卡 plan 相关路径（plan 文件 / INDEX / 归档目标），无关 dirty 文件放行
- **默认归档 caller + 关掉同 team teammate**（baton 语义）
- **abandoned plan 不走本 tool**（强制 completed）→ 走 §Step 4 §中止 手工流程
- **changelog 内容 agent 自己写**（tool 只更新 INDEX 链接）
- 预检失败但你已手工归档 → 用 §escape hatch shutdown_baton_teammates 补关 teammate

### escape hatch: shutdown_baton_teammates

手工归档 plan（绕过 archive_plan tool）后，用它补关同 team 的 reviewer teammate——否则它们衰减成 dormant 但没 closed，白占内存。archive_plan 正常跑时已含这步，不必再调。

**调用**：`mcp__agent-deck__shutdown_baton_teammates({ planId? })`
**返回**：`{ closed, failed, skipped: null, planId }`

- 只关 teammate，**不**做 git/fs 归档、**不**归档 caller 自己
- caller 在任何 team 都不是 lead → 返回 error（不是静默成功），按 hint 走 UI Team 面板
- deny external caller

### plan hand-off 自动化：hand_off_session

起新 SDK session 接力当前工作 + 默认归档 caller（单向 baton）。**两种模式**：传 `planId` = plan-driven（读 frontmatter，要求 status=in_progress + 有 worktree_path，cold-start prompt 自动 = `按 <plan-abs-path> 接力`）；不传 = generic（cold-start prompt = 你传的 `prompt`）。

**调用**：`mcp__agent-deck__hand_off_session({ planId?, phaseLabel?, prompt?, cwd?, adapter?: 'claude-code' | 'codex-cli', teamName?, permissionMode?, planFilePath?, archiveCaller?: true, adoptTeammates?: false, teamTaskPolicy?: 'clear-team' | 'preserve-team' | 'skip' })`
**返回**：`{ mode, planId, worktreePath, sessionId, cwd, teamId, archived, teammatesShutdown, taskReassignment, ... }`

**要点**：
- **adapter**（默认 `claude-code`）：省略即起 claude-code session；要起 codex session 显式传 `'codex-cli'`
- **cwd**：plan-driven 默认 mainRepo（worktree 被 archive_plan 删后仍 valid，新 session 自己 EnterWorktree 进去）；generic 默认 caller cwd。当前 cwd 不对就显式传——别在本 session `cd`（Bash 跨 turn 切 cwd 不持久）
- **archiveCaller**（默认 true）：单向 baton。传 false 让 caller 留着并行做事（如自己继续看 reviewer reply），可多次起 session
- **teamName**（默认不加）：纯 baton 不需要；要让新 session 和原 teammate 继续通信才传
- **adoptTeammates: true**：新 session 接管 caller 的 team 当 lead，原 teammate 继续可达。要求 caller 至少在一个 team 是 lead，且与 teamName 互斥
- **新 session cold-start 5 步**（plan-driven）：见 §复杂 plan workflow §Step 3 选项 A（cat plan → EnterWorktree(path:) → git log 自检 → 按「下一会话第一步」动手）
- **prompt 太长装不下** → 先落盘 `/tmp/handoff-<id>.md`，prompt 写「先 `Bash: cat <abs-path>` 再按文件推进」
- **要并行子任务而非交接身份** → 用 `spawn_session` 不是 hand_off_session

**caller 的 task 怎么过继**（`teamTaskPolicy`，仅 archiveCaller=true 时执行）：

| policy | 行为 |
|---|---|
| `clear-team`（默认）| task 过继给新 session 并清 teamId 变 personal——新 session 不必加 team 就能读写，最省心 |
| `preserve-team` | 过继但保留 teamId（配合 adoptTeammates 让新 session 当 lead 后仍能写）。新 session 没进对应 team 则写不了，return 里 `policyWarning` 提示 |
| `skip` | 直接删 caller 的 team task（plan 收口后丢弃中间 task），personal task 仍过继 |


## Issue 上报（report_issue / append_issue_context / update_issue_status）

执行中踩到「该记下来、但不该现在动手」的问题 → 用 mcp tool 落 issue tracker，别默默吞掉。三个 write tool 的完整签名 / 参数见各自工具描述，本节只讲**何时用**。agent 只写不查（无 list / get / delete），查询 / triage / 删除走应用 UI。

### 何时上报

发现以下任一、且**不在当前任务交付范围内** → `report_issue`：

| kind | 场景 |
|---|---|
| `follow-up`（default）| 当前任务暴露的后续工作（本轮 scope 外但该做）|
| `app-bug` | Agent Deck 应用本身的 bug |

**不上报**：
- **当场能顺手修的，直接修**——report 是留给「scope 外 / 需后续跟进」的，不是给自己当下能解决的事记 TODO
- 当前任务直接要交付的内容（直接做）
- 一次性 trivial 观察
- 怕重复而不报：agent 查不了已有 issue，宁可重报由 UI 合并

### 上报后

- **补现场** → `append_issue_context`：给本会话刚 report 的 issue（用返回的 `id`）追加上下文。只能补自己的、还没 resolved 的 issue。
- **改状态** → `update_issue_status`：自己修好了标 `resolved`，要重开标 `open`；仅源会话 / 解决会话能改，不用等人去 UI 点。
