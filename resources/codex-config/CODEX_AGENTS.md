<!-- 由 resources/codex-config/CODEX_AGENTS.md 打包注入到 codex SDK 子进程加载链(`~/.codex/AGENTS.md`)末尾;维护说明详 resources/codex-config/README.md(若存在)与 resources/claude-config/README.md 同款。 -->

--- Agent Deck 应用环境约定（codex 视角，随应用打包注入到每个 codex SDK 会话）---

# 应用环境约定（codex 视角）

## 优先级声明（必读）

本文件是 agent-deck 应用环境的 baseline 约定（codex 视角，注入 `~/.codex/AGENTS.md` 内由 Agent Deck installer marker 包裹的段）。**优先级链**:
- codex SDK 内置安全约束（sandbox / approval policy / system rules）**始终最高优先级**,本文件不替代
- **developer message / per-turn user prompt 中的指令优先级高于本文件 baseline**;与本文件冲突时**以 caller 当下指令为准**
- 如 `~/.codex/AGENTS.md` 内有 marker 之外的用户自加段,**该用户段与本文件 baseline 平等加载到 codex system prompt**(同 baseline 层级,无强优先级关系;与本文件冲突时 caller / user 必须自行选边或重审约定一致性 — 不依赖默认 fallback)
- 本文件提供 agent-deck 应用专属补充能力（mcp tool / plugin SKILL / cold-start 协议等）,不替换 user 通用约定

> **注:** **claude 视角等价 `CLAUDE.md` 因 claude SDK 加载机制不同(`settingSources: ['user',...]` 自动加载 user CLAUDE.md 作 baseline,有 user 通用约定全局加载机制)措辞不同是 adapter 差异不是 SSOT drift,维护时不要强行对齐两端**。

> 本文件是 **codex 视角** 的应用环境约定。**claude 视角**等价物在 `resources/claude-config/CLAUDE.md`(同应用打包同步注入 claude SDK system prompt 末尾)。两份 file 协议层语义对齐(Wire format / send_message / archive_plan / hand_off_session / shared-team 约束同款),只在**纯 codex 工具差异处**(`shell` vs `Bash` tool / `~/.codex/AGENTS.md` 加载点 / `sandboxMode` `approvalPolicy` 而非 claude 的 `--permission-mode` / 无 native EnterWorktree CLI 必须走 MCP tool)分别说明。
>
> **加载范围**：codex SDK 起 thread 时自动加载 `~/.codex/AGENTS.md`(本应用 build-time installer 把本文件内容同步到该路径)。codex 子进程 system prompt 末尾追加本文件内容,与 claude SDK `settingSources: ['user','project','local']` 自动加载 `~/.claude/CLAUDE.md` 是平行机制。

## 应用环境特有能力（不依赖 user CLAUDE.md）

### 协议覆盖：teammate 协作走 mcp tool

本应用环境(agent-deck) teammate 协作走 mcp tool(详 §Agent Deck Universal Team Backend 节)。teammate 通过 `send_message` 发消息 → universal-message-watcher → adapter.receiveTeammateMessage → adapter.sendMessage → codex SDK 把 message 喂给 receiver thread 自动注入 conversation flow(receiver codex 看到 user-role message 直接 act on it,无需主动 poll)。

### task 进度跟踪走 `mcp__agent-deck__task_*`(codex 端与 claude 端对称,无独立 task server)

本应用环境跑 plan / 多 Agent 协作 / 多步骤工作时,**task 进度跟踪必须走** `mcp__agent-deck__task_create` / `task_update` / `task_list` / `task_get` / `task_delete`(codex CLI 本身无内置原生 task 工具,所以不存在"替代"问题,直接用本组)。

**Why**:
- task 必有归属 session（创建时自动绑当前 codex SDK caller，不存在「无归属 task」）— 归属 session row 被历史保留期 GC 或显式物理删除时，DB FK ON DELETE CASCADE 自动删 owner task（**注意**：`closed` / 归档标记 仅打 lifecycle 标记不删 row 不触发 CASCADE），无 backlog 累积
- task 可绑 team 也可不绑 — 绑了 = team 共享（同 team teammate 可见可写），没绑 = 私人（仅 owner 可见可写），类比群聊 vs 私聊。team 之间严格隔离避免 lead 跨 team 时 task 串流
- **权限**按 teamId 决定：team-bound → caller 必须是该 team active member 才能 read/write；personal → 仅 owner 可见可写（不开放同 team 共享，避免 lead 私人 task 被 teammate 偷看 / 偷改）
- **task_get 严格 team-scoped 不再「跨 team 可读」**:in-process lead 跨 team 看 teammate task / external mcp client 凭已知 taskId 查 task 两类 use case 都被推翻 — task_get 走与 task_update/delete 同款 deny external 对称语义。lead 想看跨 team teammate task 应走「让 lead 加入对方 team 作为 active member」再用 `task_list({ teamIdFilter })` 查
- **personal task 是 first-class**:用户不在任何 team 时仍能用 task(典型场景:lead 起 reviewer pair 不必加 team 也想用 task 跟踪)。不传 `teamId` = personal default,与 caller 是否在 team 无关
- task 状态对 teammate(claude / codex 任一 adapter)/ hand-off 后新 session 全可见,不丢进度
- `hand_off_session` baton 时按 `teamTaskPolicy` 三态处理 task(详 §handOff 节)
- codex SDK 走 streamable HTTP transport 连本应用 MCP server,本组工具与 `send_message` / `spawn_session` 等同款 transport / 同款 per-session token 鉴权(codex 与 claude 端对称都能用 task tools)

**How to apply**:
- **新建 personal task** (default): `mcp__agent-deck__task_create({ subject, description?, status?, priority?, blocks?, blockedBy?, labels? })` → owner_session_id 自动闭包当前 caller, teamId=NULL
- **新建 team-bound task** (caller 必在该 active team): `mcp__agent-deck__task_create({ subject, teamId: <team-uuid>, ... })` — 不在该 team 是 active member 时 reject
- 状态切换: `mcp__agent-deck__task_update({ taskId, status })`, 枚举 `pending` / `active` / `completed` / `blocked` / `abandoned`(注意 `active` 替代 Claude Code 原生 `in_progress`)。写权限按 teamId 判定;跨 team 写 reject
- 列表查询:
  - 默认 `mcp__agent-deck__task_list()` → 返 `{ total, hasMore, tasks }`,visible scope = caller 可见 scope(自己 personal ∪ 所有 active team 的 team task;`hasMore: true` 表示 `tasks.length === limit` 可能还有,翻页传 `offset: prevOffset + tasks.length`)
  - `task_list({ teamIdFilter: <team-uuid> })` → 该 team 绑定的 task(caller 必在该 team active member)
  - `task_list({ teamIdFilter: 'null-personal' })` → caller 自己的 personal task(字面量,与传 team-uuid 区分语义)
- 单个查询: `mcp__agent-deck__task_get({ taskId })` — 严格 team-scoped read + deny external caller
- 删除: `mcp__agent-deck__task_delete({ taskId, force?: false })`, force=true 级联删 downstream(每个 child 都过同 team 写权限校验)

**例外**: 应用 settings `enableAgentDeckMcp: false` 关闭时本组工具(以及其他 agent-deck mcp 工具)整体不挂 → codex SDK session 没有 task 工具可用(codex CLI 本身无原生替代),plan / 多步骤工作进度跟踪只能落在 plan 文件 §当前进度 节 + 对话历史。本应用打包 SDK 会话 toggle ON 时挂上,挂上后**优先用 mcp__agent-deck__task_\***。

### codex 无 native EnterWorktree / ExitWorktree CLI → 必须走 MCP

claude SDK 在 CLI binary 内置 `EnterWorktree` / `ExitWorktree` 工具（直接调用建/退 git worktree + 切 cwd）。**codex CLI 没有等价 builtin** — 想从 codex session 内创建 / 标记 / 清理 worktree，只能调本应用提供的 MCP tool：
- `mcp__agent-deck__enter_worktree({ planId, baseCommit?, baseBranch? })`：创建 worktree 目录 + 记录 cwd 释放标记（让 archive_plan 4 态预检 case b 放过 codex caller）。**不会改变 codex SDK session cwd**（codex SDK session cwd 在 spawn 时已固定，后续 shell 命令必须显式 `git -C <worktreePath>` 或用 worktree 绝对路径）
- `mcp__agent-deck__exit_worktree({ action: "keep" | "remove", discardChanges?: false })`：清理 marker，按 action 保留或删除 worktree（同 claude 端 ExitWorktree 的归档前置语义，但不改变 codex shell 默认 cwd）
- 详 §Agent Deck Universal Team Backend §enter_worktree / exit_worktree 节

claude 视角同款 tool 也存在（MCP 通用），claude 端首选 CLI builtin。codex 端**无 fallback**必须走 MCP。

### reviewer-claude 失败 → SKILL 内合规兜底分支（对称 claude 视角）

`deep-review` SKILL 内若 reviewer-claude teammate 失败（claude SDK 起不来 / OAuth 过期 / sandbox 拒 / timeout / claude jsonl 缺失 fresh-session abort），lead 走 `shell` 起外部 claude CLI（按项目内模板 `{{AGENT_DECK_RESOURCES}}/templates/reviewer-claude.sh.tmpl` 填）仍构成 Opus 4.7 vs gpt-5.5 异构对（详 SKILL.md §失败兜底 表）。**严禁**自动降级到同源双 Codex（破坏异构对抗原则）— claude / codex 两路 reviewer 失败兜底对称 enforce。

---

## 决策对抗

下结论 / 出 plan 前必做。

**适用范围**(任一即触发):
- 给代码下定性判断:bug / 优化 / code review / 安全 / 架构 / 根因
- 出执行计划(plan)
- 重要技术选型 / 重构方向决策
- **例外**:trivial 改动(typo / 样式数值 / 单点 rename / 显然措辞修订)

**场景分流**:

| 场景 | 走哪条 | 不能反过来 |
|---|---|---|
| **单次决策对抗**(1-2 个问题就够:单点判定 / plan 评审)| 本节 §主路径 双 shell 起外部 CLI —— 同 turn 内起两个外部 CLI 进程 | 多轮 review 别走本路:fresh per turn 丢 in-memory state,反驳轮没自己上轮推理链反驳质量崩 |
| **多轮深度 review**(多轮 review × fix 循环 + 反驳轮 + focus 切片)| `agent-deck:deep-review` SKILL(teammate 模式,跨轮 context 持久化) | 单次决策对抗别走多轮编排:teammate 编排开销大无收益 |

### 主路径:双 shell 起异构外部 CLI

**操作**:codex lead 用 `shell` 起两个外部 CLI 进程,分别拿独立 stdout。两进程完全独立(互不知道对方存在 / 不沟通)→ 各自 stdout 回 lead → lead 做三态裁决:

1. reviewer-claude 走 `zsh -i -l -c "claude -p ..."`(外部 Claude Code 进程,oneshot print mode)—— 模板:`{{AGENT_DECK_RESOURCES}}/templates/reviewer-claude.sh.tmpl`
2. reviewer-codex 走 `zsh -i -l -c "codex exec ..."`(外部 codex CLI 进程,oneshot exec mode)—— 模板:`{{AGENT_DECK_RESOURCES}}/templates/reviewer-codex.sh.tmpl`

异构由两路 reviewer 物理保证(claude -p 跑 Claude Opus / codex exec 跑 codex),lead 用哪个 adapter 无关。

> ⚠️ 这两份 `.sh.tmpl` 是 **shell oneshot 起外部 CLI 用**(本节单次决策对抗);与 deep-review SKILL teammate 模式起的同名 reviewer-{claude,codex}(跨轮 context 持久化、属 SKILL 编排)是**两套独立物件**,不混用:单次决策对抗用本节 .sh.tmpl,多轮深度 review 走 deep-review SKILL。

#### 外部 CLI 对抗 Agent 通用姿势(codex 端)

- **登录式 shell 包外层**(macOS:`zsh -i -l -c "..."`),否则缺 brew / nvm / path_helper PATH
- **强制非交互模式**(`-p` / `exec`)+ **进程级只读约束**(codex `--sandbox read-only --skip-git-repo-check`;claude `--permission-mode default` + `--disallowedTools 'Edit,MultiEdit,Write,NotebookEdit,ExitPlanMode'` + `--allowedTools` 只读白名单)—— **完整 flag 以 `.sh.tmpl` 模板为准**(模板内注释含 plan-mode 陷阱等踩坑)
- **显式传项目绝对路径**(`-C` / `--cwd`)
- **分离最终答案与日志**:codex 用 `-o <FILE>`;claude 用 stdout 重定向 `> <FILE>`
- **reasoning effort 取最高档**(review / plan / 探索类;简单 yes/no 核查可临时降档,但**宁可慢别错**)
- **长 prompt 走 stdin**,prompt 里**写死要读的文件绝对路径**,不让 CLI 自由 grep / explore
- **codex shell 并发**:`shell` 起两个外部 CLI 用 `&` 后台化 + `wait` 收集两路 stdout(codex 无 claude 的 run_in_background task-notification 机制,用 shell 原生后台/wait 等价);prompt 短时也可顺序起两个
- **超时**:重 review 给 5-10 分钟;命令体内**绝不写 `timeout` / `gtimeout`**(macOS 无此命令,会连带后续命令一起 `command not found`),靠 CLI 自身完成或外层进程级控制
- **大 scope 拆批**:单批 ≤ 10 文件 / prompt ≤ 30 行;超出按主题拆批并发;卡住就拆更小批不要傻等(详 `{{AGENT_DECK_RESOURCES}}/SOPs/codex-cli-stuck-lessons.md`)

### 反驳轮 + 三态裁决

**反驳轮**:单方独有 + HIGH 候选 → 起对方 reviewer 反驳一次(保持异构),反驳 prompt 明禁「借机提其他 finding」专注单点。反驳后 lead 推到 ✅ / ❌ / 仍 ❓ → 必要时 lead 自己现场验证(**单 finding ≤ 5min / ≤ 5 次 grep / ≤ 1 个 test,超就降级非 HIGH 不再纠缠**)。

**三态裁决**(每条 finding):
- ✅ **真问题**(HIGH 必须满足 ≥1 个验证条件):「**双方独立提出**」(异构强冗余即算验证)**或**「**一方提出且现场实践验证成立**」(grep 出 N 处证据 / 写小 test 复现挂掉 / 跑命令确认)→ 必修
- ❌ **反驳**:被对抗或现场核实证伪 → 不修,记反驳依据
- ❓ **部分 / 未验证**:双方角度不同 / 一方提出但纯文本推理(含弱断言)尚未实践验证 → 综合后决定

**单方独有分流**:HIGH → 反驳轮;MED → lead 自己验证;LOW/INFO → 直接 ❓。双方都说没问题 → ✅ 可合。

### Finding 输出契约(reviewer prompt + 三态裁决 + REVIEW.md 共用)

每条 finding 必须带:
- `文件:行号` + 代码 / 原文片段(≤ 6 行)
- **验证手段**(如 "grep 出 3 处全无 null check" / "写 stateful mock 模拟双 disconnect 实测 abort 0 次")
- 严重度分组:HIGH / MED / LOW / INFO(提示性、不影响合并)/ *未验证*

**强制约束**:
- 空泛 finding + 没验证 = 直接降 ❓ 或 ❌
- **任何 ✅ HIGH 都必须落到上述两个验证条件之一**(双方独立 / 单方 + 现场验证)
- 弱断言关键词("可能 / 也许 / 看起来 / 应该 / 大概")**只允许**出现在标注 *未验证* 的条目里
- 未验证强制降级为非 HIGH

### reviewer 失败兜底

外部 CLI 失败(二进制缺失 / OAuth 过期 / 超时 / `$OUT` 空)→ 提示用户决策:等恢复 / 单方另一路出结论 / 稍后重试 / abort。invariant「**严禁同源双 reviewer**」(不可降级双 codex 或双 Claude — 破坏异构);deep-review SKILL 内合规兜底分支详 §应用环境特有能力 §reviewer-claude 失败 → SKILL 内合规兜底分支 节。

---

## 核心流程 / 架构变更必走 plantUML

涉及核心流程 / 架构变更时必须用 plantUML 画图并落到 `ref/` 对应子目录。**「怎么画」(plantUML syntax / 图类型 / workflow)由 `agent-deck:flow-arch-plantuml` SKILL(codex-config 端独立 SSOT)规定;「画在哪 / INDEX 怎么维护」由本节规定**(关注点分离 — SKILL 与位置约定独立维护)。

### 触发条件

详 SKILL.md §何时用 节;速查:
- **user 明示**「画架构图」/「画流程图」/「画 plantUML」/「核心流程图改一下」等
- **LLM 自检** 本次改动属以下 4 类任一:① 会话状态机(session lifecycle / sdk-bridge / context resume)② 跨进程通信(IPC / 跨 adapter 编排 / spawn-link 树 / event-bus 路由 / sandbox / permission)③ 数据库 / 协议(DB schema / wire format / canUseTool)④ 关键 mcp tool 行为(archive_plan / hand_off_session / spawn_session / send_message dispatch / lifecycle scheduler)
- **trivial 改动**(typo / 单点 rename / UI 微调 / 业务模块内部不动协议)**不触发**

invoke 前必须与 user 显式确认是核心变更(SKILL 入口提问 + codex turn 边界 enforce — 见下方 §与 user 确认机制);否则 skill no-op exit。

### 文件位置约定

- **流程图**(sequence diagram / activity diagram)落 `<main-repo>/ref/flows/<topic>.puml`
- **架构图**(component diagram / 模块依赖 / 跨进程边界)落 `<main-repo>/ref/architecture/<topic>.puml`
- **文件命名** `<topic>.puml`,topic 用 kebab-case(`archive-plan-flow.puml` / `mcp-server-architecture.puml`)
- **同主题需要双图**(流程图 + 架构图)→ 拆两份分别落各自目录,topic 名可一致(`archive-plan-flow.puml` vs `archive-plan-architecture.puml`)
- **目录不存在**(典型新项目 / 本 plan 实施前):SKILL 主动 `shell: mkdir -p ref/flows ref/architecture` + 建空 INDEX.md(下节 4 列模板)
- **codex shell 工具用法**: codex 端读现有 .puml / INDEX 走 `shell cat` / `shell ls`,写 / 改 .puml + INDEX 走 `apply_patch`(codex 无 claude builtin Read / Write / Edit);可选 `shell: plantuml -syntax <file>.puml` 做语法检查。**严禁** codex 端调 `plantuml -tpng / -tsvg` 渲染产 PNG/SVG(违反 flow-arch SKILL §不渲染 SSOT — user 想看渲染产物自跑 plantuml CLI)。

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

### 与 user 确认机制(codex turn 边界硬约束)

SKILL 入口必须先向 user 提 2-3 个对齐问题 — **是否核心变更 / 图类型选择 / 新建 vs 修改 vs archived 已有**(详 SKILL.md §与 user 确认机制)。**codex 无 AskUserQuestion 阻塞语义,必须靠 turn 边界保证 user 先拍板**:输出问题后必须结束本 turn 等 user 下一轮回复,严禁同一 turn 内继续生成 / 修改任何 .puml 或 INDEX.md。本应用工程实践**严禁** agent 默认静默生成图;每次画图前都要等 user 显式回复确认。

### 与其他规则关系

- 与 `agent-deck:deep-review` SKILL 互斥并行(同会话不并行,避免 .puml SSOT 写竞争);deep-review 中发现需画图 → 完成 review 后 invoke `flow-arch-plantuml`
- 与本应用 `agent-deck:flow-arch-plantuml` SKILL **关注点分离**:本节定位置/INDEX 规则,SKILL 定画图技术 — 两边修改时**不要复制 SSOT**,只保留 cross-ref(SSOT 单源不复制 — 同款规则只在一处其他位置引用)

---

## Agent Deck Universal Team Backend

跨 adapter 协作通过 Agent Deck MCP 15 tool（10 现有：`mcp__agent-deck__spawn_session` / `send_message` / `list_sessions` / `get_session` / `shutdown_session` / `archive_plan` / `hand_off_session` / `enter_worktree` / `exit_worktree` / `shutdown_baton_teammates`；+ 5 task：`task_create` / `task_list` / `task_get` / `task_update` / `task_delete`）编排 + 管理结构化任务。teammate 调工具时走自己 codex SDK 会话的 `approvalPolicy` + `sandboxMode`,**lead 不插手 teammate 权限审批**(失败弹给真人走 teammate 自己 session 的 PendingTab)。

速查:`spawn_session` 起 SDK session;`send_message` 统一发消息 / reply;`list_sessions` / `get_session` 只读查会话;`shutdown_session` close lifecycle 不删数据;`archive_plan` 原子归档 plan;`hand_off_session` baton 接力;`enter_worktree` / `exit_worktree` 管 worktree;`shutdown_baton_teammates` 补跑 teammate cleanup。

### 三个核心约定(lead 角度)

1. **spawn 首轮锚点**:`spawn_session` 返回 `spawnPromptMessageId: string | null`(仅当传 `teamName` 且 caller 在 sessions 表时非空),是首轮 prompt 在 messages 表的 placeholder id。teammate first turn 完成后调 `send_message({replyToMessageId: spawnPromptMessageId, ...})` 回复,reply 自动注入 lead conversation。lead 不需主动 poll —— 看到 user-role wire-prefixed message 即知 reply 到了
2. **后续轮次锚点**:`send_message` 返回 `{ sessionId, teamId, messageId, replyToMessageId, sentAt, queued: true }`。caller 用 `messageId` 在 DB 查 reply chain(如有审计需求);正常对话不需要 — receiver 收到 message 后会**自动通过 wire prefix `[msg <id>][sid <senderSid>]`** 提到 caller 的 messageId 当 `replyToMessageId` 调 send_message reply 回来。`replyToMessageId` 仅当 caller 调 send 时显式传入 `replyToMessageId` 才有值,开新话题(首条 message / 不挂 reply chain)时为 `null`
3. **shutdown 不删数据**:`shutdown_session` 只标 lifecycle='closed' + abort SDK live query;events / file_changes / summaries / messages 子表保留,lead 在裁决报告里仍可引用。team 成员关系软退出(行不删,archive 时归档面板仍可看 member 历史);spawn-link 父子关系全保留(list_sessions(spawnedByFilter) 跨 lifecycle 全见,跨会话救火依赖此)

> **dormant ≠ 丢 mental model**:lifecycle scheduler 转 dormant 只 abort codex SDK live query + 清 in-process `codexBySession` Map,**不删 thread jsonl**(codex 把 thread 历史持久化到 `~/.codex/sessions/<thread-id>.jsonl`);下一次 `send_message` 自动通过 `codex.resumeThread(threadId, options)` 复原对话历史。**唯一例外**:thread jsonl 缺失(用户手动删 `~/.codex/sessions/` / 应用重装 / 跨设备同步未带)走 hard fail fallback → teammate 触发 `⚠ FRESH SESSION` warn 必须重 spawn。
>
> 实操:复用直接 `send_message`;彻底不再用才 `shutdown_session`。

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
| `callerSessionId` | codex teammate 走 MCP HTTP transport 时由 per-session token 自动反查填入 | external transport 必传 |

**收消息**：caller 调 send_message → universal-message-watcher 自动把 message dispatch 给 receiver adapter → adapter 给消息加 wire prefix `[from <name> @ <adapter>][msg <id>][sid <senderSid>]` → 喂给 receiver codex SDK thread → receiver codex 看到 user-role message 直接处理（lead 不需主动 poll，看到 wire-prefixed user message 即知 reply 到了）。

### 跨会话救火:list_sessions(spawnedByFilter)

lead context 重置 / 重启后捡 stranded reviewer:`list_sessions(spawnedByFilter:'<old_lead_sid>', statusFilter:'active')` 拉自己以前 spawn 的 active reviewer;按 sessionId 调 `send_message` 发新 prompt(receiver reply 通过 wire prefix `[msg <id>][sid <senderSid>]` 自动挂 reply chain 注入 lead conversation,与 §三个核心约定 §2 后续轮次锚点同款);收尾走 `shutdown_session`。

> ⚠️ **shared-team 前置约束**:`send_message` 必须在 caller session 与 target reviewer 至少共享一个 active team 时才能 dispatch(否则报 `no-shared-team` 立即 reject,不入 messages 表)。
> - **同 caller session(context 重置 / compaction)**:sessionId 不变 → 成员关系不变 → 直接 `list_sessions(spawnedByFilter)` 捡回来 + `send_message` 即可
> - **真换了 caller session**(应用重启 / 用户手动新开 / hand_off_session 默认不携 team 起新 session):新 caller 不在原 team 内 → `send_message` 必报 `no-shared-team` → 必须先满足以下任一条件:
>   1. 调 `spawn_session({adapter:'codex-cli', teamName:<old-team-name>, ...})` 重起一对 reviewer(旧的走 `shutdown_session` 收尾,避免 ghost)
>   2. 通过 UI 手动把新 caller 加入旧 team(应用 → Team 面板 → Add Member)
>   3. `hand_off_session` 起新 session 时显式传 `teamName:<old-team-name>` 让新 session 直接落入 team(仅当 plan 接力同 team 场景;baton 单向交接默认场景不加 team)
> - 需要保留 reviewer 跨轮 mental model → 走选项 2/3;接受重跑 reviewer → 走选项 1

### Wire format / regex / DB invariant

teammate 端协议约束(`[from <name> @ <adapter>][msg <id>][sid <senderSid>]\n` 三段 wire prefix / regex 提 messageId + senderSessionId / 用 send_message 回 / DB messages.body 不含 wire prefix 的 invariant)已强约束在 reviewer-{claude,codex}.md「核心纪律」节,**lead 不需关心**这些细节。

**wire format id invariant**:`messageId` / `senderSessionId` 都由 `crypto.randomUUID()` 生成(v4 UUID lowercase hex + hyphen,charset `[0-9a-f-]{36}`),regex `/\[msg ([0-9a-f-]+)\]\[sid ([0-9a-f-]+)\]/` 与该 charset 严格对齐。

### NO MSG ANCHOR 退化路径(reviewer 端 fallback)

reviewer agent 收到的 user message 顶部如果没找到 `[msg <id>][sid <senderSid>]` 双锚点 wire prefix(典型:lead context 重置后用裸文本 ping / 第三方 dispatch 路径丢前缀),按下面 fallback 处理:

1. reply 顶部硬性输出 `⚠ NO MSG ANCHOR — prompt 顶部没找到 [msg <id>][sid <senderSessionId>] wire prefix,本 reply 没法挂 replyToMessageId 进 lead 对话链;请 lead 通过 send_message 重新发本轮 prompt 提供 anchor`
2. **退化路径**:仍要交付 finding / codex 输出(不 abort)。`sessionId` 反查:调 `mcp__agent-deck__list_sessions({statusFilter: 'active'})`(不 filter adapter — lead 可能是 claude-code / codex-cli 任一) → 按以下顺序定位 lead:① displayName 含 "Lead-" 前缀 / ② displayName 非 reviewer-* 标识 / ③ team 内排除自己 sessionId 后唯一 active;3 条都失败走第 4 步终极兜底。`teamId` 反查:调 `list_sessions` 看自己 session 的 `teams[]` 字段(与 lead 共享的 teamId)
3. **副作用警告**:reply 不挂 `replyToMessageId` 失去对话链锚点,DB / SessionDetail 看不出 reply 链关系;NO MSG ANCHOR 是**降级体验**,触发后 lead 应优先 shutdown + 重 spawn / 重发带 anchor 的 prompt 而非长期靠这个路径
4. **list_sessions 反查 lead 也失败**(多对 lead+teammate 同时跑歧义 / API 错):直接把 finding / codex 输出落本 codex SDK session 的 assistant output(不调任何 mcp tool),lead 切到本 reviewer 的 SessionDetail UI 仍可看到

### enter_worktree / exit_worktree(codex 端必走 MCP)

codex SDK session 内进 / 退 git worktree 必须通过本应用 MCP tool(codex CLI 无 native EnterWorktree / ExitWorktree builtin)。

**调用**:`mcp__agent-deck__enter_worktree({ planId, worktreePath?, baseCommit?, baseBranch?, planFilePath? })`
- `planId`:同 plan frontmatter `plan_id`(frontmatter 字段名是 snake_case),worktree 目录名 = `<main-repo>/.claude/worktrees/<plan-id-value>`,branch 名 = `worktree-<plan-id-value>`(schema 用 `baseCommit` / `baseBranch` 两字段)
- `baseCommit`(optional):caller 显式 commit hash / ref(最高优先级)
- `baseBranch`(optional):caller 显式 branch 名
- `worktreePath`(optional):override 默认 worktree 目录路径
- `planFilePath`(optional):override plan 文件路径
- **base 优先级链** 5 态:(1) `args.baseCommit` → `'arg-base-commit'` (2) `args.baseBranch` → `'arg-base-branch'` (3) plan frontmatter `base_commit` → `'frontmatter-base-commit'` (4) plan frontmatter `base_branch` → `'frontmatter-base-branch'` (5) main repo HEAD → `'head'`。**避开 EnterWorktree CLI stale base bug**(claude 端 builtin v2.1.112 默认用 `origin/<default>` 落后本地 HEAD;MCP impl 走 HEAD 不撞此坑)
- 副作用：创建 worktree 目录 + 新 branch + 设 cwd 释放标记（让 archive_plan 4 态预检 case b 放过 codex caller）。**不会改变 codex SDK session cwd**（codex 端 cwd 在 spawn 时已固定，后续 shell tool 必须用 `git -C <worktree>` 或 worktree 绝对路径）
- 返回:`{ worktreePath: string, branchName: string, baseCommit: string, baseSource: 'arg-base-commit' | 'arg-base-branch' | 'frontmatter-base-commit' | 'frontmatter-base-branch' | 'head', markerSet: boolean }`

**调用**:`mcp__agent-deck__exit_worktree({ action: "keep" | "remove", worktreePath?, discardChanges?: false })`
- `keep`:仅 clearCwdReleaseMarker(让 archive_plan 4 态预检走 marker null 路径),保留 worktree 目录 + branch(常用 — 准备 archive_plan 前的标准操作 since archive_plan 自己也清 marker)
- `remove`:同 keep + `git worktree remove` + `git branch -d/-D`(默认 `-d` 拒删未合并 commit;`discardChanges: true` 切 `-D` 强制删 + 同时跳过 dirty 预检)
- `worktreePath`(optional):默认省略让 impl 自动从 cwd 释放标记反查;仅当 caller 已知 worktree path 但 marker 丢失 (session restart / 跨进程接力等) 时显式传
- 返回:`{ worktreePath, action, branchDeleted: boolean, worktreeRemoved: boolean, markerCleared: boolean }`

### plan hand-off 自动化:archive_plan

`archive_plan` 在 plan 完成后**原子执行** **本文件** §plan hand-off 自动化 archive_plan 完成节 5 步:ff merge worktree branch → `base_branch`（plan frontmatter 字段值）/ 更新 frontmatter (`status=completed` + `final_commit` + `completed_at`) / mv plan → `<main-repo>/ref/plans/<plan-id>.md` / **如 plan 有 spike-reports/ → mv `<plan-artifact-dir>/spike-reports/` → `<main-repo>/ref/plans/<plan-id>/spike-reports/`** / 同步 `<main-repo>/ref/plans/INDEX.md` / `git add` + commit / `git worktree remove` + `git branch -D`。caller 调用前必须先 `exit_worktree(action: "keep")`(codex 端走 MCP,不是 claude builtin)。

**调用**:`mcp__agent-deck__archive_plan({ planId, worktreePath, baseBranch?: <plan frontmatter.base_branch ?? "main">, planFilePath?, changelogId? })`(`baseBranch` 默认值:schema 优先读 plan frontmatter.base_branch,缺失才 fallback "main")
**返回**:`{ archivedPath, commitHash, branchDeleted, worktreeRemoved, plansIndexAction: 'created'|'appended'|'updated'|'unchanged', finalStatus, warnings: string[], spikeReportsArchived: { srcPath, dstPath } | null, archived: 'ok'|'failed'|'skipped', teammatesShutdown: { closed, failed, skipped } }`

**app-only 差异**:

- **预检短路**:plan status ≠ in_progress / worktree dirty / **caller session cwd 在 worktree 内** / detached HEAD 任一命中 → 立即返回 error,不做部分回滚(git 操作不可逆)。**codex 端 cwd 预检**走 session 记录的 cwd + cwd 释放标记(4 态分流),不直接读进程 cwd
- **lead 必须先 exit_worktree**:tool 内不能调 exit_worktree;cwd 在 worktree 内时 tool 直接 reject
- **自动归档 caller session**:plan 收口后默认归档 caller(baton 同款语义),返回 `archived` 三态字段;归档失败仅 warn 不阻塞 ok return
- **abandoned plan 不走本 tool**:tool 强制 `status=completed` 且入项目 git 归档;abandoned 走 **本文件** §手工归档 fallback §abandoned 中止 3 步（跨 adapter 通用，下方 inline）
- **changelog 引用归档** agent 自己写(tool 不做)
- **spike-reports/ 自动归档**:detect `<plan-artifact-dir>/spike-reports/` 存在(`<plan-artifact-dir>` = `<plan-file-dir>/<plan-id>/`,即 plan 文件父目录下的同名 artifacts 目录)→ mv 到 `<main-repo>/ref/plans/<planId>/spike-reports/`(plan .md 同名子目录与 plan .md 平级,约定 plan .md 是主体 + 同名目录是 artifacts),spike-reports/ 子目录递归入 git 归档 commit。不存在 → skip 不报错(trivial plan 无 spike 是合法场景)。mv 失败(EXDEV 跨 fs / perm)→ warnings 落 hint「spike-reports archive failed: ... Manually run \`mkdir -p && mv && git add+commit --amend\`」+ 不阻塞 ok return。`spikeReportsArchived` 字段告诉 caller 实际归档结果(null = skip / `{srcPath, dstPath}` = 成功)
- **UX 完善**:
  - fallback 链 `<main-repo>/.claude/plans/` > `<main-repo>/ref/plans/` > `~/.claude/plans/`(加中间档兜底本项目实际惯例)
  - `planFilePath` 文件名 stem 必须 == `planId`(impl 层 reject 防 silent unlink)
  - INDEX 4 列 canonical `| 文件 | 状态 | 关联 changelog | 概要 |` + smart update existing 行(替换 status / changelog / description)
  - `changelogId` optional string + csv(单值 `"122"` / 多值 `"121,122"`),拼成 markdown link 写入 INDEX 第 3 列;不传时 smart update 保留老 4 列 changelog 列 / 旧 2 列或新 append 用 `—` placeholder
  - `plansIndexAction` 四态 enum 替代旧 boolean,让 caller 区分 INDEX 行真正发生的事情
  - `warnings` non-fatal warning 数组(如 `.claude/plans/<id>.md` 与 `ref/plans/<id>.md` 同 id 双存覆盖警告 — 走 warn 而非 reject)
  - 7 phase post-ff-merge 失败专用 phaseHint 给具体 manual recovery 决策树(替代旧通用 hint)
- **mainRepo dirty precheck 精确化**:仅 reject 三具体路径 `{archivedPath, indexPath, planFilePath}` 命中 dirty / staged / untracked / R rename / C copy(含 old/new path 任一命中)— 其他无关 dirty 文件降 warning + commit message 注脚(commit pathspec 隔离不吞)。precheck 失败时 hint 软引导 caller fix 撞 critical paths 后重 invoke archive_plan,**或** 走 §escape hatch: shutdown_baton_teammates 补跑 baton-cleanup phase 1(如 caller 必须手工归档场景)— 不硬技术阻断手工归档(**本文件** §手工归档 fallback §completed 收尾 5 步 仍是合法 fallback)

### 手工归档 fallback（跨 adapter 通用；archive_plan 不可用时）

archive_plan tool 撞 precheck fail / abandoned plan(tool 强制 status=completed 不接 abandoned)时,caller 手工归档。codex 端用 `shell` 跑 git 命令 + `apply_patch` 改 plan frontmatter（无 native EnterWorktree/ExitWorktree,worktree 进退走 MCP `enter_worktree` / `exit_worktree`）。

**completed 收尾 5 步**（步骤 1/2/3/5 属同一收口事务,任一失败整片 abort 不做部分回滚 — git 操作不可逆;step 4 是 changelog 引用补写不计入事务）:
1. `exit_worktree(action: "keep")` 先把 cwd 切出 worktree（codex 端走 MCP）
2. ff-merge 回 plan frontmatter `base_branch`（不是无脑 main — feature branch 上开 plan 就合回 feature branch,避免污染主线）:`git -C <main-repo> checkout <base-branch>` + `git -C <main-repo> merge --ff-only worktree-<plan-id>`
3. plan 归档:frontmatter 置 `status: completed` + `final_commit: <hash>` + `completed_at: <ISO ts>` → mv plan 到 `<main-repo>/ref/plans/<plan-id>.md`（有 `<plan-artifact-dir>/spike-reports/` 一并 mv 到 `<main-repo>/ref/plans/<plan-id>/spike-reports/`）→ 同步 `<main-repo>/ref/plans/INDEX.md` → `git add` + `git commit`
4. `<main-repo>/ref/changelogs/CHANGELOG_X.md` 引用归档（不抄全 plan）
5. 删 worktree + branch:`git worktree remove <worktreePath>` + `git branch -D worktree-<plan-id>`;**如 plan 关联 team 有 teammate**,收尾后调 §escape hatch shutdown_baton_teammates 补跑 baton-cleanup phase 1（手工归档绕过 archive_plan,teammate 不会被自动 close;无 team / teammate 时跳过此步）

**abandoned 中止 3 步**（不入项目 git 归档）:frontmatter 置 `status: abandoned` + 中止理由 → `exit_worktree(action: "keep")` → `git worktree remove --force <worktreePath>` + `git branch -D worktree-<plan-id>`

> claude 视角等价 5 步 / 3 步在 `resources/claude-config/CLAUDE.md` §复杂 plan workflow §Step 4（§完成 / §中止）;两端独立 SSOT 协议层对齐,codex 端 inline 是因 codex 无 `~/.claude/CLAUDE.md` 自动加载机制（claude 端走 `settingSources` 自动加载）。

### escape hatch: shutdown_baton_teammates

`shutdown_baton_teammates` 让 caller 手工归档 plan 后**补跑** baton-cleanup phase 1(同 team 其他 active+dormant teammate 一并 close + 成员关系软退出)。仅供 archive_plan 撞 precheck fail / 历史 dormant 残留清理使用。

**调用**:`mcp__agent-deck__shutdown_baton_teammates({ callerSessionId?, planId? })`
**返回**:`{ closed: string[], failed: Array<{sessionId,reason}>, skipped: null, planId: string | null }`

**典型场景**:

archive_plan tool 撞 mainRepo dirty / cwd resilience guard 等 precheck fail → caller 走 **本文件** §手工归档 fallback §completed 收尾 5 步绕过 archive_plan tool(commit + mv plan + git worktree remove + branch -D)→ baton-cleanup phase 1 没被自动跑到 → 同 team teammate(reviewer-claude / reviewer-codex 等)自然衰减成 dormant 但**没** closed,占内存 + SDK live query。本 tool 让 caller 显式补跑 phase 1。

**与 archive_plan 的边界**:

- archive_plan 是 plan 收口 tool(git ff-merge / mv plan / commit / git worktree remove)+ default baton-cleanup phase 1+2(archive_plan 不再支持 phase 1 跳过)
- `shutdown_baton_teammates` 是「补跑 phase 1」的独立 tool,**不**做任何 git/fs 归档操作;**不**调 phase 2 archive caller(caller 决定何时 archive;典型场景 caller 已手工归档完毕)

**错误契约**:

- caller 不在任何 team 是 lead(caller 是 teammate / 无 active membership / 所有 caller-lead 团队都已 archive)→ **error + hint**(**非** silent return success — escape hatch 是 caller 显式请求 cleanup,no-op 误导 caller 以为成功了)。hint 指向应用 UI Team 面板「Shutdown all teammates」入口(不要求 caller 是 lead)
- helper 自身抛错(DB SQLite locked / session close abort 等)→ error + console.warn,**不**像 archive_plan / hand_off_session 兜底 warn 不阻塞(本 tool 是 escape hatch,helper 失败就是补跑没成功,需让 caller 显式知道)

**deny external caller**:session close 是写操作 + caller=lead 反查需要真实 callerSessionId,绝不允许 stdio external client 调用(避免被恶意 mcp client 利用清理任意 team session)。

### plan hand-off 自动化:hand_off_session

`hand_off_session` 起新 SDK session 接力 + 自动归档 caller。**双模式**:plan-driven 传 `planId`(读 plan frontmatter,要求 `status: in_progress` + 有 `worktree_path`,cold start prompt = `按 <plan-abs-path> 接力`,可附 `phaseLabel`);generic 不传 `planId`(不读 plan,cold start prompt = `args.prompt` 或默认「从上一个会话接力继续工作」)。

**调用**:`mcp__agent-deck__hand_off_session({ planId?, phaseLabel?, prompt?, cwd?, adapter?: "codex-cli", teamName?, codexSandbox?, planFilePath?, archiveCaller?: true, adoptTeammates?: false, teamTaskPolicy?: 'clear-team' | 'preserve-team' | 'skip' })`
**返回**:`{ mode: 'plan'|'generic', planId, planFilePath, worktreePath, initialPrompt, sessionId, cwd, teamId, teamName, spawnPromptMessageId, archived, teammatesShutdown, ... }`

**app-only 差异**:

- **cwd resilience**:plan-driven 默认 `cwd = mainRepo`(fallback 链 `args.cwd > resolved.mainRepo > resolved.worktreePath`),让 session 记录的 cwd 在 worktree 被 archive_plan 删后仍 valid;新 session 自己按 **本文件** §plan cold-start protocol(codex 端 5 步) cold-start 使用 `worktreePath` 推进,必要时才调 MCP `enter_worktree(planId)` 创建 / 标记 worktree(codex 端必走 MCP,不是 claude builtin,且不改变 codex shell 默认 cwd)。generic 默认 `cwd = caller cwd`
- **hand-off 完全独立于 spawn-guards / 永不写 spawn-link**:`hand_off_session` 内部调 spawn 时传 `handOffMode: true`,让 spawn handler **完全跳过** spawn-guards 三道防御(depth check + fan-out + spawn-rate)+ **永不写** spawn-link 关系(parent 指针 / depth 字段保持 null/0)。理由:hand-off 是「平级接力 + 接管 lead 身份」语义不是 spawn 派遣关系（「平级接力」不是「派出小弟干活」）,数据层不应记录 spawn-link 让 SessionList 树形分组错挂 teammate badge。**统一行为**:无论 `archiveCaller` 值(default true / 显式 false)/ `adoptTeammates` 值(default false / true),hand-off 路径行为完全一致 — 新 session 在 SessionList 呈现为独立 root,不显示与 caller 任何 spawn 关系。**`archiveCaller: false × N` 滥用风险**:caller 持 false × N 次起 N 个 session 是合法 power-user 路径(典型 lead 起多 hand-off 子任务自己仍想看 reviewer reply / debug 工具用例),应用层不阻止 — power-user 自负责任
- **archive 默认 true,可 opt-out**:caller 无论 untracked / dirty / 已加入 team 都归档(default);typical baton 语义「任意时刻单 in-flight session」自然成立。**例外 opt-out**:caller 显式传 `archiveCaller: false` 跳过归档(罕见场景:lead 起多个 hand-off 子任务并行做事自己仍想看 reviewer reply / 出 summary;debug 工具想起新 session 实测某 plan 但 caller 仍要观察)。`archiveCaller: false` 时 ok return.archived === "skipped"
- **default 不加 team**:baton 单向交接不强加 lead/teammate 关系;显式 `teamName` 才启用通信
- **adoptTeammates 选 in 接管 caller 同 team 当 lead**:default false 走纯 baton(原 teammate 与新 session 失去 shared active team,`send_message` 撞 no-shared-team)。**`adoptTeammates: true`** 让新 session 接管 caller 同 team 当 lead,原 teammate 与新 session 共享 active team 可继续 send_message 沟通。**≥1 lead 硬约束**:caller 在所有 team 都不是 lead → handler spawn 之前 fail-fast 返 error,不 spawn / 不 archive caller。**与 teamName 互斥**:adopt 路径自动过继 caller 自己 team,与显式额外 team 语义冲突。**archived team / archived teammate filter**:caller 在 archived team 的 ghost membership(role 不论 lead / teammate)push failed reason='team-archived';archived teammate(session 已归档)进 failed reason='session-archived' + cold-start prompt 装配时已过滤。Detail 见 ok return.adopted 字段:`{ preserved, failed, teamsTotal, teamsAdopted, firstTeamId } | null`(adoptTeammates: true 时 non-null;`failed.reason` 取值 `'caller-not-lead-in-team' / 'team-archived' / 'swap-lead-failed: ...' / 'swap-lead-error: ...' / 'session-missing' / 'lifecycle-closed' / 'session-archived'`)。
- **预检短路**:plan-driven 模式 plan 文件不存在 / status ≠ in_progress / frontmatter 缺 `worktree_path` / spawn 失败 → 立即返回 error
- **新 session 必须含「复杂 plan」节 cold-start protocol 5 步**:codex SDK 加载链是 `~/.codex/AGENTS.md`(本文件),**不**自动加载 `~/.claude/CLAUDE.md`(claude 端走 `settingSources: ['user',...]` 自动加载,codex 端无对等机制)。本应用环境**已在 §plan cold-start protocol(codex 端) 节 inline 5 步**让 codex 收到 `按 <plan-abs-path> 接力` 字面提示后能正确执行;若该节缺失或被裁剪,caller 起 cold-start prompt 时必须显式把 5 步 inline 进 prompt
- **task 自动过继 + teamTaskPolicy 三态**: spawn 完成 + 新 sid 落 DB + adopt 完成后、archive caller 之前, 按 `teamTaskPolicy` 三态处理 caller owned task。**过继 ownership 不刷 `updated_at`** 让 list 默认排序保持稳定。
  - **`'clear-team'`** (default): `UPDATE tasks SET owner_session_id=newSid, teamId=NULL WHERE owner_session_id=callerSid` — 过继 ownership 同时清 teamId 变 personal。适用面最广,newSid 拿到的 task 都是 personal,caller==owner 写权限路径直接生效;newSid 不必加任何 team 就能继续 own / read / write 全部过继的 task。typical baton 场景首选,task 不丢
  - **`'preserve-team'`** (caller 自负责任): `UPDATE tasks SET owner_session_id=newSid WHERE owner_session_id=callerSid`(不动 teamId)。caller 想让 newSid 接管 team-bound task 同时继承 team 上下文(典型与 `adoptTeammates=true` 配合使用让 newSid swapLead 接管 team 当 lead)。**Caller 自负责任**:如 newSid 没成为对应 team 的 active member,newSid 撞写权限 reject — handler 不 hard reject 但 ok return `taskReassignment.policyWarning='preserve-team-unadopted-teams'` + `unadoptedTeamIds: string[]` 暴露差集 teamId
  - **`'skip'`** (清理场景): 单 transaction 4 步原子化:SELECT caller owned team task ids → DELETE → cleanup blocks/blockedBy 引用 → reassign 剩余 personal task to newSid。caller 不希望 team-bound task 跨 baton 保留(典型 plan 收口后 abandon 中间 task)。personal task 仍正常过继给 newSid;不依赖 caller archive 后 CASCADE — task 在 handoff 时被立即 DELETE 语义干净零中间窗口
  - **`archiveCaller=false` 优先级**:caller 显式 `archiveCaller=false` 时 reassign 整段被 skip(caller 仍 active 继续 own 自己 task),`teamTaskPolicy` 不执行 — ok return `taskReassignment={status:'skipped', reason:'archive-caller-false', policy: <resolvedPolicy>}`(policy 字段仍透传 advisory)
  - **失败兜底**: skip-policy / 过继 ownership 的 DB / SQL 异常都仅 warn 不阻塞 ok return — task 过继是 nice-to-have,baton 本质是 session 接力;caller 通过 ok return `taskReassignment` 字段(`'ok'+count+policy[+policyWarning+unadoptedTeamIds]` / `'failed'+error+policy` / `'skipped'+reason+policy`)看到结果。配合 ON DELETE CASCADE 让 caller archive 后被物理删时 task 已留新 session 名下不被 CASCADE 删
- **ShutdownAllTeammates 不过继 task owner**:与 handOff caller→newSid 不对称。teammate 关闭后 task 仍在 teammate 名下,被历史保留期 TTL GC 触发物理删除时 CASCADE 删。teammate context 已死 task 本质无主,删干净是合理设计(配合 GC 主语义)。
- **典型主动触发(generic mode)**:当前 cwd 不适合手头任务(cwd 已失效 / 不属目标 repo / 用户明示换目录 / 跨 repo 任务) → 不要在当前 session 强行 `cd` / 跨目录绝对路径(codex shell tool 切 cwd 不持久跨 turn),用 generic mode 显式传新 `cwd` + 自包含 `prompt` 接力到正确目录
- **prompt 装不下完整 context 时**(必要信息务必传递完整,避免 hand-off 丢失大量上下文):caller 先把 context 落盘到 `/tmp/handoff-<id>.md`(临时文件不用清理),prompt 起手写「先 `shell: cat <abs-path>` 再按文件内指令推进」让新 session cold-start 第一步读全
- **想保留 caller 不归档** → 两个选项:① `hand_off_session({..., archiveCaller: false})` 显式 opt-out(详上方 archive 默认 true 节);② `spawn_session(cwd:<目标>, prompt:<打包信息>)` 而非 `hand_off_session`(spawn 出新 session 但不切换接力身份,适合并行子任务)

### plan cold-start protocol(codex 端 5 步)

新 codex SDK session 收到 hand_off_session 注入的 cold-start prompt(典型字面:`按 <plan-abs-path> 接力（Phase: <phaseLabel>）`)时,**必做** 5 步:

1. `shell: cat <plan-abs-path>` 读 plan 全文(codex CLI 默认无 native Read tool — 跨会话第一次读「长期存在 + 其他会话动过的文件」务必走 `shell: cat` 走真 fs。本规约对 codex 端单方有效;claude 端有 Read tool 缓存陷阱另规)
2. 从 frontmatter 拿 `worktree_path` + `plan_id`（frontmatter 字段名是 snake_case）。若 `worktree_path` 值已存在(典型 hand_off_session 接力已有 plan worktree),**不要**调 `enter_worktree`(该 tool 只创建新 worktree,会拒绝复用既有 path);直接使用 worktree 绝对路径推进。若 plan 仍处在“新建 worktree”阶段且路径不存在,才调 `mcp__agent-deck__enter_worktree({ planId, baseCommit: <frontmatter.base_commit> })` 创建并记录 marker(codex 无 native EnterWorktree CLI;`baseCommit` 显式传 frontmatter 的 `base_commit` 避撞 stale base bug)
3. 自检:`shell: git -C <worktree-path-value> rev-parse HEAD` 与 `git -C <worktree-path-value> log --oneline -3`,确认 HEAD = frontmatter `base_commit` / `final_commit` 或之后
4. 按 plan **§下一会话第一步** 节直接动手:**不重新讨论已记录的 §设计决策**;**所有 shell / 文件路径显式指向 worktree**(`git -C <worktree-path-value>` 或 `<worktree-path-value>/...`),不要依赖 codex SDK cwd 已切换;plan 「§下一会话第一步」描述的「先 X 再 Y 再 Z」级别动作按字面执行
5. 进度变更 / §设计决策 / §不变量 修订必须先告诉用户征得确认(plan §Agent 自主 hand-off 授权 节列具体例外清单)

> claude 视角的对应 protocol 在 `resources/claude-config/CLAUDE.md` §复杂 plan workflow §Step 3 §选项 A;codex 端无 `~/.claude/CLAUDE.md` 自动加载机制(claude 端走 `settingSources` 自动加载),本节是 codex 端等价物 inline。

### codex SDK 特有:per-session token / spawn options default

codex teammate spawn(`adapter: 'codex-cli'`)走应用层默认 enforce 一组 spawn options(reviewer-* 必需):
- `sandboxMode: 'workspace-write'`(SDK 默认档;`approvalPolicy: 'never'` 配合不弹审批)
- `approvalPolicy: 'never'`(SDK 无 UI 弹审批会挂)
- `networkAccessEnabled: true`(reviewer-codex teammate 调 OpenAI API;cross-adapter pair 时 reviewer-claude 跑在 claude SDK 端不走本 default)
- `additionalDirectories: ['~/.claude', '~/.codex', '/tmp']`(reviewer 跨目录读 plan / claude config / codex config 文件 + cache 中间文件落 `/tmp`)
- 只有内部 createSession 调用方能覆盖完整 codex SDK options；MCP `spawn_session` 当前仅暴露 `codexSandbox` / `permissionMode` 等白名单字段,**不**暴露任意 `additionalDirectories` / `networkAccessEnabled` override。需要读默认范围外文件时,走 deep-review SKILL auto cp 或把文件复制到 worktree/repo cwd / `~/.claude` / `~/.codex` / `/tmp` 后再传 scope

per-session MCP token 机制 — 应用启动 codex 子进程时分发一次性 token 让本应用 MCP server 反查 caller，工作流：
- 应用 spawn 新 codex SDK session 时为它分配 per-session token，通过环境变量 `AGENT_DECK_MCP_TOKEN` 注入子进程
- codex CLI 通过 `bearer_token_env_var: 'AGENT_DECK_MCP_TOKEN'` 读 env var 拼 HTTP `Authorization: Bearer <token>` 头连 streamable HTTP MCP server
- 应用端 MCP server 收到 Bearer token → 反查回 caller `sessionId` 自动填入 tool handler（caller 不必手动传 `callerSessionId` arg）
- 全局 token fallback（外部 codex CLI 走 `process.env.AGENT_DECK_MCP_TOKEN` 全局值）只读不能写（spawn / send / archive 等高危 tool deny external caller）

### recoverer cwd 启发式 fallback(兜底)

caller 取消归档继续给已收口 plan-driven session 发消息(撞 cwd 失效)/ 用户手动 `git worktree remove` 不走 archive_plan / 跨设备同步丢目录 → codex sdk-bridge.recoverer 启发式找仍存在的祖先目录当 cwd 兜底(worktree 路径取段之前部分 / 父目录 walk 不超过 home),找到 → emit info + 强制走 jsonl missing fallback 同款下游(CLI 历史失但应用层 events / file_changes / summaries 子表保留);找不到 → emit error 清晰告诉用户。


## Issue 上报(report_issue / append_issue_context / update_issue_status)

Agent 执行中踩到「需后续跟进的问题」→ 通过 mcp tool 落 issue tracker。**agent 以写为主**:`report_issue`(上报)+ `append_issue_context`(同 session 补现场)+ `update_issue_status`(源 / 解决会话自助改 status)3 个 write tool,无 list / get / delete — 查询 / triage / 软删全走应用 UI(agent 上报,真人 + 关联会话协同处置)。callerSessionId 由 per-session token 自动反查填入,codex 端不必手传。

### 何时上报

执行中发现以下任一、且**不属于当前任务直接交付范围** → 上报 issue(而非默默吞掉 / 强塞进当前改动):

| kind(soft enum) | 场景 |
|---|---|
| `follow-up`(default)| 当前任务暴露的后续工作(本轮 scope 外但该做)|
| `app-bug` | Agent Deck 应用本身的 bug |

> 仅这 2 个推荐值;kind 是软枚举,需要时仍可传任意自定义字符串(UI 归到 "other" 分组)。

**不上报**:**当场就能顺手修掉的,直接修,别 report**(report 是留给「本轮 scope 外 / 需后续跟进」的,不是给自己当下能解决的事记 TODO);当前任务直接交付的内容(直接做);一次性 trivial 观察;疑似重复 issue(agent 查不了已有 issue,宁可重报由 UI 合并,不要因怕重复而不报)。

### report_issue

`mcp__agent-deck__report_issue({ title, description, kind?, severity?, repro?, labels?, cwd?, logsRef? })`

| 字段 | 必传 | 说明 |
|---|---|---|
| `title` | ✓ | 1-200 字,一句话点题 |
| `description` | ✓ | 1-2000 字,**self-contained**(triager 不读日志也能懂上下文)|
| `kind` | optional | 见上表,default `follow-up`;非枚举值原样存,UI 归到 "other" |
| `severity` | optional | strict enum `low` / `medium` / `high`,default `medium` |
| `repro` | optional | 复现步骤 1-2000 字 |
| `labels` | optional | 自由 tag,≤16 个 |
| `cwd` | optional | **默认不传**,自动取 caller session cwd |
| `logsRef` | optional | 日志指针(非日志内容):`{ date: "YYYY-MM-DD", tsRange?, scopes?, note? }` |

返回完整 IssueRecord(主键字段名是 `id`,**不是** `issueId`);把该 `id` 作为 `append_issue_context` 入参 `issueId` 传入做同会话后续追加。

### append_issue_context(source-bound)

`mcp__agent-deck__append_issue_context({ issueId, additionalContext, logsRef? })` — 给**本会话自己上报过**的 issue 追加上下文。

- **source-bound**:仅 `issue.sourceSessionId === 当前 caller` 才能 append;别人的 / 跨会话的 issue 一律 reject → 改用 `report_issue` 开新 issue(UI 手动合并)
- **resolved / 软删 拒 append**:issue 已 resolved 或已被用户软删(隐藏)→ reject(源 / 解决会话可先用 `update_issue_status` 把 status 改回 open/in-progress 再 append;或 UI 端恢复 / 改回,或改用 `report_issue` 开新 issue)
- 追加内容进独立子表,**不改**原 `description`;`logsRef` 合并规则:date 覆盖 / tsRange min-max 扩展 / scopes union 去重 / note 追加(**date 始终必填**,即使只更新 tsRange / scopes / note)

### update_issue_status(源 / 解决会话自助改状态)

`mcp__agent-deck__update_issue_status({ issueId, status, note? })` — 让 issue 的**源会话**(report 它的会话)或**解决会话**(UI「起新会话解决」起的会话)自己推进状态,不必劳烦用户去 UI 点。

- **授权边界**:仅 `issue.sourceSessionId === 当前 caller` **或** `issue.resolutionSessionId === 当前 caller` 才放行;第三方会话 reject(其余请走 UI)。两者皆 null(会话被 GC)→ 只能走 UI。
- **典型用法**:
  - 你 report 的 issue 后来自己修好了 → `update_issue_status({ issueId, status: 'resolved', note: '简述怎么修的' })`
  - 解决会话修完 → 同上自助标 resolved;没修好 / 需重开 → `status: 'open'` + note 说明原因
- **status** 严格 3 态 `open` / `in-progress` / `resolved`;**note**(可选 1-2000 字)会作为一条「补充记录」留痕(怎么修的 / 为何 reopen)。
- 软删 issue reject。
